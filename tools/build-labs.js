// Generates every HTML entry page from assets/js/ui/registry.js. Run: npm run build
//
// Per page, the registry decides what loads:
//   hub: true + systemId  -> system hub page          (SDL.ui.mountHub)
//   id 'dashboard'        -> landing page             (SDL.ui.mountLanding)
//   status 'planned'      -> honest placeholder       (SDL.ui.mountPlanned)
//   calc: { module, mount }-> calculator page module  (assets/js/pages/<module>, SDL.ui.<mount>(id))
//   otherwise             -> simulation lab           (SDL.ui.mountLab(id)) loading
//                            [system.common?] + (page.scenario || `${id}.js`) from assets/js/scenarios/
// Never hand-edit generated HTML: change the registry and rerun this.
const fs = require('fs');
const path = require('path');
const { page } = require('./build-pages.js');
require('../assets/js/ui/registry.js');
const SDL = globalThis.SDL;
const ROOT = path.join(__dirname, '..');

const systemOf = (p) => (SDL.SYSTEMS || []).find((s) => s.groups.includes(p.group));
let n = 0;
for (const p of SDL.PAGES) {
  const depth = p.path.split('/').length - 1;
  const rootRel = '../'.repeat(depth);
  const title = p.id === 'dashboard' ? 'System Design Lab' : `${p.title} | System Design Lab`;
  let html;
  if (p.id === 'dashboard') html = page({ title, rootRel, id: p.id, mount: 'SDL.ui.mountLanding();' });
  else if (p.hub) html = page({ title, rootRel, id: p.id, mount: `SDL.ui.mountHub('${p.id}');` });
  else if (p.status !== 'built') html = page({ title, rootRel, id: p.id, mount: `SDL.ui.mountPlanned('${p.id}');` });
  else if (p.calc) {
    html = page({ title, rootRel, id: p.id, mount: `SDL.ui.${p.calc.mount}('${p.id}');` });
    html = html.replace(`<script src="${rootRel}assets/js/ui/phone.js"></script>`, `<script src="${rootRel}assets/js/ui/phone.js"></script>\n<script src="${rootRel}assets/js/pages/${p.calc.module}"></script>`);
  } else {
    const sys = systemOf(p);
    const scripts = [sys && sys.common, p.scenario || `${p.id}.js`].filter(Boolean);
    for (const sc of scripts) if (!fs.existsSync(path.join(ROOT, 'assets/js/scenarios', sc))) throw new Error(`${p.id}: missing scenario file ${sc}`);
    html = page({ title, rootRel, id: p.id, mount: `SDL.ui.mountLab('${p.id}');`, scenarioScripts: scripts });
  }
  const file = path.join(ROOT, p.path);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, html);
  n++;
}
console.log(`Wrote ${n} pages.`);
