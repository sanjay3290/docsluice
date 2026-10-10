import { mkdir, writeFile } from 'node:fs/promises';
import { URL } from 'node:url';

// Hostile mailboxes: 6,000 one-line messages, each with one MIME part (12,000 zipEntries), and 20,000 lines of nested ">From "
// quoting in one message.
const directory = new URL('../../hostile/mbox/', import.meta.url);
await mkdir(directory, { recursive: true });
const message = (index) => `From x\nFrom: x\nSubject: ${index}\n\nm\n`;
await writeFile(new URL('messages-6000.mbox', directory), Array.from({ length: 6_000 }, (_, index) => message(index)).join('\n'));
await writeFile(
  new URL('quoted-from-flood.mbox', directory),
  `From x@example.test Mon Oct  5 08:15:00 2026\nFrom: x@example.test\nSubject: quoted\n\n${'>>>>>>From q\n'.repeat(20_000)}`,
);
