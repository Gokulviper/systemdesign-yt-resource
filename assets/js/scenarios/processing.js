/*
 * Video processing and transcoding. A job splits into one task per
 * (rendition, segment). A pool of workers leases tasks; leases expire if a
 * worker dies so the task is retried; tasks that keep failing go to a
 * dead-letter queue; the pool autoscales on backlog; publishing can be
 * progressive (watchable once low renditions are ready).
 */
(function (root) {
  'use strict';
  const SDL = root.SDL;
  const Y = SDL.yt;
  const RENDITIONS = [['240p', 250], ['480p', 400], ['720p', 600], ['1080p', 900]];
  const SEGMENTS = 4;
  const LEASE_MS = 1500;

  function startJob(sim, label) {
    const st = sim.state;
    const job = 'job-' + ++st.seq.job;
    sim.startAction(label || 'Creator: process my upload', function* (ctx) {
      Y.L(ctx, { displayed: ['pending', 'Shows “Processing”.'], retrySafe: ['yes', 'Submitting the same upload returns the existing job.'] });
      const r = yield ctx.call('orchestrator', 'submit', { job }, { timeout: 1500 });
      if (r.ok) { Y.L(ctx, { displayed: 'yes', accepted: 'yes', async: ['pending', 'Transcoding runs in the background.'] }); ctx.explain(`The orchestrator recorded ${job} and queued ${r.value.tasks} tasks: four renditions × four segments, plus a thumbnail. Workers lease tasks from the queue.`); }
      else Y.failed(ctx);
    }, { self: 'creator' });
    return job;
  }

  const sc = (SDL.scenarios.processing = {
    id: 'processing',
    seed: 137,
    productWidth: 460,
    intro: 'Tap “Process my upload”. The job fans out into 17 tasks; watch workers lease them, renditions fill in, and the video publish. Then crash a worker or feed it a poison segment.',
    topology: {
      width: 1100, height: 540,
      nodes: [
        { id: 'creator', label: 'Creator app', sub: 'Watches progress', kind: 'client', x: 100, y: 90, latency: 1, role: 'Submits processing and shows progress per rendition.', owns: ['Nothing'] },
        { id: 'orchestrator', label: 'Job orchestrator', sub: 'Splits, tracks, leases', kind: 'service', x: 320, y: 90, latency: 4, role: 'Splits a job into tasks, tracks completion, re-queues tasks whose lease expired, and triggers publishing.', ops: [{ name: 'submit', desc: 'Create a job.' }, { name: 'taskDone', desc: 'Record a finished task.' }], owns: ['Lease monitor'] },
        { id: 'jobdb', label: 'Job state', sub: 'Tasks and leases', kind: 'db', x: 540, y: 90, latency: 6, role: 'Every task’s status, attempts, and lease expiry.', ops: [{ name: 'update', desc: 'Change task status.' }], owns: ['jobs', 'tasks'] },
        { id: 'taskq', label: 'Task queue', sub: 'Pending work', kind: 'queue', x: 540, y: 300, latency: 3, queue: 'tasks', role: 'Tasks waiting for a worker.', ops: [{ name: 'publish', desc: 'Enqueue a task.' }], owns: ['task log'] },
        { id: 'workers', label: 'Transcode workers', sub: 'Autoscaling pool', kind: 'worker', x: 760, y: 300, latency: 3, role: 'Each worker transcodes one segment at a time; 1080p takes longest.', ops: [{ name: 'run', desc: 'Transcode one segment.' }], owns: ['Leased tasks'] },
        { id: 'store', label: 'Object storage', sub: 'Renditions', kind: 'store', x: 980, y: 300, latency: 12, role: 'Holds every transcoded segment.', ops: [{ name: 'put', desc: 'Store a segment.' }], owns: ['segments'] },
        { id: 'dlq', label: 'Dead-letter queue', sub: 'Failed tasks', kind: 'queue', x: 760, y: 480, latency: 3, queue: 'dead', role: 'Tasks that failed too many times, parked for a human to inspect.', ops: [{ name: 'publish', desc: 'Park a task.' }], owns: ['dead tasks'] },
        { id: 'publisher', label: 'Publisher', sub: 'Manifest, go live', kind: 'service', x: 980, y: 90, latency: 5, role: 'Writes the playback manifest and makes the video watchable.', ops: [{ name: 'publish', desc: 'Publish available renditions.' }], owns: ['Manifests'] },
      ],
      edges: [
        { from: 'creator', to: 'orchestrator', latency: 30 },
        { from: 'orchestrator', to: 'jobdb', latency: 4 },
        { from: 'orchestrator', to: 'taskq', latency: 4 },
        { from: 'taskq', to: 'workers', latency: 3 },
        { from: 'workers', to: 'store', latency: 5 },
        { from: 'workers', to: 'orchestrator', latency: 5, label: 'done' },
        { from: 'workers', to: 'dlq', latency: 3 },
        { from: 'orchestrator', to: 'publisher', latency: 5, via: [[320, 22], [980, 22]] },
      ],
      queues: [{ id: 'tasks', broker: 'taskq', label: 'tasks', groups: ['pool'] }, { id: 'dead', broker: 'dlq', label: 'dead letters', groups: [] }],
    },
    modeLabels: { poison: 'Poison segment', crashed: 'Worker crashed' },
    failures: [
      { id: 'crash', node: 'workers', mode: 'crashed', label: 'Workers crash mid-task', desc: 'Every task in progress is lost with its worker.' },
      { id: 'poison', node: 'workers', mode: 'poison', label: 'Poison segment', desc: '1080p segment 3 has a corrupt frame that crashes the encoder every time.' },
      { id: 'store-slow', node: 'store', mode: 'slow', params: { factor: 20 }, label: 'Object storage slow', desc: 'Every segment write takes 20 times longer.' },
      { id: 'q-down', node: 'taskq', mode: 'down', label: 'Task queue unavailable', desc: 'New jobs cannot be queued.' },
    ],
    switches: Y.switches([
      ['leases', 'Task leases with expiry', 'A task leased by a dead worker is re-queued after 1.5 s. Off: it is stuck forever.'],
      ['dlq', 'Dead-letter after 3 attempts', 'Off: a poison task is retried forever, occupying a worker.'],
      ['autoscale', 'Autoscale workers on backlog', 'Grow from 2 to 8 workers when more than 10 tasks wait.'],
      ['progressive', 'Publish progressively', 'Make the video watchable as soon as 240p and 480p are ready. Off: wait for every rendition.'],
    ]),
    presets: Y.presets({ leases: true, dlq: true, autoscale: true, progressive: true }, [
      { id: 'job', label: 'Process one upload', desc: '17 tasks across the pool; low renditions finish first and the video goes live early.', run: (s) => startJob(s) },
      { id: 'crash', label: 'Worker crash, with leases', desc: 'Workers die 1.2 s in. Their leases expire and the tasks are retried; the job completes.', run: (s) => { startJob(s); s.schedule(1200, () => s.inject('workers', 'crashed', true, 400)); } },
      { id: 'crash-bad', label: 'Worker crash, no leases', desc: 'The lost tasks are never retried. The job is stuck at a few tasks short, forever.', sw: { leases: false }, run: (s) => { startJob(s); s.schedule(1200, () => s.inject('workers', 'crashed', true, 400)); } },
      { id: 'poison', label: 'Poison segment, dead-lettered', desc: 'The bad segment fails three times and is parked. The video publishes without 1080p.', run: (s) => { s.inject('workers', 'poison'); startJob(s); } },
      { id: 'poison-bad', label: 'Poison segment, retried forever', desc: 'The task keeps crashing a worker. 1080p never finishes and capacity is wasted.', sw: { dlq: false }, run: (s) => { s.inject('workers', 'poison'); startJob(s); } },
      { id: 'burst', label: 'Five uploads at once, autoscaling', desc: '85 tasks hit the queue; the pool grows to 8 workers and drains it.', run: (s) => { for (let i = 0; i < 5; i++) startJob(s, `Creator ${i + 1}: process upload`); } },
      { id: 'burst-fixed', label: 'Five uploads, fixed pool', desc: 'Two workers grind through 85 tasks; the last creator waits several times longer.', sw: { autoscale: false }, run: (s) => { for (let i = 0; i < 5; i++) startJob(s, `Creator ${i + 1}: process upload`); } },
      { id: 'all-or-nothing', label: 'Publish only when complete', desc: 'Progressive publishing off: viewers wait for 1080p even though 240p was ready long ago.', sw: { progressive: false }, run: (s) => startJob(s) },
    ]),
    initialState: () => ({ config: { leases: true, dlq: true, autoscale: true, progressive: true }, jobs: {}, leases: {}, workers: 2, busy: 0, stats: { retries: 0, lost: 0, dead: 0, poisonRuns: 0 }, seq: { job: 0 } }),
    initialUI: () => ({}),
    actions: { process(sim) { startJob(sim); }, set: Y.setAction },
    handlers: {
      orchestrator: {
        submit: function* (ctx, p) {
          const st = ctx.state;
          const tasks = { thumb: { id: 'thumb', rendition: 'thumb', seg: 0, status: 'queued', attempts: 0 } };
          for (const [r] of RENDITIONS) for (let i = 1; i <= SEGMENTS; i++) tasks[`${r}-${i}`] = { id: `${r}-${i}`, rendition: r, seg: i, status: 'queued', attempts: 0 };
          st.jobs[p.job] = { id: p.job, tasks, start: ctx.now(), published: null, done: null, actionId: ctx.actionId };
          ctx.must(yield ctx.call('jobdb', 'update', { job: p.job }, { timeout: 500 }));
          for (const t of Object.values(tasks)) ctx.sim.enqueue('tasks', { type: 'task', payload: { job: p.job, task: t.id }, actionId: ctx.actionId, quiet: true });
          ctx.ledger('committed', 'yes', 'Job and its tasks recorded and queued.');
          return { tasks: Object.keys(tasks).length };
        },
        taskDone: function* (ctx, p) {
          const st = ctx.state;
          const job = st.jobs[p.job];
          const t = job.tasks[p.task];
          if (t) {
            if (t.status === 'done') return { duplicate: true };
            t.status = 'done';
            delete st.leases[`${p.job}/${p.task}`];
          }
          yield ctx.call('jobdb', 'update', { job: p.job }, { timeout: 500, quiet: true });
          const ready = (r) => Object.values(job.tasks).filter((x) => x.rendition === r).every((x) => x.status === 'done');
          const settled = Object.values(job.tasks).every((x) => x.status === 'done' || x.status === 'dead');
          const canPublish = st.config.progressive ? ready('240p') && ready('480p') && ready('thumb') : settled;
          if (canPublish && !job.published) {
            job.published = ctx.now();
            yield ctx.call('publisher', 'publish', { job: p.job }, { timeout: 600 });
            ctx.log({ op: `${p.job} is watchable`, status: 'ok', actionId: job.actionId, detail: `Published after ${((job.published - job.start) / 1000).toFixed(1)} s with ${RENDITIONS.filter(([r]) => ready(r)).map(([r]) => r).join(', ')}.` });
          }
          if (settled && !job.done) {
            job.done = ctx.now();
            const dead = Object.values(job.tasks).filter((x) => x.status === 'dead').length;
            ctx.sim.setLedger(job.actionId, 'async', dead ? 'no' : 'yes', dead ? `Finished with ${dead} task(s) dead-lettered.` : 'Every rendition is ready.');
            ctx.explain(dead ? 'The job finished without the poisoned segment: that rendition is unavailable while a person inspects the dead-letter queue. Everything else published.' : `Every task finished in ${((job.done - job.start) / 1000).toFixed(1)} s. The video was watchable ${st.config.progressive ? 'earlier, as soon as the low renditions were ready' : 'only now, once every rendition finished'}.`);
          }
          return { ok: true };
        },
      },
      jobdb: { update() { return { ok: true }; } },
      store: { put() { return { stored: true }; } },
      publisher: { publish() { return { published: true }; } },
      dlq: { publish(ctx, p) { ctx.sim.enqueue('dead', { type: 'dead', payload: p }); return { parked: true }; } },
    },
    setup(sim) {
      // Worker pool: lease up to the number of free workers, run each task concurrently.
      sim.spawn(function* (ctx) {
        for (;;) {
          const st = ctx.state;
          const crashed = !!ctx.sim.nodes.workers.modes.crashed;
          const backlog = ctx.sim.queueStats('tasks').depth;
          if (st.config.autoscale) {
            const want = backlog > 10 ? 8 : 2;
            if (want !== st.workers) { ctx.log({ op: `pool scaled to ${want} workers`, status: 'note', detail: `${backlog} tasks waiting.` }); st.workers = want; }
          } else st.workers = 2;
          const free = st.workers - st.busy;
          if (crashed || free <= 0) { yield ctx.wait(100); continue; }
          const { msgs } = yield ctx.take('tasks', 'pool', free);
          ctx.ack('tasks', 'pool');
          for (const m of msgs) {
            const { job, task } = m.payload;
            const t = st.jobs[job].tasks[task];
            if (t.status === 'done' || t.status === 'dead') continue;
            t.status = 'running';
            t.attempts++;
            st.busy++;
            const leaseKey = `${job}/${task}`;
            st.leases[leaseKey] = { expires: ctx.now() + LEASE_MS, attempt: t.attempts };
            const ms = t.rendition === 'thumb' ? 200 : RENDITIONS.find(([r]) => r === t.rendition)[1];
            ctx.spawn(function* (c) {
              const epoch = st.crashEpoch || 0;
              yield c.wait(ms);
              const died = (st.crashEpoch || 0) !== epoch || c.sim.nodes.workers.modes.crashed;
              if (died) { st.stats.lost++; c.log({ op: `task ${task} lost`, status: 'err', detail: 'Its worker crashed. Only the lease can bring it back.' }); return; }
              st.busy--;
              if (c.sim.nodes.workers.modes.poison && task === '1080p-3') {
                st.stats.poisonRuns++;
                delete st.leases[leaseKey];
                if (st.config.dlq && t.attempts >= 3) {
                  t.status = 'dead';
                  st.stats.dead++;
                  yield c.call('dlq', 'publish', { job, task }, { timeout: 400 });
                  c.log({ op: `task ${task} dead-lettered`, status: 'err', detail: 'Failed 3 times with the same encoder crash. Parked so it stops consuming workers.' });
                  yield c.call('orchestrator', 'taskDone', { job, task: '__check__' }, { timeout: 600, quiet: 'all' });
                } else {
                  t.status = 'queued';
                  st.stats.retries++;
                  c.log({ op: `task ${task} failed (attempt ${t.attempts})`, status: 'retry', detail: 'The encoder crashed on a corrupt frame. Re-queued.' });
                  c.sim.enqueue('tasks', { type: 'task', payload: { job, task }, quiet: true });
                }
                return;
              }
              const s = yield c.call('store', 'put', { job, task }, { timeout: 2000, quiet: true });
              if (!s.ok) { t.status = 'queued'; c.sim.enqueue('tasks', { type: 'task', payload: { job, task }, quiet: true }); return; }
              yield c.call('orchestrator', 'taskDone', { job, task }, { timeout: 800, quiet: true });
            }, { self: 'workers' });
          }
          if (!msgs.length) yield ctx.wait(50);
        }
      }, { self: 'workers' });
      // Lease monitor: re-queue tasks whose worker vanished.
      sim.spawn(function* (ctx) {
        for (;;) {
          yield ctx.wait(300);
          const st = ctx.state;
          if (!st.config.leases) continue;
          for (const [key, l] of Object.entries(st.leases)) {
            if (ctx.now() < l.expires) continue;
            const [job, task] = key.split('/');
            const t = st.jobs[job].tasks[task];
            delete st.leases[key];
            if (t.status !== 'running') continue;
            t.status = 'queued';
            st.stats.retries++;
            ctx.sim.enqueue('tasks', { type: 'task', payload: { job, task }, quiet: true });
            ctx.log({ op: `lease on ${task} expired`, status: 'retry', detail: 'No result before the lease ran out, so the task is offered to another worker.' });
          }
        }
      }, { self: 'orchestrator', quiet: 'all' });
    },
    onFailureChange(sim, e) {
      if (e.node === 'workers' && e.mode === 'crashed' && e.active) { sim.state.crashEpoch = (sim.state.crashEpoch || 0) + 1; sim.state.busy = 0; }
    },
    consistency(sim) {
      const st = sim.state;
      for (const j of Object.values(st.jobs)) {
        const open = Object.values(j.tasks).filter((t) => t.status !== 'done' && t.status !== 'dead');
        const stuck = open.filter((t) => { const l = st.leases[`${j.id}/${t.id}`]; return t.status === 'running' && l && sim.now > l.expires + 500; });
        if (!st.config.leases && st.stats.lost && stuck.length) return { key: 'wrong', label: `${j.id} is stuck: ${stuck.length} task(s) were lost with a crashed worker and nothing will retry them.` };
        if (!st.config.dlq && st.stats.poisonRuns > 3) return { key: 'wrong', label: `A poison task has crashed workers ${st.stats.poisonRuns} times and will keep doing so; 1080p never finishes.` };
      }
      const running = Object.values(st.jobs).filter((j) => !j.done);
      if (running.length) return { key: 'stale', label: `${running.length} job${running.length > 1 ? 's' : ''} still processing.` };
      if (st.stats.dead) return { key: 'stale', label: `${st.stats.dead} task(s) in the dead-letter queue need a human; that rendition is unavailable.` };
      return { key: 'ok', label: 'Every job finished and every rendition is stored.' };
    },
    metrics(snap, sim) {
      const st = sim.state;
      const done = Object.values(st.jobs).filter((j) => j.done);
      const avg = done.length ? done.reduce((a, j) => a + (j.done - j.start), 0) / done.length : null;
      return [
        { label: 'Workers', value: `${st.busy} busy of ${st.workers}` },
        { label: 'Tasks waiting', value: sim.queueStats('tasks').depth, tone: sim.queueStats('tasks').depth > 20 ? 'warn' : '' },
        { label: 'Retries', value: st.stats.retries },
        { label: 'Dead-lettered', value: st.stats.dead, tone: st.stats.dead ? 'warn' : '' },
        { label: 'Average job time', value: avg == null ? 'n/a' : `${(avg / 1000).toFixed(1)} s` },
      ];
    },
    product: {
      mount(el, sim) { Y.mount(el, sim, [['creator', 'Creator phone']], { note: 'Each row is a rendition, each square a segment: blue running, green done, red dead-lettered.' }); },
      render(el, sim) {
        const st = sim.state;
        const jobs = Object.values(st.jobs);
        const j = jobs[0];
        let body = Y.btn('process', 'Process my upload');
        if (j) {
          body += `<p class="app-sub">${jobs.length > 1 ? `Showing ${j.id} of ${jobs.length} jobs` : j.id}</p>`;
          for (const [r] of RENDITIONS.slice().reverse()) {
            body += `<div class="rend-row"><span>${r}</span><div class="chunk-grid rend">${[1, 2, 3, 4].map((i) => { const t = j.tasks[`${r}-${i}`]; return `<span class="chunk chunk-${{ queued: 'empty', running: 'sending', done: 'done', dead: 'failed' }[t.status]}">${i}</span>`; }).join('')}</div></div>`;
          }
          body += `<div class="app-card ${j.published ? 'is-ok' : 'is-work'}"><strong>${j.published ? 'Watchable now' : '<span class="spinner"></span>Processing'}</strong><span class="app-sub">${j.done ? `All done in ${((j.done - j.start) / 1000).toFixed(1)} s` : `${Object.values(j.tasks).filter((t) => t.status === 'done').length} of 17 tasks done`}</span></div>`;
        }
        Y.paint(el, sim, 'creator', { head: '<div><p class="app-title">YouTube Studio</p><p class="app-sub">Processing</p></div>', body }, {});
      },
    },
  });
  void sc;
})(typeof window !== 'undefined' ? window : globalThis);
