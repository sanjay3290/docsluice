# vCard (VCF)

The vCard reader (`docsluice/vcf`) reads vCard 2.1, 3.0 and 4.0 (RFC 6350) with the same content-line parser as [iCalendar](ics.md): lines are unfolded, group prefixes (`item1.EMAIL`) are dropped and TEXT escapes are decoded.

- Each `VCARD` becomes one two-column table (Field, Value), properties in file order.
- `N` (`Family;Given;Additional;Prefix;Suffix`) is shown as `Prefix Given Additional Family Suffix`; `ADR` and `ORG` parts are joined with commas; `BDAY` and `ANNIVERSARY` dates become ISO 8601; a `tel:` prefix is dropped.
- Contact details are personal and need `metadata: true`: `EMAIL`, `TEL`, `ADR`, `BDAY`, `ANNIVERSARY`, `GEO`, `IMPP`, `URL`, `LABEL` and `RELATED`. The name (`FN`, `N`), `ORG`, `TITLE` and `NOTE` are always shown.
- Binary or linked media (`PHOTO`, `LOGO`, `SOUND`, `KEY`), identifiers (`UID`, `REV`, `PRODID`, `VERSION`) and `X-` properties are not shown.

Detection: content starting with `BEGIN:VCARD`. `hostile/vcf` holds a large card count.
