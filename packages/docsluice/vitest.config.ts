import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    testTimeout: 10_000,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      reporter: ['text', 'json-summary', 'json'],
      thresholds: {
        lines: 85,
        perFile: true,
        'src/core/budget.ts': { lines: 100, perFile: true },
        'src/zip/**/*.ts': { lines: 100, perFile: true },
        'src/xml/**/*.ts': { lines: 100, perFile: true },
        'src/readers/**/*.ts': { lines: 90, perFile: true },
      },
    },
  },
});
