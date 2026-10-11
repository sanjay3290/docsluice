function digits(value: string, start: number, length: number): number | undefined {
  if (value.length < start + length) return undefined;
  let result = 0;
  for (let index = start; index < start + length; index++) {
    const code = value.charCodeAt(index);
    if (code < 48 || code > 57) return undefined;
    result = result * 10 + code - 48;
  }
  return result;
}

const pad = (value: number, width = 2) => String(value).padStart(width, '0');

/**
 * A PDF date (`D:YYYYMMDDHHmmSSOHH'mm'`, ISO 32000-1 7.9.4) as an ISO 8601 string. Missing parts
 * default as the standard says (month and day 1, time 0); a time zone becomes an offset, `Z` stays
 * `Z`, and no zone means local time without an offset. Invalid dates give `undefined`.
 */
export function parsePdfDate(input: string): string | undefined {
  let value = input.trim();
  if (value.startsWith('D:')) value = value.slice(2);
  const year = digits(value, 0, 4);
  if (year === undefined) return undefined;
  const month = digits(value, 4, 2) ?? 1;
  const day = digits(value, 6, 2) ?? 1;
  const hour = digits(value, 8, 2) ?? 0;
  const minute = digits(value, 10, 2) ?? 0;
  const second = digits(value, 12, 2) ?? 0;
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59)
    return undefined;
  let iso = `${pad(year, 4)}-${pad(month)}-${pad(day)}T${pad(hour)}:${pad(minute)}:${pad(second)}`;
  // The zone starts after the last digit that was read.
  let zoneStart = 4;
  for (const [start, length] of [
    [4, 2],
    [6, 2],
    [8, 2],
    [10, 2],
    [12, 2],
  ] as const) {
    if (digits(value, start, length) === undefined) break;
    zoneStart = start + length;
  }
  const zone = value[zoneStart];
  if (zone === 'Z') iso += 'Z';
  else if (zone === '+' || zone === '-') {
    const hours = digits(value, zoneStart + 1, 2);
    const minutesStart = value[zoneStart + 3] === "'" ? zoneStart + 4 : zoneStart + 3;
    const minutes = digits(value, minutesStart, 2) ?? 0;
    if (hours !== undefined && hours <= 23 && minutes <= 59) iso += `${zone}${pad(hours)}:${pad(minutes)}`;
  }
  return iso;
}

/** `1, 3-5, 9` for sorted page numbers. */
export function pageRanges(pages: readonly number[]): string {
  const parts: string[] = [];
  let start = pages[0];
  let end = start;
  for (let index = 1; index <= pages.length; index++) {
    const page = pages[index];
    if (page !== undefined && end !== undefined && page === end + 1) {
      end = page;
      continue;
    }
    if (start !== undefined && end !== undefined)
      parts.push(start === end ? String(start) : `${start}-${end}`);
    start = page;
    end = page;
  }
  return parts.join(', ');
}
