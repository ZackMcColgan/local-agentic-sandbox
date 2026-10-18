const { exec } = require('child_process');
const fs = require('fs');

const os = require('os');
const path = require('path');

setTimeout(() => {
  console.error(JSON.stringify({ pass: false, error: "deadline exceeded" }));
  process.exit(1);
}, 180_000).unref();

async function waitForPort(port, maxRetries = 15) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json`, { signal: AbortSignal.timeout(15000) });
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
        ws.send(JSON.stringify({ id: 5, method: 'Runtime.enable' }));

        setTimeout(() => {
          // Assert zero horizontal overflow via CDP Runtime.evaluate
          ws.send(
            JSON.stringify({
              id: 4,
              method: 'Runtime.evaluate',
              params: {
                expression: '({ scrollWidth: document.documentElement.scrollWidth, innerWidth: window.innerWidth })',
                returnByValue: true,
              },
            })
          );
        }, delayMs);
      };

      ws.onmessage = (event) => {
        const data = JSON.parse(event.data);
        if (data.id === 4) {
          const evalRes = data.result?.result?.value;
          if (evalRes) {
            const { scrollWidth, innerWidth } = evalRes;
            // Tolerance of 1px for subpixel CSS calculations
            if (scrollWidth > innerWidth + 1) {
              ws.close();
              return reject(
                new Error(
                  `Horizontal scroll overflow detected at ${width}x${height} (${url}): scrollWidth ${scrollWidth} > innerWidth ${innerWidth}`
                )
              );
            }
          }
          // Zero overflow assertion passed — capture screenshot
          ws.send(
            JSON.stringify({
              id: 2,
              method: 'Page.captureScreenshot',
              params: { format: 'png' },
            })
          );
        } else if (data.id === 2) {
          fs.writeFileSync(outputPath, Buffer.from(data.result.data, 'base64'));
          console.log(`Saved ${outputPath} [${width}x${height}, zero horizontal overflow confirmed]`);
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

async function getBaseUrl() {
  if (process.env.UI_URL) return process.env.UI_URL;
  const candidates = ['http://127.0.0.1:3005', 'http://127.0.0.1:3001'];
  for (const c of candidates) {
    try {
      const res = await fetch(c, { signal: AbortSignal.timeout(15000) });
      if (res.status < 500) return c;
    } catch {}
  }
  return 'http://127.0.0.1:3001';
}

async function run() {
  const baseUrl = await getBaseUrl();
  console.log(`Capturing visual test screenshots against ${baseUrl} across 3 viewports (Mobile, Desktop, Ultrawide) and Light/Dark modes...`);
  let threadQuery = '';
  try {
    const tRes = await fetch(`${baseUrl}/api/threads`, { signal: AbortSignal.timeout(15000) });
    if (tRes.ok) {
      const tData = await tRes.json();
      if (tData.threads && tData.threads.length > 0) {
        threadQuery = `&thread=${encodeURIComponent(tData.threads[0].id)}`;
      }
    }
  } catch {}

  // 1. Mobile (390×844) Light & Dark
  await capture(`${baseUrl}/?theme=light${threadQuery}`, 390, 844, true, 'test_ui_mobile_light.png');
  await capture(`${baseUrl}/?theme=dark${threadQuery}`, 390, 844, true, 'test_ui_mobile_dark.png');

  // 2. Desktop (1440×900) Light & Dark
  await capture(`${baseUrl}/?theme=light${threadQuery}`, 1440, 900, false, 'test_ui_desktop_light.png');
  await capture(`${baseUrl}/?theme=dark${threadQuery}`, 1440, 900, false, 'test_ui_desktop_dark.png');

  // 3. Ultrawide (3440×1440) Light & Dark
  await capture(`${baseUrl}/?theme=light${threadQuery}`, 3440, 1440, false, 'test_ui_ultrawide_light.png');
  await capture(`${baseUrl}/?theme=dark${threadQuery}`, 3440, 1440, false, 'test_ui_ultrawide_dark.png');

  // Hubs & Specialized Views (Light & Dark)
  await capture(`${baseUrl}/?theme=light&tab=skills`, 1440, 900, false, 'test_ui_skills_desktop_light.png');
  await capture(`${baseUrl}/?theme=dark&tab=skills`, 1440, 900, false, 'test_ui_skills_desktop_dark.png');
  await capture(`${baseUrl}/?theme=light&tab=builds`, 1440, 900, false, 'test_ui_builds_desktop_light.png');
  await capture(`${baseUrl}/?theme=dark&tab=builds`, 1440, 900, false, 'test_ui_builds_desktop_dark.png');
  await capture(`${baseUrl}/?theme=dark&tab=security`, 1440, 900, false, 'test_ui_telemetry_desktop.png');
  await capture(`${baseUrl}/?theme=light&tab=security`, 390, 844, true, 'test_ui_telemetry_mobile.png');

  // Settings Views (Light & Dark)
  await capture(`${baseUrl}/?theme=light&tab=settings`, 1440, 900, false, 'test_ui_settings_desktop_light.png');
  await capture(`${baseUrl}/?theme=dark&tab=settings`, 1440, 900, false, 'test_ui_settings_desktop_dark.png');
  await capture(`${baseUrl}/?theme=light&tab=settings`, 390, 844, true, 'test_ui_settings_mobile_light.png');
  await capture(`${baseUrl}/?theme=dark&tab=settings`, 390, 844, true, 'test_ui_settings_mobile_dark.png');

  // Morning Report Views
  await capture(`${baseUrl}/morning-report?theme=light`, 1440, 900, false, 'test_ui_morning_report_desktop_light.png', 2200);
  await capture(`${baseUrl}/morning-report?theme=light`, 390, 844, true, 'test_ui_morning_report_mobile_light.png', 2200);
  await capture(`${baseUrl}/morning-report?theme=dark`, 1440, 900, false, 'test_ui_morning_report_desktop_dark.png', 2200);
  await capture(`${baseUrl}/morning-report?theme=dark`, 390, 844, true, 'test_ui_morning_report_mobile_dark.png', 2200);

  console.log('All visual screenshots across all 3 viewports captured successfully with zero overflow!');
  process.exit(0);
}

run().catch((err) => {
  console.error('Visual capture error:', err);
  process.exit(1);
});
