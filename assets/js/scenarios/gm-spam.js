/*
 * Spam, phishing, and sender authentication.
 * For every inbound message the MTA asks: who really sent this (SPF: is the
 * connecting IP allowed for the domain; DKIM: is the signature valid; DMARC:
 * does the visible From domain align with them, and what does that domain
 * ask receivers to do if not), what is the sending domain’s reputation, and
 * what does the classifier say about the content. Score = content + a
 * reputation adjustment − Maya’s personal “not spam” signal; 0.7 or more goes
 * to Spam. Reports from users feed a reputation updater. Each message also
 * carries what it really is (wanted, spam, phishing) so the lab can say when
 * the filter got it wrong.
 */
(function (root) {
  'use strict';
  const SDL = root.SDL;
  const Y = SDL.yt;

  const THRESHOLD = 0.7;
  const REPORTS_TO_BLOCK = 3;
  const REP_ADJ = { good: -0.1, unknown: 0.1, bad: 0.5 };
  // What each sender sends. auth: what SPF/DKIM will find; truth: what the message really is.
  const KINDS = {
    omar: { name: 'Omar', from: 'omar@example.org', domain: 'example.org', subject: 'Contract draft', content: 0.05, spf: 'pass', dkim: 'pass', truth: 'ham', retries: true },
    digest: { name: 'Finch News', from: 'digest@finch.news', domain: 'finch.news', subject: 'Weekly digest', content: 0.2, spf: 'pass', dkim: 'pass', truth: 'ham', retries: true },
    promo: { name: 'Finch News', from: 'deals@finch.news', domain: 'finch.news', subject: 'Black Friday: 40% off', content: 0.85, spf: 'pass', dkim: 'pass', truth: 'ham', retries: true },
    spammer: { name: 'Known spammer', from: 'win@spam.example', domain: 'spam.example', subject: 'You won a prize!', content: 0.9, spf: 'pass', dkim: 'none', truth: 'spam', retries: false },
    spoof: { name: '“Maya’s bank” (forged)', from: 'alerts@mybank.example', domain: 'mybank.example', subject: 'Your account is locked: verify now', content: 0.3, spf: 'fail', dkim: 'none', truth: 'phish', retries: false },
    wave: { name: 'deals-xyz.example', from: 'hello@deals-xyz.example', domain: 'deals-xyz.example', subject: 'Limited offer', content: 0.55, spf: 'pass', dkim: 'pass', truth: 'spam', retries: false },
    stolen: { name: 'Finch News (account stolen)', from: 'digest@finch.news', domain: 'finch.news', subject: 'Action required: confirm your payment', content: 0.95, spf: 'pass', dkim: 'pass', truth: 'phish', retries: true },
  };
  const DMARC = { 'example.org': 'none', 'finch.news': 'quarantine', 'spam.example': 'none', 'mybank.example': 'reject', 'deals-xyz.example': 'none' };

  function sendKind(sim, kind, opts) {
    opts = opts || {};
    const st = sim.state;
    const k = KINDS[kind];
    const n = ++st.seq.msg;
    const trace = `${kind}-${n}`;
    st.msgs[trace] = { trace, kind, truth: k.truth, subject: k.subject, name: k.name, t0: sim.now, deferred: 0, outcome: null, folder: null, wave: !!opts.wave };
    sim.startAction(`${k.name}: “${k.subject}”`, function* (ctx) {
      const m = ctx.state.msgs[trace];
      Y.L(ctx, { displayed: ['n/a', 'A mail server, no screen.'], retrySafe: [k.retries ? 'yes' : 'n/a', k.retries ? 'A legitimate server retries on 4xx.' : 'Spammers rarely retry.'] });
      for (let a = 1; a <= 6; a++) {
        const r = yield ctx.call('mta', 'smtp', { trace, kind }, { timeout: 2000, quiet: opts.wave ? true : undefined });
        if (r.ok) {
          m.outcome = 'accepted';
          Y.L(ctx, { accepted: ['yes', '250.'], committed: ['yes', `Filed in ${r.value.folder === 'spam' ? 'Spam' : 'the inbox'} (score ${r.value.score == null ? 'not scored' : r.value.score.toFixed(2)}).`], async: ['n/a', '—'] });
          if (!opts.wave) ctx.explain(r.value.why);
          return;
        }
        if (r.error.code === 'REJECTED') {
          m.outcome = 'rejected';
          Y.L(ctx, { accepted: ['no', r.error.message], committed: ['n/a', 'Refused during the SMTP conversation.'], async: ['n/a', '—'] });
          ctx.explain(`${r.error.message}. The visible From domain asked receivers to reject mail that fails its checks, and Gmail did, while the forger was still connected.`);
          return;
        }
        m.deferred++;
        if (!k.retries) { m.outcome = 'gave up'; Y.failed(ctx, `${r.error.message}; this sender does not retry.`); return; }
        log(ctx, `${k.name}: ${r.error.message}, retry in ${SDL.fmtMs(600 * a)}`);
        yield ctx.wait(600 * a);
      }
      m.outcome = 'gave up';
    }, { self: 'senders' });
  }
  function log(ctx, line) {
    const l = ctx.ui.log;
    l.push(`${(ctx.now() / 1000).toFixed(1)} s  ${line}`);
    if (l.length > 4) l.shift();
  }

  function wave(sim) {
    for (let i = 0; i < 20; i++) sim.spawn(function* (ctx) { yield ctx.wait(i * 200); sendKind(ctx.sim, 'wave', { wave: true }); }, { self: 'senders', quiet: 'all' });
  }

  function report(sim, id, kind) {
    const st = sim.state;
    const m = st.box[id];
    if (!m) return;
    sim.startAction(`Maya: ${kind === 'spam' ? 'report spam' : 'not spam'} on “${m.subject}”`, function* (ctx) {
      Y.L(ctx, { displayed: ['yes', kind === 'spam' ? 'Moved to Spam.' : 'Moved to the inbox.'], retrySafe: ['yes', 'Moving twice is harmless.'] });
      const r = yield ctx.call('store', 'report', { id, kind }, { timeout: 1500 });
      if (r.ok) Y.L(ctx, { accepted: ['yes', 'Moved.'], committed: ['yes', ctx.state.config.personal && kind === 'ham' ? `${m.domain} is now trusted for Maya.` : 'Folder changed.'], async: ['pending', 'The report feeds the reputation updater.'] });
    }, { self: 'maya' });
  }

  const later = (sim, ms, fn) => sim.spawn(function* (ctx) { yield ctx.wait(ms); fn(ctx.sim); }, { self: 'senders', quiet: 'all' });
  const newestIn = (st, folder, pred) => Object.values(st.box).filter((m) => m.folder === folder && (!pred || pred(m))).map((m) => m.id).pop();

  SDL.scenarios['gm-spam'] = {
    id: 'gm-spam',
    seed: 2903,
    minHopMs: 5,
    productWidth: 640,
    intro: 'Send from the console: Omar, Finch News, a known spammer, a forged “bank”, a wave from a brand-new domain. Watch SPF, DKIM, DMARC, reputation, and the classifier decide. Then take the classifier down, mark a newsletter as not spam, or steal Finch’s account.',
    topology: {
      width: 1160, height: 560,
      nodes: [
        { id: 'senders', label: 'Outside senders', sub: 'The internet', kind: 'client', x: 90, y: 280, latency: 2, role: 'Omar, Finch News, spammers, and a forger. Legitimate servers retry on 4xx; the others do not.', owns: ['Their messages'] },
        { id: 'mta', label: 'Inbound MTA', sub: 'Decides per message', kind: 'gateway', x: 300, y: 280, latency: 3, role: 'Runs the checks in order: authentication, DMARC policy, reputation, classifier. Rejects, files in Spam, or delivers.', ops: [{ name: 'smtp', desc: 'One message.' }], owns: ['Nothing durable'] },
        { id: 'auth', label: 'Authentication', sub: 'SPF, DKIM, DMARC', kind: 'service', x: 520, y: 110, latency: 2, role: 'SPF: may this IP send for the domain? DKIM: is the signature valid? DMARC: does the From domain align with a pass, and what does the domain ask receivers to do if not?', ops: [{ name: 'check', desc: 'Authenticate a message.' }], owns: ['Nothing durable'] },
        { id: 'dns', label: 'DNS', sub: 'SPF, DKIM keys, DMARC', kind: 'store', x: 760, y: 60, latency: 3, role: 'The sending domain’s published records. A timeout is a temporary error, not a failure.', ops: [{ name: 'txt', desc: 'Look up a record.' }], owns: ['Other domains’ records'] },
        { id: 'rep', label: 'Reputation', sub: 'Per domain', kind: 'cache', x: 520, y: 280, latency: 1, role: 'good, unknown, or bad for each sending domain, updated from user reports.', ops: [{ name: 'get', desc: 'Reputation of a domain.' }, { name: 'set', desc: 'Update it.' }], owns: ['reputation[domain]'] },
        { id: 'clf', label: 'Classifier', sub: 'Content model', kind: 'service', x: 520, y: 450, latency: 4, role: 'Scores the content from 0 (wanted) to 1 (spam).', ops: [{ name: 'score', desc: 'Score a message.' }], owns: ['Model'] },
        { id: 'store', label: 'Mailbox store', sub: 'Inbox and Spam', kind: 'db', x: 760, y: 280, latency: 4, role: 'Files each message in a folder. A report moves it and goes to the feedback queue.', ops: [{ name: 'deliver', desc: 'File a message.' }, { name: 'report', desc: 'Report spam / not spam.' }], owns: ['Maya’s folders', 'Maya’s trusted senders'] },
        { id: 'fb', label: 'Feedback', sub: 'User reports', kind: 'queue', x: 760, y: 450, latency: 2, role: 'Reports from Maya and from every other recipient.', owns: ['reports'] },
        { id: 'updater', label: 'Reputation updater', sub: 'Counts reports', kind: 'worker', x: 980, y: 450, latency: 2, role: `${REPORTS_TO_BLOCK} spam reports about a domain turn its reputation bad.`, owns: ['Report counts'] },
        { id: 'maya', label: 'Maya’s phone', sub: 'Inbox and Spam', kind: 'client', x: 980, y: 200, latency: 1, role: 'Shows the inbox and the Spam folder; can report spam or mark not spam.', owns: ['Nothing'] },
      ],
      edges: [
        { from: 'senders', to: 'mta', latency: 30, label: 'SMTP' },
        { from: 'mta', to: 'auth', latency: 2, via: [[400, 280], [400, 110]] },
        { from: 'auth', to: 'dns', latency: 15, via: [[640, 110], [640, 60]] },
        { from: 'mta', to: 'rep', latency: 1 },
        { from: 'mta', to: 'clf', latency: 2, via: [[400, 280], [400, 450]] },
        { from: 'mta', to: 'store', latency: 2, via: [[400, 360], [680, 360], [680, 280]] },
        { from: 'store', to: 'maya', latency: 20, via: [[880, 280], [880, 200]] },
        { from: 'maya', to: 'store', latency: 30 },
        { from: 'store', to: 'fb', latency: 2 },
        { from: 'fb', to: 'updater', latency: 2 },
        { from: 'updater', to: 'rep', latency: 2, via: [[980, 560], [645, 560], [645, 300]] },
      ],
      queues: [{ id: 'fb', broker: 'fb', label: 'reports', groups: ['updater'] }],
    },
    modeLabels: { stale: 'Ignores updates', wave: 'New-domain wave', compromised: 'Account stolen' },
    failures: [
      { id: 'dns-timeout', node: 'dns', mode: 'hang', label: 'DNS timeout', desc: 'SPF and DKIM cannot be checked: a temporary error, so Gmail answers 451.' },
      { id: 'clf-down', node: 'clf', mode: 'down', label: 'Classifier down', desc: 'No content score. Fail closed answers 451; fail open delivers unfiltered.' },
      { id: 'clf-slow', node: 'clf', mode: 'slow', params: { factor: 100 }, label: 'Classifier slow', desc: 'Every message waits for its score.' },
      { id: 'rep-stale', node: 'rep', mode: 'stale', label: 'Reputation stale', desc: 'Updates from reports are not applied; a bad domain keeps its old standing.' },
      { id: 'wave', node: 'senders', mode: 'wave', label: 'New-domain wave', desc: '20 messages from a domain registered yesterday, with no reputation yet.' },
      { id: 'compromised', node: 'senders', mode: 'compromised', label: 'Trusted sender compromised', desc: 'Finch News’s own servers send phishing: SPF, DKIM, and DMARC all pass.' },
      { id: 'fb-lag', node: 'updater', mode: 'paused', label: 'Feedback lag', desc: 'Reports pile up; reputation does not change.' },
      { id: 'store-slow', node: 'store', mode: 'slow', params: { factor: 40 }, label: 'Mailbox store slow', desc: 'Filing and moving take longer.' },
    ],
    switches: Y.switches([
      ['dmarc', 'Enforce DMARC p=reject', 'When the From domain fails DMARC and publishes p=reject, refuse the message. Off: ignore DMARC and let the classifier decide.'],
      ['failClosed', 'Fail closed when the classifier is down', 'Answer 451 so senders retry later. Off: deliver unfiltered.'],
      ['personal', 'Personal “not spam”', 'Marking a sender not spam trusts its domain for Maya. Off: the mark moves one message and changes nothing else.'],
      ['fastPath', 'Reputation-only fast path', 'Skip the classifier for domains with a good reputation that pass DMARC. Saves compute; trusts reputation completely.'],
    ]),
    presets: Y.presets({ dmarc: true, failClosed: true, personal: true, fastPath: false }, [
      { id: 'normal', label: 'Omar, Finch, and a spammer', desc: 'Omar and the Finch digest pass authentication, score low, and land in the inbox. The known spammer’s domain has a bad reputation and its content scores high: Spam folder.', run: (s) => { sendKind(s, 'omar'); later(s, 200, (x) => sendKind(x, 'digest')); later(s, 400, (x) => sendKind(x, 'spammer')); } },
      { id: 'spoof-no-dmarc', label: 'Forged bank mail, DMARC ignored', desc: 'The From address says mybank.example but the IP is not allowed by its SPF and there is no DKIM signature. Ignoring DMARC, the classifier sees a carefully written message from a domain with a good reputation: it lands in the inbox.', sw: { dmarc: false }, run: (s) => { sendKind(s, 'spoof'); } },
      { id: 'spoof-dmarc', label: 'Forged bank mail, DMARC enforced', desc: 'Same forgery. mybank.example publishes p=reject; the message fails DMARC, so Gmail answers 550 during the conversation. It never reaches anyone.', run: (s) => { sendKind(s, 'spoof'); } },
      { id: 'classifier-down-open', label: 'Classifier down, fail open', desc: 'The spammer’s message cannot be scored, so it is delivered unfiltered: spam in the inbox, for every user, for as long as the outage lasts.', sw: { failClosed: false }, run: (s) => { s.inject('clf', 'down'); sendKind(s, 'spammer'); later(s, 200, (x) => sendKind(x, 'omar')); } },
      { id: 'classifier-down-451', label: 'Classifier down, fail closed', desc: 'Same outage. Gmail answers 451: Omar’s server keeps the message and retries, and it is scored and delivered once the classifier is back. The spammer does not retry.', run: (s) => { s.inject('clf', 'down', true, 2000); sendKind(s, 'spammer'); later(s, 200, (x) => sendKind(x, 'omar')); } },
      { id: 'dns-timeout', label: 'DNS timeout during authentication', desc: 'SPF and DKIM lookups for example.org time out. That is a temporary error, not a failure, so Gmail answers 451 rather than treating Omar as a forger; his server retries and gets through.', run: (s) => { s.inject('dns', 'hang', true, 2000); sendKind(s, 'omar'); } },
      { id: 'new-domain-wave', label: 'Wave from a brand-new domain', desc: 'deals-xyz.example has no reputation and its content scores just under the line, so the first messages reach inboxes. Maya and other recipients report them; after three reports its reputation turns bad and the rest go to Spam.', run: (s) => { s.inject('senders', 'wave'); later(s, 1000, (x) => { const id = newestIn(x.state, 'inbox', (m) => m.kind === 'wave'); if (id) report(x, id, 'spam'); }); } },
      { id: 'finch-not-spam', label: 'Finch promo in Spam, marked not spam', desc: 'Finch’s Black Friday email scores high and goes to Spam, though Maya wants it. She marks it not spam; with the personal signal, Finch’s next promo lands in her inbox.', run: (s) => { sendKind(s, 'promo'); later(s, 1000, (x) => { const id = newestIn(x.state, 'spam', (m) => m.kind === 'promo'); if (id) report(x, id, 'ham'); }); later(s, 2000, (x) => sendKind(x, 'promo')); } },
      { id: 'compromised-fast-path', label: 'Finch account stolen, reputation fast path', desc: 'The phishing comes from Finch’s real servers: SPF, DKIM, and DMARC pass and its reputation is good. The fast path skips the classifier and delivers it to the inbox.', sw: { fastPath: true }, run: (s) => { s.inject('senders', 'compromised'); } },
      { id: 'compromised-full', label: 'Finch account stolen, classifier always runs', desc: 'Same phishing. Reputation lowers the score a little, but the content scores 0.95: it goes to Spam. Authentication says who sent it, not whether it is safe.', run: (s) => { s.inject('senders', 'compromised'); } },
    ]),
    initialState: () => ({
      config: { dmarc: true, failClosed: true, personal: true, fastPath: false },
      msgs: {}, box: {}, rep: { 'example.org': 'good', 'finch.news': 'good', 'spam.example': 'bad', 'mybank.example': 'good', 'deals-xyz.example': 'unknown' },
      allow: {}, reports: {}, otherReports: 0,
      stats: { rejected: 0, tempfails: 0, unfiltered: 0, scored: 0 },
      seq: { msg: 0, box: 0 },
    }),
    initialUI: () => ({ log: [] }),
    actions: {
      send(sim, a) { sendKind(sim, a.kind || 'omar'); },
      wave(sim) { sim.inject('senders', 'wave'); },
      stolen(sim) { sim.inject('senders', 'compromised'); },
      report(sim, a) { report(sim, a.id, a.kind); },
      set: Y.setAction,
    },
    handlers: {
      mta: {
        smtp: function* (ctx, p) {
          const st = ctx.state;
          const k = KINDS[p.kind];
          const q = st.msgs[p.trace].wave ? true : undefined;
          const a = yield ctx.call('auth', 'check', { domain: k.domain, spf: k.spf, dkim: k.dkim }, { timeout: 800, quiet: q });
          if (!a.ok || a.value.temperror) { st.stats.tempfails++; ctx.fail('TEMPFAIL', '451 4.7.0 Temporary authentication failure'); }
          const au = a.value;
          if (st.config.dmarc && au.dmarc === 'fail' && au.policy === 'reject') { st.stats.rejected++; ctx.fail('REJECTED', `550 5.7.26 ${k.domain} DMARC policy: reject`); }
          const r = yield ctx.call('rep', 'get', { domain: k.domain }, { timeout: 300, quiet: true });
          const rep = r.ok ? r.value.rep : 'unknown';
          let score = null;
          let why;
          if (st.config.fastPath && rep === 'good' && au.dmarc === 'pass') {
            why = `${k.domain} passes DMARC and has a good reputation, so the fast path skipped the classifier and delivered it.`;
          } else {
            const c = yield ctx.call('clf', 'score', { content: k.content }, { timeout: 1000, quiet: q });
            if (!c.ok) {
              if (st.config.failClosed) { st.stats.tempfails++; ctx.fail('TEMPFAIL', '451 4.3.0 Try again later'); }
              st.stats.unfiltered++;
              why = 'The classifier is down and Gmail fails open: delivered without a content score.';
            } else {
              const personal = st.config.personal && st.allow[k.domain] ? -0.5 : 0;
              score = Math.round((c.value.score + REP_ADJ[rep] + personal) * 100) / 100;
              st.stats.scored++;
              why = `Content ${c.value.score.toFixed(2)}, reputation ${rep} (${REP_ADJ[rep] > 0 ? '+' : ''}${REP_ADJ[rep]})${personal ? ', Maya trusts this sender (−0.5)' : ''}: ${score.toFixed(2)}, ${score >= THRESHOLD ? `at or over ${THRESHOLD}, so Spam` : `under ${THRESHOLD}, so the inbox`}. Authentication: SPF ${au.spf}, DKIM ${au.dkim}, DMARC ${au.dmarc}.`;
            }
          }
          const folder = score != null && score >= THRESHOLD ? 'spam' : 'inbox';
          ctx.must(yield ctx.call('store', 'deliver', { trace: p.trace, kind: p.kind, folder, score, unfiltered: score == null && !st.config.fastPath }, { timeout: 1000, quiet: q }));
          return { folder, score, why };
        },
      },
      auth: {
        check: function* (ctx, p) {
          const r = yield ctx.call('dns', 'txt', { domain: p.domain }, { timeout: 500, quiet: true });
          if (!r.ok) return { temperror: true };
          const aligned = p.spf === 'pass' || p.dkim === 'pass';
          return { spf: p.spf, dkim: p.dkim, dmarc: aligned ? 'pass' : 'fail', policy: r.value.dmarc };
        },
      },
      dns: { txt(ctx, p) { return { dmarc: DMARC[p.domain] || 'none' }; } },
      rep: {
        get(ctx, p) { return { rep: ctx.state.rep[p.domain] || 'unknown' }; },
        set(ctx, p) {
          if (ctx.mode('stale')) { ctx.log({ op: `reputation update for ${p.domain} ignored`, status: 'warn', detail: 'The reputation cache is not taking updates; the domain keeps its old standing.' }); return { applied: false }; }
          ctx.state.rep[p.domain] = p.rep;
          return { applied: true };
        },
      },
      clf: { score(ctx, p) { return { score: p.content }; } },
      store: {
        deliver(ctx, p) {
          const st = ctx.state;
          const k = KINDS[p.kind];
          const id = `b${++st.seq.box}`;
          const m = st.msgs[p.trace];
          st.box[id] = { id, trace: p.trace, kind: p.kind, from: k.from, name: k.name, domain: k.domain, subject: k.subject, folder: p.folder, score: p.score, truth: k.truth, unfiltered: p.unfiltered, t: ctx.now() };
          m.folder = p.folder; m.box = id; m.tDone = ctx.now();
          // Other recipients of the same wave: one in two who see it in their inbox reports it.
          if (m.wave && p.folder === 'inbox' && ++st.otherReports % 2 === 0) ctx.sim.enqueue('fb', { type: 'report', eventId: `o${st.otherReports}`, payload: { domain: k.domain, kind: 'spam', who: 'other users' } });
          return { id };
        },
        report(ctx, p) {
          const st = ctx.state;
          const m = st.box[p.id];
          if (!m) ctx.fail('NOT_FOUND', 'No such message.');
          m.folder = p.kind === 'spam' ? 'spam' : 'inbox';
          m.userMoved = true;
          if (p.kind === 'ham' && st.config.personal) st.allow[m.domain] = true;
          ctx.sim.enqueue('fb', { type: 'report', eventId: `r-${p.id}`, payload: { domain: m.domain, kind: p.kind, who: 'Maya' }, actionId: ctx.actionId });
          return { folder: m.folder };
        },
      },
    },
    setup(sim) {
      Y.consumer(sim, 'fb', 'updater', 'updater', function* (ctx, msg) {
        const st = ctx.state;
        const p = msg.payload;
        if (p.kind !== 'spam') return true;
        st.reports[p.domain] = (st.reports[p.domain] || 0) + 1;
        if (st.reports[p.domain] === REPORTS_TO_BLOCK && st.rep[p.domain] !== 'bad') {
          yield ctx.call('rep', 'set', { domain: p.domain, rep: 'bad' }, { timeout: 300 });
          ctx.log({ op: `${p.domain}: reputation now bad`, status: 'recovered', detail: `${REPORTS_TO_BLOCK} spam reports. New mail from ${p.domain} gets +${REP_ADJ.bad} on its score.` });
        }
        return true;
      });
    },
    onFailureChange(sim, ch) {
      if (!ch.active || ch.node !== 'senders') return;
      if (ch.mode === 'wave') wave(sim);
      if (ch.mode === 'compromised') sendKind(sim, 'stolen');
    },
    consistency(sim) {
      const st = sim.state;
      const inbox = Object.values(st.box).filter((m) => m.folder === 'inbox' && !m.userMoved);
      const phish = inbox.find((m) => m.truth === 'phish');
      if (phish) return { key: 'wrong', label: phish.kind === 'spoof' ? `A forged “${phish.subject}” from ${phish.from} is in Maya’s inbox. It failed SPF and had no DKIM signature; the bank’s DMARC record says reject such mail, and Gmail ignored it, so the bank’s good reputation helped the forger.` : `Phishing from Finch News’s stolen account is in Maya’s inbox. It passed SPF, DKIM, and DMARC because it really came from Finch, and the fast path trusted reputation without reading the content.` };
      const raw = inbox.find((m) => m.truth === 'spam' && m.unfiltered);
      if (raw) return { key: 'wrong', label: `“${raw.subject}” from ${raw.from} is in the inbox unscored: the classifier is down and Gmail fails open. Every user gets spam for as long as the outage lasts.` };
      const legit = Object.values(st.msgs).filter((m) => m.truth === 'ham');
      const waiting = legit.find((m) => !m.outcome || m.outcome === null);
      if (waiting && waiting.deferred) return { key: 'stale', label: `${waiting.name}’s server got 451 (${waiting.deferred}×) and still holds “${waiting.subject}”: Gmail would rather delay than guess.` };
      const missed = inbox.filter((m) => m.truth === 'spam');
      if (missed.length) { const blocked = st.rep['deals-xyz.example'] === 'bad'; return { key: 'stale', label: `${missed.length} message${missed.length > 1 ? 's' : ''} from ${missed[0].domain} reached the inbox before ${blocked ? `reports turned its reputation bad; the rest of the wave went to Spam` : 'enough recipients reported it'}. Filters are probabilistic; feedback closes the gap after the fact.` }; }
      const fp = Object.values(st.box).find((m) => m.folder === 'spam' && m.truth === 'ham' && !m.userMoved);
      if (fp) return { key: 'stale', label: `“${fp.subject}” from ${fp.name} is in Spam, though Maya wants it: a false positive.${st.config.personal ? '' : ' Without the personal signal, marking it not spam does not change the next one.'}` };
      const late = legit.find((m) => m.deferred && m.outcome === 'accepted');
      if (late) return { key: 'stale', label: `“${late.subject}” was delayed by ${late.deferred} temporary failure${late.deferred > 1 ? 's' : ''} (451) and delivered ${SDL.fmtMs(late.tDone - late.t0)} after the first attempt. Nothing was guessed; nothing was lost.` };
      if (!Object.keys(st.msgs).length) return { key: 'ok', label: 'Send something from the console to start.' };
      const notes = [];
      if (st.stats.rejected) notes.push('the forgery was refused with 550 because its From domain publishes DMARC p=reject');
      const spamFiled = Object.values(st.box).filter((m) => m.folder === 'spam' && m.truth !== 'ham').length;
      if (spamFiled) notes.push(`${spamFiled} unwanted message${spamFiled > 1 ? 's' : ''} filed in Spam`);
      if (Object.keys(st.allow).length) notes.push(`Maya trusts ${Object.keys(st.allow).join(', ')}`);
      return { key: 'ok', label: `Every wanted message is in the inbox and nothing harmful is${notes.length ? `; ${notes.join('; ')}` : ''}.` };
    },
    metrics(snap, sim) {
      const st = sim.state;
      const box = Object.values(st.box);
      const missed = box.filter((m) => m.folder === 'inbox' && m.truth !== 'ham' && !m.userMoved).length;
      const fp = box.filter((m) => m.folder === 'spam' && m.truth === 'ham' && !m.userMoved).length;
      return [
        { label: 'In the inbox', value: box.filter((m) => m.folder === 'inbox').length },
        { label: 'In Spam', value: box.filter((m) => m.folder === 'spam').length },
        { label: 'Unwanted in the inbox', value: missed, tone: missed ? 'fail' : '' },
        { label: 'Wanted in Spam', value: fp, tone: fp ? 'warn' : '' },
        { label: 'Rejected (550)', value: st.stats.rejected },
        { label: 'Deferred (451)', value: st.stats.tempfails, tone: st.stats.tempfails ? 'warn' : '' },
        { label: 'Delivered unscored', value: st.stats.unfiltered, tone: st.stats.unfiltered ? 'fail' : '' },
        { label: 'deals-xyz.example', value: `${st.rep['deals-xyz.example']} · ${st.reports['deals-xyz.example'] || 0} reports` },
      ];
    },
    product: {
      mount(el, sim) {
        Y.mount(el, sim, [['maya', 'Maya’s phone']], {
          note: 'Each button sends one message to Maya. The phone shows where it was filed; report spam or mark not spam to give feedback.',
          side: '<div data-ref="senders"></div>',
        });
      },
      render(el, sim) {
        const esc = SDL.ui.esc;
        const st = sim.state;
        const box = Object.values(st.box);
        // Identical messages (a wave) are grouped into one row with a count; the button acts on the newest.
        const groups = (folder) => {
          const g = {};
          for (const m of box.filter((x) => x.folder === folder)) { const k = `${m.kind}|${m.subject}`; (g[k] = g[k] || []).push(m); }
          return Object.values(g).map((ms) => ({ m: ms[ms.length - 1], n: ms.length })).reverse();
        };
        const row = (x, act) => `<div class="app-card ${x.m.folder === 'inbox' ? 'is-ok' : ''}"><strong>${esc(x.m.name)}${x.n > 1 ? ` ×${x.n}` : ''}</strong><span class="app-sub">${esc(x.m.subject)} · ${x.m.score != null ? x.m.score.toFixed(2) : 'not scored'}</span>${act}</div>`;
        const inbox = groups('inbox').slice(0, 4).map((x) => row(x, Y.btn('report', 'Report spam', { arg: { id: x.m.id, kind: 'spam' }, cls: 'secondary' }))).join('');
        const spam = groups('spam').slice(0, 3).map((x) => row(x, Y.btn('report', 'Not spam', { arg: { id: x.m.id, kind: 'ham' }, cls: 'secondary' }))).join('');
        Y.paint(el, sim, 'maya', {
          head: `<div><p class="app-title">Inbox · ${box.filter((m) => m.folder === 'inbox').length}</p><p class="app-sub">Spam · ${box.filter((m) => m.folder === 'spam').length}</p></div>`,
          inbox: inbox || '<p class="app-sub">Inbox empty.</p>',
          spam: `<p class="app-sub">Spam</p>${spam || '<p class="app-sub">Nothing in Spam.</p>'}`,
        }, {});
        const c = sim.scenario.consistency(sim);
        const b = (kind, label, cls) => Y.btn('send', label, { arg: { kind }, cls });
        SDL.ui.paintSections(el.querySelector('[data-ref="senders"]'), {
          title: '<p class="ops-title">Senders</p>',
          btns: `<div class="app-row">${b('omar', '✉ Omar')}${b('digest', 'Finch digest', 'secondary')}${b('promo', 'Finch promo', 'secondary')}</div>
            <div class="app-row">${b('spammer', 'Known spammer', 'secondary')}${b('spoof', 'Forged “bank”', 'secondary')}</div>
            <div class="app-row">${Y.btn('wave', 'New-domain wave', { cls: 'secondary', disabled: !!sim.nodes.senders.modes.wave })}${Y.btn('stolen', 'Steal Finch’s account', { cls: 'secondary', disabled: !!sim.nodes.senders.modes.compromised })}</div>`,
          rows: `<div class="ops-shards"><div class="ops-row"><div class="ops-name">Reputation<span>${Object.entries(st.rep).map(([d, r]) => `${d} ${r}`).join(' · ')}</span></div></div>
            <div class="ops-row"><div class="ops-name">SMTP log<span>${sim.ui.log.length ? sim.ui.log.map(esc).join('<br>') : 'no deferrals'}</span></div></div></div>`,
          recon: `<p class="recon" data-tone="${c.key}">${c.key === 'ok' ? '✓' : c.key === 'stale' ? '…' : '✕'} ${esc(c.label)}</p>`,
        }, {});
      },
    },
  };
})(typeof window !== 'undefined' ? window : globalThis);
