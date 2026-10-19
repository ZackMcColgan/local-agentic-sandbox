const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const REPO_ROOT = path.resolve(__dirname, '..');
const WEB_UI_DIR = path.join(REPO_ROOT, 'web-ui');
const TESTS_DIR = path.join(WEB_UI_DIR, 'tests');

function findTestFiles(dir) {
  let results = [];
  const list = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of list) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results = results.concat(findTestFiles(fullPath));
    } else if (entry.isFile() && entry.name.endsWith('.test.ts')) {
      results.push(fullPath);
    }
  }
  return results.sort();
}

const TSX_CLI = path.join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');

function runTestFile(filePath, timeoutMs = 120000) {
  return new Promise((resolve) => {
    const relPath = path.relative(WEB_UI_DIR, filePath);
    const start = Date.now();
    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const child = spawn(process.execPath, [TSX_CLI, '--test', relPath], {
      cwd: WEB_UI_DIR,
      env: { ...process.env, NODE_ENV: 'test' },
      stdio: ['ignore', 'pipe', 'pipe']
    });

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        if (process.platform === 'win32') {
          spawn('taskkill', ['/pid', child.pid.toString(), '/f', '/t']);
        } else {
          child.kill('SIGKILL');
        }
      } catch (err) {
        // ignore
      }
    }, timeoutMs);

    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });

    child.on('close', (code) => {
      clearTimeout(timer);
      const durationMs = Date.now() - start;

      if (timedOut) {
        resolve({
          file: relPath,
          status: 'HANG',
          durationMs,
          code,
          stdout,
          stderr
        });
        return;
      }

      // Parse TAP / node:test output
      let passCount = 0;
      let failCount = 0;
      let totalCount = 0;

      const passMatch = stdout.match(/# pass\s+(\d+)/);
      const failMatch = stdout.match(/# fail\s+(\d+)/);
      const testsMatch = stdout.match(/# tests\s+(\d+)/);

      if (passMatch) passCount = parseInt(passMatch[1], 10);
      if (failMatch) failCount = parseInt(failMatch[1], 10);
      if (testsMatch) totalCount = parseInt(testsMatch[1], 10);

      const status = (code === 0 && failCount === 0) ? 'PASS' : 'FAIL';

      resolve({
        file: relPath,
        status,
        durationMs,
        code,
        passCount,
        failCount,
        totalCount: totalCount || (passCount + failCount),
        stdout,
        stderr
      });
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({
        file: relPath,
        status: 'ERROR',
        durationMs: Date.now() - start,
        error: err.message,
        stdout,
        stderr
      });
    });
  });
}

async function main() {
  const testFiles = findTestFiles(TESTS_DIR);
  console.log(`Discovered ${testFiles.length} test files in ${TESTS_DIR}`);
  console.log(`Executing full suite with per-file timeout: 120s\n`);

  const suiteStart = Date.now();
  const results = [];
  const hangs = [];
  const fails = [];
  let totalPassTests = 0;
  let totalFailTests = 0;

  for (let i = 0; i < testFiles.length; i++) {
    const file = testFiles[i];
    const rel = path.relative(WEB_UI_DIR, file);
    process.stdout.write(`[${i + 1}/${testFiles.length}] ${rel} ... `);

    const res = await runTestFile(file, 120000);
    results.push(res);

    if (res.status === 'PASS') {
      totalPassTests += res.passCount;
      console.log(`✅ PASS (${(res.durationMs / 1000).toFixed(2)}s, ${res.passCount} tests)`);
    } else if (res.status === 'HANG') {
      hangs.push(res);
      console.log(`⏳ HANG (timed out after ${(res.durationMs / 1000).toFixed(1)}s)`);
    } else {
      fails.push(res);
      totalPassTests += (res.passCount || 0);
      totalFailTests += (res.failCount || 1);
      console.log(`❌ FAIL (${(res.durationMs / 1000).toFixed(2)}s, code: ${res.code}, fail: ${res.failCount || 1})`);
    }
  }

  const totalDurationSec = ((Date.now() - suiteStart) / 1000).toFixed(2);

  console.log('\n======================================================');
  console.log('FULL SUITE EXECUTION REPORT');
  console.log('======================================================');
  console.log(`Total test files: ${testFiles.length}`);
  console.log(`Files passed:     ${results.filter(r => r.status === 'PASS').length}`);
  console.log(`Files failed:     ${fails.length}`);
  console.log(`Files hung:       ${hangs.length}`);
  console.log(`Total test assertions passed: ${totalPassTests}`);
  console.log(`Total test assertions failed: ${totalFailTests}`);
  console.log(`Total duration:   ${totalDurationSec}s`);
  console.log('======================================================\n');

  if (hangs.length > 0) {
    console.log('--- HANGING TEST FILES ---');
    for (const h of hangs) {
      console.log(`- ${h.file} (exceeded 120s)`);
    }
    console.log('');
  }

  if (fails.length > 0) {
    console.log('--- FAILING TEST FILES ---');
    for (const f of fails) {
      console.log(`\n[FAIL] ${f.file} (code: ${f.code})`);
      if (f.stderr) console.log(`Stderr:\n${f.stderr.trim()}`);
      if (f.stdout) {
        // Print relevant failure lines from stdout
        const lines = f.stdout.split('\n');
        const failLines = lines.filter(l => l.includes('not ok') || l.includes('Error:') || l.includes('AssertionError')).slice(0, 10);
        if (failLines.length > 0) {
          console.log(`Failure details:\n${failLines.join('\n')}`);
        }
      }
    }
    console.log('');
  }

  fs.writeFileSync(path.join(REPO_ROOT, 'full-suite-results.json'), JSON.stringify({
    totalFiles: testFiles.length,
    passedFiles: results.filter(r => r.status === 'PASS').length,
    failedFiles: fails.length,
    hungFiles: hangs.length,
    totalPassTests,
    totalFailTests,
    totalDurationSec,
    hangs: hangs.map(h => ({ file: h.file, durationMs: h.durationMs })),
    fails: fails.map(f => ({ file: f.file, code: f.code, error: f.stderr || f.stdout }))
  }, null, 2));
}

main().catch(err => {
  console.error('Suite runner error:', err);
  process.exit(1);
});
