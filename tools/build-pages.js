// Generates an HTML entry page for every registry page that is not yet built.
// Built pages are hand-authored and never overwritten. Run: node tools/build-pages.js
const fs = require('fs');
const path = require('path');
require('../assets/js/ui/registry.js');
const SDL = globalThis.SDL;
const ROOT = path.join(__dirname, '..');

function page({ title, rootRel, id, mount, scenarioScripts = [] }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${title}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&family=IBM+Plex+Sans:wght@400;500;600&display=swap">
<link rel="stylesheet" href="${rootRel}assets/css/tokens.css">
<link rel="stylesheet" href="${rootRel}assets/css/lab.css">
</head>
<body data-root="${rootRel}" data-page="${id}">
<script src="${rootRel}assets/js/engine/sim.js"></script>
<script src="${rootRel}assets/js/engine/metrics.js"></script>
${scenarioScripts.map((s) => `<script src="${rootRel}assets/js/scenarios/${s}"></script>\n`).join('')}<script src="${rootRel}assets/js/ui/registry.js"></script>
<script src="${rootRel}assets/js/ui/shell.js"></script>
<script src="${rootRel}assets/js/ui/panels.js"></script>
<script src="${rootRel}assets/js/ui/phone.js"></script>
<script>${mount}</script>
</body>
</html>
`;
}
module.exports = { page };

if (require.main === module) {
  let n = 0;
  for (const p of SDL.PAGES) {
    if (p.status === 'built') continue;
    const depth = p.path.split('/').length - 1;
    const rootRel = '../'.repeat(depth);
    const file = path.join(ROOT, p.path);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, page({ title: `${p.title} | System Design Lab`, rootRel, id: p.id, mount: `SDL.ui.mountPlanned('${p.id}');` }));
    n++;
  }
  console.log(`Generated ${n} planned pages.`);
}
