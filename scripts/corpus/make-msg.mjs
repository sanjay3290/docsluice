// Self-made Outlook .msg fixtures for corpus/msg. The writer is in msg-writer.mjs.
import { writeFile } from 'node:fs/promises';
import { URL } from 'node:url';
import { compressRtf, msg, recipient, sender, utf8 } from './msg-writer.mjs';

const directory = new URL('../../corpus/msg/', import.meta.url);

const fixtures = new Map([
  [
    'plain-attachments.msg',
    msg({
      strings: [
        [0x0037, 'Field survey schedule'],
        ...sender('Ada Field', 'ada@example.org'),
        [0x1000, 'Hello team,\r\n\r\nThe river survey starts on Monday at 08:00.\r\nBring waders.\r\n\r\nThe plot list and counts are attached.\r\n'],
      ],
      times: [[0x0039, '2025-03-14T09:30:00Z']],
      recipients: [
        recipient(1, 'Grace Plot', 'grace@example.org'),
        recipient(1, 'Alan Count', 'alan@example.org'),
        recipient(2, 'Survey Desk', 'desk@example.org'),
      ],
      attachments: [
        {
          strings: [
            [0x3707, 'plots.txt'],
            [0x370e, 'text/plain'],
          ],
          binaries: [[0x3701, utf8('North meadow\nSouth bank\nOld orchard\n')]],
          longs: [[0x3705, 1]],
        },
        {
          strings: [[0x3707, 'counts.csv']],
          binaries: [[0x3701, utf8('species,count\nheron,4\nkingfisher,1\n')]],
          longs: [[0x3705, 1]],
        },
      ],
    }),
  ],
  [
    'html-body.msg',
    msg({
      strings: [
        [0x0037, 'Weekly bird counts'],
        ...sender('Grace Plot', 'grace@example.org'),
      ],
      binaries: [
        [
          0x1013,
          utf8(
            '<html><body><h1>Weekly counts</h1><p>Totals for <b>week 11</b>, see <a href="https://example.org/counts">the archive</a>.</p>' +
              '<table><tr><th>Species</th><th>Count</th></tr><tr><td>Heron</td><td>4</td></tr><tr><td>Wren</td><td>12</td></tr></table>' +
              '<p>Photo: <img src="cid:wren01" alt="wren"></p></body></html>',
          ),
        ],
      ],
      longs: [[0x3fde, 65001]],
      times: [[0x0039, '2025-03-21T16:05:00Z']],
      recipients: [recipient(1, 'Ada Field', 'ada@example.org')],
      attachments: [
        {
          strings: [
            [0x3707, 'wren.txt'],
            [0x3712, 'wren01'],
          ],
          binaries: [[0x3701, utf8('A placeholder for an inline image.\n')]],
          longs: [[0x3705, 1]],
        },
      ],
    }),
  ],
  [
    'rtf-fromhtml.msg',
    msg({
      strings: [
        [0x0037, 'Encapsulated HTML body'],
        ...sender('Alan Count', 'alan@example.org'),
      ],
      binaries: [
        [
          0x1009,
          compressRtf(
            '{\\rtf1\\ansi\\ansicpg1252\\fromhtml1 \\deff0{\\fonttbl{\\f0\\fswiss Arial;}}\r\n' +
              '{\\*\\htmltag19 <html>}{\\*\\htmltag50 <body>}\r\n' +
              '{\\*\\htmltag64 <p>}\\htmlrtf {\\htmlrtf0 The tide table for April is ready.\\htmlrtf }\\htmlrtf0 {\\*\\htmltag72 </p>}\r\n' +
              '{\\*\\htmltag64 <p>}\\htmlrtf {\\htmlrtf0 High water at 06:12 and 18:40.\\htmlrtf }\\htmlrtf0 {\\*\\htmltag72 </p>}\r\n' +
              '{\\*\\htmltag58 </body>}{\\*\\htmltag27 </html>}}',
          ),
        ],
      ],
      times: [[0x0039, '2025-04-01T07:00:00Z']],
      recipients: [recipient(1, 'Survey Desk', 'desk@example.org')],
    }),
  ],
  [
    'rtf-ansi-1251.msg',
    msg({
      ansi: true,
      strings: [
        [0x0037, 'Отчет о съемке'],
        [0x0c1a, 'Ivan Survey'],
        [0x0c1f, 'ivan@example.org'],
      ],
      binaries: [
        [
          0x1009,
          compressRtf(
            '{\\rtf1\\ansi\\deff0{\\fonttbl{\\f0 Times New Roman;}}\\pard Plain RTF body, repeated: survey survey survey.\\par\r\n' +
              '\\pard Second paragraph with \\b bold\\b0  text.\\par\r\n}',
          ),
        ],
      ],
      longs: [[0x3ffd, 1251]],
      times: [[0x0039, '2025-04-02T11:15:00Z']],
    }),
  ],
  [
    'embedded-message.msg',
    msg({
      strings: [
        [0x0037, 'Fwd: Field survey schedule'],
        ...sender('Survey Desk', 'desk@example.org'),
        [0x1000, 'Forwarding the original schedule below.\r\n'],
      ],
      times: [[0x0039, '2025-03-15T10:00:00Z']],
      recipients: [recipient(1, 'Ada Field', 'ada@example.org')],
      attachments: [
        {
          strings: [[0x3001, 'Field survey schedule']],
          longs: [[0x3705, 5]],
          embedded: {
            strings: [
              [0x0037, 'Field survey schedule'],
              ...sender('Ada Field', 'ada@example.org'),
              [0x1000, 'The river survey starts on Monday at 08:00.\r\n'],
            ],
            times: [[0x0039, '2025-03-14T09:30:00Z']],
            recipients: [recipient(1, 'Survey Desk', 'desk@example.org')],
            attachments: [
              {
                strings: [[0x3707, 'plots.txt']],
                binaries: [[0x3701, utf8('North meadow\nSouth bank\n')]],
                longs: [[0x3705, 1]],
              },
            ],
          },
        },
      ],
    }),
  ],
]);

for (const [name, bytes] of fixtures) await writeFile(new URL(name, directory), bytes);
