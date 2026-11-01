const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.goto('http://localhost:3001');

  // Trigger a long streaming answer
  const textarea = page.locator('textarea');
  await textarea.fill('Provide a thorough, comprehensive 800 word explanation of orbital mechanics and Lagrange points.');
  
  const sendBtn = page.locator('button[data-testid="send-button"]');
  await sendBtn.click();
  console.log('[Acceptance b] Sent prompt.');

  // Wait 1.5s for stream to begin
  await page.waitForTimeout(1500);

  // Scroll to TOP within the first second/start
  console.log('[Acceptance b] Scrolling to TOP (scrollTop = 0)...');
  await page.evaluate(() => {
    const el = document.querySelector('[data-scroll-container="true"]');
    if (el) {
      el.scrollTop = 0;
      el.dispatchEvent(new Event('scroll'));
    }
  });

  // Track viewport position over 10 seconds while stream generates
  let moved = false;
  let finalContentLength = 0;

  for (let i = 0; i < 20; i++) {
    await page.waitForTimeout(500);
    const snap = await page.evaluate(() => {
      const el = document.querySelector('[data-scroll-container="true"]');
      const text = el ? el.innerText : '';
      return {
        scrollTop: el ? el.scrollTop : -1,
        scrollHeight: el ? el.scrollHeight : -1,
        length: text.length
      };
    });
    finalContentLength = snap.length;
    if (snap.scrollTop > 5) {
      console.error(`[Acceptance b FAILED] Viewport moved to ${snap.scrollTop} at step ${i}`);
      moved = true;
      break;
    }
  }

  if (!moved) {
    console.log(`[Acceptance b PASSED] Viewport stayed at 0 throughout stream! Content length: ${finalContentLength}`);
  }

  // Stop generation if still streaming so composer send button is recovered immediately
  const stopBtn = page.locator('button[data-testid="stop-button"]');
  if (await stopBtn.isVisible()) {
    console.log('Halting remaining stream via Stop button to recover composer...');
    await stopBtn.click();
    await page.waitForTimeout(500);
  }

  // Wait for send button to be visible
  await page.waitForSelector('button[data-testid="send-button"]', { timeout: 10000 });

  // Acceptance c: send follow-up and ensure view jumps to bottom on send
  console.log('[Acceptance c] Sending follow-up message...');
  await textarea.fill('Brief follow-up question');
  await page.locator('button[data-testid="send-button"]').click();
  
  await page.waitForTimeout(600);
  const snapAfterSend = await page.evaluate(() => {
    const el = document.querySelector('[data-scroll-container="true"]');
    return el ? { scrollTop: el.scrollTop, scrollHeight: el.scrollHeight, clientHeight: el.clientHeight, dist: el.scrollHeight - (el.scrollTop + el.clientHeight) } : null;
  });
  console.log('[Acceptance c] Position after follow-up send:', snapAfterSend);
  if (snapAfterSend && snapAfterSend.dist <= 150) {
    console.log('[Acceptance c PASSED] View jumped to bottom on send and re-pinned follow mode!');
  } else {
    console.error('[Acceptance c FAILED] View did not jump to bottom on send');
  }

  await browser.close();
})();
