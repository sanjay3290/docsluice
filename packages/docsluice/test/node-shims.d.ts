declare module 'node:fs' {
  export function readFileSync(path: URL): Uint8Array;
  export function readFileSync(path: URL, encoding: 'utf8'): string;
  export function readdirSync(path: URL, options?: { recursive: true }): string[];
  export function writeFileSync(path: URL, data: string): void;
  export function existsSync(path: URL): boolean;
}
