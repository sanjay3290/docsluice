import { mkdir, writeFile } from 'node:fs/promises';
import { URL } from 'node:url';

// A hand-made mboxrd mailbox (CC0-1.0, RFC 4155): three synthetic messages, a body line quoted as
// ">From " and ">>From ", a "From " line inside a paragraph (not an envelope), and a multipart
// message with an attachment.
const directory = new URL('../../corpus/mbox/', import.meta.url);
await mkdir(directory, { recursive: true });
const messages = [
  [
    'From alex@example.test Mon Oct  5 08:15:00 2026',
    'From: Alex Example <alex@example.test>',
    'To: Reader <reader@example.test>',
    'Subject: Field plan',
    'Date: Mon, 05 Oct 2026 08:15:00 +0000',
    'Message-ID: <plan@example.test>',
    '',
    'The tide survey starts at dawn.',
    '>From the north jetty we walk south.',
    '>>From a quoted reply, still quoted once.',
    'Bring the gauge.',
    'From here on the line is body text, not an envelope.',
  ],
  [
    'From casey@example.test Tue Oct  6 09:30:00 2026',
    'From: Casey Example <casey@example.test>',
    'To: Alex Example <alex@example.test>',
    'Subject: Re: Field plan',
    'Date: Tue, 06 Oct 2026 09:30:00 +0000',
    'In-Reply-To: <plan@example.test>',
    '',
    'Confirmed for Tuesday.',
  ],
  [
    'From casey@example.test Wed Oct  7 10:00:00 2026',
    'From: Casey Example <casey@example.test>',
    'To: Alex Example <alex@example.test>',
    'Subject: Readings',
    'Date: Wed, 07 Oct 2026 10:00:00 +0000',
    'MIME-Version: 1.0',
    'Content-Type: multipart/mixed; boundary="b1"',
    '',
    '--b1',
    'Content-Type: text/plain; charset=utf-8',
    '',
    'Readings attached.',
    '--b1',
    'Content-Type: text/csv; name="readings.csv"',
    'Content-Disposition: attachment; filename="readings.csv"',
    '',
    'station,salinity',
    'N-1,24',
    '--b1--',
  ],
];
const mailbox = `${messages.map((lines) => `${lines.join('\n')}\n`).join('\n')}`;
await writeFile(new URL('mailbox.mbox', directory), mailbox);
await writeFile(
  new URL('mailbox.mbox.license', directory),
  'SPDX-License-Identifier: CC0-1.0\nSource: hand-made for docsluice by scripts/corpus/make-mbox.mjs\nRequirements: EML-1, EML-3\nNotes: mboxrd quoting, a body line that starts with "From " after text, and a message with an attachment.\n',
);
