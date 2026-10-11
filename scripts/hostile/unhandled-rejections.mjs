import { setImmediate } from 'node:timers/promises';

export async function checkUnhandledRejections(operation) {
  let count = 0;
  let result;
  let failure;
  let failed = false;
  const record = () => {
    count += 1;
  };
  process.on('unhandledRejection', record);
  try {
    result = await operation();
  } catch (error) {
    failed = true;
    failure = error;
  } finally {
    await setImmediate();
    process.off('unhandledRejection', record);
  }
  if (count > 0) throw new Error(`Hostile extraction caused ${count} unhandled rejection(s).`);
  if (failed) throw failure;
  return result;
}
