declare module '*scripts/hostile/unhandled-rejections.mjs' {
  export function checkUnhandledRejections<T>(operation: () => Promise<T>): Promise<T>;
}
