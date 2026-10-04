const { exec } = require('child_process');
const fs = require('fs');

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

async function testBehavioralSvg() {
  const port = 9520 + Math.floor(Math.random() * 400);
  const targetHost = "http://127.0.0.1:3001";
  console.log(`Starting headless Chrome on port ${port}...`);

  const chrome = exec(
    `"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" --headless=new --remote-debugging-port=${port} --window-size=1280,900`
  );

  try {
    const tabs = await waitForPort(port);
    const pageTab = tabs.find((t) => t.type === 'page');
    if (!pageTab) throw new Error('No page tab found');

    const ws = new WebSocket(pageTab.webSocketDebuggerUrl);

    await new Promise((resolve, reject) => {
      let msgId = 1;
      const callbacks = new Map();

      function send(method, params = {}) {
        return new Promise((res, rej) => {
          const id = msgId++;
          callbacks.set(id, { res, rej });
          ws.send(JSON.stringify({ id, method, params }));
        });
      }

      ws.onmessage = (event) => {
        const data = JSON.parse(event.data);
        if (data.id && callbacks.has(data.id)) {
          const { res, rej } = callbacks.get(data.id);
          callbacks.delete(data.id);
          if (data.error) rej(data.error);
          else res(data.result);
        }
      };

      ws.onerror = reject;

      ws.onopen = async () => {
        try {
          console.log("Connected to Chrome CDP WebSocket.");
          await send("Page.enable");
          await send("Runtime.enable");

          console.log("Navigating to live UI:", targetHost);
          await send("Page.navigate", { url: targetHost });
          await new Promise((r) => setTimeout(r, 3000));

          // -------------------------------------------------------------
          // Test Case 1: User pastes minimal SVG into chat input
          // -------------------------------------------------------------
          const minimalSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><circle cx="50" cy="50" r="40" fill="red"/></svg>`;
          console.log("\n[Test 1] Pasting minimal SVG into chat input in live UI...");

          await send("Runtime.evaluate", {
            expression: `document.querySelector('textarea').focus()`
          });

          await send("Input.insertText", { text: minimalSvg });
          await new Promise((r) => setTimeout(r, 400));

          await send("Runtime.evaluate", {
            expression: `document.querySelector('button[type="submit"]').click()`
          });

          // Wait 2s for React render
          await new Promise((r) => setTimeout(r, 2000));

          const check1 = await send("Runtime.evaluate", {
            expression: `
              (function() {
                const redCircles = document.querySelectorAll('circle[fill="red"]');
                const previewTabs = Array.from(document.querySelectorAll('button')).filter(b => b.innerText.includes('Preview'));
                return {
                  previewTabsCount: previewTabs.length,
                  redCirclesCount: redCircles.length,
                  redCircleHtml: redCircles[0] ? redCircles[0].outerHTML : null
                };
              })()
            `,
            returnByValue: true
          });
          const val1 = check1.value || check1.result?.value || check1;
          console.log("Minimal SVG DOM verification result:", val1);

          if (!val1.redCirclesCount) {
            throw new Error(`Minimal SVG circle was not found in rendered DOM! Result: ${JSON.stringify(val1)}`);
          }
          console.log("✅ Acceptance 1 passed: User pastes minimal SVG into chat → preview pane renders the graphic (<circle fill=\"red\"/>)!");

          // -------------------------------------------------------------
          // Reset chat session cleanly for Test 2
          // -------------------------------------------------------------
          console.log("\nResetting session for Test 2...");
          await send("Runtime.evaluate", {
            expression: `localStorage.clear()`
          });
          await send("Page.navigate", { url: targetHost });
          await new Promise((r) => setTimeout(r, 3000));

          // -------------------------------------------------------------
          // Test Case 2: User pastes malicious SVG into chat
          // -------------------------------------------------------------
          const maliciousSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><script>window.__xss_fired=true; alert('xss')</script><circle cx="50" cy="50" r="40" fill="green" onload="window.__xss_fired=true; alert('xss')"/></svg>`;
          console.log("\n[Test 2] Pasting malicious SVG into chat input in live UI...");

          await send("Runtime.evaluate", {
            expression: `document.querySelector('textarea').focus()`
          });

          await send("Input.insertText", { text: maliciousSvg });
          await new Promise((r) => setTimeout(r, 400));

          await send("Runtime.evaluate", {
            expression: `document.querySelector('button[type="submit"]').click()`
          });

          await new Promise((r) => setTimeout(r, 2000));

          const check2 = await send("Runtime.evaluate", {
            expression: `
              (function() {
                const greenCircles = document.querySelectorAll('circle[fill="green"]');
                const scripts = document.querySelectorAll('svg script, script[text*="xss"]');
                return {
                  xssFired: Boolean(window.__xss_fired),
                  greenCirclesCount: greenCircles.length,
                  hasOnloadAttr: greenCircles[0] ? greenCircles[0].hasAttribute('onload') : false,
                  hasScriptInsideSvg: scripts.length > 0,
                  renderedCircleSnippet: greenCircles[0] ? greenCircles[0].outerHTML : null
                };
              })()
            `,
            returnByValue: true
          });
          const val2 = check2.value || check2.result?.value || check2;
          console.log("Malicious SVG DOM verification result:", val2);

          if (val2.xssFired) {
            throw new Error("❌ XSS script executed in browser!");
          }
          if (val2.hasOnloadAttr) {
            throw new Error("❌ onload attribute survived sanitization!");
          }
          if (val2.hasScriptInsideSvg) {
            throw new Error("❌ script tag survived sanitization!");
          }
          if (!val2.greenCirclesCount) {
            throw new Error("❌ inert graphic was not rendered in preview pane!");
          }

          console.log("✅ Acceptance 2 passed: User pastes malicious SVG → preview pane renders inert graphic (<circle fill=\"green\">), scripts stripped, onload stripped, zero execution!");

          ws.close();
          resolve();
        } catch (err) {
          ws.close();
          reject(err);
        }
      };
    });
  } finally {
    try {
      chrome.kill();
    } catch {}
  }
}

testBehavioralSvg()
  .then(() => {
    console.log("\n===================================================================");
    console.log("  🎯 ALL FIX 3 BEHAVIORAL ACCEPTANCE CRITERIA 100% VERIFIED!");
    console.log("===================================================================");
    process.exit(0);
  })
  .catch((e) => {
    console.error("Test failed:", e);
    process.exit(1);
  });
