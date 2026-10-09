import { playwright } from '@vitest/browser-playwright';
import { defineConfig } from 'vitest/config';

const localChromium = process.env.DOCSLUICE_PLAYWRIGHT_CHROMIUM_PATH;

export default defineConfig({
  test: {
    include: ['packages/docsluice/test-runtime/browser/**/*.test.mjs'],
    browser: {
      enabled: true,
      provider: playwright(
        localChromium
          ? { launchOptions: { executablePath: localChromium, args: ['--no-sandbox'] } }
          : undefined,
      ),
      headless: true,
      instances: localChromium
        ? [{ browser: 'chromium' }]
        : [{ browser: 'chromium' }, { browser: 'firefox' }, { browser: 'webkit' }],
    },
  },
});
