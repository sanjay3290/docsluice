import { writeFile } from 'node:fs/promises';
import { URL } from 'node:url';
import { HELVETICA, pdf, stream, textPage } from './pdf-writer.mjs';

// Hand-made PDF (CC0-1.0) with a filled AcroForm and text annotations. Written from ISO 32000-1
// sections 12.5.6.4 (text annotations), 12.5.6.6 (free text), 12.7.3 (field names and values),
// 12.7.4.2 (check boxes, radio buttons, push buttons) and 12.7.4.4 (choice fields).
// Objects: 1 catalog, 2 pages, 3 font, 4 page, 5 contents, 6 appearance, 7 applicant (parent),
// 8 name, 9 email, 10 subscribe, 11 plan (radio parent), 12-13 plan widgets, 14 country,
// 15 topics, 16 submit (push button), 17 sticky note, 18 free text, 19 highlight.
const widget = (rect, rest) => `<< /Type /Annot /Subtype /Widget /P 4 0 R /Rect [${rect}] ${rest} >>`;
const states = (on) => `/AP << /N << /${on} 6 0 R /Off 6 0 R >> >>`;
const objects = [
  '<< /Type /Catalog /Pages 2 0 R /AcroForm << /Fields [7 0 R 10 0 R 11 0 R 14 0 R 15 0 R 16 0 R] /DA (/Helv 10 Tf 0 g) /DR << /Font << /Helv 3 0 R >> >> >> >>',
  '<< /Type /Pages /Kids [4 0 R] /Count 1 >>',
  HELVETICA,
  '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents 5 0 R /Annots [8 0 R 9 0 R 10 0 R 12 0 R 13 0 R 14 0 R 15 0 R 16 0 R 17 0 R 18 0 R 19 0 R] >>',
  stream(textPage(['Field Survey Application', 'Name', 'Email', 'Send updates', 'Plan', 'Country', 'Topics'], { leading: 30 })),
  stream('', '/Type /XObject /Subtype /Form /BBox [0 0 12 12]'),
  '<< /T (applicant) /Kids [8 0 R 9 0 R] >>',
  widget('200 722 400 738', '/FT /Tx /Parent 7 0 R /T (name) /V (Jordan Sample)'),
  widget('200 692 400 708', '/FT /Tx /Parent 7 0 R /T (email) /V (jordan@example.invalid)'),
  widget('200 662 212 674', `/FT /Btn /T (subscribe) /V /Yes /AS /Yes ${states('Yes')}`),
  // Radio flag (bit 16) and NoToggleToOff (bit 15).
  '<< /FT /Btn /Ff 49152 /T (plan) /V /Annual /Kids [12 0 R 13 0 R] >>',
  widget('200 632 212 644', `/Parent 11 0 R /AS /Off ${states('Monthly')}`),
  widget('260 632 272 644', `/Parent 11 0 R /AS /Annual ${states('Annual')}`),
  // Combo box (bit 18) and multi-select list box (bit 22).
  widget('200 602 400 618', '/FT /Ch /Ff 131072 /T (country) /Opt [(Norway) (Chile)] /V (Chile)'),
  widget('200 532 400 588', '/FT /Ch /Ff 2097152 /T (topics) /Opt [(Tides) (Birds) (Soil)] /V [(Tides) (Soil)]'),
  // Push button (bit 17): it has no value and is not a field value.
  widget('72 480 160 500', '/FT /Btn /Ff 65536 /T (submit)'),
  '<< /Type /Annot /Subtype /Text /Rect [520 720 540 740] /T (Reviewer A) /Contents (Check the email address.) /Name /Comment >>',
  '<< /Type /Annot /Subtype /FreeText /Rect [72 420 360 440] /DA (/Helv 10 Tf 0 g) /T (Reviewer B) /Contents (Approved for the pilot.) >>',
  '<< /Type /Annot /Subtype /Highlight /Rect [72 750 260 770] /QuadPoints [72 770 260 770 72 750 260 750] /T (Reviewer C) /Contents (A highlight is not a text annotation.) >>',
];
await writeFile(new URL('../../corpus/pdf/form-annotations.pdf', import.meta.url), pdf(objects, '/Root 1 0 R'));
await writeFile(
  new URL('../../corpus/pdf/form-annotations.pdf.license', import.meta.url),
  'SPDX-License-Identifier: CC0-1.0\nSource: hand-made for docsluice by scripts/corpus/make-pdf-forms.mjs\nRequirements: PDF-7, MOD-4\nNotes: a filled AcroForm (nested text fields, check box, radio group, combo box, multi-select list, push button), a sticky note and a free-text annotation with authors, and a highlight.\n',
);
