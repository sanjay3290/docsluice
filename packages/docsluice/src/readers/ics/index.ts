import { makeCalendarTextReader } from '../calendar-text.js';

/** RFC 5545 iCalendar reader for VEVENT components; folding is unfolded without executing data. */
export const reader = makeCalendarTextReader('ics', 'VEVENT', 'text/calendar');
export default reader;
