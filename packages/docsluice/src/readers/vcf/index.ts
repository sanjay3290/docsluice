import { makeCalendarTextReader } from '../calendar-text.js';

/** RFC 6350 vCard reader; card fields remain document content. */
export const reader = makeCalendarTextReader('vcf', 'VCARD', 'text/vcard');
export default reader;
