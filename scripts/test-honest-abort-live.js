const http = require('http');
const { execSync } = require('child_process');

const CHAT_URL = 'http://localhost/api/chat';
const K8S_NAMESPACE = 'local-agentic-sandbox';

function run(cmd) {
  console.log(`[cmd] ${cmd}`);
  return execSync(cmd, { encoding: 'utf8' }).trim();
}

function sendChatStream(payload, timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    const url = new URL(CHAT_URL);
    const bodyStr = JSON.stringify(payload);

    const req = http.request({
      hostname: url.hostname,
      port: url.port || 80,
      path: url.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(bodyStr)
      }
    });

    let buffer = '';
    const events = [];
    const traces = [];
    let assistantContent = '';
    let timedOut = false;
    let webCallCount = 0;

    const timer = setTimeout(() => {
      timedOut = true;
      req.destroy(new Error(`Turn timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    req.on('response', (res) => {
      if (res.statusCode !== 200) {
        clearTimeout(timer);
        return reject(new Error(`Chat endpoint returned status ${res.statusCode}`));
      }

      res.on('data', (chunk) => {
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop(); // keep remainder

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith('data:')) continue;
          const dataStr = trimmed.slice(5).trim();
          if (!dataStr || dataStr === '[DONE]') continue;

          try {
            const ev = JSON.parse(dataStr);
            events.push(ev);

            if (ev.type === 'trace' && ev.trace) {
              traces.push(ev.trace);
              if (ev.trace.tool === 'search_web') {
                webCallCount++;
                console.log(`[trace:search_web] args: ${JSON.stringify(ev.trace.args)} | duration: ${ev.trace.durationMs}ms`);
                if (webCallCount > 3) {
                  req.destroy(new Error('Exceeded max web-research calls (>3)'));
                  return;
                }
              } else if (ev.trace.tool === 'grounding_gate') {
                console.log(`[trace:grounding_gate] ${JSON.stringify(ev.trace.result)}`);
              }
            } else if (ev.type === 'token' && ev.content) {
              assistantContent += ev.content;
            } else if (ev.type === 'done' && ev.content) {
              assistantContent = ev.content;
            }
          } catch (e) {
            // ignore parse err
          }
        }
      });

      res.on('end', () => {
        clearTimeout(timer);
        resolve({
          events,
          traces,
          content: assistantContent,
          timedOut: false
        });
      });
    });

    req.on('error', (err) => {
      clearTimeout(timer);
      if (timedOut) {
        resolve({ events, traces, content: assistantContent, timedOut: true });
      } else {
        reject(err);
      }
    });

    req.write(bodyStr);
    req.end();
  });
}

async function main() {
  console.log('=== WORK ITEM B: HONEST-ABORT LIVE PROOF ===\n');

  // STEP 1: Enable test hook SEARCH_FORCE_EMPTY_RESULTS=1
  console.log('--- Step 1: Enabling SEARCH_FORCE_EMPTY_RESULTS=1 on browser-mcp ---');
  run(`kubectl set env deployment/browser-mcp SEARCH_FORCE_EMPTY_RESULTS=1 -n ${K8S_NAMESPACE}`);
  run(`kubectl rollout status deployment/browser-mcp -n ${K8S_NAMESPACE} --timeout=60s`);
  console.log('Waiting 5s for pod readiness...');
  await new Promise(r => setTimeout(r, 5000));
  console.log('✔ browser-mcp configured with SEARCH_FORCE_EMPTY_RESULTS=1\n');

  // STEP 2: Send live query with hook ON
  console.log('--- Step 2: Testing live prompt with hook ON ("weather today in Spanish Fort AL") ---');
  const t0 = Date.now();
  const resEmpty = await sendChatStream({
    messages: [{ role: 'user', content: 'weather today in Spanish Fort AL' }],
    model: 'swift-15-27b-mtp',
    mode: 'auto',
    reasoning_effort: 'medium',
    threadId: `live-abort-test-${Date.now()}`
  }, 120000);
  const durSec = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`\nTurn completed in ${durSec}s (timedOut: ${resEmpty.timedOut})`);

  // Assertions with hook ON
  console.log('\n--- Step 3: Assertions on Trace & Content ---');
  const searchTrace = resEmpty.traces.find(t => t.tool === 'search_web');
  if (!searchTrace) {
    throw new Error('FAIL: search_web was NOT called');
  }
  console.log('✔ Assertion 1 PASS: search_web was called');

  // Check search_web returned empty
  const rawResult = typeof searchTrace.result === 'string'
    ? searchTrace.result
    : JSON.stringify(searchTrace.result || {});
  console.log(`search_web result snippet: ${rawResult.slice(0, 150)}`);

  let innerResults = null;
  try {
    if (searchTrace.result?.content?.[0]?.text) {
      innerResults = JSON.parse(searchTrace.result.content[0].text);
    } else if (typeof searchTrace.result === 'object') {
      innerResults = searchTrace.result;
    }
  } catch {}

  const isEmptyResults = (innerResults && Array.isArray(innerResults.results) && innerResults.results.length === 0)
    || (rawResult.includes('results') && rawResult.includes('[]'));
  if (!isEmptyResults) {
    throw new Error(`FAIL: search_web did not return { results: [] }. Got: ${rawResult}`);
  }
  console.log('✔ Assertion 2 PASS: search_web returned empty ({ results: [] })');

  // Check HONEST_ABORT_DIRECTIVE injected
  const abortTrace = resEmpty.traces.find(t =>
    t.tool === 'grounding_gate' ||
    JSON.stringify(t).includes('Live data could not be retrieved') ||
    JSON.stringify(t).includes('HONEST_ABORT')
  );
  if (!abortTrace) {
    console.warn('Notice: grounding_gate trace event check. Checking all events for abort directive...');
  }
  const hasAbortDirective = resEmpty.events.some(e =>
    JSON.stringify(e).includes('Live data could not be retrieved') ||
    JSON.stringify(e).includes('HONEST_ABORT') ||
    (e.trace && e.trace.tool === 'grounding_gate')
  );
  if (!hasAbortDirective && !abortTrace) {
    throw new Error('FAIL: HONEST_ABORT_DIRECTIVE was not detected in traces or events');
  }
  console.log('✔ Assertion 3 PASS: HONEST_ABORT_DIRECTIVE was injected and visible in trace');

  // Check final message states retrieval failed
  console.log(`\nFinal Assistant Content:\n----------------------------------------\n${resEmpty.content.trim()}\n----------------------------------------\n`);
  const honestFailurePhrases = [
    /could not (be )?retrieve/i,
    /(wasn't|was not|not|unable) (to|able to) (retrieve|get|fetch)/i,
    /cannot (provide|retrieve|access)/i,
    /failed to (retrieve|fetch|find)/i,
    /no live (weather|data)/i
  ];
  const statesRetrievalFailed = honestFailurePhrases.some(p => p.test(resEmpty.content));
  if (!statesRetrievalFailed) {
    throw new Error('FAIL: Final message does not clearly state retrieval failed');
  }
  console.log('✔ Assertion 4 PASS: Final message states retrieval failed');

  // Check ZERO live figures (no temperatures °F or °C)
  const tempRegex = /[°º]\s*[FC]\b|\b\d+\s*(degrees\s+)?(fahrenheit|celsius)\b/i;
  if (tempRegex.test(resEmpty.content)) {
    throw new Error(`FAIL: Final message contains fabricated temperature figure! Matched: ${resEmpty.content.match(tempRegex)[0]}`);
  }
  console.log('✔ Assertion 5 PASS: Zero live figures detected (no °F or °C anywhere in response)');

  // STEP 4: Disable hook
  console.log('\n--- Step 4: Disabling SEARCH_FORCE_EMPTY_RESULTS (Hook OFF) ---');
  run(`kubectl set env deployment/browser-mcp SEARCH_FORCE_EMPTY_RESULTS- -n ${K8S_NAMESPACE}`);
  run(`kubectl rollout status deployment/browser-mcp -n ${K8S_NAMESPACE} --timeout=60s`);
  console.log('Waiting 5s for pod readiness...');
  await new Promise(r => setTimeout(r, 5000));
  console.log('✔ browser-mcp hook turned OFF\n');

  // STEP 5: Sanity check with hook OFF
  console.log('--- Step 5: Sanity check with normal search (Hook OFF) ---');
  const t1 = Date.now();
  const resNormal = await sendChatStream({
    messages: [{ role: 'user', content: 'weather today in Spanish Fort AL' }],
    model: 'swift-15-27b-mtp',
    mode: 'auto',
    reasoning_effort: 'medium',
    threadId: `live-normal-test-${Date.now()}`
  }, 120000);
  const durNormalSec = ((Date.now() - t1) / 1000).toFixed(1);
  console.log(`\nNormal turn completed in ${durNormalSec}s`);

  const normalSearchTrace = resNormal.traces.find(t => t.tool === 'search_web');
  if (!normalSearchTrace) {
    throw new Error('FAIL: search_web was not called in sanity check');
  }
  const normalResult = typeof normalSearchTrace.result === 'string'
    ? normalSearchTrace.result
    : JSON.stringify(normalSearchTrace.result || {});
  if (normalResult.includes('"results":[]') || normalResult.length < 200) {
    throw new Error('FAIL: search_web did not return real substantive data with hook OFF');
  }
  console.log('✔ Sanity Check PASS: search_web retrieved real data (>200 chars, SUCCESS)');
  console.log(`Snippet: ${normalResult.slice(0, 150)}`);

  console.log('\n======================================================');
  console.log('WORK ITEM B PROOF COMPLETED SUCCESSFULLY!');
  console.log('======================================================');
}

main().catch(err => {
  console.error('\n❌ Work Item B Error:', err.message);
  // Always attempt to turn off hook on error
  try {
    run(`kubectl set env deployment/browser-mcp SEARCH_FORCE_EMPTY_RESULTS- -n ${K8S_NAMESPACE}`);
  } catch {}
  process.exit(1);
});
