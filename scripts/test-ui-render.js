const { exec } = require('child_process');
const fs = require('fs');

async function capture(url, width, height, isMobile, outputPath) {
  return new Promise((resolve, reject) => {
    const port = 9222 + Math.floor(Math.random() * 100);
    const chrome = exec(`"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" --headless=new --remote-debugging-port=${port} "${url}"`);

    setTimeout(async () => {
      try {
        const listRes = await fetch(`http://127.0.0.1:${port}/json`);
        const tabs = await listRes.json();
        const pageTab = tabs.find(t => t.type === 'page');
        if (!pageTab) throw new Error('No page tab');

        const ws = new WebSocket(pageTab.webSocketDebuggerUrl);

        ws.onopen = () => {
          ws.send(JSON.stringify({
            id: 1,
            method: 'Emulation.setDeviceMetricsOverride',
            params: {
              width,
              height,
              deviceScaleFactor: 1,
              mobile: isMobile
            }
          }));

          setTimeout(() => {
            ws.send(JSON.stringify({
              id: 2,
              method: 'Page.captureScreenshot',
              params: { format: 'png' }
            }));
          }, 600);
        };

        ws.onmessage = (event) => {
          const data = JSON.parse(event.data);
          if (data.id === 2) {
            fs.writeFileSync(outputPath, Buffer.from(data.result.data, 'base64'));
            console.log(`Saved ${outputPath}`);
            ws.close();
            chrome.kill();
            resolve();
          }
        };
      } catch (err) {
        chrome.kill();
        reject(err);
      }
    }, 1500);
  });
}

async function run() {
  console.log('Capturing visual test screenshots...');
  await capture('http://127.0.0.1:3001/?theme=light', 1280, 800, false, 'test_ui_desktop_light.png');
  await capture('http://127.0.0.1:3001/?theme=light', 390, 844, true, 'test_ui_mobile_light.png');
  await capture('http://127.0.0.1:3001/?theme=dark', 1280, 800, false, 'test_ui_desktop_dark.png');
  await capture('http://127.0.0.1:3001/?theme=dark', 390, 844, true, 'test_ui_mobile_dark.png');
  console.log('All visual screenshots captured successfully!');
  process.exit(0);
}

run().catch(console.error);
