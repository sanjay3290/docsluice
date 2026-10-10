import type { Budget } from '../../core/budget.js';

const MAX_FORMAT_CODE_LENGTH = 2_048;
const MAX_SECTIONS = 4;
const MAX_TOKENS = 512;
const MAX_PRECISION = 20;
const MAX_OUTPUT_LENGTH = 16_384;
const DAY_MILLISECONDS = 86_400_000;
const UNIX_DAY_1900_EPOCH = -25_568;
const UNIX_DAY_1904_EPOCH = -24_107;

type TokenKind =
  | 'literal'
  | 'placeholder'
  | 'decimal'
  | 'comma'
  | 'percent'
  | 'slash'
  | 'date'
  | 'elapsed'
  | 'ampm'
  | 'exponent'
  | 'at';

interface Token {
  kind: TokenKind;
  text: string;
}

interface Condition {
  operator: string;
  value: number;
}

interface Section {
  tokens: Token[];
  condition?: Condition;
}

interface CalendarDate {
  year: number;
  month: number;
  day: number;
  weekday: number;
  fictitiousLeapDay: boolean;
}

const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTHS_LONG = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];
const DAYS_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const DAYS_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

const BUILT_IN_FORMATS: ReadonlyMap<number, string> = new Map([
  [0, 'General'],
  [1, '0'],
  [2, '0.00'],
  [3, '#,##0'],
  [4, '#,##0.00'],
  [5, '"$"#,##0_);("$"#,##0)'],
  [6, '"$"#,##0;("$"#,##0)'],
  [7, '"$"#,##0.00;("$"#,##0.00)'],
  [8, '"$"#,##0.00_);("$"#,##0.00)'],
  [9, '0%'],
  [10, '0.00%'],
  [11, '0.00E+00'],
  [12, '# ?/?'],
  [13, '# ??/??'],
  [14, 'mm-dd-yy'],
  [15, 'd-mmm-yy'],
  [16, 'd-mmm'],
  [17, 'mmm-yy'],
  [18, 'h:mm AM/PM'],
  [19, 'h:mm:ss AM/PM'],
  [20, 'h:mm'],
  [21, 'h:mm:ss'],
  [22, 'm/d/yy h:mm'],
  [37, '#,##0 ;(#,##0)'],
  [38, '#,##0 ;[Red](#,##0)'],
  [39, '#,##0.00;(#,##0.00)'],
  [40, '#,##0.00;[Red](#,##0.00)'],
  [41, '_(* #,##0_);_(* (#,##0);_(* "-"_);_(@_)'],
  [42, '_("$"* #,##0_);_("$"* (#,##0);_("$"* "-"_);_(@_)'],
  [43, '_(* #,##0.00_);_(* (#,##0.00);_(* "-"??_);_(@_)'],
  [44, '_("$"* #,##0.00_);_("$"* (#,##0.00);_("$"* "-"??_);_(@_)'],
  [45, 'mm:ss'],
  [46, '[h]:mm:ss'],
  [47, 'mmss.0'],
  [48, '##0.0E+0'],
  [49, '@'],
]);

/** Return the locale-independent built-in Excel format, or General for reserved ids. */
export function builtInNumberFormat(id: number): string {
  return BUILT_IN_FORMATS.get(id) ?? 'General';
}

/**
 * Format a stored scalar using an Excel number format. This helper only formats
 * the cached value passed by its caller; it never evaluates formula text.
 */
export function formatNumber(
  value: number | string,
  formatCode: string,
  date1904 = false,
  budget?: Budget,
): string {
  budget?.tick();
  if (formatCode.length > MAX_FORMAT_CODE_LENGTH) return general(value);
  if (formatCode.trim().toLowerCase() === 'general') return general(value);
  const rawSections = splitSections(formatCode, budget);
  if (!rawSections || rawSections.length === 0 || rawSections.length > MAX_SECTIONS) return general(value);
  const sections: Section[] = [];
  for (const rawSection of rawSections) {
    budget?.tick();
    const section = tokenizeSection(rawSection, budget);
    if (!section || section.tokens.length > MAX_TOKENS) return general(value);
    sections.push(section);
  }

  if (typeof value === 'string') {
    const textSection = sections[3] ?? sections[0];
    if (!textSection) return value;
    if (sections[3]) return renderText(value, textSection.tokens, budget);
    if (sections.length > 1) return value;
    for (const token of textSection.tokens) {
      budget?.tick();
      if (token.kind === 'at') return renderText(value, textSection.tokens, budget);
    }
    return value;
  }
  if (!Number.isFinite(value)) return general(value);

  const selected = selectSection(value, sections, budget);
  if (!selected) return general(value);
  let dateTokens = false;
  let fractionTokens = false;
  let scientificTokens = false;
  for (const token of selected.section.tokens) {
    budget?.tick();
    if (token.kind === 'date' || token.kind === 'elapsed' || token.kind === 'ampm') dateTokens = true;
    if (token.kind === 'slash') fractionTokens = true;
    if (token.kind === 'exponent') scientificTokens = true;
  }
  let result: string;
  if (dateTokens) {
    result = renderDate(value, selected.section.tokens, date1904, budget);
  } else if (fractionTokens && hasFractionPlaceholders(selected.section.tokens, budget)) {
    result = renderFraction(value, selected.section.tokens, selected.automaticNegative, budget);
  } else if (scientificTokens) {
    result = renderScientific(value, selected.section.tokens, selected.automaticNegative, budget);
  } else {
    result = renderDecimal(value, selected.section.tokens, selected.automaticNegative, budget);
  }
  return result.length <= MAX_OUTPUT_LENGTH ? result : general(value);
}

/** Excel's General format: up to 15 significant digits, without binary noise like 0.30000000000000004. */
export function formatGeneral(value: number): string {
  if (Object.is(value, -0)) return '0';
  if (Number.isInteger(value) && Math.abs(value) < 1e15) return String(value);
  const text = String(Number(value.toPrecision(15)));
  const exponent = text.indexOf('e');
  return exponent < 0 ? text : `${text.slice(0, exponent)}E${text.slice(exponent + 1)}`;
}

function general(value: number | string): string {
  return typeof value === 'number' ? formatGeneral(value) : value;
}

function splitSections(code: string, budget?: Budget): string[] | null {
  const sections: string[] = [];
  let start = 0;
  let quoted = false;
  let bracketed = false;
  for (let index = 0; index < code.length; index += 1) {
    budget?.tick();
    const char = code[index]!;
    if (char === '\\') {
      budget?.tick();
      index += 1;
      continue;
    }
    if (char === '"' && !bracketed) {
      quoted = !quoted;
      continue;
    }
    if (quoted) continue;
    if (char === '[') {
      bracketed = true;
      continue;
    }
    if (char === ']') {
      bracketed = false;
      continue;
    }
    if (char === ';' && !bracketed) {
      sections.push(code.slice(start, index));
      if (sections.length >= MAX_SECTIONS) return null;
      start = index + 1;
    }
  }
  sections.push(code.slice(start));
  return sections;
}

function tokenizeSection(section: string, budget?: Budget): Section | null {
  const tokens: Token[] = [];
  let condition: Condition | undefined;
  for (let index = 0; index < section.length; index += 1) {
    budget?.tick();
    const char = section[index]!;
    if (char === '"') {
      let literal = '';
      index += 1;
      while (index < section.length && section[index] !== '"') {
        budget?.tick();
        if (section[index] === '\\' && index + 1 < section.length) {
          budget?.tick();
          index += 1;
        }
        literal += section[index]!;
        index += 1;
      }
      tokens.push({ kind: 'literal', text: literal });
    } else if (char === '\\') {
      if (index + 1 < section.length) {
        budget?.tick();
        index += 1;
        tokens.push({ kind: 'literal', text: section[index]! });
      }
    } else if (char === '_') {
      if (index + 1 < section.length) {
        budget?.tick();
        index += 1;
      }
    } else if (char === '*') {
      if (index + 1 < section.length) {
        budget?.tick();
        index += 1;
      }
      // Spreadsheet fill is column-width dependent; skip it deterministically.
    } else if (char === '[') {
      let end = index + 1;
      while (end < section.length && section[end] !== ']') {
        budget?.tick();
        end += 1;
      }
      if (end >= section.length) {
        tokens.push({ kind: 'literal', text: '[' });
      } else {
        const annotation = section.slice(index + 1, end);
        const lower = annotation.toLowerCase();
        if (
          lower === 'h' ||
          lower === 'hh' ||
          lower === 'm' ||
          lower === 'mm' ||
          lower === 's' ||
          lower === 'ss'
        ) {
          tokens.push({ kind: 'elapsed', text: lower });
        } else if (annotation.startsWith('$')) {
          const locale = annotation.slice(1).split('-', 1)[0]!;
          if (locale) tokens.push({ kind: 'literal', text: locale });
        } else {
          const parsed = parseCondition(annotation);
          if (parsed) condition = parsed;
        }
        index = end;
      }
    } else if (matchesIgnoreCase(section, index, 'AM/PM')) {
      tokens.push({ kind: 'ampm', text: section.slice(index, index + 5) });
      index += 4;
    } else if (matchesIgnoreCase(section, index, 'A/P')) {
      tokens.push({ kind: 'ampm', text: section.slice(index, index + 3) });
      index += 2;
    } else if ((char === 'E' || char === 'e') && (section[index + 1] === '+' || section[index + 1] === '-')) {
      tokens.push({ kind: 'exponent', text: char + section[index + 1]! });
      index += 1;
    } else if (char === '0' || char === '#' || char === '?') {
      tokens.push({ kind: 'placeholder', text: char });
    } else if (char >= '1' && char <= '9') {
      tokens.push({ kind: 'literal', text: char });
    } else if (char === '.') {
      tokens.push({ kind: 'decimal', text: char });
    } else if (char === ',') {
      tokens.push({ kind: 'comma', text: char });
    } else if (char === '%') {
      tokens.push({ kind: 'percent', text: char });
    } else if (char === '/') {
      tokens.push({ kind: 'slash', text: char });
    } else if (char === '@') {
      tokens.push({ kind: 'at', text: char });
    } else if (isDateLetter(char)) {
      let end = index + 1;
      while (end < section.length && section[end]!.toLowerCase() === char.toLowerCase()) {
        budget?.tick();
        end += 1;
      }
      tokens.push({ kind: 'date', text: section.slice(index, end) });
      index = end - 1;
    } else {
      tokens.push({ kind: 'literal', text: char });
    }
    if (tokens.length > MAX_TOKENS) return null;
  }
  return { tokens, condition };
}

function parseCondition(annotation: string): Condition | undefined {
  const operators = ['>=', '<=', '<>', '>', '<', '='];
  for (const operator of operators) {
    if (!annotation.startsWith(operator)) continue;
    const value = Number(annotation.slice(operator.length));
    return Number.isFinite(value) ? { operator, value } : undefined;
  }
  return undefined;
}

function matchesIgnoreCase(input: string, index: number, expected: string): boolean {
  if (index + expected.length > input.length) return false;
  return input.slice(index, index + expected.length).toLowerCase() === expected.toLowerCase();
}

function isDateLetter(char: string): boolean {
  const lower = char.toLowerCase();
  return lower === 'y' || lower === 'm' || lower === 'd' || lower === 'h' || lower === 's';
}

function selectSection(
  value: number,
  sections: Section[],
  budget?: Budget,
): { section: Section; automaticNegative: boolean } | undefined {
  let hasConditions = false;
  for (const section of sections) {
    budget?.tick();
    if (section.condition !== undefined) hasConditions = true;
  }
  if (hasConditions) {
    for (const section of sections) {
      budget?.tick();
      if (section.condition && conditionMatches(value, section.condition))
        return { section, automaticNegative: false };
    }
    let fallback: Section | undefined;
    for (const section of sections) {
      budget?.tick();
      if (!section.condition) {
        fallback = section;
        break;
      }
    }
    return fallback ? { section: fallback, automaticNegative: false } : undefined;
  }
  if (value < 0 && sections[1]) return { section: sections[1], automaticNegative: false };
  if (value === 0 && sections[2]) return { section: sections[2], automaticNegative: false };
  const section = sections[0];
  return section ? { section, automaticNegative: value < 0 } : undefined;
}

function conditionMatches(value: number, condition: Condition): boolean {
  switch (condition.operator) {
    case '>=':
      return value >= condition.value;
    case '<=':
      return value <= condition.value;
    case '<>':
      return value !== condition.value;
    case '>':
      return value > condition.value;
    case '<':
      return value < condition.value;
    default:
      return value === condition.value;
  }
}

function renderText(value: string, tokens: Token[], budget?: Budget): string {
  let outputLength = 0;
  const parts: string[] = [];
  for (const token of tokens) {
    budget?.tick();
    if (token.kind === 'at') {
      outputLength += value.length;
      parts.push(value);
    } else if (token.kind === 'literal') {
      outputLength += token.text.length;
      parts.push(token.text);
    } else {
      continue;
    }
    if (outputLength > MAX_OUTPUT_LENGTH) return value;
  }
  return parts.join('');
}

function renderDecimal(value: number, tokens: Token[], automaticNegative: boolean, budget?: Budget): string {
  let first = -1;
  let last = -1;
  for (let index = 0; index < tokens.length; index += 1) {
    budget?.tick();
    if (tokens[index]!.kind === 'placeholder') {
      if (first < 0) first = index;
      last = index;
    }
  }
  if (first < 0 || last < first) return renderLiterals(tokens, automaticNegative, budget);
  let decimalIndex = -1;
  for (let index = first + 1; index < last; index += 1) {
    budget?.tick();
    if (tokens[index]!.kind === 'decimal') {
      decimalIndex = index;
      break;
    }
  }
  const integerEnd = decimalIndex >= 0 ? decimalIndex : last + 1;
  const integerSlots: Token[] = [];
  const fractionSlots: Token[] = [];
  let percentCount = 0;
  for (let index = 0; index < tokens.length; index += 1) {
    budget?.tick();
    const token = tokens[index]!;
    if (index < integerEnd && token.kind === 'placeholder') integerSlots.push(token);
    else if (decimalIndex >= 0 && index > decimalIndex && index <= last && token.kind === 'placeholder')
      fractionSlots.push(token);
    if (token.kind === 'percent') percentCount += 1;
  }
  let scale = Math.abs(value) * Math.pow(100, percentCount);
  let scaleCommas = 0;
  let lastIntegerToken = -1;
  for (let index = first; index < integerEnd; index += 1) {
    budget?.tick();
    if (tokens[index]!.kind === 'placeholder') lastIntegerToken = index;
  }
  let lastPlaceholderToken = -1;
  for (let index = 0; index < tokens.length; index += 1) {
    budget?.tick();
    if (tokens[index]!.kind === 'placeholder') lastPlaceholderToken = index;
  }
  for (let index = lastPlaceholderToken + 1; index < tokens.length; index += 1) {
    budget?.tick();
    const token = tokens[index]!;
    if (token.kind === 'comma') scaleCommas += 1;
    else if (token.kind !== 'literal' || token.text.trim() !== '') break;
  }
  scale /= Math.pow(1000, scaleCommas);
  if (!Number.isFinite(scale) || scale >= 1e21) return general(value);
  const precision = Math.min(fractionSlots.length, MAX_PRECISION);
  const fixed = decimalFixed(scale, precision);
  const point = fixed.indexOf('.');
  const integerDigits = point < 0 ? fixed : fixed.slice(0, point);
  const fractionDigits = point < 0 ? '' : fixed.slice(point + 1);
  let hasGrouping = false;
  for (let index = first; index < lastIntegerToken; index += 1) {
    budget?.tick();
    if (tokens[index]!.kind === 'comma') hasGrouping = true;
  }
  const renderedInteger = placeInteger(integerDigits, integerSlots, hasGrouping, budget);
  const renderedFraction = placeFraction(fractionDigits, fractionSlots.slice(0, MAX_PRECISION), budget);
  const showDecimal = renderedFraction !== '';
  const prefix = renderAffix(tokens, 0, first, budget);
  const suffix = renderAffix(tokens, last + 1, tokens.length, budget);
  const core = renderedInteger + (showDecimal ? `.${renderedFraction}` : '');
  const sign = automaticNegative && core !== '' ? '-' : '';
  return sign + prefix + core + suffix;
}

function placeInteger(digits: string, slots: Token[], grouping: boolean, budget?: Budget): string {
  let hasMandatoryZero = false;
  let questionCount = 0;
  for (const slot of slots) {
    budget?.tick();
    if (slot.text === '0') hasMandatoryZero = true;
    if (slot.text === '?') questionCount += 1;
  }
  if (digits === '0' && !hasMandatoryZero) return questionCount > 0 ? '\u2007'.repeat(questionCount) : '';
  const result = new Array<string>(slots.length);
  let digitIndex = digits.length - 1;
  for (let index = slots.length - 1; index >= 0; index -= 1) {
    budget?.tick();
    const slot = slots[index]!;
    if (digitIndex >= 0) {
      result[index] = digits[digitIndex]!;
      digitIndex -= 1;
    } else if (slot.text === '0') {
      result[index] = '0';
    } else if (slot.text === '?') {
      result[index] = '\u2007';
    } else {
      result[index] = '';
    }
  }
  let rendered = (digitIndex >= 0 ? digits.slice(0, digitIndex + 1) : '') + result.join('');
  if (!rendered.replace(/[ ,]/g, '')) {
    if (!hasMandatoryZero) return '';
  }
  if (grouping) {
    let start = 0;
    while (rendered[start] === ' ') {
      budget?.tick();
      start += 1;
    }
    let end = start;
    while (rendered[end] !== undefined && rendered[end]! >= '0' && rendered[end]! <= '9') {
      budget?.tick();
      end += 1;
    }
    if (end > start)
      rendered =
        rendered.slice(0, start) + groupDigits(rendered.slice(start, end), budget) + rendered.slice(end);
  }
  return rendered;
}

function decimalFixed(value: number, precision: number): string {
  // Correct common decimal half cases such as 0.995 without perturbing the
  // many low-order places of a precision-capped 20-digit format.
  return (precision <= 15 ? value + Number.EPSILON : value).toFixed(precision);
}

function groupDigits(digits: string, budget?: Budget): string {
  let output = '';
  for (let index = 0; index < digits.length; index += 1) {
    budget?.tick();
    if (index > 0 && (digits.length - index) % 3 === 0) output += ',';
    output += digits[index]!;
  }
  return output;
}

function placeFraction(digits: string, slots: Token[], budget?: Budget): string {
  let lastVisible = -1;
  for (let index = 0; index < slots.length; index += 1) {
    budget?.tick();
    const slot = slots[index]!;
    if (slot.text === '0' || digits[index] !== '0') lastVisible = index;
  }
  let output = '';
  for (let index = 0; index <= lastVisible; index += 1) {
    budget?.tick();
    const digit = digits[index] ?? '0';
    output += digit;
  }
  for (let index = lastVisible + 1; index < slots.length; index += 1) {
    budget?.tick();
    if (slots[index]!.text === '?') output += '\u2007';
  }
  return output;
}

function renderAffix(tokens: Token[], start: number, end: number, budget?: Budget): string {
  let output = '';
  for (let index = start; index < end; index += 1) {
    budget?.tick();
    const token = tokens[index]!;
    if (token.kind === 'literal') output += token.text;
    else if (token.kind === 'percent') output += '%';
  }
  return output;
}

function renderLiterals(tokens: Token[], negative: boolean, budget?: Budget): string {
  let output = '';
  for (const token of tokens) {
    budget?.tick();
    if (token.kind === 'literal') output += token.text;
  }
  return (negative && output ? '-' : '') + output;
}

function hasFractionPlaceholders(tokens: Token[], budget?: Budget): boolean {
  let slash = -1;
  for (let index = 0; index < tokens.length; index += 1) {
    budget?.tick();
    if (tokens[index]!.kind === 'slash') {
      slash = index;
      break;
    }
  }
  if (slash < 0) return false;
  let numerator = false;
  let denominator = false;
  for (let index = 0; index < tokens.length; index += 1) {
    budget?.tick();
    if (index < slash && tokens[index]!.kind === 'placeholder') numerator = true;
    if (index > slash && tokens[index]!.kind === 'placeholder') denominator = true;
    if (
      index > slash &&
      tokens[index]!.kind === 'literal' &&
      tokens[index]!.text >= '1' &&
      tokens[index]!.text <= '9'
    )
      denominator = true;
  }
  return numerator && denominator;
}

function renderFraction(value: number, tokens: Token[], automaticNegative: boolean, budget?: Budget): string {
  let slash = -1;
  for (let index = 0; index < tokens.length; index += 1) {
    budget?.tick();
    if (tokens[index]!.kind === 'slash') {
      slash = index;
      break;
    }
  }
  if (slash < 0) return renderDecimal(value, tokens, automaticNegative, budget);
  let numeratorStart = slash - 1;
  while (numeratorStart >= 0 && tokens[numeratorStart]!.kind === 'placeholder') {
    budget?.tick();
    numeratorStart -= 1;
  }
  const numeratorSlots = tokens.slice(numeratorStart + 1, slash);
  let integerEnd = numeratorStart + 1;
  if (
    integerEnd > 0 &&
    tokens[integerEnd - 1]!.kind === 'literal' &&
    /^\s+$/.test(tokens[integerEnd - 1]!.text)
  )
    integerEnd -= 1;
  const integerSlots: Token[] = [];
  for (let index = 0; index < integerEnd; index += 1) {
    budget?.tick();
    if (tokens[index]!.kind === 'placeholder') integerSlots.push(tokens[index]!);
  }
  const hasIntegerPart = integerSlots.length > 0;
  let denominatorEnd = slash + 1;
  const denominatorSlots: Token[] = [];
  let fixedDenominator = '';
  let hasFixedDigit = false;
  while (denominatorEnd < tokens.length) {
    budget?.tick();
    const token = tokens[denominatorEnd]!;
    if (token.kind === 'literal' && token.text.length === 1 && token.text >= '1' && token.text <= '9') {
      fixedDenominator += token.text;
      hasFixedDigit = true;
      denominatorEnd += 1;
    } else if (hasFixedDigit && token.kind === 'placeholder' && token.text === '0') {
      fixedDenominator += '0';
      denominatorEnd += 1;
    } else {
      break;
    }
  }
  if (!hasFixedDigit) {
    fixedDenominator = '';
    denominatorEnd = slash + 1;
    while (denominatorEnd < tokens.length && tokens[denominatorEnd]!.kind === 'placeholder') {
      budget?.tick();
      denominatorSlots.push(tokens[denominatorEnd]!);
      denominatorEnd += 1;
    }
  }
  const wholeBase = hasIntegerPart ? Math.floor(Math.abs(value)) : 0;
  const fraction = hasIntegerPart ? Math.abs(value) - wholeBase : Math.abs(value);
  const maxDenominator = fixedDenominator
    ? Number(fixedDenominator)
    : Math.min(99, Math.pow(10, Math.max(1, denominatorSlots.length)) - 1);
  if (maxDenominator < 1 || maxDenominator > 100) return general(value);
  let bestNumerator = 0;
  let bestDenominator = 1;
  let bestError = Number.POSITIVE_INFINITY;
  const firstDenominator = fixedDenominator ? maxDenominator : 1;
  for (let denominator = firstDenominator; denominator <= maxDenominator; denominator += 1) {
    budget?.tick();
    const numerator = Math.round(fraction * denominator);
    const error = Math.abs(fraction - numerator / denominator);
    if (error < bestError) {
      bestError = error;
      bestNumerator = numerator;
      bestDenominator = denominator;
    }
  }
  let whole = wholeBase;
  if (hasIntegerPart && bestNumerator >= bestDenominator) {
    whole += 1;
    bestNumerator = 0;
  }
  const useFraction = bestNumerator !== 0;
  const wholeText = hasIntegerPart ? placeInteger(String(whole), integerSlots, false, budget) : '';
  const numeratorText = useFraction ? placeInteger(String(bestNumerator), numeratorSlots, false, budget) : '';
  const denominatorText =
    fixedDenominator ||
    (useFraction ? placeFractionDenominator(String(bestDenominator), denominatorSlots, budget) : '');
  const between = hasIntegerPart && (wholeText !== '' || useFraction) ? ' ' : '';
  const fractionText = useFraction ? `${numeratorText}/${denominatorText}` : '';
  const prefix = renderAffix(tokens, 0, Math.max(0, integerEnd - integerSlots.length), budget);
  const suffix = renderAffix(tokens, denominatorEnd, tokens.length, budget);
  const sign = automaticNegative ? '-' : '';
  return sign + prefix + wholeText + between + fractionText + suffix;
}

function placeFractionDenominator(digits: string, slots: Token[], budget?: Budget): string {
  let output = '';
  for (let index = 0; index < slots.length; index += 1) {
    budget?.tick();
    if (index < digits.length) output += digits[index]!;
    else if (slots[index]!.text === '0') output += '0';
    else if (slots[index]!.text === '?') output += '\u2007';
  }
  return output;
}

function renderScientific(
  value: number,
  tokens: Token[],
  automaticNegative: boolean,
  budget?: Budget,
): string {
  let exponentIndex = -1;
  let first = -1;
  for (let index = 0; index < tokens.length; index += 1) {
    budget?.tick();
    if (tokens[index]!.kind === 'exponent' && exponentIndex < 0) exponentIndex = index;
    if (tokens[index]!.kind === 'placeholder' && first < 0) first = index;
  }
  if (exponentIndex < 0 || first < 0) return renderDecimal(value, tokens, automaticNegative, budget);
  let integerSlots = 0;
  let fractionSlots = 0;
  let inFraction = false;
  for (let index = first; index < exponentIndex; index += 1) {
    budget?.tick();
    const token = tokens[index]!;
    if (token.kind === 'decimal') inFraction = true;
    else if (token.kind === 'placeholder') {
      if (inFraction) fractionSlots += 1;
      else integerSlots += 1;
    }
  }
  if (integerSlots < 1) integerSlots = 1;
  const precision = Math.min(fractionSlots, MAX_PRECISION);
  const absolute = Math.abs(value);
  let exponent = absolute === 0 ? 0 : Math.floor(Math.log10(absolute) / integerSlots) * integerSlots;
  let mantissa = absolute === 0 ? 0 : absolute / Math.pow(10, exponent);
  if (!Number.isFinite(mantissa)) return general(value);
  const fixed = mantissa.toFixed(precision);
  const integerPart = Number(fixed.slice(0, fixed.indexOf('.') < 0 ? fixed.length : fixed.indexOf('.')));
  if (integerPart >= Math.pow(10, integerSlots)) {
    exponent += integerSlots;
    mantissa /= Math.pow(10, integerSlots);
  }
  const mantissaTokens = tokens.slice(first, exponentIndex);
  const mantissaOutput = renderDecimal(value < 0 ? -mantissa : mantissa, mantissaTokens, false, budget);
  let exponentWidth = 0;
  for (
    let index = exponentIndex + 1;
    index < tokens.length && tokens[index]!.kind === 'placeholder';
    index += 1
  ) {
    budget?.tick();
    exponentWidth += 1;
  }
  const exponentMagnitude = String(Math.abs(exponent)).padStart(Math.max(1, exponentWidth), '0');
  const exponentText =
    exponent < 0
      ? `-${exponentMagnitude}`
      : tokens[exponentIndex]!.text.endsWith('+')
        ? `+${exponentMagnitude}`
        : exponentMagnitude;
  const prefix = renderAffix(tokens, 0, first, budget);
  const suffixStart = exponentIndex + 1 + exponentWidth;
  const suffix = renderAffix(tokens, suffixStart, tokens.length, budget);
  const sign = automaticNegative ? '-' : '';
  return (
    sign + prefix + mantissaOutput + tokens[exponentIndex]!.text[0]!.toUpperCase() + exponentText + suffix
  );
}

function renderDate(value: number, tokens: Token[], date1904: boolean, budget?: Budget): string {
  if (Math.abs(value) > 10_000_000) return general(value);
  const wholeDays = Math.floor(value);
  const fraction = value - wholeDays;
  // Excel rounds the time to the precision the format shows: whole seconds, or `ss.0` to `ss.000`.
  const unit = 10 ** (3 - fractionalSecondDigits(tokens, budget));
  let milliseconds = Math.round(Math.round(fraction * DAY_MILLISECONDS) / unit) * unit;
  let day = wholeDays;
  if (milliseconds >= DAY_MILLISECONDS) {
    day += 1;
    milliseconds = 0;
  }
  const date = excelDate(day, date1904);
  const totalHours = Math.floor(milliseconds / 3_600_000);
  const minutes = Math.floor(milliseconds / 60_000) % 60;
  const seconds = Math.floor(milliseconds / 1000) % 60;
  const millis = milliseconds % 1000;
  const time = { totalHours, minutes, seconds, millis, day };
  let output = '';
  for (let index = 0; index < tokens.length; index += 1) {
    budget?.tick();
    const token = tokens[index]!;
    if (
      token.kind === 'literal' ||
      token.kind === 'percent' ||
      token.kind === 'comma' ||
      token.kind === 'slash'
    ) {
      output +=
        token.kind === 'literal'
          ? token.text
          : token.kind === 'percent'
            ? '%'
            : token.kind === 'comma'
              ? ','
              : '/';
    } else if (token.kind === 'ampm') {
      const pm = totalHours >= 12;
      if (token.text.toLowerCase() === 'a/p')
        output += pm
          ? token.text === token.text.toLowerCase()
            ? 'p'
            : 'P'
          : token.text === token.text.toLowerCase()
            ? 'a'
            : 'A';
      else {
        const suffix = pm ? 'PM' : 'AM';
        output += token.text === token.text.toLowerCase() ? suffix.toLowerCase() : suffix;
      }
    } else if (token.kind === 'elapsed') {
      const totalSeconds = Math.floor(milliseconds / 1000) + Math.max(0, day) * 86_400;
      const total =
        token.text[0] === 'h'
          ? Math.floor(totalSeconds / 3600)
          : token.text[0] === 'm'
            ? Math.floor(totalSeconds / 60)
            : totalSeconds;
      output += token.text.length > 1 ? String(total).padStart(token.text.length, '0') : String(total);
    } else if (token.kind === 'date') {
      const kind = classifyDateToken(tokens, index, budget);
      output += renderDateToken(token.text, kind, date, time, tokens, index, budget);
    } else if (token.kind === 'decimal') {
      const next = tokens[index + 1];
      if (
        next?.kind === 'placeholder' &&
        index > 0 &&
        tokens[index - 1]!.kind === 'date' &&
        tokens[index - 1]!.text[0]!.toLowerCase() === 's'
      ) {
        let count = 0;
        let cursor = index + 1;
        while (tokens[cursor]?.kind === 'placeholder' && count < MAX_PRECISION) {
          budget?.tick();
          count += 1;
          cursor += 1;
        }
        output += `.${String(time.millis).padStart(3, '0').slice(0, count)}`;
        index += count;
      } else output += '.';
    } else if (token.kind === 'at') {
      output += '@';
    }
  }
  return output;
}

/** Placeholders after a decimal point that follows a seconds field (`ss.00` → 2), at most 3. */
function fractionalSecondDigits(tokens: Token[], budget?: Budget): number {
  for (let index = 1; index < tokens.length; index += 1) {
    budget?.tick();
    const token = tokens[index]!;
    const previous = tokens[index - 1]!;
    if (token.kind !== 'decimal' || previous.kind !== 'date' || previous.text[0]!.toLowerCase() !== 's')
      continue;
    let count = 0;
    while (tokens[index + 1 + count]?.kind === 'placeholder' && count < 3) {
      budget?.tick();
      count += 1;
    }
    return count;
  }
  return 0;
}

function classifyDateToken(
  tokens: Token[],
  index: number,
  budget?: Budget,
): 'year' | 'month' | 'minute' | 'day' | 'hour' | 'second' {
  const token = tokens[index]!;
  const first = token.text[0]!.toLowerCase();
  if (first !== 'm') {
    if (first === 'y') return 'year';
    if (first === 'd') return 'day';
    if (first === 'h') return 'hour';
    return 'second';
  }
  let previousField: string | undefined;
  for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
    budget?.tick();
    const candidate = tokens[cursor]!;
    if (candidate.kind === 'date' || candidate.kind === 'elapsed' || candidate.kind === 'ampm') {
      previousField = candidate.text[0]!.toLowerCase();
      break;
    }
  }
  let nextField: string | undefined;
  for (let cursor = index + 1; cursor < tokens.length; cursor += 1) {
    budget?.tick();
    const candidate = tokens[cursor]!;
    if (candidate.kind === 'date' || candidate.kind === 'elapsed' || candidate.kind === 'ampm') {
      nextField = candidate.text[0]!.toLowerCase();
      break;
    }
  }
  return previousField === 'h' || previousField === 's' || nextField === 's' ? 'minute' : 'month';
}

function renderDateToken(
  text: string,
  kind: 'year' | 'month' | 'minute' | 'day' | 'hour' | 'second',
  date: CalendarDate,
  time: { totalHours: number; minutes: number; seconds: number; millis: number; day: number },
  tokens: Token[],
  index: number,
  budget?: Budget,
): string {
  const width = text.length;
  if (kind === 'year')
    return width <= 2 ? String(date.year % 100).padStart(width, '0') : String(date.year).padStart(width, '0');
  if (kind === 'month') {
    if (width === 5) return MONTHS_LONG[date.month - 1]![0]!;
    if (width > 5) return MONTHS_LONG[date.month - 1]!;
    if (width === 4) return MONTHS_LONG[date.month - 1]!;
    if (width === 3) return MONTHS_SHORT[date.month - 1]!;
    return width === 2 ? String(date.month).padStart(2, '0') : String(date.month);
  }
  if (kind === 'day') {
    if (width >= 4) return DAYS_LONG[date.weekday]!;
    if (width === 3) return DAYS_SHORT[date.weekday]!;
    return width === 2 ? String(date.day).padStart(2, '0') : String(date.day);
  }
  if (kind === 'hour') {
    let hasAmPm = false;
    for (const candidate of tokens) {
      budget?.tick();
      if (candidate.kind === 'ampm') hasAmPm = true;
    }
    const hour = hasAmPm ? ((time.totalHours + 11) % 12) + 1 : time.totalHours % 24;
    return width === 2 ? String(hour).padStart(2, '0') : String(hour);
  }
  if (kind === 'minute') return width === 2 ? String(time.minutes).padStart(2, '0') : String(time.minutes);
  const second = time.seconds;
  return width === 2 ? String(second).padStart(2, '0') : String(second);
}

function excelDate(serial: number, date1904: boolean): CalendarDate {
  if (!date1904 && serial === 60)
    return { year: 1900, month: 2, day: 29, weekday: 4, fictitiousLeapDay: true };
  const unixDay = date1904
    ? UNIX_DAY_1904_EPOCH + serial
    : UNIX_DAY_1900_EPOCH + serial - (serial > 60 ? 1 : 0);
  const civil = civilFromDays(unixDay);
  const weekday = (((unixDay + 4) % 7) + 7) % 7;
  return { ...civil, weekday, fictitiousLeapDay: false };
}

function civilFromDays(daysSinceUnixEpoch: number): { year: number; month: number; day: number } {
  const z = daysSinceUnixEpoch + 719_468;
  const era = Math.floor(z / 146_097);
  const dayOfEra = z - era * 146_097;
  const yearOfEra = Math.floor(
    (dayOfEra -
      Math.floor(dayOfEra / 1_460) +
      Math.floor(dayOfEra / 36_524) -
      Math.floor(dayOfEra / 146_096)) /
      365,
  );
  let year = yearOfEra + era * 400;
  const dayOfYear = dayOfEra - (365 * yearOfEra + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100));
  const monthPrime = Math.floor((5 * dayOfYear + 2) / 153);
  const day = dayOfYear - Math.floor((153 * monthPrime + 2) / 5) + 1;
  const month = monthPrime + (monthPrime < 10 ? 3 : -9);
  if (month <= 2) year += 1;
  return { year, month, day };
}
