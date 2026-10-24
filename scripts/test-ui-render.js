/**
 * RETIRED: Replaced by Playwright automated test suite in web-ui/tests/e2e
 * (Work Order #3: real flows + pairwise layout invariants + visual baselines)
 */

const { spawnSync } = require('child_process');
const path = require('path');

console.log('[Notice] scripts/test-ui-render.js is retired in favor of Playwright e2e suite.');
console.log('[Notice] Delegating to: npm --prefix web-ui run test:e2e\n');

const res = spawnSync('npm', ['--prefix', 'web-ui', 'run', 'test:e2e'], {
  stdio: 'inherit',
  shell: true,
  cwd: path.resolve(__dirname, '..'),
});

process.exit(res.status || 0);
