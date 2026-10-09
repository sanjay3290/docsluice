export type * from './core/model.js';
export type { ExtractOptions } from './core/options.js';
export type { Limits } from './core/limits.js';
export { DEFAULT_LIMITS, resolveLimits } from './core/limits.js';
export { Budget } from './core/budget.js';
export type { BudgetOptions, DepthKind } from './core/budget.js';
export { WarningSink } from './core/warnings.js';
export type { WarningSinkOptions } from './core/warnings.js';
export {
  DocsluiceError,
  UnsupportedFormatError,
  EncryptedError,
  CorruptFileError,
  LimitExceededError,
  TimeoutError,
  AbortError,
  StrictModeError,
} from './core/errors.js';
export type { ErrorCode } from './core/errors.js';
export { parseXml, scanXml } from './xml/index.js';
export type { XmlContext, XmlElement, XmlElementInfo, XmlHandler } from './xml/index.js';
