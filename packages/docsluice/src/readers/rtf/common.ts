/** Shared RTF byte classes and code-page tables for the document reader and the HTML de-encapsulator. */
export const MAX_RAW_CHUNK = 4096;
export const MAX_METADATA_VALUE = 4096;
export const MAX_METADATA_FIELDS = 1024;
export const MAX_FONTS = 1024;
export const MAX_CONTROL_WORD = 64;

export function isAlpha(byte: number): boolean {
  return (byte >= 65 && byte <= 90) || (byte >= 97 && byte <= 122);
}

export function isDigit(byte: number): boolean {
  return byte >= 48 && byte <= 57;
}

export function hexValueRtf(byte: number): number {
  if (byte >= 48 && byte <= 57) return byte - 48;
  if (byte >= 65 && byte <= 70) return byte - 55;
  if (byte >= 97 && byte <= 102) return byte - 87;
  return -1;
}

export function codePageName(codePage: number): string | undefined {
  if (codePage === 932) return 'shift_jis';
  if (codePage === 936) return 'gbk';
  if (codePage === 949) return 'euc-kr';
  if (codePage === 950) return 'big5';
  if (codePage === 65001) return 'utf-8';
  if (codePage >= 1250 && codePage <= 1258) return `windows-${codePage}`;
  if (codePage === 874) return 'windows-874';
  if (codePage === 437) return 'ibm437';
  if (codePage === 850) return 'ibm850';
  return undefined;
}

export function charsetCodePage(charset: number): number | undefined {
  switch (charset) {
    case 0:
    case 1:
      return 1252;
    case 2:
      return 42;
    case 77:
      return 10000;
    case 128:
      return 932;
    case 129:
      return 949;
    case 134:
      return 936;
    case 136:
      return 950;
    case 161:
      return 1253;
    case 162:
      return 1254;
    case 163:
      return 1258;
    case 177:
      return 1255;
    case 178:
      return 1256;
    case 186:
      return 1257;
    case 204:
      return 1251;
    case 222:
      return 874;
    case 238:
      return 1250;
    default:
      return undefined;
  }
}
