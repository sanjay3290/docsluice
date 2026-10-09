declare module 'node:fs' {
  export interface Dirent {
    name: string;
    isDirectory(): boolean;
  }
  export function readFileSync(path: URL): Uint8Array;
  export function readFileSync(path: URL, encoding: 'utf8'): string;
  export function readFileSync(path: string, encoding: 'utf8'): string;
  export function readdirSync(path: string): string[];
  export function readdirSync(path: string, options: { withFileTypes: true }): Dirent[];
  export function writeFileSync(path: string, data: string, encoding: 'utf8'): void;
}
