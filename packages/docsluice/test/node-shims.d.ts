declare module 'node:fs' {
  export function readFileSync(path: URL): Uint8Array;
  export function readFileSync(path: URL, encoding: 'utf8'): string;
  export function readdirSync(path: URL): string[];
}
