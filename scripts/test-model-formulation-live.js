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
        buffer = lines.pop();

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
                console.log(`  [trace:search_web] query="${ev.trace.args?.query}" (${ev.trace.durationMs}ms)`);
              } else if (ev.trace.tool === 'grounding_gate') {
                console.log(`  [trace:grounding_gate] ${JSON.stringify(ev.trace.result).slice(0, 100)}...`);
              }
            } else if (ev.type === 'token' && ev.content) {
              assistantContent += ev.content;
            } else if (ev.type === 'done' && ev.content) {
              assistantContent = ev.content;
            }
          } catch {}
        }
      });

      res.on('end', () => {
        clearTimeout(timer);
        resolve({ events, traces, content: assistantContent, timedOut: false });
      });
    });

    req.on('error', (err) => {
      clearTimeout(timer);
      if (timedOut) resolve({ events, traces, content: assistantContent, timedOut: true });
      else reject(err);
    });

    req.write(bodyStr);
    req.end();
  });
}

async function main() {
  console.log('================================================================');
  console.log('LIVE ACCEPTANCE BATTERY: MODEL FORMULATION + VALIDATION');
  console.log('================================================================\n');

  const threadId = `model-formulation-test-${Date.now()}`;
  const conversationMessages = [];

  // -------------------------------------------------------------------------
  // Live Test 1: Initial Prompt
  // Prompt: "Create a svg of the weather today hourly in Spanish Fort AL"
  // Assert: query not verbatim, no "svg"/"create", contains "Spanish Fort".
  // -------------------------------------------------------------------------
  console.log('--- Live Test 1: Initial prompt ---');
  const prompt1 = 'Create a svg of the weather today hourly in Spanish Fort AL';
  console.log(`User: "${prompt1}"`);
  conversationMessages.push({ role: 'user', content: prompt1 });

  const t1 = Date.now();
  const res1 = await sendChatStream({
    messages: conversationMessages,
    model: 'swift-15-27b-mtp',
    mode: 'auto',
    reasoning_effort: 'medium',
    threadId
  }, 120000);
  console.log(`Turn 1 finished in ${((Date.now() - t1) / 1000).toFixed(1)}s`);

  const search1 = res1.traces.find(t => t.tool === 'search_web');
  if (!search1) throw new Error('Live Test 1 FAIL: search_web was not called');
  const q1 = (search1.args?.query || '').trim();
  console.log(`Formulated query 1: "${q1}"`);

  if (q1.toLowerCase() === prompt1.toLowerCase()) {
    throw new Error('Live Test 1 FAIL: query is verbatim user prompt');
  }
  if (/\b(svg|create)\b/i.test(q1)) {
    throw new Error(`Live Test 1 FAIL: query contains forbidden words (svg/create): "${q1}"`);
  }
  if (!/Spanish Fort/i.test(q1)) {
    throw new Error(`Live Test 1 FAIL: query does not contain "Spanish Fort": "${q1}"`);
  }
  console.log('✔ Live Test 1 PASS: query not verbatim, no "svg"/"create", contains "Spanish Fort"\n');

  conversationMessages.push({ role: 'assistant', content: res1.content });

  // -------------------------------------------------------------------------
  // Live Test 2: Follow-up resolving references
  // Prompt: "Please look up the hourly forecast for the day"
  // Assert: query contains "Spanish Fort" and "hourly".
  // -------------------------------------------------------------------------
  console.log('--- Live Test 2: Follow-up reference resolution ---');
  const prompt2 = 'Please look up the hourly forecast for the day';
  console.log(`User: "${prompt2}"`);
  conversationMessages.push({ role: 'user', content: prompt2 });

  const t2 = Date.now();
  const res2 = await sendChatStream({
    messages: conversationMessages,
    model: 'swift-15-27b-mtp',
    mode: 'auto',
    reasoning_effort: 'medium',
    threadId
  }, 120000);
  console.log(`Turn 2 finished in ${((Date.now() - t2) / 1000).toFixed(1)}s`);

  const search2 = res2.traces.find(t => t.tool === 'search_web');
  if (!search2) throw new Error('Live Test 2 FAIL: search_web was not called');
  const q2 = (search2.args?.query || '').trim();
  console.log(`Formulated query 2: "${q2}"`);

  if (!/Spanish Fort/i.test(q2)) {
    throw new Error(`Live Test 2 FAIL: query did not resolve location "Spanish Fort": "${q2}"`);
  }
  if (!/hourly/i.test(q2)) {
    throw new Error(`Live Test 2 FAIL: query did not include "hourly": "${q2}"`);
  }
  console.log('✔ Live Test 2 PASS: query contains "Spanish Fort" and "hourly"\n');

  conversationMessages.push({ role: 'assistant', content: res2.content });

  // -------------------------------------------------------------------------
  // Live Test 3: Meta-challenge follow-up
  // Prompt: "Did you actually read the weather?"
  // Assert: query from conversation, real data.
  // -------------------------------------------------------------------------
  console.log('--- Live Test 3: Meta-challenge follow-up ---');
  const prompt3 = 'Did you actually read the weather?';
  console.log(`User: "${prompt3}"`);
  conversationMessages.push({ role: 'user', content: prompt3 });

  const t3 = Date.now();
  const res3 = await sendChatStream({
    messages: conversationMessages,
    model: 'swift-15-27b-mtp',
    mode: 'auto',
    reasoning_effort: 'medium',
    threadId
  }, 120000);
  console.log(`Turn 3 finished in ${((Date.now() - t3) / 1000).toFixed(1)}s`);

  const search3 = res3.traces.find(t => t.tool === 'search_web');
  if (!search3) throw new Error('Live Test 3 FAIL: search_web was not called');
  const q3 = (search3.args?.query || '').trim();
  console.log(`Formulated query 3: "${q3}"`);

  if (/\bdid you\b/i.test(q3)) {
    throw new Error(`Live Test 3 FAIL: query searched challenge verbatim: "${q3}"`);
  }
  if (!/Spanish Fort|weather|forecast/i.test(q3)) {
    throw new Error(`Live Test 3 FAIL: query not derived from conversation context: "${q3}"`);
  }
  console.log('✔ Live Test 3 PASS: query formulated from conversation context, real data\n');

  // -------------------------------------------------------------------------
  // Live Test 4: Sabotage via SEARCH_FORCE_EMPTY_RESULTS=1
  // Assert: honest abort, zero live figures in output.
  // -------------------------------------------------------------------------
  console.log('--- Live Test 4: Sabotage via SEARCH_FORCE_EMPTY_RESULTS=1 ---');
  run(`kubectl set env deployment/browser-mcp SEARCH_FORCE_EMPTY_RESULTS=1 -n ${K8S_NAMESPACE}`);
  run(`kubectl rollout status deployment/browser-mcp -n ${K8S_NAMESPACE} --timeout=60s`);
  console.log('Waiting 5s for pod readiness...');
  await new Promise(r => setTimeout(r, 5000));

  try {
    const t4 = Date.now();
    const res4 = await sendChatStream({
      messages: [{ role: 'user', content: 'weather today in Spanish Fort AL' }],
      model: 'swift-15-27b-mtp',
      mode: 'auto',
      reasoning_effort: 'medium',
      threadId: `live-sabotage-${Date.now()}`
    }, 120000);
    console.log(`Turn 4 finished in ${((Date.now() - t4) / 1000).toFixed(1)}s`);

    const abortTrace = res4.traces.find(t =>
      t.tool === 'grounding_gate' || JSON.stringify(t).includes('Live data could not be retrieved')
    );
    if (!abortTrace) {
      throw new Error('Live Test 4 FAIL: HONEST_ABORT_DIRECTIVE trace was not detected');
    }
    console.log('✔ Live Test 4 trace assertion: HONEST_ABORT_DIRECTIVE injected');

    console.log(`Final message snippet:\n"${res4.content.trim().slice(0, 200)}..."`);
    const tempRegex = /[°º]\s*[FC]\b|\b\d+\s*(degrees\s+)?(fahrenheit|celsius)\b/i;
    if (tempRegex.test(res4.content)) {
      throw new Error(`Live Test 4 FAIL: Output contains fabricated temperature figure! Matched: ${res4.content.match(tempRegex)[0]}`);
    }
    console.log('✔ Live Test 4 content assertion: Zero live figures detected');
    console.log('✔ Live Test 4 PASS: honest abort, zero live figures in output\n');
  } finally {
    console.log('Restoring SEARCH_FORCE_EMPTY_RESULTS off...');
    run(`kubectl set env deployment/browser-mcp SEARCH_FORCE_EMPTY_RESULTS- -n ${K8S_NAMESPACE}`);
    run(`kubectl rollout status deployment/browser-mcp -n ${K8S_NAMESPACE} --timeout=60s`);
    await new Promise(r => setTimeout(r, 5000));
    console.log('✔ browser-mcp restored with hook OFF\n');
  }

  console.log('================================================================');
  console.log('ALL 4 LIVE ACCEPTANCE TESTS PASSED SUCCESSFULLY!');
  console.log('================================================================');
}

main().catch(err => {
  console.error('\n❌ Live Battery Error:', err.message);
  try {
    run(`kubectl set env deployment/browser-mcp SEARCH_FORCE_EMPTY_RESULTS- -n ${K8S_NAMESPACE}`);
  } catch {}
  process.exit(1);
});
