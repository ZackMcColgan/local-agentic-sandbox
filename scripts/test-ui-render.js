const { exec } = require('child_process');
const fs = require('fs');

async function waitForPort(port, maxRetries = 10) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json`);
      if (res.ok) return await res.json();
    } catch {}
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error(`Failed to connect to Chrome on port ${port}`);
}

async function capture(url, width, height, isMobile, outputPath) {
  const port = 9300 + Math.floor(Math.random() * 500);
  const chrome = exec(
    `"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" --headless=new --remote-debugging-port=${port} --window-size=${width},${height} "${url}"`
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

        setTimeout(() => {
          ws.send(
            JSON.stringify({
              id: 2,
              method: 'Page.captureScreenshot',
              params: { format: 'png' },
            })
          );
        }, 800);
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
  await capture('http://127.0.0.1:3001/?theme=light', 1280, 800, false, 'test_ui_desktop_light.png');
  await capture('http://127.0.0.1:3001/?theme=light', 390, 844, true, 'test_ui_mobile_light.png');
  await capture('http://127.0.0.1:3001/?theme=dark', 1280, 800, false, 'test_ui_desktop_dark.png');
  await capture('http://127.0.0.1:3001/?theme=dark', 390, 844, true, 'test_ui_mobile_dark.png');
  await capture('http://127.0.0.1:3001/?theme=dark&tab=security', 1280, 900, false, 'test_ui_telemetry_desktop.png');
  await capture('http://127.0.0.1:3001/?theme=light&tab=security', 390, 844, true, 'test_ui_telemetry_mobile.png');
  await capture('http://127.0.0.1:3001/?theme=light&tab=overnight', 1280, 800, false, 'test_ui_builder_desktop_light.png');
  await capture('http://127.0.0.1:3001/?theme=dark&tab=overnight', 390, 844, true, 'test_ui_builder_mobile_dark.png');
  console.log('All visual screenshots captured successfully!');
  process.exit(0);
}

run().catch((err) => {
  console.error('Visual capture error:', err);
  process.exit(1);
});
