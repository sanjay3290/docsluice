declare module 'node:fs' {
  export function readFileSync(path: string): Uint8Array;
}

declare module 'node:url' {
  export function fileURLToPath(url: URL): string;
}
