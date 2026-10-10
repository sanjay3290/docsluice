import { mkdir, writeFile } from 'node:fs/promises';
import { URL } from 'node:url';

// Hostile EML inputs: deep multipart nesting, unterminated multiparts, huge encoded lines, nested attachment bombs.
const eml = new URL('../../hostile/eml/', import.meta.url);
await mkdir(eml, { recursive: true });
const header = 'From: a@example.test\r\nSubject: hostile\r\nMIME-Version: 1.0\r\n';

// 10,000 nested multipart/mixed levels, each opened and never needed by the body.
let deep = header + 'Content-Type: multipart/mixed; boundary="b0"\r\n\r\n';
for (let level = 1; level <= 10_000; level++)
  deep += `--b${level - 1}\r\nContent-Type: multipart/mixed; boundary="b${level}"\r\n\r\n`;
deep += `--b10000\r\nContent-Type: text/plain\r\n\r\ndeepest\r\n`;
for (let level = 10_000; level >= 0; level--) deep += `--b${level}--\r\n`;
await writeFile(new URL('nested-multipart-10000.eml', eml), deep);

// A multipart whose closing delimiter never comes.
await writeFile(
  new URL('missing-boundary-end.eml', eml),
  header +
    'Content-Type: multipart/mixed; boundary="open"\r\n\r\n--open\r\nContent-Type: text/plain\r\n\r\nfirst\r\n' +
    '--open\r\nContent-Type: text/plain\r\n\r\nsecond part with no closing delimiter\r\n',
);

// One 384 KiB base64 line with no line breaks inside an attachment.
const chunk = 'QUJD'.repeat(1024);
await writeFile(
  new URL('huge-base64-line.eml', eml),
  header +
    'Content-Type: multipart/mixed; boundary="x"\r\n\r\n--x\r\nContent-Type: text/plain\r\n\r\nbody\r\n' +
    '--x\r\nContent-Type: application/octet-stream\r\nContent-Transfer-Encoding: base64\r\n' +
    'Content-Disposition: attachment; filename="big.bin"\r\n\r\n' +
    chunk.repeat(96) +
    '\r\n--x--\r\n',
);

// A MIME bomb: 200 message/rfc822 attachments nested inside each other, each level adding 8 attachments.
let message = 'From: a@example.test\r\nSubject: leaf\r\nContent-Type: text/plain\r\n\r\nleaf\r\n';
for (let level = 0; level < 200; level++) {
  const boundary = `bomb${level}`;
  let parts = '';
  for (let copy = 0; copy < 8; copy++)
    parts += `--${boundary}\r\nContent-Type: text/plain\r\nContent-Disposition: attachment; filename="a${level}-${copy}.txt"\r\n\r\nx\r\n`;
  parts += `--${boundary}\r\nContent-Type: message/rfc822\r\nContent-Disposition: attachment; filename="m${level}.eml"\r\n\r\n${message}\r\n`;
  message = `From: a@example.test\r\nSubject: level ${level}\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary="${boundary}"\r\n\r\n${parts}--${boundary}--\r\n`;
}
await writeFile(new URL('nested-attachment-bomb.eml', eml), message);
