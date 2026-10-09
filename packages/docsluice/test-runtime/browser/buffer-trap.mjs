export async function withBrowserBufferAccessTrap(callback, target = globalThis) {
  const prior = Object.getOwnPropertyDescriptor(target, 'Buffer');
  if (prior && !prior.configurable) {
    throw new Error('Cannot install browser Buffer trap because global Buffer is not configurable');
  }

  Object.defineProperty(target, 'Buffer', {
    configurable: true,
    get() {
      throw new Error('global Buffer access trap: built runtime contract accessed Buffer');
    },
  });
  try {
    return await callback();
  } finally {
    if (prior) Object.defineProperty(target, 'Buffer', prior);
    else Reflect.deleteProperty(target, 'Buffer');
  }
}
