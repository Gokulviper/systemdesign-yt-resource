/* Page shell: header, topic navigation, the playback controller, and the
   functions each HTML page calls to mount itself. */
(function () {
  'use strict';
  const SDL = window.SDL;
  const ui = (SDL.ui = SDL.ui || {});

  const esc = (s) =>
    String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const root = () => document.body.dataset.root || '';
  const hrefOf = (page) => root() + page.path;
  const h = (html) => {
    const t = document.createElement('template');
    t.innerHTML = html.trim();
    return t.content.firstElementChild;
  };
  ui.esc = esc;
  ui.h = h;
  ui.hrefOf = hrefOf;
  ui.href = (id) => {
    const p = SDL.page(id);
    return p ? hrefOf(p) : '#';
  };
  ui.fmtMs = (ms) => (ms == null ? 'n/a' : `${Math.round(ms).toLocaleString('en-US')} ms`);

  /* ---------- theme ---------- */
  const THEMES = ['system', 'light', 'dark'];
  function applyTheme(t) {
    if (t === 'system') document.documentElement.removeAttribute('data-theme');
    else document.documentElement.setAttribute('data-theme', t);
  }
  function storedTheme() {
    try {
      return localStorage.getItem('sdl-theme') || 'system';
    } catch (e) {
      return 'system';
    }
  }
  applyTheme(storedTheme());

  /* ---------- header ---------- */
  function statusText(p) {
    return p.status === 'built' ? 'Ready' : p.stageLabel ? 'Planned' : `Stage ${p.stage}`;
  }
  function buildHeader(pageId) {
    const pages = SDL.PAGES;
    const idx = pages.findIndex((p) => p.id === pageId);
    const prev = idx > 0 ? pages[idx - 1] : null;
    const next = idx >= 0 && idx < pages.length - 1 ? pages[idx + 1] : null;
    const groups = SDL.GROUPS.map((g) => {
      const items = pages
        .filter((p) => p.group === g)
        .map(
          (p) => `<li><a href="${hrefOf(p)}"${p.id === pageId ? ' aria-current="page"' : ''}>
              <span>${esc(p.title)}</span><span class="badge ${p.status === 'built' ? 'badge-ready' : ''}">${statusText(p)}</span></a></li>`
        )
        .join('');
      return `<div class="menu-group"><h2>${esc(g)}</h2><ul>${items}</ul></div>`;
    }).join('');

    const el = h(`
      <header class="site-header">
        <a class="skip-link" href="#main">Skip to content</a>
        <a class="brand" href="${root()}index.html">
          <svg viewBox="0 0 32 32" width="26" height="26" aria-hidden="true">
            <rect x="2" y="5" width="10" height="8" rx="2" class="brand-node"/>
            <rect x="20" y="5" width="10" height="8" rx="2" class="brand-node"/>
            <rect x="11" y="20" width="10" height="8" rx="2" class="brand-node"/>
            <path d="M12 9h8M7 13l7 7M25 13l-7 7" class="brand-edge"/>
            <circle cx="16" cy="9" r="2.4" class="brand-packet"/>
          </svg>
          <span>System Design Lab</span>
        </a>
        <nav class="topic-nav" aria-label="Topics">
          <button class="btn btn-quiet nav-toggle" aria-expanded="false" aria-controls="topic-menu">All topics</button>
          <div id="topic-menu" class="topic-menu" hidden>${groups}</div>
        </nav>
        <div class="header-end">
          ${prev ? `<a class="pager-link" href="${hrefOf(prev)}" rel="prev"><span class="pager-dir">Previous</span> ${esc(prev.title)}</a>` : ''}
          ${next ? `<a class="pager-link" href="${hrefOf(next)}" rel="next"><span class="pager-dir">Next</span> ${esc(next.title)}</a>` : ''}
          <button class="btn btn-quiet theme-toggle" type="button"></button>
        </div>
      </header>`);

    const toggle = el.querySelector('.nav-toggle');
    const menu = el.querySelector('.topic-menu');
    const setOpen = (open) => {
      toggle.setAttribute('aria-expanded', String(open));
      menu.hidden = !open;
      if (open) (menu.querySelector('[aria-current]') || menu.querySelector('a')).focus();
    };
    toggle.addEventListener('click', () => setOpen(menu.hidden));
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !menu.hidden) {
        setOpen(false);
        toggle.focus();
      }
    });
    document.addEventListener('click', (e) => {
      if (!menu.hidden && !el.querySelector('.topic-nav').contains(e.target)) setOpen(false);
    });

    const themeBtn = el.querySelector('.theme-toggle');
    let theme = storedTheme();
    const paintTheme = () => {
      themeBtn.textContent = `Theme: ${theme}`;
      themeBtn.setAttribute('aria-label', `Colour theme: ${theme}. Activate to change.`);
    };
    paintTheme();
    themeBtn.addEventListener('click', () => {
      theme = THEMES[(THEMES.indexOf(theme) + 1) % THEMES.length];
      applyTheme(theme);
      try {
        localStorage.setItem('sdl-theme', theme);
      } catch (e) { /* storage unavailable: theme lasts for this page only */ }
      paintTheme();
    });
    return el;
  }

  function mountShell(pageId) {
    const page = SDL.page(pageId);
    document.title = page && page.id !== 'dashboard' ? `${page.title} | System Design Lab` : 'System Design Lab';
    document.body.prepend(buildHeader(pageId));
    const main = h('<main id="main" class="page" tabindex="-1"></main>');
    document.body.insertBefore(main, document.querySelector('script'));
    return main;
  }

  ui.mountShell = mountShell;

  /* ---------- controller: owns the clock and the render loop ---------- */
  class Controller {
    constructor(sim) {
      this.sim = sim;
      this.playing = true;
      this.speed = 0.1;
      try {
        const saved = Number(localStorage.getItem('sdl-speed'));
        if ([0.02, 0.05, 0.1, 0.2, 0.5, 1].includes(saved)) this.speed = saved;
      } catch (e) { /* storage unavailable: use the default */ }
      this.views = [];
      this.selectedNode = null;
      this.selectedEvent = null;
      this.reducedMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      this.dirty = true;
      this._last = null;
      this._listeners = new Set();
      sim.subscribe(() => (this.dirty = true));
      this._frame = this._frame.bind(this);
      requestAnimationFrame(this._frame);
    }
    _frame(ts) {
      const dt = this._last == null ? 0 : Math.min(100, ts - this._last);
      this._last = ts;
      if (this.playing && this.sim.hasWork()) this.sim.advanceTo(this.sim.now + dt * this.speed);
      const moving = this.sim.packets.some((p) => p.t1 >= this.sim.now - 60);
      if (this.dirty || moving) {
        this.dirty = false;
        this.render();
      }
      requestAnimationFrame(this._frame);
    }
    render() {
      for (const v of this.views) {
        try {
          v.render(this.sim, this);
        } catch (e) {
          console.error('[SDL] view render failed', e);
        }
      }
    }
    changed() {
      this.dirty = true;
      this._listeners.forEach((fn) => fn());
    }
    onChange(fn) {
      this._listeners.add(fn);
    }
    play() {
      this.playing = true;
      this.changed();
    }
    pause() {
      this.playing = false;
      this.changed();
    }
    toggle() {
      this.playing ? this.pause() : this.play();
    }
    step() {
      this.playing = false;
      const ran = this.sim.step();
      this.changed();
      return ran;
    }
    reset() {
      this.sim.reset();
      this.selectedEvent = null;
      this.changed();
    }
    replay() {
      const n = this.sim.replay();
      this.selectedEvent = null;
      this.playing = true;
      this.changed();
      return n;
    }
    inspect(nodeId) {
      this.selectedNode = nodeId;
      this.changed();
    }
  }
  ui.Controller = Controller;

  /* ---------- lab page ---------- */
  ui.mountLab = function (pageId, scenarioId) {
    const main = mountShell(pageId);
    const page = SDL.page(pageId);
    const scenario = SDL.scenarios[scenarioId || pageId];
    const sim = new SDL.Simulator(scenario);
    const ctl = new Controller(sim);
    if (ctl.reducedMotion) document.documentElement.classList.add('reduce-motion');

    main.innerHTML = `
      <div class="lab-head">
        <h1>${esc(page.title)}</h1>
        <p class="lede">${esc(page.summary || '')}</p>
        <p class="disclaimer">A local simulation of one possible reference design, not ${esc(page.system || 'any company')}’s proprietary implementation. Timings and metrics are illustrative simulated values.</p>
      </div>
      <div class="playback" data-view="playback"></div>
      <div class="lab-top" style="--product-w: ${scenario.productWidth || 400}px">
        <section class="panel panel-product" aria-labelledby="h-product">
          <h2 id="h-product">Try it</h2>
          <div data-view="product"></div>
        </section>
        <div class="lab-main">
          <section class="panel panel-diagram" aria-labelledby="h-diagram">
            <div class="panel-head">
              <h2 id="h-diagram">Architecture and request flow</h2>
              <p class="panel-hint">Select any component to inspect it.</p>
            </div>
            <div data-view="diagram"></div>
            <div data-view="explain"></div>
          </section>
          <section class="panel panel-ledger" aria-labelledby="h-ledger">
            <h2 id="h-ledger">What each layer knows</h2>
            <div data-view="ledger"></div>
          </section>
        </div>
      </div>
      <div class="lab-bottom">
        <section class="panel panel-failures" aria-labelledby="h-failures">
          <h2 id="h-failures">Inject failures</h2>
          <div data-view="failures"></div>
        </section>
        <section class="panel panel-presets" aria-labelledby="h-presets">
          <h2 id="h-presets">Guided scenarios</h2>
          <div data-view="presets"></div>
        </section>
        <section class="panel panel-metrics" aria-labelledby="h-metrics">
          <h2 id="h-metrics">Metrics <span class="sim-tag">Simulated</span></h2>
          <div data-view="metrics"></div>
        </section>
        <section class="panel panel-timeline" aria-labelledby="h-timeline">
          <h2 id="h-timeline">Request timeline</h2>
          <div data-view="timeline"></div>
        </section>
      </div>`;
    const inspectorEl = h('<aside class="inspector" aria-labelledby="inspector-title" hidden></aside>');
    document.body.appendChild(inspectorEl);

    const slot = (n) => main.querySelector(`[data-view="${n}"]`);
    const P = ui.panels;
    ctl.views.push(
      new P.Playback(slot('playback'), sim, ctl),
      new P.Product(slot('product'), sim, ctl, scenario.product),
      new P.Ledger(slot('ledger'), sim, ctl),
      new P.Diagram(slot('diagram'), sim, ctl),
      new P.Explain(slot('explain'), sim, ctl),
      new P.Failures(slot('failures'), sim, ctl),
      new P.Presets(slot('presets'), sim, ctl),
      new P.Timeline(slot('timeline'), sim, ctl),
      new P.Metrics(slot('metrics'), sim, ctl),
      new P.Inspector(inspectorEl, sim, ctl)
    );

    document.addEventListener('keydown', (e) => {
      if (e.target.closest('input, textarea, select, [contenteditable]') || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === 'p' || e.key === 'P') { ctl.toggle(); e.preventDefault(); }
      else if (e.key === '.') { ctl.step(); e.preventDefault(); }
    });
    ctl.render();
    window.SDL_LAB = { sim, ctl }; // handy for debugging and browser tests
    return { sim, ctl };
  };

  /* ---------- planned page ---------- */
  ui.mountPlanned = function (pageId) {
    const main = mountShell(pageId);
    const p = SDL.page(pageId);
    main.innerHTML = `
      <div class="planned">
        <p class="planned-stage">${p.stageLabel ? `Planned: ${esc(p.stageLabel)}` : `Scheduled for Stage ${p.stage}`}</p>
        <h1>${esc(p.title)}</h1>
        <p class="lede">${esc(p.summary)}</p>
        <div class="planned-cols">
          <section><h2>What you’ll be able to do</h2><ul>${p.will.map((w) => `<li>${esc(w)}</li>`).join('')}</ul></section>
          <section><h2>Failures you’ll inject</h2><ul>${p.failures.map((w) => `<li>${esc(w)}</li>`).join('')}</ul></section>
        </div>
        <p>This lab isn’t built yet. Every lab uses the same controls, so <a href="${ui.href('sandbox')}">the simulator sandbox</a> is the best place to start.</p>
      </div>`;
  };

  /* ---------- landing and system hubs ---------- */
  const labsOf = (sys) => SDL.PAGES.filter((p) => sys.groups.includes(p.group) && !p.hub);
  const progress = (sys) => {
    const labs = labsOf(sys);
    const ready = labs.filter((p) => p.status === 'built').length;
    return { labs, ready, pct: labs.length ? (ready / labs.length) * 100 : 0 };
  };

  ui.mountLanding = function () {
    const main = mountShell('dashboard');
    const cards = (SDL.SYSTEMS || []).map((sys) => {
      const g = progress(sys);
      return `<a class="system-card system-card-lg" href="${ui.href(sys.hub)}">
        <span class="system-title">${esc(sys.title)}</span>
        <span class="system-blurb">${esc(sys.blurb)}</span>
        <span class="system-progress" aria-hidden="true"><i style="width:${g.pct}%"></i></span>
        <span class="system-count">${g.ready} of ${g.labs.length} labs ready</span>
        <span class="system-go">Open ${esc(sys.title)} →</span></a>`;
    }).join('');
    main.innerHTML = `
      <div class="dash-hero">
        <h1>Watch a request cross the system. Then break it.</h1>
        <p class="lede">Interactive system design labs. Each one pairs a working mock of a real product with the architecture behind it: tap a button, follow the request through every service, inject a failure anywhere, and see exactly what the user, the server, and the database each end up believing.</p>
      </div>
      <section class="dash-systems" aria-labelledby="systems">
        <h2 id="systems">Choose a system</h2>
        <div class="system-cards">${cards}</div>
      </section>
      <section class="dash-how" aria-labelledby="how">
        <h2 id="how">How every lab works</h2>
        <ul class="how-list">
          <li><strong>Try it.</strong> A working mock of the product, usually a phone you can tap.</li>
          <li><strong>Architecture.</strong> A live diagram. Every component shows its state and opens an inspector.</li>
          <li><strong>Request flow.</strong> Packets move along the diagram in step with the simulation, including retries and timeouts.</li>
          <li><strong>Failures and switches.</strong> Break any component, or turn off a safeguard, and watch the consequences.</li>
          <li><strong>Timeline and metrics.</strong> Every operation with its input and output, and numbers computed from what actually ran.</li>
        </ul>
        <p><a class="btn" href="${ui.href('sandbox')}">New here? Learn the controls in the sandbox</a></p>
      </section>
      <p class="dash-foot">Everything runs locally in your browser. Nothing connects to any real service, and the designs are reference architectures for learning, not descriptions of any company’s internal systems.</p>`;
  };
  ui.mountDashboard = ui.mountLanding;

  ui.mountHub = function (hubId) {
    const main = mountShell(hubId);
    const sys = SDL.SYSTEMS.find((x) => x.hub === hubId);
    const g = progress(sys);
    const item = (p, n) => `<li><a href="${hrefOf(p)}">${n != null ? `<span class="hub-step">${n}</span>` : ''}<span class="topic-title">${esc(p.title)}</span>
      <span class="topic-summary">${esc(p.summary || '')}</span><span class="badge ${p.status === 'built' ? 'badge-ready' : ''}">${statusText(p)}</span></a></li>`;
    const pathPages = sys.path.map((id) => SDL.page(id)).filter(Boolean);
    const groups = sys.groups.map((gname) => `<section class="topic-group"><h2>${esc(gname)}</h2><ul class="topic-list">${SDL.PAGES.filter((p) => p.group === gname && !p.hub).map((p) => item(p)).join('')}</ul></section>`).join('');
    main.innerHTML = `
      <p class="hub-crumb"><a href="${ui.href('dashboard')}">All systems</a> / ${esc(sys.title)}</p>
      <div class="dash-hero hub-hero">
        <h1>${esc(sys.title)}</h1>
        <p class="lede">${esc(sys.blurb)}</p>
        <p class="system-count">${g.ready} of ${g.labs.length} labs ready</p>
        <p class="hero-actions"><a class="btn btn-primary" href="${hrefOf(pathPages[0])}">Start with ${esc(pathPages[0].title)}</a></p>
      </div>
      <section class="topic-group" aria-labelledby="path"><h2 id="path">Recommended path</h2><ol class="topic-list hub-path">${pathPages.map((p, i) => item(p, i + 1)).join('')}</ol></section>
      ${groups}
      <p class="dash-foot">Reference architectures for learning, not descriptions of ${esc(sys.company)}’s internal systems.</p>`;
  };
})();
