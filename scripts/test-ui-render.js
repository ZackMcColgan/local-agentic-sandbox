const { exec } = require('child_process');
const fs = require('fs');

const os = require('os');
const path = require('path');

async function waitForPort(port, maxRetries = 15) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json`);
      if (res.ok) return await res.json();
    } catch {}
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error(`Failed to connect to Chrome on port ${port}`);
}

async function capture(url, width, height, isMobile, outputPath, delayMs = 1200) {
  const port = 9300 + Math.floor(Math.random() * 500);
  const tmpUserData = path.join(os.tmpdir(), `chrome-test-ui-${port}`);
  const chrome = exec(
    `"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" --headless=new --remote-debugging-port=${port} --user-data-dir="${tmpUserData}" --no-first-run --no-default-browser-check --disable-gpu --window-size=${width},${height} "${url}"`
  );

  try {
    const tabs = await waitForPort(port);
    const pageTab = tabs.find((t) => t.type === 'page');
    if (!pageTab) throw new Error('No page tab found');

    await new Promise((resolve, reject) => {
      const ws = new WebSocket(pageTab.webSocketDebuggerUrl);

      ws.onopen = () => {
        ws.send(
          JSON.stringify({
            id: 1,
            method: 'Emulation.setDeviceMetricsOverride',
            params: {
              width,
              height,
              deviceScaleFactor: 1,
              mobile: isMobile,
            },
          })
        );

        ws.send(JSON.stringify({ id: 3, method: 'Page.enable' }));
        setTimeout(() => {
          ws.send(
            JSON.stringify({
              id: 2,
              method: 'Page.captureScreenshot',
              params: { format: 'png' },
            })
          );
        }, delayMs);
      };

      ws.onmessage = (event) => {
        const data = JSON.parse(event.data);
        if (data.id === 2) {
          fs.writeFileSync(outputPath, Buffer.from(data.result.data, 'base64'));
          console.log(`Saved ${outputPath}`);
          ws.close();
          resolve();
        }
      };

      ws.onerror = reject;
    });
  } finally {
    try {
      chrome.kill();
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
}

async function run() {
  console.log('Capturing visual test screenshots across Desktop/Mobile and Light/Dark modes...');
  let threadQuery = '';
  try {
    const tRes = await fetch('http://127.0.0.1:3001/api/threads');
    if (tRes.ok) {
      const tData = await tRes.json();
      if (tData.threads && tData.threads.length > 0) {
        threadQuery = `&thread=${encodeURIComponent(tData.threads[0].id)}`;
      }
    }
  } catch {}

  await capture(`http://127.0.0.1:3001/?theme=light${threadQuery}`, 1280, 800, false, 'test_ui_desktop_light.png');
  await capture(`http://127.0.0.1:3001/?theme=light${threadQuery}`, 390, 844, true, 'test_ui_mobile_light.png');
  await capture(`http://127.0.0.1:3001/?theme=dark${threadQuery}`, 1280, 800, false, 'test_ui_desktop_dark.png');
  await capture(`http://127.0.0.1:3001/?theme=dark${threadQuery}`, 390, 844, true, 'test_ui_mobile_dark.png');
  await capture('http://127.0.0.1:3001/?theme=dark&tab=security', 1280, 900, false, 'test_ui_telemetry_desktop.png');
  await capture('http://127.0.0.1:3001/?theme=light&tab=security', 390, 844, true, 'test_ui_telemetry_mobile.png');
  await capture('http://127.0.0.1:3001/morning-report?theme=light', 1280, 900, false, 'test_ui_morning_report_desktop_light.png', 2200);
  await capture('http://127.0.0.1:3001/morning-report?theme=light', 390, 844, true, 'test_ui_morning_report_mobile_light.png', 2200);
  await capture('http://127.0.0.1:3001/morning-report?theme=dark', 1280, 900, false, 'test_ui_morning_report_desktop_dark.png', 2200);
  await capture('http://127.0.0.1:3001/morning-report?theme=dark', 390, 844, true, 'test_ui_morning_report_mobile_dark.png', 2200);
  console.log('All visual screenshots captured successfully!');
  process.exit(0);
}

run().catch((err) => {
  console.error('Visual capture error:', err);
  process.exit(1);
});
