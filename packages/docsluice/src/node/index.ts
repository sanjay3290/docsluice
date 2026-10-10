/**
 * Node-only entry point (`docsluice/node`, IN-2, RT-2).
 * Only this folder may use `node:` imports and Node globals.
 */
export * from '../index.js';
// These shadow the core `extract` re-exported above: they also accept Node `Readable` and `Buffer`.
export { extract, extractFile } from './file.js';
