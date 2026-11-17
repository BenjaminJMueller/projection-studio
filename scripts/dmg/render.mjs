// Hintergrundbild für das DMG-Fenster rendern (1× und 2×) nach build/.
import { chromium } from 'playwright';
import path from 'node:path';
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
for (const [scale, name] of [[1, 'background.png'], [2, 'background@2x.png']]) {
  const page = await browser.newPage({ viewport: { width: 640, height: 520 }, deviceScaleFactor: scale });
  await page.goto('file://' + path.join(root, 'scripts/dmg/background.html'));
  await page.screenshot({ path: path.join(root, 'build', name) });
  await page.close();
}
await browser.close();
