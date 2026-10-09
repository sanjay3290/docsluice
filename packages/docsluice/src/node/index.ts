/**
 * Node-only entry point (`docsluice/node`, IN-2, RT-2).
 * Only this folder may use `node:` imports and Node globals.
 * `extractFile()` and Node stream input arrive with their issues.
 */
export * from '../index.js';
