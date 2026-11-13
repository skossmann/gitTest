// Erzeugt die PNG-Icons aus public/icon.svg (benötigt Playwright; nur nötig, wenn das Icon geändert wird).
const { chromium } = require('playwright');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
(async () => {
  const pub = join(__dirname, '..', 'public');
  const svg = readFileSync(join(pub, 'icon.svg'), 'utf8');
  const b = await chromium.launch();
  for (const size of [180, 192, 512]) {
    const p = await b.newPage({ viewport: { width: size, height: size } });
    await p.setContent(`<style>body{margin:0}svg{display:block;width:${size}px;height:${size}px}</style>${svg}`);
    await p.screenshot({ path: join(pub, `icon-${size}.png`) });
  }
  await b.close();
})();
