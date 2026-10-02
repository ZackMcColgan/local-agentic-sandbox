const { exec } = require('child_process');
const fs = require('fs');
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

const mockMessages = JSON.stringify([
  {
    id: "user-1",
    role: "user",
    content: "Can you generate a secure cluster architecture diagram and render the SVG vector graphic?"
  },
  {
    id: "assistant-1",
    role: "assistant",
    content: `Here is the requested SVG vector diagram:

\`\`\`svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 540 180" width="100%" height="180">
  <defs>
    <linearGradient id="grad1" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" style="stop-color:#059669;stop-opacity:1" />
      <stop offset="100%" style="stop-color:#0284c7;stop-opacity:1" />
    </linearGradient>
  </defs>
  <rect x="10" y="10" width="520" height="160" rx="14" fill="#ffffff" stroke="#10b981" stroke-width="2" />
  <circle cx="60" cy="90" r="30" fill="url(#grad1)" />
  <text x="110" y="70" font-family="system-ui, sans-serif" font-size="16" font-weight="bold" fill="#0f172a">Zero-Trust Kubernetes AI Sandbox</text>
  <text x="110" y="95" font-family="system-ui, sans-serif" font-size="12" fill="#475569">Real-time vector rendering with zoom, pan, and code inspection</text>
  <rect x="110" y="115" width="120" height="26" rx="6" fill="#10b981" />
  <text x="130" y="132" font-family="system-ui, sans-serif" font-size="11" font-weight="600" fill="#ffffff">SLSA-3 Verified</text>
  <rect x="240" y="115" width="130" height="26" rx="6" fill="#0284c7" />
  <text x="252" y="132" font-family="system-ui, sans-serif" font-size="11" font-weight="600" fill="#ffffff">Air-Gapped Mesh</text>
</svg>
\`\`\`

You can also view the repository architecture diagram file:
![Architecture Diagram](docs/architecture.drawio.svg)

File link: [docs/architecture.drawio.svg](docs/architecture.drawio.svg)`
  }
]);

async function captureSvg(url, width, height, isMobile, outputPath) {
  const port = 9400 + Math.floor(Math.random() * 500);
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
        // 1. Set emulation metrics
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

        // 2. Inject mock SVG chat history into localStorage
        setTimeout(() => {
          ws.send(
            JSON.stringify({
              id: 2,
              method: 'Runtime.evaluate',
              params: {
                expression: `
                  localStorage.setItem('local_agent_chat_history_v1', ${JSON.stringify(mockMessages)});
                  location.reload();
                `
              }
            })
          );
        }, 600);

        // 3. Wait for reload and capture screenshot
        setTimeout(() => {
          ws.send(
            JSON.stringify({
              id: 3,
              method: 'Page.captureScreenshot',
              params: { format: 'png' },
            })
          );
        }, 2200);
      };

      ws.onmessage = (event) => {
        const data = JSON.parse(event.data);
        if (data.id === 3 && data.result?.data) {
          fs.writeFileSync(outputPath, Buffer.from(data.result.data, 'base64'));
          console.log(`Saved screenshot: ${outputPath}`);
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
    await new Promise((r) => setTimeout(r, 400));
  }
}

async function run() {
  const targetHost = "http://127.0.0.1:3005";
  console.log("Starting SVG visual verification capture suite across 4 viewports...");

  await captureSvg(`${targetHost}/?theme=light`, 1280, 900, false, "test_svg_desktop_light.png");
  await captureSvg(`${targetHost}/?theme=light`, 390, 844, true, "test_svg_mobile_light.png");
  await captureSvg(`${targetHost}/?theme=dark`, 1280, 900, false, "test_svg_desktop_dark.png");
  await captureSvg(`${targetHost}/?theme=dark`, 390, 844, true, "test_svg_mobile_dark.png");

  console.log("All visual screenshots captured successfully!");
  process.exit(0);
}


run().catch((err) => {
  console.error("SVG visual capture failed:", err);
  process.exit(1);
});
