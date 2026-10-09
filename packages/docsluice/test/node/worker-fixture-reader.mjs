export function readTestInput(mode, bytes) {
  if (mode === 'hang' || (mode === 'hang-on-zero' && bytes[0] === 0)) {
    while (true) {
      // The worker-pool tests use this test-only reader to verify termination.
    }
  }

  if (mode === 'oom') {
    const retained = [];
    let index = 0;
    while (true) {
      retained.push(`${index++}-${'x'.repeat(1024)}`);
    }
  }

  return { bytes: Array.from(bytes) };
}
