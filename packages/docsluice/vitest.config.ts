import { defineConfig } from 'vitest/config';

const coverage = process.argv.includes('--coverage');

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    testTimeout: 10_000,
    // Timing tests skip themselves under coverage instrumentation.
    env: { DOCSLUICE_COVERAGE: coverage ? '1' : '' },
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      // The worker-thread entry runs only inside a Worker, where this process's coverage cannot see
      // it; the built-package worker tests exercise it end to end.
      exclude: ['src/node/worker/worker.ts'],
      reporter: ['text', 'json-summary'],
      // Line coverage per file (QA-5, docs/testing.md): 100% for the budget, ZIP and XML modules,
      // 90% for readers, 85% for everything else. `npm run coverage` fails below any of them.
      thresholds: {
        perFile: true,
        lines: 85,
        'src/core/budget.ts': { lines: 100, perFile: true },
        'src/zip/**': { lines: 100, perFile: true },
        'src/xml/**': { lines: 100, perFile: true },
        'src/readers/**': { lines: 90, perFile: true },
      },
    },
  },
});
