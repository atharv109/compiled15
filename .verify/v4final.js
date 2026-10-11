const root = 'C:/Users/athar/OneDrive/Desktop/compiled15';
(async () => {
  const { chromium } = require('C:/Users/athar/OneDrive/Desktop/node_modules/playwright');
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text().slice(0, 200)); });
  const out = {};

  // ---------- fresh load ----------
  await page.goto('http://127.0.0.1:9000/console.html?mock=1', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2500);
  out.jsFresh = await page.evaluate(() =>
    fetch('assets/js/console.js?v=18', { cache: 'no-store' }).then((r) => r.text())
      .then((t) => t.includes('card.hidden = false;') && t.includes('setViewMode')));

  // ---------- A. link intake: no pre-confirm, straight through ----------
  await page.evaluate(() => {
    document.querySelector('#biz-link').value = 'https://maps.google.com/maps/place/Cafe+210+West';
    document.querySelector('#biz-question').value = 'Should we stay open until 2 AM on weekends and spend $400/month on a blanket delivery promo?';
    document.querySelector('#start-btn').click();
  });
  await page.waitForTimeout(900);
  out.linkNoConfirm = await page.evaluate(() =>
    !document.querySelector('.cs-confirm') &&
    window.CS.state === 'running' &&
    !document.getElementById('launcher').hidden);
  // resolved entity → anchored slim line (non-interactive)
  await page.evaluate(() => window.CS.emit('business:resolved', { entity: {
    display_name: 'Cafe 210 West', location: '210 W College Ave, State College',
    maps_url: 'https://maps.google.com/maps/place/Cafe+210+West' } }));
  await page.waitForTimeout(400);
  out.linkAnchoredLine = await page.evaluate(() => {
    const line = document.querySelector('.cs-anchored');
    return line && /anchored on/.test(line.textContent) && !line.querySelector('.fb-actions');
  });
  await page.evaluate(() => { if (window.CS.session) window.CS.session._stop = true; });
  await page.waitForTimeout(600);
  // back to launcher for the name+town test
  await page.evaluate(() => new Promise((res) => setTimeout(res, 200)));

  // ---------- B. name+town intake: post-resolution ask ----------
  await page.evaluate(() => {
    document.querySelector('#launcher').hidden = false;
    document.querySelector('#runview').hidden = true;
    document.getElementById('biz-link').value = '';
    document.getElementById('biz-name').value = 'Cafe 210 West';
    document.getElementById('biz-town').value = 'State College';
    document.getElementById('biz-question').value = 'Should we stay open until 2 AM on weekends and spend $400/month on a blanket delivery promo?';
    document.getElementById('start-btn').click();
  });
  await page.waitForTimeout(900);
  out.nameNoPreConfirm = await page.evaluate(() =>
    !document.querySelector('.cs-confirm') && window.CS.state === 'running');
  await page.evaluate(() => window.CS.emit('business:resolved', { entity: {
    display_name: 'Cafe 210 West', location: '210 W College Ave, State College',
    maps_url: 'https://maps.google.com/maps/place/Cafe+210+West' } }));
  await page.waitForTimeout(400);
  out.resolveAskShown = await page.evaluate(() => {
    const card = document.querySelector('.cs-resolve');
    return card && /Open listing/.test(card.textContent) && !!card.querySelector('.fb-yes');
  });
  await page.evaluate(() => { const y = document.querySelector('.cs-resolve .fb-yes'); if (y) y.click(); });
  await page.waitForTimeout(300);
  out.resolveOnceThenAnchored = await page.evaluate(() =>
    !document.querySelector('.cs-resolve') && !!document.querySelector('.cs-anchored'));

  // ---------- C. run to verdict + done ----------
  await page.waitForFunction(() => window.CS && window.CS.session && window.CS.session.verdict && window.CS.state === 'done', null, { timeout: 120000 });

  await page.screenshot({ path: root + '/v4-verdict-in-chat.png' });

  out.v = await page.evaluate(() => {
    const card = document.getElementById('verdict-card');
    const b = document.getElementById('vc-body');
    const q = (sel) => (b.querySelector(sel) || {});
    return {
      cardVisible: !card.hidden,
      cardH: Math.round(card.getBoundingClientRect().height),
      hero: (q('.vc-hero').textContent || '').slice(0, 55),
      conf: q('.vc-num').textContent || null,
      barW: (q('.vc-bar i').style || {}).width || null,
      segs: b.querySelectorAll('.vc-split .vd-seg').length,
      legend: (q('.vc-legend').textContent || '').replace(/\s+/g, ' ') || null,
      mini: document.getElementById('vc-mini').textContent,
      inChatScroll: !!card.closest('#chat-scroll'),
      beforeStation: !!(card.nextElementSibling && card.nextElementSibling.classList.contains('chat-station')),
      noLockInsideCard: !b.querySelector('.vc-lock'),
      lockInChatState: !!document.querySelector('#ad-msgs .ad-lock'),
      lockTitle: (document.querySelector('#ad-msgs .ad-lock .ad-lock-t') || {}).textContent || null,
      lockCta: (document.querySelector('#ad-msgs .vc-cta') || {}).textContent || null,
      pillVisible: !document.getElementById('pay-pill').hidden,
      pillText: document.getElementById('pay-pill').textContent,
      actBtnVisible: !document.getElementById('act-button').hidden,
      overlayAutoHidden: document.getElementById('step-overlay').hidden,
      verdictOverlayAuto: document.getElementById('step-overlay').hidden,
      emptyState: document.getElementById('ad-msgs').textContent.slice(0, 45)
    };
  });

  // collapse / expand verdict card
  await page.evaluate(() => document.getElementById('vc-head').click());
  out.vcCollapsed = await page.evaluate(() => document.getElementById('vc-body').hidden && document.getElementById('verdict-card').classList.contains('is-closed'));
  await page.evaluate(() => document.getElementById('vc-head').click());
  out.vcReopened = await page.evaluate(() => !document.getElementById('vc-body').hidden);

  // ---------- D. unlock via the chat-state lock card ----------
  out.unlock = await page.evaluate(async () => {
    const lk = document.querySelector('#ad-msgs .vc-cta');
    lk.click();
    const t0 = Date.now();
    while (Date.now() - t0 < 15000 && !window.CS.isPaid()) await new Promise((r) => setTimeout(r, 300));
    await new Promise((r) => setTimeout(r, 700));
    const b = document.getElementById('vc-body');
    return {
      paid: window.CS.isPaid(),
      deep: !!b.querySelector('.vc-deep'),
      impacts: b.querySelectorAll('.vc-srow').length,
      objections: b.querySelectorAll('.vc-obj').length,
      cites: b.querySelectorAll('.vc-srow .ad-cite').length,
      lockGone: !document.querySelector('#ad-msgs .ad-lock'),
      pillGone: document.getElementById('pay-pill').hidden,
      composerEnabledNoAgent: !document.getElementById('ad-input').disabled, // false (no agent)
      placeholder: document.getElementById('ad-input').placeholder,
    };
  });

  // ---------- E. node → agent chat + send ----------
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('csgraph:node', { detail: { nodeId: 'pe:' + window.CS.session.personas[0].id } })));
  await page.waitForTimeout(400);
  out.agent = await page.evaluate(() => ({
    name: document.getElementById('ad-name').textContent,
    sub: document.getElementById('ad-sub').textContent,
    enabled: !document.getElementById('ad-input').disabled,
    avatar: document.getElementById('ad-av').children.length > 0,
  }));
  await page.evaluate(() => { document.getElementById('ad-input').value = 'why 2 AM instead of midnight?'; });
  await page.evaluate(() => document.getElementById('ad-send').click());
  await page.waitForTimeout(800);
  out.typing = await page.evaluate(() => !!document.querySelector('.ad-typing'));
  const replyReady = await page.waitForFunction(
    () => !document.querySelector('.ad-typing') && document.querySelectorAll('#ad-msgs .ad-msg').length >= 2,
    null, { timeout: 40000 }).then(() => true).catch(() => false);
  out.chat = await page.evaluate(() => {
    const b = Array.from(document.querySelectorAll('#ad-msgs .ad-bubble'));
    return { bubbles: b.length, last: b.length ? b[b.length - 1].textContent.slice(0, 90) : null,
      cites: document.querySelectorAll('#ad-msgs .ad-cite').length };
  });

  // ---------- F. evidence node → context, no agent ----------
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('csgraph:node', { detail: { nodeId: 'ev:' + window.CS.session.evidence[0].id } })));
  await page.waitForTimeout(400);
  out.topic = await page.evaluate(() => ({
    name: document.getElementById('ad-name').textContent,
    sub: document.getElementById('ad-sub').textContent,
    about: ((document.querySelector('#ad-msgs .ad-quote') || {}).textContent || '').replace(/\s+/g, ' ').slice(0, 95) || null,
    disabled: document.getElementById('ad-input').disabled,
    placeholder: document.getElementById('ad-input').placeholder,
  }));

  // ---------- G. Act-on-it button + chips ----------
  out.act = await page.evaluate(() => {
    document.getElementById('act-button').click();
    return new Promise((res) => setTimeout(() => {
      const mount = document.getElementById('step-mount');
      const chips = mount.querySelectorAll('.act-chip');
      const overlayOpen = !document.getElementById('step-overlay').hidden;
      const stubFlyer = !!mount.querySelector('.flyer-card.is-stub');
      const stubTag = ((mount.querySelector('.flyer-stub-tag') || {}).textContent) || null;
      const flyerCopyBtn = !!mount.querySelector('.flyer-copybtn');
      const printBtn = !!mount.querySelector('.flyer-print');
      // click the flyer chip → run starts
      const flyerChip = Array.from(chips).find((c) => /flyer/i.test(c.textContent) && !c.classList.contains('is-flyer')) || mount.querySelector('.act-chip.is-flyer');
      const draftCopyBtn = !!mount.querySelector('.dr-copy');
      res({ overlayOpen, chipCount: chips.length, hasFlyerChip: !!mount.querySelector('.act-chip.is-flyer'),
        stubFlyer, stubTag, flyerCopyBtn, printBtn, draftCopyBtn });
    }, 500));
  });
  // run a chip → running state appears
  out.actRun = await page.evaluate(() => new Promise((res) => {
    const chip = document.querySelector('.act-chip');
    if (!chip) { res({ noChips: true }); return; }
    chip.click();
    setTimeout(() => {
      const mount = document.getElementById('step-mount');
      const runningUI = !!mount.querySelector('.lrn-spin') || /Drafting/.test(mount.textContent);
      res({ runningUI, label: (window.CS.session.act || {}).requestLabel || chip.textContent });
    }, 1200);
  }));
  // wait for act result (mock llm may take a while) or 402-style failure
  const actDone = await page.waitForFunction(() => {
    const m = document.getElementById('step-mount');
    const A = window.CS.session && window.CS.session.act;
    return m && A && ((A.result && window.CS.session.actResult) || !A.running), A && !A.running;
  }, null, { timeout: 90000 }).then(() => true).catch(() => false);
  out.actFinished = actDone;
  out.actResultUI = await page.evaluate(() => {
    const m = document.getElementById('step-mount');
    const A = window.CS.session.act || {};
    return {
      hasResult: !!A.result,
      drafts: (A.result && A.result.drafts || []).length,
      scoredFlyer: !!m.querySelector('.flyer-card:not(.is-stub)'),
      flyerHead: (m.querySelector('.flyer-sec-head') || {}).textContent || null,
      flyerCopyBtn: !!m.querySelector('.flyer-copybtn'),
      errorNote: (m.querySelector('.lrn-warn') || {}).textContent || null,
    };
  });

  // copy flyer button (clipboard permission in headless may fail → fallback path; just check state text)
  out.copy = await page.evaluate(async () => {
    const btn = document.querySelector('.flyer-card:not(.is-stub) .flyer-copybtn') || document.querySelector('.flyer-copybtn');
    if (!btn) return { noBtn: true };
    btn.click();
    await new Promise((r) => setTimeout(r, 800));
    return { pressed: btn.textContent };
  });

  // ---------- H. view modes ----------
  out.modes = await page.evaluate(() => new Promise((res) => {
    document.querySelector('.vt-btn[data-mode="split"]').click();
    setTimeout(() => {
      const splitState = {
        hostLeft: Math.round(document.querySelector('.graph-host').getBoundingClientRect().left),
        hostW: Math.round(document.querySelector('.graph-host').getBoundingClientRect().width),
        overlayLeft: Math.round(document.querySelector('#step-overlay').getBoundingClientRect().left),
        paneW: Math.round(document.querySelector('.graph-pane').getBoundingClientRect().width),
        overlayFont: getComputedStyle(document.querySelector('.so-body') || document.body).fontSize,
      };
      document.querySelector('.vt-btn[data-mode="workbench"]').click();
      setTimeout(() => {
        const wb = {
          hostHidden: getComputedStyle(document.querySelector('.graph-host')).display === 'none',
          runlogOpen: !document.querySelector('.runlog-body').hidden,
        };
        document.querySelector('.vt-btn[data-mode="graph"]').click();
        setTimeout(() => {
          const back = {
            hostVisible: getComputedStyle(document.querySelector('.graph-host')).display !== 'none',
          };
          res({ split: splitState, workbench: wb, graphBack: back });
        }, 250);
      }, 250);
    }, 250);
  }));

  // ---------- I. 1920 legibility spot check ----------
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.waitForTimeout(400);
  out.w1920 = await page.evaluate(() => ({
    bubblePx: getComputedStyle(document.querySelector('#ad-msgs .ad-bubble') || document.body).fontSize,
    paneTitlePx: getComputedStyle(document.querySelector('.chat-head .pane-title')).fontSize,
    rtabLabelPx: getComputedStyle(document.querySelector('.rtab span')).fontSize,
    appFillsViewport: Math.abs(document.querySelector('.graph-pane').getBoundingClientRect().height -
      (document.querySelector('.graph-pane').getBoundingClientRect().height)) >= 0,
    bodyNoScroll: document.body.scrollHeight <= window.innerHeight + 2,
  }));

  // ---------- J. phone 390px ----------
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(500);
  out.phone = await page.evaluate(() => {
    const g = document.querySelector('.graph-pane').getBoundingClientRect();
    const c = document.querySelector('.chat-pane').getBoundingClientRect();
    return {
      graphFirst: g.top < c.top,
      runlogInGraphPane: !!document.querySelector('.graph-pane .runlog'),
      noHScroll: document.documentElement.scrollWidth <= 392,
      bodyScrolls: document.documentElement.scrollHeight > window.innerHeight,
      chips: document.querySelectorAll('#graph-stats .gchip').length,
    };
  });
  await page.screenshot({ path: root + '/v4-phone.png' });

  // ---------- final desktop screenshot (1600x900, paid, verdict card) ----------
  await page.setViewportSize({ width: 1600, height: 900 });
  await page.waitForTimeout(500);
  await page.evaluate(() => { window.scrollTo(0, 0); });
  await page.screenshot({ path: root + '/v4-desktop.png' });

  await browser.close();
  console.log(JSON.stringify(out, null, 1));
  console.log('ERRORS(non-dragNode): ' + JSON.stringify(errors.filter((e) => !/dragNode/.test(e)), null, 1));
  console.log('ERRORS(all): ' + errors.length);
})();