/** Test-only Jazzer target; the checked-in seed triggers a deliberate failure. */
export function fuzz(input) {
  if (input.byteLength > 0 && input[0] === 0x42) throw new Error('planted fuzz crash');
}
