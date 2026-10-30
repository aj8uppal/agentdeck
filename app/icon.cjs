// Renders icon.svg to AppIcon.icns. Only needed after editing the SVG; build.sh uses the committed .icns.
//   PATH=~/.local/node/bin:$PATH node app/icon.cjs
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const pw = require(process.env.HOME + '/personal/3d-tetris/node_modules/playwright');  // same borrowed Playwright as test.cjs

(async () => {
  const set = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-icon-')) + '/AppIcon.iconset';
  fs.mkdirSync(set);
  const browser = await pw.chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1024, height: 1024 } });
  await page.goto('file://' + path.join(__dirname, 'icon.svg'));
  await page.screenshot({ path: set + '/icon_512x512@2x.png', omitBackground: true });
  await browser.close();
  for (const size of [16, 32, 128, 256, 512]) {
    for (const [scale, suffix] of [[1, ''], [2, '@2x']]) {
      const name = `${set}/icon_${size}x${size}${suffix}.png`;
      if (!fs.existsSync(name)) execFileSync('sips', ['-z', size * scale, size * scale, set + '/icon_512x512@2x.png', '--out', name], { stdio: 'ignore' });
    }
  }
  execFileSync('iconutil', ['-c', 'icns', set, '-o', path.join(__dirname, 'AppIcon.icns')]);
  console.log('wrote ' + path.join(__dirname, 'AppIcon.icns'));
})();
