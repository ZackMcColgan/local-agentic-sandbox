const fs = require('fs');
const path = require('path');
const http = require('http');

const FIXTURES_DIR = 'D:\\AI\\orchestrator-scratch\\matrix-prompts';

function postJson(url, payload, timeoutMs = 900000) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const postData = JSON.stringify(payload);
    const req = http.request({
      hostname: urlObj.hostname,
      port: urlObj.port,
      path: urlObj.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData)
      },
      timeout: timeoutMs
    }, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            resolve(data);
          }
        } else {
          reject(new Error(`HTTP ${res.statusCode}: ${data}`));
        }
      });
    });

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy(new Error(`Request timed out after ${timeoutMs / 1000}s`));
    });

    req.write(postData);
    req.end();
  });
}

async function runCell(cellName, maxTokens = 600) {
  const filePath = path.join(FIXTURES_DIR, `${cellName}.txt`);
  if (!fs.existsSync(filePath)) {
    throw new Error(`Fixture file not found: ${filePath}`);
  }
  const prompt = fs.readFileSync(filePath, 'utf8');
  console.log(`\n[BENCH] Running cell: ${cellName} (prompt len: ${prompt.length} chars, max_tokens: ${maxTokens})...`);

  const startTime = Date.now();

  const data = await postJson('http://127.0.0.1:8080/v1/chat/completions', {
    model: 'qwen3.8-flash-next-gyro-gyro-s',
    messages: [{ role: 'user', content: prompt }],
    max_tokens: maxTokens,
    temperature: 0.0
  }, 900000); // 15 minute timeout

  const totalDurationMs = Date.now() - startTime;

  const usage = data.usage || {};
  const timings = data.timings || {};

  const promptTokens = usage.prompt_tokens || timings.prompt_n || Math.round(prompt.length / 4);
  const completionTokens = usage.completion_tokens || timings.predicted_n || 0;

  const prefillTokS = timings.prompt_per_second || (promptTokens / ((timings.prompt_ms || totalDurationMs) / 1000));
  const decodeTokS = timings.predicted_per_second || (completionTokens / ((timings.predicted_ms || 1) / 1000));
  const ttftMs = timings.prompt_ms || totalDurationMs;

  const draftRatio = timings.draft_n > 0 ? (timings.draft_n_accepted / timings.draft_n) : null;

  const result = {
    cell: cellName,
    promptTokens,
    completionTokens,
    prefillTokS: parseFloat(prefillTokS.toFixed(1)),
    decodeTokS: parseFloat(decodeTokS.toFixed(1)),
    ttftMs: parseFloat(ttftMs.toFixed(1)),
    draftRatio: draftRatio !== null ? parseFloat(draftRatio.toFixed(3)) : null,
    totalDurationSec: parseFloat((totalDurationMs / 1000).toFixed(1))
  };

  console.log(`[BENCH] ${cellName} DONE: decode=${result.decodeTokS} tok/s | prefill=${result.prefillTokS} tok/s | TTFT=${result.ttftMs}ms | tokens=${promptTokens} in / ${completionTokens} out (${result.totalDurationSec}s)`);
  return result;
}

async function main() {
  const args = process.argv.slice(2);
  let mode = 'matrix';
  let cellArg = null;
  let reps = 1;
  let trimmed = false;
  let maxTokensArg = null;

  for (const arg of args) {
    if (arg === '--matrix') mode = 'matrix';
    if (arg === '--subset') mode = 'subset';
    if (arg.startsWith('--cell=')) cellArg = arg.split('=')[1];
    if (arg.startsWith('--reps=')) reps = parseInt(arg.split('=')[1], 10);
    if (arg.startsWith('--max-tokens=')) maxTokensArg = parseInt(arg.split('=')[1], 10);
    if (arg === '--trimmed') trimmed = true;
    if (arg === '--untrimmed') trimmed = false;
  }

  // Full untrimmed matrix per Addendum B: all 7 cells at 600 tokens
  const fullMatrixCells = [
    { name: 'prose-4k', maxTokens: 600 },
    { name: 'code-4k', maxTokens: 600 },
    { name: 'json-4k', maxTokens: 600 },
    { name: 'prose-48k', maxTokens: 600 },
    { name: 'code-48k', maxTokens: 600 },
    { name: 'json-48k', maxTokens: 600 },
    { name: 'prose-100k', maxTokens: 600 }
  ];

  const trimmedMatrixCells = [
    { name: 'prose-4k', maxTokens: 600 },
    { name: 'code-4k', maxTokens: 600 },
    { name: 'json-4k', maxTokens: 600 },
    { name: 'prose-48k', maxTokens: 600 },
    { name: 'prose-100k', maxTokens: 300 }
  ];

  const subsetCells = [
    { name: 'prose-4k', maxTokens: 600 },
    { name: 'json-4k', maxTokens: 600 },
    { name: 'prose-100k', maxTokens: 300 }
  ];

  let cellsToRun = mode === 'subset' ? subsetCells : (trimmed ? trimmedMatrixCells : fullMatrixCells);
  if (cellArg) {
    const found = cellsToRun.find(c => c.name === cellArg);
    cellsToRun = found ? [found] : [{ name: cellArg, maxTokens: 600 }];
  }
  if (maxTokensArg !== null) {
    cellsToRun = cellsToRun.map(c => ({ ...c, maxTokens: maxTokensArg }));
  }

  console.log(`===================================================================`);
  console.log(`  STRATA SPEED BENCHMARK RUNNER (REV 4 / ADDENDUM B)`);
  console.log(`  Mode: ${mode} | Reps: ${reps} | Trimmed: ${trimmed} | Cells: ${cellsToRun.map(c => c.name).join(', ')}`);
  console.log(`===================================================================`);

  const results = [];
  for (let rep = 1; rep <= reps; rep++) {
    for (const cell of cellsToRun) {
      const res = await runCell(cell.name, cell.maxTokens);
      res.rep = rep;
      results.push(res);
    }
  }

  console.log(`\n===================================================================`);
  console.log(`  MARKDOWN TABLE FOR RESULTS`);
  console.log(`===================================================================`);
  console.log(`| Cell | Rep | Prompt Tokens | Gen Tokens | Decode (tok/s) | Prefill (tok/s) | TTFT (s) | Draft Accepted | Duration (s) |`);
  console.log(`|---|---|---|---|---|---|---|---|---|`);
  for (const r of results) {
    const draftStr = r.draftRatio !== null ? `${(r.draftRatio * 100).toFixed(1)}%` : '—';
    console.log(`| ${r.cell} | ${r.rep} | ${r.promptTokens} | ${r.completionTokens} | **${r.decodeTokS}** | ${r.prefillTokS} | ${(r.ttftMs / 1000).toFixed(2)} | ${draftStr} | ${r.totalDurationSec} |`);
  }

  const outPath = `D:\\AI\\orchestrator-scratch\\bench-${mode}-${Date.now()}.json`;
  fs.writeFileSync(outPath, JSON.stringify(results, null, 2));
  console.log(`\nSaved raw results to: ${outPath}`);
}

main().catch(err => {
  console.error('[BENCH ERROR]', err);
  process.exit(1);
});
