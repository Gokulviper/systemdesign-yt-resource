/*
 * Video upload. A resumable session splits the file into chunks; each chunk
 * carries a checksum; completion assembles the parts and emits exactly one
 * video.uploaded event for processing (idempotently, even if retried).
 */
(function (root) {
  'use strict';
  const SDL = root.SDL;
  const Y = SDL.yt;
  const CHUNKS = 8;
  const FILES = { trip: { label: 'Road trip vlog.mp4', size: '640 MB' }, talk: { label: 'Conference talk.mov', size: '1.2 GB' } };

  function startUpload(sim) {
    const st = sim.state;
    const file = sim.ui.creator.file;
    const key = 'up-' + ++st.seq.key;
    sim.startAction(`Creator: upload ${FILES[file].label}`, function* (ctx) {
      const u = ctx.ui.creator;
      const online = () => !ctx.sim.nodes.creator.modes.down;
      const waitOnline = function* () { while (!online()) { u.status = 'Offline: waiting for the network…'; yield ctx.wait(200); } };
      Object.assign(u, { busy: true, parts: new Array(CHUNKS).fill('empty'), status: 'Starting upload…', done: false });
      Y.L(ctx, { displayed: ['pending', 'Shows chunk-by-chunk progress.'], retrySafe: ['yes', 'Chunks and completion are idempotent per session.'] });
      let s = yield ctx.call('api', 'create', { key, file }, { timeout: 1000 });
      if (!s.ok) { u.busy = false; u.status = `Couldn’t start: ${s.error.message}`; Y.failed(ctx); return; }
      let uploadId = s.value.uploadId;
      let n = 0;
      while (n < CHUNKS) {
        while (u.paused) { u.status = 'Paused.'; yield ctx.wait(200); }
        if (!online()) {
          u.parts[n] = 'failed';
          yield* waitOnline();
          if (st.config.resumable) {
            const r = yield ctx.call('api', 'status', { uploadId }, { timeout: 1000 });
            if (r.ok) { n = r.value.received; ctx.log({ op: `resume at chunk ${n + 1}`, status: 'recovered', detail: `The session already has ${n} of ${CHUNKS} chunks; only the rest are sent.` }); }
          } else {
            st.wasted += n;
            ctx.log({ op: 'restart from scratch', status: 'retry', detail: `No resumable session: the ${n} chunks already sent are thrown away and the upload starts again.` });
            u.parts = new Array(CHUNKS).fill('empty');
            s = yield ctx.call('api', 'create', { key: key + '-r' + st.wasted, file }, { timeout: 1000 });
            uploadId = s.value.uploadId;
            n = 0;
          }
          continue;
        }
        u.parts[n] = 'sending';
        u.status = `Uploading chunk ${n + 1} of ${CHUNKS}…`;
        const corrupt = !!ctx.sim.nodes.creator.modes.corrupt && n === 4 && !st.corruptedOnce;
        if (corrupt) st.corruptedOnce = true;
        st.sent++;
        const r = yield ctx.call('api', 'chunk', { uploadId, n, corrupt }, { timeout: 1200 });
        if (r.ok) { u.parts[n] = r.value.corrupt ? 'corrupt' : 'done'; n++; continue; }
        if (r.error.code === 'CHECKSUM_MISMATCH') { u.parts[n] = 'failed'; ctx.log({ op: `chunk ${n + 1} rejected`, status: 'retry', detail: 'The server’s checksum did not match the data, so the chunk was rejected and is being resent.' }); continue; }
        if (online()) { u.parts[n] = 'failed'; yield ctx.wait(400); }
      }
      u.status = 'Finishing upload…';
      let c;
      for (let attempt = 1; attempt <= 4; attempt++) {
        c = yield ctx.call('api', 'complete', { uploadId }, { timeout: 1500 });
        if (c.ok) break;
        ctx.log({ op: `complete attempt ${attempt} failed`, status: 'retry', error: c.error, detail: 'No confirmation; the app retries completion.' });
        yield ctx.wait(300);
      }
      u.busy = false;
      if (c.ok) {
        Object.assign(u, { done: true, status: c.value.corrupt ? 'Uploaded, but the file is damaged.' : 'Upload complete. Processing will start shortly.' });
        Y.L(ctx, { displayed: 'yes', accepted: 'yes', committed: ['yes', 'All chunks stored and the session completed.'], async: ['pending', 'Waiting for processing.'] });
        ctx.explain(`All ${CHUNKS} chunks were stored and the session completed${c.value.replayed ? ' (a retried completion found the session already complete and returned the same result)' : ''}. A video.uploaded event hands the file to processing.`);
      } else { u.status = `Couldn’t finish: ${c.error.message}`; Y.failed(ctx); }
    }, { self: 'creator' });
  }

  const sc = (SDL.scenarios.upload = {
    id: 'upload',
    seed: 131,
    productWidth: 440,
    intro: 'Pick a file and tap Upload. Each chunk travels to object storage and is recorded in the session; completion hands the video to processing. Pause and resume, or drop the network mid-upload.',
    topology: {
      width: 1100, height: 520,
      nodes: [
        { id: 'creator', label: 'Creator app', sub: 'Uploads chunks', kind: 'client', x: 100, y: 90, latency: 1, role: 'Splits the file into chunks with checksums, resumes from the session after interruptions.', owns: ['The file', 'Upload progress'] },
        { id: 'api', label: 'Upload API', sub: 'Sessions, chunks', kind: 'service', x: 320, y: 90, latency: 4, role: 'Creates resumable sessions, verifies chunk checksums, assembles on completion.', ops: [{ name: 'create', desc: 'New session.' }, { name: 'chunk', desc: 'Store one chunk.' }, { name: 'status', desc: 'Which chunks arrived.' }, { name: 'complete', desc: 'Assemble and finish.' }], owns: ['Upload rules'] },
        { id: 'sessions', label: 'Upload sessions', sub: 'Progress + outbox', kind: 'db', x: 540, y: 90, latency: 8, role: 'Each session’s received chunks and status. Completion writes a video.uploaded event in the same transaction.', ops: [{ name: 'markPart', desc: 'Record a chunk.' }, { name: 'complete', desc: 'Finish once.' }], owns: ['upload_sessions', 'outbox'] },
        { id: 'objstore', label: 'Object storage', sub: 'Chunks, files', kind: 'store', x: 320, y: 320, latency: 15, role: 'Stores chunks, then composes them into the final file.', ops: [{ name: 'putPart', desc: 'Store a chunk.' }, { name: 'compose', desc: 'Join chunks.' }], owns: ['Raw video files'] },
        { id: 'events', label: 'Upload events', sub: 'Event broker', kind: 'queue', x: 760, y: 90, latency: 4, queue: 'uploads', role: 'Hands finished uploads to processing.', ops: [{ name: 'publish', desc: 'Append.' }], owns: ['upload log'] },
        { id: 'processing', label: 'Processing', sub: 'Next lab', kind: 'worker', x: 980, y: 90, latency: 6, role: 'Starts a transcoding job per uploaded video (the processing lab covers what happens next).', ops: [{ name: 'consume', desc: 'Start a job.' }], owns: ['Jobs'] },
      ],
      edges: [
        { from: 'creator', to: 'api', latency: 40, label: 'HTTPS' },
        { from: 'api', to: 'sessions', latency: 4 },
        { from: 'api', to: 'objstore', latency: 6 },
        { from: 'sessions', to: 'events', latency: 6, label: 'outbox' },
        { from: 'events', to: 'processing', latency: 4 },
      ],
      queues: [{ id: 'outbox', broker: 'sessions', label: 'outbox', groups: ['relay'] }, { id: 'uploads', broker: 'events', label: 'uploads', groups: ['processing'] }],
    },
    modeLabels: { corrupt: 'Corrupting data', dropComplete: 'Losing completion replies' },
    failures: [
      { id: 'net', node: 'creator', mode: 'down', label: 'Network drops', desc: 'The phone loses its connection mid-upload.' },
      { id: 'corrupt', node: 'creator', mode: 'corrupt', label: 'A chunk is corrupted in transit', desc: 'Chunk 5 arrives with damaged bytes.' },
      { id: 'store-down', node: 'objstore', mode: 'down', label: 'Object storage unavailable', desc: 'Chunks cannot be stored; the app retries.' },
      { id: 'drop-complete', node: 'sessions', mode: 'dropComplete', label: 'Completion reply lost', desc: 'The session completes but the app never hears back, so it retries.' },
      { id: 'proc-paused', node: 'processing', mode: 'paused', label: 'Processing backlog', desc: 'Uploads finish; jobs wait in the queue.' },
    ],
    switches: Y.switches([
      ['resumable', 'Resumable sessions', 'After an interruption, ask which chunks arrived and continue. Off: start over.'],
      ['checksum', 'Per-chunk checksums', 'Reject chunks whose bytes do not match. Off: damaged data is stored.'],
      ['idemComplete', 'Idempotent completion', 'A repeated “complete” returns the first result. Off: each emits another upload event.'],
    ]),
    presets: Y.presets({ resumable: true, checksum: true, idemComplete: true }, [
      { id: 'upload', label: 'Upload a video', desc: 'Session, eight chunks, completion, one processing job.', run: (s) => startUpload(s) },
      { id: 'drop', label: 'Network drop, resumable', desc: 'The connection drops for 1.5 s. The app asks the session what arrived and continues.', run: (s) => { startUpload(s); s.schedule(900, () => s.inject('creator', 'down', true, 1500)); } },
      { id: 'drop-restart', label: 'Network drop, no resume', desc: 'The same drop, but the upload restarts from the first chunk.', sw: { resumable: false }, run: (s) => { startUpload(s); s.schedule(900, () => s.inject('creator', 'down', true, 1500)); } },
      { id: 'corrupt', label: 'Corrupted chunk, checksums on', desc: 'Chunk 5 arrives damaged; the checksum catches it and the app resends.', run: (s) => { s.inject('creator', 'corrupt'); startUpload(s); } },
      { id: 'corrupt-bad', label: 'Corrupted chunk, no checksums', desc: 'The damaged chunk is stored. The upload “succeeds”, and processing fails later.', sw: { checksum: false }, run: (s) => { s.inject('creator', 'corrupt'); startUpload(s); } },
      { id: 'complete', label: 'Completion reply lost, idempotent', desc: 'The app retries “complete”; the session is already complete, so one event, one job.', run: (s) => { s.inject('sessions', 'dropComplete', true, 2600); startUpload(s); } },
      { id: 'complete-bad', label: 'Completion reply lost, not idempotent', desc: 'Every retry emits another upload event: the video is transcoded twice.', sw: { idemComplete: false }, run: (s) => { s.inject('sessions', 'dropComplete', true, 2600); startUpload(s); } },
      { id: 'store-down', label: 'Storage outage mid-upload', desc: 'Chunk writes fail for 1.2 s; the app retries each chunk until storage returns.', run: (s) => { startUpload(s); s.schedule(700, () => s.inject('objstore', 'down', true, 1200)); } },
      { id: 'backlog', label: 'Processing backlog', desc: 'The upload completes instantly from the creator’s view; the job waits until processing resumes.', run: (s) => { s.inject('processing', 'paused', true, 4000); startUpload(s); } },
    ]),
    initialState: () => ({ config: { resumable: true, checksum: true, idemComplete: true }, sessions: {}, keys: {}, jobs: {}, failedJobs: 0, sent: 0, wasted: 0, corruptedOnce: false, seq: { key: 0, session: 0, event: 0 } }),
    initialUI: () => ({ creator: { file: 'trip', busy: false, paused: false, parts: new Array(CHUNKS).fill('empty'), status: 'Choose a file and tap Upload.', done: false } }),
    actions: {
      upload(sim) { startUpload(sim); },
      pause(sim) { sim.ui.creator.paused = !sim.ui.creator.paused; },
      set: Y.setAction,
    },
    handlers: {
      api: {
        create: function* (ctx, p) { return ctx.must(yield ctx.call('sessions', 'create', p, { timeout: 600 })); },
        status: function* (ctx, p) { return ctx.must(yield ctx.call('sessions', 'status', p, { timeout: 600 })); },
        chunk: function* (ctx, p) {
          if (p.corrupt && ctx.state.config.checksum) ctx.fail('CHECKSUM_MISMATCH', `Chunk ${p.n + 1} checksum mismatch.`);
          ctx.must(yield ctx.call('objstore', 'putPart', p, { timeout: 800 }));
          ctx.must(yield ctx.call('sessions', 'markPart', p, { timeout: 600 }));
          return { stored: p.n, corrupt: !!p.corrupt };
        },
        complete: function* (ctx, p) {
          const sess = ctx.state.sessions[p.uploadId];
          if (!sess || sess.parts.filter(Boolean).length < CHUNKS) ctx.fail('INCOMPLETE', 'Some chunks are missing.');
          const f = ctx.must(yield ctx.call('objstore', 'compose', p, { timeout: 800 }));
          const r = ctx.must(yield ctx.call('sessions', 'complete', { uploadId: p.uploadId, corrupt: f.corrupt }, { timeout: 700 }));
          void f; // the API cannot tell a damaged file from a good one without checksums
          return Object.assign({ corrupt: false }, r);
        },
      },
      sessions: {
        create(ctx, p) {
          const st = ctx.state;
          if (st.keys[p.key]) return { uploadId: st.keys[p.key] };
          const id = 'upl-' + ++st.seq.session;
          st.sessions[id] = { id, file: p.file, parts: new Array(CHUNKS).fill(false), corrupt: false, status: 'OPEN' };
          st.keys[p.key] = id;
          return { uploadId: id };
        },
        status(ctx, p) { const s = ctx.state.sessions[p.uploadId]; return { received: s.parts.indexOf(false) === -1 ? CHUNKS : s.parts.indexOf(false) }; },
        markPart(ctx, p) { const s = ctx.state.sessions[p.uploadId]; s.parts[p.n] = true; if (p.corrupt) s.corrupt = true; return { ok: true }; },
        complete(ctx, p) {
          const st = ctx.state;
          const s = st.sessions[p.uploadId];
          const already = s.status === 'COMPLETE';
          if (!(already && st.config.idemComplete)) {
            s.status = 'COMPLETE';
            ctx.sim.enqueue('outbox', { type: 'video.uploaded', eventId: 'ev' + ++st.seq.event, payload: { video: s.id, corrupt: s.corrupt }, actionId: ctx.actionId });
          }
          if (ctx.mode('dropComplete')) ctx.fail('TIMEOUT', 'The completion reply was lost.');
          return { video: s.id, replayed: already };
        },
      },
      objstore: {
        putPart(ctx) { return { ok: true }; },
        compose(ctx, p) { return { corrupt: ctx.state.sessions[p.uploadId].corrupt }; },
      },
    },
    setup(sim) {
      Y.relay(sim, 'outbox', 'relay', 'events', 'uploads');
      Y.consumer(sim, 'uploads', 'processing', 'processing', function* (ctx, msg) {
        const st = ctx.state;
        const v = msg.payload.video;
        st.jobs[v] = (st.jobs[v] || 0) + 1;
        if (msg.payload.corrupt) {
          st.failedJobs++;
          ctx.log({ op: `transcoding ${v} failed`, status: 'err', actionId: msg.actionId, detail: 'The assembled file is damaged. Without per-chunk checksums the problem surfaced only now, after the creator was told the upload succeeded.' });
          ctx.explain('The damaged chunk was accepted because nothing checked it. The creator saw “upload complete”; processing then failed on a corrupt file. Checksums move that failure to the moment it can still be fixed by resending one chunk.');
        } else {
          ctx.log({ op: `transcoding job ${st.jobs[v]} for ${v}`, status: st.jobs[v] > 1 ? 'err' : 'ok', actionId: msg.actionId, detail: st.jobs[v] > 1 ? 'A second job for the same video: double the transcoding cost, and possibly two published copies.' : 'One job queued for this video.' });
        }
        ctx.sim.setLedger(msg.actionId, 'async', msg.payload.corrupt ? 'no' : 'yes', msg.payload.corrupt ? 'Processing failed on a corrupt file.' : 'Processing job started.');
        yield ctx.wait(1);
        return true;
      }, () => false);
    },
    consistency(sim) {
      const st = sim.state;
      const twice = Object.entries(st.jobs).find(([, n]) => n > 1);
      if (twice) return { key: 'wrong', label: `${twice[0]} was sent to processing ${twice[1]} times.` };
      if (st.failedJobs) return { key: 'wrong', label: 'The creator was told the upload succeeded, but the stored file is corrupt.' };
      const open = Object.values(st.sessions).filter((s) => s.status === 'OPEN' && s.parts.some(Boolean));
      if (sim.ui.creator.busy || open.length && sim.ui.creator.busy) return { key: 'stale', label: 'An upload is in progress.' };
      if (sim.queueStats('uploads').depth) return { key: 'stale', label: 'A finished upload is waiting for processing.' };
      return { key: 'ok', label: 'Every completed upload is stored intact and processed exactly once.' };
    },
    metrics(snap, sim) {
      const st = sim.state;
      return [
        { label: 'Chunks sent', value: st.sent },
        { label: 'Chunks wasted by restarts', value: st.wasted, tone: st.wasted ? 'warn' : '' },
        { label: 'Processing jobs', value: Object.values(st.jobs).reduce((a, b) => a + b, 0) },
        { label: 'Corrupt files processed', value: st.failedJobs, tone: st.failedJobs ? 'fail' : '' },
      ];
    },
    product: {
      mount(el, sim) { Y.mount(el, sim, [['creator', 'Creator phone']], { note: 'Each square is one chunk: grey waiting, blue sending, green stored, red failed, hatched corrupt.' }); },
      render(el, sim) {
        const u = sim.ui.creator;
        const body = `<div class="app-row"><label for="uf">File</label><select id="uf" data-field="creator.file"${u.busy ? ' disabled' : ''}>${Object.entries(FILES).map(([k, f]) => `<option value="${k}"${k === u.file ? ' selected' : ''}>${f.label}, ${f.size}</option>`).join('')}</select></div>
          <div class="chunk-grid" aria-label="Chunks">${u.parts.map((p, i) => `<span class="chunk chunk-${p}" title="Chunk ${i + 1}: ${p}">${i + 1}</span>`).join('')}</div>
          <div class="app-countdown"><i style="width:${(u.parts.filter((p) => p === 'done' || p === 'corrupt').length / CHUNKS) * 100}%"></i></div>
          <div class="app-row">${Y.btn('upload', u.busy ? '<span class="spinner"></span>Uploading…' : 'Upload', { disabled: u.busy })}${Y.btn('pause', u.paused ? 'Resume' : 'Pause', { cls: 'secondary', disabled: !u.busy })}</div>
          ${Y.msg(u.status, u.done ? 'ok' : '')}`;
        Y.paint(el, sim, 'creator', { head: '<div><p class="app-title">YouTube Studio</p><p class="app-sub">Upload video</p></div>', body }, {});
      },
    },
  });
  void sc;
})(typeof window !== 'undefined' ? window : globalThis);
