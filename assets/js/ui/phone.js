/* Reusable phone mock. A scenario renders its app screens inside it; the
   frame itself shows the simulated clock, a network indicator that lights
   while packets leave or reach this device on the diagram, push banners, and
   a ripple wherever the user taps. */
(function () {
  'use strict';
  const SDL = window.SDL;
  const ui = SDL.ui;

  /**
   * Paint a screen in independent sections so moving or ticking content never
   * rebuilds the buttons under the user's finger. Sections are replaced only
   * when their markup changes; [data-live*] values are written in place.
   */
  function paintSections(screen, sections, live) {
    live = live || {};
    for (const [name, html] of Object.entries(sections)) {
      let sec = screen.querySelector(`:scope > [data-sec="${name}"]`);
      if (!sec) {
        sec = document.createElement('div');
        sec.dataset.sec = name;
        sec.className = 'app-sec';
        screen.appendChild(sec);
      }
      if (sec._html === html) continue;
      sec._html = html;
      const a = document.activeElement;
      const key = a && sec.contains(a) ? a.dataset.act || a.dataset.field || a.dataset.opt : null;
      sec.innerHTML = html;
      if (key) {
        const again = sec.querySelector(`[data-act="${key}"], [data-field="${key}"], [data-opt="${key}"]`);
        if (again && !again.disabled) again.focus();
      }
    }
    screen.querySelectorAll('[data-live]').forEach((n) => { const v = live[n.dataset.live]; if (v != null && n.textContent !== v) n.textContent = v; });
    screen.querySelectorAll('[data-live-width]').forEach((n) => { const v = live[n.dataset.liveWidth]; if (v != null) n.style.width = v; });
    screen.querySelectorAll('[data-live-label]').forEach((n) => { const v = live[n.dataset.liveLabel]; if (v != null) n.setAttribute('aria-label', v); });
  }
  ui.paintSections = paintSections;

  ui.phone = {
    paint(phoneEl, sections, live) { paintSections(phoneEl.querySelector('.phone-screen'), sections, live); },
    /** Markup for one phone. id is the diagram node this phone represents. */
    frame(id, title) {
      return `
        <figure class="phone" data-phone="${id}">
          <figcaption class="phone-caption">${ui.esc(title)}</figcaption>
          <div class="phone-body">
            <div class="phone-notch" aria-hidden="true"></div>
            <div class="phone-status">
              <span class="phone-clock" data-ref="clock">8:30</span>
              <span class="phone-net" data-ref="net" aria-hidden="true"><b class="net-up">↑</b><b class="net-down">↓</b></span>
              <span class="phone-signal" data-ref="signal" aria-hidden="true"><i></i><i></i><i></i><i></i></span>
            </div>
            <div class="phone-banner" data-ref="banner" role="status" aria-live="polite" hidden></div>
            <div class="phone-screen" data-ref="screen"></div>
            <div class="phone-netline" data-ref="netline" aria-hidden="true"></div>
            <div class="phone-home" aria-hidden="true"></div>
          </div>
        </figure>`;
    },
    /** Attach tap ripples to a phone. */
    wire(phoneEl) {
      const screen = phoneEl.querySelector('.phone-screen');
      screen.addEventListener('pointerdown', (e) => {
        if (!e.target.closest('button, select, input, label')) return;
        if (document.documentElement.classList.contains('reduce-motion')) return;
        const r = screen.getBoundingClientRect();
        const dot = document.createElement('span');
        dot.className = 'tap-ripple';
        dot.style.left = `${e.clientX - r.left}px`;
        dot.style.top = `${e.clientY - r.top}px`;
        screen.appendChild(dot);
        setTimeout(() => dot.remove(), 650);
      });
    },
    /** Update the frame from simulation state. banner: {title, body, t, tone} or null. */
    render(phoneEl, sim, nodeId, banner, offline) {
      const q = (r) => phoneEl.querySelector(`[data-ref="${r}"]`);
      const secs = Math.floor(sim.now / 1000);
      const clock = `8:${String(30 + Math.floor(secs / 60)).padStart(2, '0')}:${String(secs % 60).padStart(2, '0')}`;
      if (q('clock').textContent !== clock) q('clock').textContent = clock;
      const now = sim.now;
      const live = sim.packets.filter((p) => now >= p.t0 && now <= p.t1);
      const up = live.filter((p) => p.from === nodeId);
      const down = live.filter((p) => p.to === nodeId);
      const net = q('net');
      net.classList.toggle('is-up', up.length > 0);
      net.classList.toggle('is-down', down.length > 0);
      const nl = q('netline');
      const txt = up.length ? `Sending ${up[up.length - 1].label}…` : down.length ? `Receiving ${down[down.length - 1].kind === 'req' ? down[down.length - 1].label : 'reply'}…` : '';
      if (nl.textContent !== txt) nl.textContent = txt;
      nl.dataset.dir = up.length ? 'up' : down.length ? 'down' : '';
      phoneEl.classList.toggle('is-offline', !!offline);
      const b = q('banner');
      const show = banner && now - banner.t < 2600;
      if (show) {
        const html = `<strong>${ui.esc(banner.title)}</strong><span>${ui.esc(banner.body || '')}</span>`;
        if (b.innerHTML !== html) b.innerHTML = html;
        b.dataset.tone = banner.tone || 'work';
      }
      b.hidden = !show;
    },
  };
})();
