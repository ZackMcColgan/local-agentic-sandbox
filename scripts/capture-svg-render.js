const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');

async function waitForPort(port, maxRetries = 20) {
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
    content: "Draw an architecture diagram for a two-tier application in SVG format."
  },
  {
    id: "assistant-1",
    role: "assistant",
    content: "There we go! The SVG has been written via the tool call to `two_tier_architecture.svg` in your workspace, featuring web presentation and server data tiers with secure boundary isolation.",
    traces: [
      {
        tool: "workspace_write_file",
        durationMs: 6,
        timestamp: "2026-10-02T16:09:00.000Z",
        args: {
          path: "two_tier_architecture.svg",
          content: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 240" width="100%" height="240">
  <defs>
    <linearGradient id="gClient" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" style="stop-color:#38bdf8;stop-opacity:1" />
      <stop offset="100%" style="stop-color:#0284c7;stop-opacity:1" />
    </linearGradient>
    <linearGradient id="gServer" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" style="stop-color:#10b981;stop-opacity:1" />
      <stop offset="100%" style="stop-color:#047857;stop-opacity:1" />
    </linearGradient>
  </defs>
  <rect x="5" y="5" width="590" height="230" rx="14" fill="#ffffff" stroke="#cbd5e1" stroke-width="1.5" />
  <text x="300" y="32" text-anchor="middle" font-family="system-ui, sans-serif" font-size="15" font-weight="bold" fill="#0f172a">Two-Tier Application Architecture</text>
  
  <!-- Tier 1 -->
  <rect x="30" y="55" width="240" height="155" rx="10" fill="#f0f9ff" stroke="#38bdf8" stroke-width="1.5" stroke-dasharray="4,3" />
  <text x="150" y="80" text-anchor="middle" font-family="system-ui, sans-serif" font-size="13" font-weight="bold" fill="#0284c7">TIER 1: PRESENTATION</text>
  <rect x="50" y="95" width="200" height="42" rx="8" fill="url(#gClient)" />
  <text x="150" y="121" text-anchor="middle" font-family="system-ui, sans-serif" font-size="12" font-weight="bold" fill="#ffffff">Web &amp; Mobile UI</text>
  <rect x="50" y="148" width="200" height="42" rx="8" fill="#e0f2fe" stroke="#7dd3fc" />
  <text x="150" y="174" text-anchor="middle" font-family="system-ui, sans-serif" font-size="11" fill="#0369a1">Client State &amp; Validation</text>

  <!-- Flow Arrow -->
  <path d="M 280 135 L 320 135" stroke="#64748b" stroke-width="2" marker-end="url(#arrowhead)" />
  <text x="300" y="125" text-anchor="middle" font-family="system-ui, sans-serif" font-size="10" font-weight="bold" fill="#475569">HTTPS</text>

  <!-- Tier 2 -->
  <rect x="330" y="55" width="240" height="155" rx="10" fill="#ecfdf5" stroke="#10b981" stroke-width="1.5" stroke-dasharray="4,3" />
  <text x="450" y="80" text-anchor="middle" font-family="system-ui, sans-serif" font-size="13" font-weight="bold" fill="#047857">TIER 2: DATA &amp; LOGIC</text>
  <rect x="350" y="95" width="200" height="42" rx="8" fill="url(#gServer)" />
  <text x="450" y="121" text-anchor="middle" font-family="system-ui, sans-serif" font-size="12" font-weight="bold" fill="#ffffff">Backend API Service</text>
  <rect x="350" y="148" width="200" height="42" rx="8" fill="#d1fae5" stroke="#6ee7b7" />
  <text x="450" y="174" text-anchor="middle" font-family="system-ui, sans-serif" font-size="11" fill="#065f46">PostgreSQL &amp; Storage</text>
</svg>`
        },
        result: {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                status: "SUCCESS",
                path: "two_tier_architecture.svg",
                bytes_written: 2450,
                is_diagram: true
              })
            }
          ]
        }
      }
    ]
  },
  {
    id: "user-2",
    role: "user",
    content: "Render two_tier_aws_architecture.drawio.svg as well"
  },
  {
    id: "assistant-2",
    role: "assistant",
    content: "I have updated the diagram for AWS cloud environment with ALB, Web Servers, ElastiCache Redis, and RDS database layers.",
    traces: [
      {
        tool: "workspace_write_file",
        durationMs: 8,
        timestamp: "2026-10-02T17:33:00.000Z",
        args: {
          path: "two_tier_aws_architecture.drawio.svg",
          content: `<mxfile host="app.diagrams.net" modified="2024-07-25T12:00:00.000Z" agent="AI Agent" version="24.4.13" type="device">
  <diagram id="two_tier_aws" name="Two Tier AWS Architecture">
    <mxGraphModel dx="1434" dy="846" grid="1" gridSize="10" guides="1" tooltips="1" connect="1" arrows="1" fold="1" page="1" pageScale="1" pageWidth="850" pageHeight="1100">
      <root>
        <mxCell id="0"/>
        <mxCell id="1" parent="0"/>
        <mxCell id="vpc" value="VPC Network" style="rounded=1;fillColor=#e1d5e7;strokeColor=#9673a6;" vertex="1" parent="1">
          <mxGeometry x="0" y="0" width="850" height="900" as="geometry"/>
        </mxCell>
        <mxCell id="aws_boundary" value="AWS Cloud Environment" style="rounded=1;fillColor=#f8cecc;strokeColor=#b85450;" vertex="1" parent="1">
          <mxGeometry x="50" y="50" width="750" height="800" as="geometry"/>
        </mxCell>
        <mxCell id="elb" value="Application Load Balancer (ALB)" style="shape=cylinder;fillColor=#dae8fc;strokeColor=#6c8ebf;" vertex="1" parent="aws_boundary">
          <mxGeometry x="100" y="150" width="150" height="80" as="geometry"/>
        </mxCell>
        <mxCell id="web_tier" value="Web/Presentation Tier (EC2/ECS/Lambda)" style="rounded=1;fillColor=#d5e8d4;strokeColor=#82b366;" vertex="1" parent="aws_boundary">
          <mxGeometry x="300" y="130" width="300" height="100" as="geometry"/>
        </mxCell>
        <mxCell id="rds" value="RDS Database (PostgreSQL/MySQL)" style="shape=cylinder;fillColor=#f8cecc;strokeColor=#b85450;" vertex="1" parent="aws_boundary">
          <mxGeometry x="550" y="400" width="150" height="80" as="geometry"/>
        </mxCell>
        <mxCell id="cache" value="ElastiCache (Redis)" style="shape=cylinder;fillColor=#dae8fc;strokeColor=#6c8ebf;" vertex="1" parent="aws_boundary">
          <mxGeometry x="350" y="400" width="150" height="80" as="geometry"/>
        </mxCell>
        <mxCell id="conn_elb_to_web" value="HTTP/S Traffic" style="endArrow=classic;strokeColor=#2563eb;" edge="1" parent="vpc" source="elb" target="web_tier">
          <mxGeometry relative="1" as="geometry"/>
        </mxCell>
        <mxCell id="conn_web_to_cache" value="Cache Read/Write" style="endArrow=classic;strokeColor=#2563eb;" edge="1" parent="vpc" source="web_tier" target="cache">
          <mxGeometry relative="1" as="geometry"/>
        </mxCell>
      </root>
    </mxGraphModel>
  </diagram>
</mxfile>`
        },
        result: {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                status: "SUCCESS",
                path: "two_tier_aws_architecture.drawio.svg",
                bytes_written: 5566,
                is_diagram: true
              })
            }
          ]
        }
      }
    ]
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
        }, 500);

        // 3. Wait for reload, DOM render, and capture screenshot
        setTimeout(() => {
          ws.send(
            JSON.stringify({
              id: 3,
              method: 'Page.captureScreenshot',
              params: { format: 'png' },
            })
          );
        }, 2500);
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
  const targetHost = "http://127.0.0.1:3001";
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
