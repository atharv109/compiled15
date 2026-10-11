const root = 'C:/Users/athar/OneDrive/Desktop/compiled15';
(async () => {
  const { chromium } = require('C:/Users/athar/OneDrive/Desktop/node_modules/playwright');
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errs = [];
  page.on('pageerror', (e) => errs.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/dragNode/.test(m.text())) errs.push('console: ' + m.text().slice(0, 160)); });
  await page.goto('http://127.0.0.1:9000/console.html?mock=1', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3000);
  const info = await page.evaluate(() => ({
    launcherHidden: document.getElementById('launcher').hidden,
    runviewHidden: document.getElementById('runview').hidden,
    btnVisible: !!document.getElementById('start-btn').offsetParent,
    btnRect: document.getElementById('start-btn').getBoundingClientRect().width,
    hasCs: typeof window.CS,
    hasSteps: window.CS ? window.CS.STEPS.length : null,
    bodyBg: getComputedStyle(document.body).backgroundColor
  }));
  console.log(JSON.stringify({ info, errs }, null, 1));
  await page.screenshot({ path: root + '/.verify/dbg.png' });
  await browser.close();
})();
