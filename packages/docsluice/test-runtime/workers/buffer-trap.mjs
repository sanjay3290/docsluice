export async function withBufferAccessTrap(callback, target = globalThis) {
  if ('Buffer' in target)
    throw new Error('Worker unexpectedly exposes Buffer before the runtime contract import');
  Object.defineProperty(target, 'Buffer', {
    configurable: true,
    get() {
      throw new Error('global Buffer access trap: built runtime contract accessed Buffer');
    },
  });
  try {
    return await callback();
  } finally {
    Reflect.deleteProperty(target, 'Buffer');
  }
}
