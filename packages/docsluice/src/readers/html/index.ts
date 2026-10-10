import type { Reader } from '../../core/reader.js';
import { readHtml } from './read.js';

/** HTML reader: visible headings, paragraphs, lists, tables, code and image alt text. */
export const htmlReader: Reader = { id: 'html', mimeTypes: ['text/html'], read: readHtml };
