# iCalendar (ICS)

The iCalendar reader (`docsluice/ics`) reads RFC 5545 calendars. Content lines are unfolded (a line starting with a space or tab continues the previous one) and split into name, parameters and value, with quoted parameters kept whole.

- Each `VEVENT`, `VTODO`, `VJOURNAL`, `VFREEBUSY` and `VALARM` becomes one two-column table (Field, Value), properties in file order. Time zones and the calendar wrapper are not tables. `X-WR-CALNAME` is `metadata.title`.
- TEXT escapes (`\n`, `\,`, `\;`, `\\`) are decoded. `DTSTART`, `DTEND`, `DUE`, `RECURRENCE-ID`, `EXDATE`, `RDATE` and `COMPLETED` become ISO 8601 (`2026-05-14T08:00:00Z`, `2026-05-14`); a `TZID` is kept beside a local time (`2026-05-14T08:00:00 (Europe/Berlin)`), never converted.
- `ORGANIZER` and `ATTENDEE` show `Name <address>` from `CN` and the `mailto:` value. They and `CONTACT` are personal and are left out with `metadata: false`.
- Identifiers and bookkeeping (`UID`, `DTSTAMP`, `SEQUENCE`, `CREATED`, `LAST-MODIFIED`, `CLASS`, `TRANSP`), attachments and every `X-` property are not shown. Group prefixes (`item1.`) are dropped.
- Components are tracked with an explicit stack bounded by `blockDepth`; deeper ones are merged into their parent with a `DEPTH_LIMIT` warning.

Detection: content starting with `BEGIN:VCALENDAR`. `hostile/ics` holds a fold bomb, unbalanced components and parameter floods.
