export type * from './core/model.js';
export { toJSON } from './render/json.js';
export type { ToJSONOptions } from './render/json.js';
export type { ExtractOptions } from './core/options.js';
export { extract, extractStream } from './core/extract.js';
export type { BlockStream } from './core/extract.js';
export { detect } from './detect/detect.js';
export type { Limits } from './core/limits.js';
export { DEFAULT_LIMITS, resolveLimits } from './core/limits.js';
export { Budget } from './core/budget.js';
export type { BudgetOptions, DepthKind } from './core/budget.js';
export { WarningSink } from './core/warnings.js';
export type { WarningSinkOptions } from './core/warnings.js';
export { openZip } from './zip/index.js';
export type { ZipArchive, ZipEntry } from './zip/index.js';
export {
  DocsluiceError,
  UnsupportedFormatError,
  EncryptedError,
  CorruptFileError,
  LimitExceededError,
  TimeoutError,
  AbortError,
  StrictModeError,
  PluginContractError,
} from './core/errors.js';
export { createRegistry, registerFormat, READER_CONTRACT_VERSION } from './core/registry.js';
export type { FormatPlugin, ReaderRegistry } from './core/registry.js';
export type { ReadContext } from './core/reader.js';
export type { DocBuilder } from './core/builder.js';
export type { ErrorCode } from './core/errors.js';
export { parseXml, scanXml } from './xml/index.js';
export type { XmlContext, XmlElement, XmlElementInfo, XmlHandler } from './xml/index.js';
export { toText } from './render/text.js';
export type { TextOptions } from './render/layout.js';
export { toMarkdown } from './render/markdown.js';
export { chunk } from './chunk/index.js';
export type { Chunk, ChunkOptions } from './chunk/index.js';
export type { MarkdownOptions } from './render/markdown.js';
