declare module 'node:fs' {
  export interface Dirent {
    name: string;
    isDirectory(): boolean;
  }
  export function readFileSync(path: string): Uint8Array;
  export function readFileSync(path: string, encoding: 'utf8'): string;
  export function readdirSync(path: string): string[];
  export function readdirSync(path: string, options: { withFileTypes: true }): Dirent[];
  export function writeFileSync(path: string, data: string, encoding: 'utf8'): void;
}

declare module 'node:url' {
  export function fileURLToPath(url: URL): string;
}

declare module 'node:path' {
  export function join(...paths: string[]): string;
}
