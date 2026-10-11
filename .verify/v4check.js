const root = 'C:/Users/athar/OneDrive/Desktop/compiled15';
(async () => {
  const { chromium } = require('C:/Users/athar/OneDrive/Desktop/node_modules/playwright');
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 200)); });
  await page.goto('http://127.0.0.1:9000/console.html?mock=1', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2500);
  const out = {};

  // 1. intake + confirm-once
  await page.evaluate(() => {
    const $ = (s) => document.querySelector(s);
    document.querySelector('#biz-name').value = 'Cafe 210 West';
    document.querySelector('#biz-town').value = 'State College';
    document.querySelector('#biz-question').value = 'Should we stay open until 2 AM on weekends and spend $400/month on a blanket delivery promo?';
    document.querySelector('#start-btn').click();
  });
  await page.waitForSelector('.cs-confirm', { timeout: 5000 });
  out.confirmShown = true;
  await page.evaluate(() => document.querySelector('.cs-confirm .cdm-go').click());
  await page.evaluate(() => document.getElementById('start-btn').click());
  await page.waitForTimeout(300);
  out.confirmOnce = !(await page.$('.cs-confirm'));

  // 2. run to verdict + done
  await page.waitForFunction(() => window.CS && window.CS.session && window.CS.session.verdict && window.CS.state === 'done', null, { timeout: 120000 });

  out.v = await page.evaluate(() => {
    const card = document.getElementById('verdict-card');
    const b = document.getElementById('vc-body');
    const q = (sel) => (b.querySelector(sel) || {});
    return {
      cardVisible: !card.hidden,
      cardH: Math.round(card.getBoundingClientRect().height),
      hero: (q('.vc-hero').textContent || '').slice(0, 60),
      lockT: q('.vc-lock-t').textContent || null,
      cta: q('.vc-cta').textContent || null,
      conf: q('.vc-num').textContent || null,
      barW: (q('.vc-bar i').style || {}).width || null,
      segs: b.querySelectorAll('.vc-split .vd-seg').length,
      mini: document.getElementById('vc-mini').textContent,
      inChatScroll: !!card.closest('#chat-scroll'),
      beforeStation: !!(card.nextElementSibling && card.nextElementSibling.classList.contains('chat-station')),
      emptyState: document.getElementById('ad-msgs').textContent.slice(0, 50),
      noAdLock: !document.querySelector('#ad-msgs .ad-lock'),
      verdictOverlayAuto: !document.getElementById('step-overlay').hidden,
    };
  });

  // 3. collapse / expand
  await page.evaluate(() => document.getElementById('vc-head').click());
  out.collapsed = await page.evaluate(() => document.getElementById('vc-body').hidden && document.getElementById('verdict-card').classList.contains('is-closed'));
  await page.evaluate(() => document.getElementById('vc-head').click());
  out.reopened = await page.evaluate(() => !document.getElementById('vc-body').hidden);

  // screenshot: unpaid verdict in chat
  await page.screenshot({ path: root + '/v4-verdict-in-chat.png' });

  // 4. unlock
  out.unlock = await page.evaluate(async () => {
    document.querySelector('.vc-cta').click();
    const t0 = Date.now();
    while (Date.now() - t0 < 15000 && !window.CS.isPaid()) await new Promise((r) => setTimeout(r, 300));
    await new Promise((r) => setTimeout(r, 600));
    const b = document.getElementById('vc-body');
    return {
      paid: window.CS.isPaid(),
      deep: !!b.querySelector('.vc-deep'),
      impacts: b.querySelectorAll('.vc-srow').length,
      objections: b.querySelectorAll('.vc-obj').length,
      cites: b.querySelectorAll('.vc-srow .ad-cite').length,
      lockGone: !b.querySelector('.vc-lock'),
      composerEnabledNoAgent: !document.getElementById('ad-input').disabled,
      placeholder: document.getElementById('ad-input').placeholder,
    };
  });

  // 5. graph node -> agent chat + send
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('csgraph:node', { detail: { nodeId: 'pe:' + window.CS.session.personas[0].id } })));
  await page.waitForTimeout(400);
  out.agent = await page.evaluate(() => ({
    name: document.getElementById('ad-name').textContent,
    sub: document.getElementById('ad-sub').textContent,
    enabled: !document.getElementById('ad-input').disabled,
    avatar: document.getElementById('ad-av').children.length > 0,
    quoteTop: (document.querySelector('#ad-msgs .ad-quote') || {}).textContent ? document.querySelector('#ad-msgs .ad-quote').textContent.replace(/\s+/g, ' ').slice(0, 70) : null,
  }));
  await page.evaluate(() => {
    const i = document.getElementById('ad-input');
    i.value = 'why 2 AM instead of midnight?';
  });
  await page.evaluate(() => document.getElementById('ad-send').click());
  await page.waitForTimeout(1000);
  out.typingShown = await page.evaluate(() => !!document.querySelector('.ad-typing'));
  const replyReady = await page.waitForFunction(
    () => !document.querySelector('.ad-typing') && document.querySelectorAll('#ad-msgs .ad-msg').length >= 2,
    null, { timeout: 40000 }).then(() => true).catch(() => false);
  out.chat = await page.evaluate(() => {
    const b = Array.from(document.querySelectorAll('#ad-msgs .ad-bubble'));
    return {
      bubbles: b.length,
      last: b.length ? b[b.length - 1].textContent.slice(0, 110) : null,
      cites: document.querySelectorAll('#ad-msgs .ad-cite').length,
      composerReEnabled: !document.getElementById('ad-input').disabled,
    };
  });

  // 6. topic/evidence node -> context, no agent
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('csgraph:node', { detail: { nodeId: 'ev:' + window.CS.session.evidence[0].id } })));
  await page.waitForTimeout(400);
  out.topic = await page.evaluate(() => ({
    name: document.getElementById('ad-name').textContent,
    sub: document.getElementById('ad-sub').textContent,
    about: (document.querySelector('#ad-msgs .ad-quote') || {}).textContent ? document.querySelector('#ad-msgs .ad-quote').textContent.replace(/\s+/g, ' ').slice(0, 100) : null,
    disabled: document.getElementById('ad-input').disabled,
    placeholder: document.getElementById('ad-input').placeholder,
    clearHidden: document.getElementById('chat-clear').hidden,
  }));

  // 7. word node (defensive, no persona)
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('csgraph:node', { detail: { nodeId: 'w:coffee' } })));
  await page.waitForTimeout(300);
  out.wordNode = await page.evaluate(() => ({
    name: document.getElementById('ad-name').textContent,
    disabled: document.getElementById('ad-input').disabled,
  }));

  // 8. desktop screenshot (paid state)
  await page.waitForTimeout(300);
  await page.screenshot({ path: root + '/v4-desktop.png' });

  // 9. phone 390px - stacked: graph -> log -> chat
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(400);
  out.phone = await page.evaluate(() => {
    const g = document.querySelector('.graph-pane').getBoundingClientRect();
    const c = document.querySelector('.chat-pane').getBoundingClientRect();
    return {
      graphOrderOK: g.top < c.top,
      runlogInGraph: !!document.querySelector('.graph-pane .runlog'),
      noHScroll: document.documentElement.scrollWidth <= 392,
      chipsShown: Array.from(document.querySelectorAll('#graph-stats .gchip')).length,
      chatBottomVisible: true,
    };
  });
  await page.screenshot({ path: root + '/v4-phone.png' });

  await browser.close();
  console.log(JSON.stringify(out, null, 1));
  console.log('ERRORS(non-dragNode): ' + JSON.stringify(errors.filter((e) => !/dragNode/.test(e)), null, 1));
  console.log('ERRORS(all): ' + errors.length);
})();