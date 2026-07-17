import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateRawSync } from 'node:zlib';

import { describe, expect, it } from 'vitest';

import { acceptLinkedinArchiveZip } from './archive-acceptance.js';
import { readLinkedinArchiveZipEntries } from './archive-zip.js';
import { SYNTHETIC_LINKEDIN_MESSAGES_CSV_BYTES } from './fixtures.js';

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) === 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let value = 0xffffffff;
  for (const byte of bytes) {
    value = (CRC_TABLE[(value ^ byte) & 0xff] as number) ^ (value >>> 8);
  }
  return (value ^ 0xffffffff) >>> 0;
}

function zip(entries: readonly { path: string; bytes: Uint8Array }[]): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let localOffset = 0;
  for (const entry of entries) {
    const path = Buffer.from(entry.path, 'utf8');
    const source = Buffer.from(entry.bytes);
    const compressed = deflateRawSync(source);
    const crc = crc32(source);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(source.length, 22);
    local.writeUInt16LE(path.length, 26);
    localParts.push(local, path, compressed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(source.length, 24);
    central.writeUInt16LE(path.length, 28);
    central.writeUInt32LE(localOffset, 42);
    centralParts.push(central, path);
    localOffset += local.length + path.length + compressed.length;
  }
  const centralDirectory = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralDirectory.length, 12);
  eocd.writeUInt32LE(localOffset, 16);
  return Buffer.concat([...localParts, centralDirectory, eocd]);
}

async function withTempZip<T>(
  bytes: Uint8Array,
  run: (path: string) => Promise<T>,
): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), 'linkedin-archive-'));
  const path = join(directory, 'input.zip');
  try {
    await writeFile(path, bytes);
    return await run(path);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

describe('LinkedIn ZIP archive acceptance', () => {
  it('streams a ZIP through the existing import contract and emits redacted aggregate facts', async () => {
    const bytes = zip([
      {
        path: 'Complete_LinkedInDataExport/messages.csv',
        bytes: SYNTHETIC_LINKEDIN_MESSAGES_CSV_BYTES,
      },
    ]);
    const report = await withTempZip(bytes, (path) =>
      acceptLinkedinArchiveZip(path, {
        tenantId: 'tenant-acceptance',
        accountId: 'account-acceptance',
        importedAt: '2026-07-17T00:00:00.000Z',
      }),
    );

    expect(report.status).toBe('pass');
    expect(report.containerSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(report.logicalArchiveSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(report.counts).toMatchObject({ entries: 1, messages: 2 });
    expect(report.admission).toMatchObject({ admittedToRag: false });
    expect(JSON.stringify(report)).not.toContain('[SYNTHETIC]');
    expect(JSON.stringify(report)).not.toContain('messages.csv');
  });

  it('rejects unsafe member paths before import', async () => {
    const bytes = zip([
      { path: '../messages.csv', bytes: SYNTHETIC_LINKEDIN_MESSAGES_CSV_BYTES },
    ]);
    await expect(
      withTempZip(bytes, async (path) => {
        await readLinkedinArchiveZipEntries(path).next();
      }),
    ).rejects.toMatchObject({ code: 'UNSAFE_ARCHIVE_PATH' });
  });

  it('enforces compression-ratio bounds before inflating member content', async () => {
    const bytes = zip([
      {
        path: 'messages.csv',
        bytes: SYNTHETIC_LINKEDIN_MESSAGES_CSV_BYTES,
      },
    ]);
    await expect(
      withTempZip(bytes, async (path) => {
        await readLinkedinArchiveZipEntries(path, {
          maxCompressionRatio: 1,
        }).next();
      }),
    ).rejects.toMatchObject({ code: 'ZIP_COMPRESSION_RATIO_EXCEEDED' });
  });

  it('verifies CRC and uncompressed size while streaming', async () => {
    const bytes = zip([
      {
        path: 'messages.csv',
        bytes: SYNTHETIC_LINKEDIN_MESSAGES_CSV_BYTES,
      },
    ]);
    const centralOffset = bytes.readUInt32LE(bytes.length - 6);
    bytes.writeUInt32LE(0, centralOffset + 16);
    await expect(
      withTempZip(bytes, async (path) => {
        for await (const entry of readLinkedinArchiveZipEntries(path)) {
          let consumedBytes = 0;
          for await (const chunk of entry.bytes) {
            consumedBytes += chunk.byteLength;
          }
          expect(consumedBytes).toBeGreaterThan(0);
        }
      }),
    ).rejects.toMatchObject({ code: 'ZIP_ENTRY_INTEGRITY_FAILED' });
  });
});
