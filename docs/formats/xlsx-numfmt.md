# XLSX number-format helper

`formatNumber(value, formatCode, date1904?, budget?)` converts a stored numeric or
text value to a deterministic display string. It never reads or evaluates formula
text. The XLSX reader (see [xlsx.md](xlsx.md)) maps each cell's style to a format
code through `styles.xml` and calls it for every cell whose format is not General.
`builtInNumberFormat(id)` provides the standard built-in code for IDs 0–49 and
returns `General` for reserved or unknown IDs.

The helper recognizes up to four sections, numeric conditions, quoted and escaped
literals, colors as nonprinting annotations, `0`/`#`/`?` placeholders, grouping
and scaling commas, decimal points, percentages, currency annotations, scientific
notation, bounded fraction approximation (including fixed denominators through
100), date/time fields, elapsed `[h]`/`[m]`/
`[s]` fields, text `@`, and `_`/`*` spacing instructions. Both `_x` and `*x`
skip the instruction and following character because actual width and fill are
not available. A literal space remains visible when quoted or escaped. A locale
tag in a currency annotation is ignored while its symbol is retained. Built-in
ID 14 uses the standard English `mm-dd-yy` pattern for deterministic output.

Text is formatted by the fourth section when present, including a literal-only
section. Without a fourth section, the original text is preserved; a single-
section format containing `@` still applies that placeholder and its literals.

The implementation does not use `Date`, host timezone, host locale, formula
evaluation, regular-expression compilation from input, or recursion. It caps the
format code at 2,048 UTF-16 code units, sections at four, tokens at 512, decimal
precision at 20 places, and generated output at 16,384 code units (original
input text is preserved). Supplying a `Budget` charges scans of format and token
data; aborted budgets propagate their abort error. Unsupported or malformed
patterns fall back to the scalar's general
string representation (the reader's General: 15 significant digits, `1E+21`). Times
are rounded to the precision the format shows (whole seconds, or `ss.0` to `ss.000`),
as Excel does, so 3,659.99999 seconds shows `1:01:00`. The 2,048-unit cap is a defensive implementation limit;
Office format codes are normally under 255 characters. Known limits include no
width-aware rendering, localized month/day names, locale-specific decimal/group
separators, or calendar eras. Variable fraction denominators are limited to 99;
fixed denominator formats are limited to 100. `General` can differ from Excel's
column-width-dependent rounding and scientific-notation thresholds. Condition handling chooses
the first matching condition, uses the first unconditioned section as fallback,
and falls back to General if no condition matches and no unconditional section
exists.

Serial 60 in the 1900 date system is rendered as Excel's fictitious
`1900-02-29`. LibreOfficeDev 26.8 uses a different 1900-system epoch before
March 1900, including rendering serial 60 as 1900-02-28. Those captured rows
are retained in the fixture but excluded from direct output comparison. The
helper's Excel epoch behavior around serials 0, 1, 59, 60, and 61 is asserted
separately. The 1904 epoch and date rendering are timezone-independent.

Built-in code choices follow the standard number-format mappings and
section-selection behavior described in Microsoft's
[MS-OI29500 number format specification](https://learn.microsoft.com/en-us/openspecs/office_standards/ms-oi29500/17d11129-219b-4e2c-88db-45844d21e528)
and [Excel number format code guidance](https://support.microsoft.com/en-us/excel/number-format-codes-in-excel-for-mac).

## Reference evidence

`packages/docsluice/test/xlsx/fixtures/numfmt/libreoffice-reference.json`
contains 421 captured rows from self-authored, formula-free XLSX inputs. The
source CSV export is included alongside it. LibreOfficeDev
26.8.0.0.alpha0 exported CSV with “Save cell contents as shown” enabled; its
version, invocation, filter flags, locale environment, and documentation links
are recorded in the JSON. Both reference files have CC0-1.0 license sidecars.
Of the 421 rows, 349 are compared directly, 64 pre-March-1900 calendar rows are
excluded for Calc/Excel epoch differences, and 8 underscore-padding rows are
excluded because Calc renders width-dependent spaces that this helper skips.
The test does not derive display strings from raw numeric values. The reader-level
golden `corpus/xlsx/number-formats.xlsx` has one row per format kind, reviewed
against Excel's documented behaviour. `scripts/test/timezones.test.mjs` runs the
number-format tests and all goldens with `TZ=Pacific/Kiritimati` and
`TZ=America/Los_Angeles`.

The separate self-authored captures under
`packages/docsluice/test/xlsx/fixtures/numfmt/` include
`rounding-edgecases.*` and `rendering-edgecases.*` XLSX/CSV/JSON files. They
record the exact LibreOffice version, source display strings, and export options
for decimal values adjacent to a rounding boundary, fixed-denominator fractions,
scientific affixes, and negative sign placement. Each artifact has a CC0-1.0
sidecar; the 421-case source data is unchanged.

Official CSV filter documentation:
[LibreOffice CSV parameter options](https://help.libreoffice.org/latest/en-US/text/shared/guide/csv_params.html)
and [Text/CSV export options](https://help.libreoffice.org/latest/en-US/text/shared/00/00000207.html).
