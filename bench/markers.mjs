/** Validate the exact expected marker identities in extracted semantic output. */
export function validateMarkers(text, { markerPattern, markerPrefix, markerWidth, expectedUnits }) {
  const expression = new RegExp(markerPattern, 'g');
  const found = new Set();
  let duplicate = false;
  let unexpected = false;
  let matches = 0;

  for (const match of String(text).matchAll(expression)) {
    const marker = match[0];
    matches += 1;
    const identity = Number(marker.slice(markerPrefix.length));
    if (
      !marker.startsWith(markerPrefix) ||
      marker.length !== markerPrefix.length + markerWidth ||
      !Number.isInteger(identity) ||
      identity < 1 ||
      identity > expectedUnits ||
      `${markerPrefix}${String(identity).padStart(markerWidth, '0')}` !== marker
    ) {
      unexpected = true;
      continue;
    }
    if (found.has(marker)) duplicate = true;
    found.add(marker);
  }

  let missing = false;
  if (found.size !== expectedUnits) missing = true;
  else {
    for (let identity = 1; identity <= expectedUnits; identity += 1) {
      if (!found.has(`${markerPrefix}${String(identity).padStart(markerWidth, '0')}`)) {
        missing = true;
        break;
      }
    }
  }

  return {
    valid: !duplicate && !unexpected && !missing && matches === expectedUnits,
    matches,
    unique: found.size,
    duplicate,
    unexpected,
    missing,
  };
}

/** Include a duration only after exact semantic validation succeeds. */
export function semanticResult({ text, units, durationMs, markerOptions }) {
  const markerValidation = validateMarkers(text, markerOptions);
  const valid = String(text).length > 0 && markerValidation.valid;
  return {
    status: valid ? 'ok' : 'invalid-output',
    ...(valid ? { durationMs } : { reason: 'semantic-output-marker-identity-mismatch' }),
    outputCharacters: String(text).length,
    units,
    markerCount: markerValidation.matches,
    uniqueMarkerCount: markerValidation.unique,
    expectedUnits: markerOptions.expectedUnits,
    markerValidation,
  };
}
