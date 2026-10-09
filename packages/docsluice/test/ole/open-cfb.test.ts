import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Budget } from '../../src/core/budget.js';
import { resolveLimits } from '../../src/core/limits.js';
import { AbortError, CorruptFileError, LimitExceededError } from '../../src/core/errors.js';
import { resolveFormat } from '../../src/detect/detect.js';
import { openCfb } from '../../src/ole/index.js';

const FREE = 0xffff_ffff;
const END = 0xffff_fffe;
const FAT = 0xffff_fffd;

interface FixtureOptions {
  sectorSize?: 512 | 4096;
  mini?: boolean;
  fatLoop?: boolean;
  difatLoop?: boolean;
  directoryCycle?: boolean;
  difatFat?: boolean;
  difatNotTerminated?: boolean;
  miniFatWithoutCount?: boolean;
  overlappingStreams?: number;
  reportedSize?: number;
}

function makeCfb(options: FixtureOptions = {}): Uint8Array {
  const sectorSize = options.sectorSize ?? 512;
  const mini = options.mini ?? false;
  const bytes = new Uint8Array(sectorSize * 7);
  const view = new DataView(bytes.buffer);
  const header = bytes.subarray(0, sectorSize);
  header.set([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
  view.setUint16(24, 0x003e, true);
  view.setUint16(26, sectorSize === 512 ? 3 : 4, true);
  view.setUint16(28, 0xfffe, true);
  view.setUint16(30, sectorSize === 512 ? 9 : 12, true);
  view.setUint16(32, 6, true);
  view.setUint32(40, sectorSize === 512 ? 0 : 1, true);
  view.setUint32(44, 1, true);
  view.setUint32(48, 2, true);
  view.setUint32(56, 4096, true);
  view.setUint32(60, mini || options.miniFatWithoutCount ? 1 : END, true);
  view.setUint32(64, mini ? 1 : 0, true);
  view.setUint32(68, options.difatLoop || options.difatFat || options.difatNotTerminated ? 5 : END, true);
  view.setUint32(72, options.difatLoop ? 2 : options.difatFat || options.difatNotTerminated ? 1 : 0, true);
  for (let i = 0; i < 109; i++) view.setUint32(76 + i * 4, i === 0 && !options.difatFat ? 0 : FREE, true);

  const sector = (sid: number) => bytes.subarray((sid + 1) * sectorSize, (sid + 2) * sectorSize);
  const fat = new DataView(sector(0).buffer, sector(0).byteOffset, sectorSize);
  for (let i = 0; i < sectorSize / 4; i++) fat.setUint32(i * 4, FREE, true);
  fat.setUint32(0, FAT, true);
  fat.setUint32(8, END, true);
  if (mini) {
    fat.setUint32(4, END, true);
    fat.setUint32(12, END, true);
    const miniFat = new DataView(sector(1).buffer, sector(1).byteOffset, sectorSize);
    for (let i = 0; i < sectorSize / 4; i++) miniFat.setUint32(i * 4, FREE, true);
    miniFat.setUint32(0, END, true);
    sector(3).set(new TextEncoder().encode('small stream'));
  } else {
    fat.setUint32(16, options.fatLoop ? 4 : END, true);
    sector(4).set(new TextEncoder().encode('regular stream'));
  }
  if (options.difatLoop) {
    const difat = new DataView(sector(5).buffer, sector(5).byteOffset, sectorSize);
    for (let i = 0; i < sectorSize / 4 - 1; i++) difat.setUint32(i * 4, FREE, true);
    difat.setUint32((sectorSize / 4 - 1) * 4, 5, true);
  } else if (options.difatFat || options.difatNotTerminated) {
    const difat = new DataView(sector(5).buffer, sector(5).byteOffset, sectorSize);
    for (let i = 0; i < sectorSize / 4 - 1; i++) difat.setUint32(i * 4, FREE, true);
    if (options.difatFat) difat.setUint32(0, 0, true);
    difat.setUint32((sectorSize / 4 - 1) * 4, options.difatFat ? END : 5, true);
  }

  const dir = new DataView(sector(2).buffer, sector(2).byteOffset, sectorSize);
  const writeName = (entry: number, name: string) => {
    for (let i = 0; i < name.length; i++) dir.setUint16(entry * 128 + i * 2, name.charCodeAt(i), true);
    dir.setUint16(entry * 128 + 64, (name.length + 1) * 2, true);
  };
  writeName(0, 'Root Entry');
  dir.setUint8(0 * 128 + 66, 5);
  dir.setUint32(0 * 128 + 68, FREE, true);
  dir.setUint32(0 * 128 + 72, FREE, true);
  dir.setUint32(0 * 128 + 76, 1, true);
  dir.setUint32(0 * 128 + 116, mini ? 3 : END, true);
  dir.setUint32(0 * 128 + 120, mini ? 64 : 0, true);
  writeName(1, 'Storage');
  dir.setUint8(1 * 128 + 66, 1);
  dir.setUint32(1 * 128 + 68, options.directoryCycle ? 1 : FREE, true);
  dir.setUint32(1 * 128 + 72, FREE, true);
  dir.setUint32(1 * 128 + 76, 2, true);
  dir.setUint32(1 * 128 + 116, END, true);
  writeName(2, 'WordDocument');
  dir.setUint8(2 * 128 + 66, 2);
  dir.setUint32(2 * 128 + 68, FREE, true);
  dir.setUint32(2 * 128 + 72, FREE, true);
  dir.setUint32(2 * 128 + 76, FREE, true);
  dir.setUint32(2 * 128 + 116, mini ? 0 : 4, true);
  dir.setUint32(2 * 128 + 120, options.reportedSize ?? (mini ? 12 : 5000), true);
  if (options.overlappingStreams) {
    dir.setUint32(2 * 128 + 72, 3, true);
    for (let alias = 0; alias < options.overlappingStreams; alias++) {
      const index = alias + 3;
      writeName(index, `AliasStream${alias}`);
      dir.setUint8(index * 128 + 66, 2);
      dir.setUint32(index * 128 + 68, FREE, true);
      dir.setUint32(index * 128 + 72, alias + 1 < options.overlappingStreams ? index + 1 : FREE, true);
      dir.setUint32(index * 128 + 76, FREE, true);
      dir.setUint32(index * 128 + 116, mini ? 0 : 4, true);
      dir.setUint32(index * 128 + 120, mini ? 12 : 512, true);
    }
  }
  return bytes;
}

describe('openCfb', () => {
  it('does not classify a nested WordDocument stream as a root DOC', async () => {
    const result = await resolveFormat(makeCfb(), {}, new Budget(resolveLimits()));

    expect(result.result.format).toBe('ole');
  });

  it('does not treat a nested EncryptedPackage stream as a root encrypted package', async () => {
    const fixture = makeCfb();
    renameDirectoryStream(fixture, 'WordDocument', 'EncryptedPackage');
    const result = await resolveFormat(fixture, {}, new Budget(resolveLimits()));

    expect(result.result.format).toBe('ole');
  });

  it.each(['libreoffice.doc', 'libreoffice.xls', 'libreoffice.ppt', 'test_outlook_msg.msg'])(
    'opens the licensed %s fixture and reads every stream',
    (filename) => {
      const fixture = new Uint8Array(
        readFileSync(fileURLToPath(new URL(`../../../../corpus/ole/${filename}`, import.meta.url))),
      );
      const budget = new Budget(resolveLimits());
      const cfb = openCfb(fixture, budget);
      const streams = cfb.entries.filter((entry) => entry.type === 'stream');
      expect(streams.length).toBeGreaterThan(0);
      for (const stream of streams) {
        budget.tick();
        expect(cfb.read(stream.path)).toHaveLength(stream.size);
      }
    },
  );

  it.each(['fat-loop.cfb', 'difat-loop.cfb', 'directory-cycle.cfb'])(
    'rejects hostile fixture %s',
    (filename) => {
      const fixture = new Uint8Array(
        readFileSync(fileURLToPath(new URL(`../../../../hostile/ole/${filename}`, import.meta.url))),
      );
      expect(() => openCfb(fixture, new Budget(resolveLimits()))).toThrow(CorruptFileError);
    },
  );

  it('caps a hostile stream-size claim at the reachable bytes', () => {
    const budget = new Budget(resolveLimits());
    const fixture = new Uint8Array(
      readFileSync(fileURLToPath(new URL('../../../../hostile/ole/huge-stream-size.cfb', import.meta.url))),
    );
    const archive = openCfb(fixture, budget);
    expect(archive.entries[1]?.size).toBe(512);
    expect(archive.read('HugeStream')).toHaveLength(512);
    expect(budget.warnings.warnings).toEqual([]);
  });

  it('ticks the shared budget before validating malformed input', () => {
    const controller = new AbortController();
    controller.abort();
    const budget = new Budget(resolveLimits(), { signal: controller.signal });
    expect(() => openCfb(new Uint8Array(0), budget)).toThrow(AbortError);
  });

  it('skips directory-slot parsing when the shared archive-entry budget truncates', () => {
    const fixture = makeCfb();
    new DataView(fixture.buffer).setUint8(3 * 512 + 128 + 66, 9);
    const budget = new Budget(resolveLimits({ zipEntries: 1 }));
    const archive = openCfb(fixture, budget);
    expect(archive.entries).toEqual([{ path: '', size: 0, type: 'root' }]);
    expect(() => archive.read('Storage/WordDocument')).toThrow(RangeError);
    expect(budget.entries).toBe(3);
    expect(budget.truncated).toBe(true);
  });

  it('throws the shared archive-entry limit when configured to throw', () => {
    const budget = new Budget(resolveLimits({ zipEntries: 1 }), { onLimit: 'throw' });
    expect(() => openCfb(makeCfb(), budget)).toThrow(LimitExceededError);
  });

  it('shares physical directory-slot counts across CFB archives', () => {
    const budget = new Budget(resolveLimits({ zipEntries: 3 }));
    expect(openCfb(makeCfb(), budget).entries).toHaveLength(3);
    const second = openCfb(makeCfb(), budget);
    expect(second.entries).toEqual([{ path: '', size: 0, type: 'root' }]);
    expect(budget.entries).toBe(6);
  });

  it('lists storages and reads a regular stream', () => {
    const cfb = openCfb(makeCfb(), new Budget(resolveLimits()));
    expect(cfb.entries).toEqual([
      { path: '', size: 0, type: 'root' },
      { path: 'Storage', size: 0, type: 'storage' },
      { path: 'Storage/WordDocument', size: 512, type: 'stream' },
    ]);
    expect(new TextDecoder().decode(cfb.read('Storage/WordDocument').subarray(0, 14))).toBe('regular stream');
  });

  it('reads mini streams through the mini FAT', () => {
    const cfb = openCfb(makeCfb({ mini: true }), new Budget(resolveLimits()));
    expect(new TextDecoder().decode(cfb.read('Storage/WordDocument'))).toBe('small stream');
  });

  it('rejects multiple streams that alias the same regular sector chain', () => {
    expect(() =>
      openCfb(makeCfb({ sectorSize: 4096, overlappingStreams: 16 }), new Budget(resolveLimits())),
    ).toThrow(CorruptFileError);
  });

  it('rejects multiple streams that alias the same mini-sector chain', () => {
    expect(() =>
      openCfb(makeCfb({ mini: true, overlappingStreams: 1 }), new Budget(resolveLimits())),
    ).toThrow(CorruptFileError);
  });

  it('supports 4096-byte sectors', () => {
    const cfb = openCfb(makeCfb({ sectorSize: 4096 }), new Budget(resolveLimits()));
    expect(cfb.read('Storage/WordDocument')).toHaveLength(4096);
  });

  it('rejects FAT loops', () => {
    expect(() => openCfb(makeCfb({ fatLoop: true }), new Budget(resolveLimits()))).toThrow(CorruptFileError);
  });

  it('rejects DIFAT loops', () => {
    expect(() => openCfb(makeCfb({ difatLoop: true }), new Budget(resolveLimits()))).toThrow(
      CorruptFileError,
    );
  });

  it('reads FAT sector ids from a valid DIFAT sector', () => {
    const cfb = openCfb(makeCfb({ difatFat: true }), new Budget(resolveLimits()));
    expect(cfb.entries.some((entry) => entry.type === 'stream')).toBe(true);
  });

  it('rejects a DIFAT chain that continues beyond its declared length', () => {
    expect(() => openCfb(makeCfb({ difatNotTerminated: true }), new Budget(resolveLimits()))).toThrow(
      CorruptFileError,
    );
  });

  it('rejects directory cycles', () => {
    const budget = new Budget(resolveLimits({ blockDepth: 1 }));
    expect(() => openCfb(makeCfb({ directoryCycle: true }), budget)).toThrow(CorruptFileError);
    expect(budget.enterDepth('block')).toBe(true);
    budget.exitDepth('block');
  });

  it('bounds huge claimed sizes by the stream chain', () => {
    const cfb = openCfb(makeCfb({ reportedSize: 0xffff_ffff }), new Budget(resolveLimits()));
    expect(cfb.entries[2]?.size).toBe(512);
    expect(cfb.read('Storage/WordDocument')).toHaveLength(512);
  });

  it('rejects invalid magic and unsupported sector shifts', () => {
    const wrongMagic = makeCfb();
    wrongMagic[0] = 0;
    expect(() => openCfb(wrongMagic, new Budget(resolveLimits()))).toThrow(CorruptFileError);
    const wrongShift = makeCfb();
    new DataView(wrongShift.buffer).setUint16(30, 10, true);
    expect(() => openCfb(wrongShift, new Budget(resolveLimits()))).toThrow(CorruptFileError);
    const wrongMiniShift = makeCfb();
    new DataView(wrongMiniShift.buffer).setUint16(32, 7, true);
    expect(() => openCfb(wrongMiniShift, new Budget(resolveLimits()))).toThrow(CorruptFileError);
  });

  it('rejects FAT and directory counts beyond the actual file', () => {
    const tooManyFatSectors = makeCfb();
    new DataView(tooManyFatSectors.buffer).setUint32(44, 999, true);
    expect(() => openCfb(tooManyFatSectors, new Budget(resolveLimits()))).toThrow(CorruptFileError);
    const directoryOutOfRange = makeCfb();
    new DataView(directoryOutOfRange.buffer).setUint32(48, 999, true);
    expect(() => openCfb(directoryOutOfRange, new Budget(resolveLimits()))).toThrow(CorruptFileError);
  });

  it('rejects inconsistent MiniFAT header fields', () => {
    expect(() => openCfb(makeCfb({ miniFatWithoutCount: true }), new Budget(resolveLimits()))).toThrow(
      CorruptFileError,
    );
  });

  it('balances depth when a storage tree is skipped by the budget', () => {
    const archive = openCfb(makeCfb(), new Budget(resolveLimits({ blockDepth: 1 })));
    expect(archive.entries.map((entry) => entry.type)).toEqual(['root', 'storage']);
  });

  it('restores the shared block depth after directory enumeration', () => {
    const budget = new Budget(resolveLimits({ blockDepth: 1 }));
    openCfb(makeCfb(), budget);
    expect(budget.enterDepth('block')).toBe(true);
    budget.exitDepth('block');
  });

  it('balances a thrown depth limit while descending storage entries', () => {
    const budget = new Budget(resolveLimits({ blockDepth: 1 }), { onLimit: 'throw' });
    expect(() => openCfb(makeCfb(), budget)).toThrow();
    expect(budget.enterDepth('block')).toBe(true);
    budget.exitDepth('block');
  });

  it('balances depth when the root directory tree exceeds the budget', () => {
    const archive = openCfb(makeCfb(), new Budget(resolveLimits({ blockDepth: 0 })));
    expect(archive.entries.map((entry) => entry.type)).toEqual(['root']);
  });

  it('ticks the shared budget while walking sectors', () => {
    const budget = new Budget(resolveLimits());
    const tick = vi.spyOn(budget, 'tick');
    const cfb = openCfb(makeCfb(), budget);
    cfb.read('Storage/WordDocument');
    expect(tick).toHaveBeenCalled();
    expect(budget.totalUncompressedBytes).toBe(512);
  });
});

function renameDirectoryStream(bytes: Uint8Array, from: string, to: string): void {
  const findName = (value: string): number => {
    for (let offset = 0; offset + value.length * 2 <= bytes.length; offset += 1) {
      let matches = true;
      for (let index = 0; index < value.length; index += 1) {
        if (bytes[offset + index * 2] !== value.charCodeAt(index) || bytes[offset + index * 2 + 1] !== 0) {
          matches = false;
          break;
        }
      }
      if (matches && bytes[offset + value.length * 2] === 0 && bytes[offset + value.length * 2 + 1] === 0)
        return offset;
    }
    return -1;
  };
  const offset = findName(from);
  if (offset < 0) throw new RangeError('Directory stream name was not found.');
  const replacement = new Uint8Array(to.length * 2);
  for (let index = 0; index < to.length; index += 1) replacement[index * 2] = to.charCodeAt(index);
  bytes.fill(0, offset, offset + 64);
  bytes.set(replacement, offset);
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).setUint16(
    offset + 64,
    replacement.length + 2,
    true,
  );
}
