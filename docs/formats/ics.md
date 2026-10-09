# iCalendar (ICS)

The reader unfolds RFC 5545 continuation lines and emits one paragraph for each `VEVENT`. The paragraph starts with `VEVENT` followed by its properties; `loc.path` is `VEVENT[n]`. Other calendar components are ignored. Property values remain text and are never executed or fetched. When `metadata: false`, `ORGANIZER` and `ATTENDEE` properties are omitted as personal contact metadata; event content such as `SUMMARY` and `DESCRIPTION` remains. Output obeys `outputChars`.
