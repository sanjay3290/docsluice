import { withBufferAccessTrap } from './buffer-trap.mjs';

export default {
  async fetch(request) {
    if (new globalThis.URL(request.url).pathname !== '/runtime-contract') {
      return new globalThis.Response('not found', { status: 404 });
    }
    try {
      await withBufferAccessTrap(async () => {
        const [{ runRuntimeContract }, { loadRuntimeFixtures }] = await Promise.all([
          import('../cases.mjs'),
          import('../fixtures.generated.mjs'),
        ]);
        await runRuntimeContract(loadRuntimeFixtures());
      });
      return globalThis.Response.json({ ok: true, bufferAbsent: true, bufferAccessTrap: 'passed' });
    } catch {
      return new globalThis.Response('built package runtime contract failed', { status: 500 });
    }
  },
};
