import { createReadStream } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { createInflateRaw } from 'node:zlib';

import { normalizeArchivePath } from './archive-path.js';
import type {
  LinkedinArchiveEntry,
  LinkedinArchiveZipLimits,
} from './archive-types.js';
import { LinkedinArchiveImportError } from './errors.js';

export const LINKEDIN_ARCHIVE_ZIP_DEFAULT_LIMITS = Object.freeze({
  maxContainerBytes: 128 * 1024 * 1024,
  maxEntries: 256,
  maxCompressedBytes: 128 * 1024 * 1024,
  maxUncompressedBytes: 128 * 1024 * 1024,
  maxCompressionRatio: 200,
});

interface EffectiveZipLimits {
  readonly maxContainerBytes: number;
  readonly maxEntries: number;
  readonly maxCompressedBytes: number;
  readonly maxUncompressedBytes: number;
  readonly maxCompressionRatio: number;
}

interface ZipEntryDescriptor {
  readonly path: string;
  readonly flags: number;
  readonly method: number;
  readonly crc32: number;
  readonly compressedSize: number;
  readonly uncompressedSize: number;
  readonly localHeaderOffset: number;
}

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const MAX_EOCD_SEARCH_BYTES = 65_557;
const UTF8 = new TextDecoder('utf-8', { fatal: true });

function bounded(
  value: number | undefined,
  fallback: number,
  hardMaximum: number,
): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError('ZIP limits must be positive safe integers');
  }
  return Math.min(value, hardMaximum);
}

function resolveZipLimits(
  overrides: LinkedinArchiveZipLimits,
): EffectiveZipLimits {
  const defaults = LINKEDIN_ARCHIVE_ZIP_DEFAULT_LIMITS;
  return {
    maxContainerBytes: bounded(
      overrides.maxContainerBytes,
      defaults.maxContainerBytes,
      defaults.maxContainerBytes,
    ),
    maxEntries: bounded(
      overrides.maxEntries,
      defaults.maxEntries,
      defaults.maxEntries,
    ),
    maxCompressedBytes: bounded(
      overrides.maxCompressedBytes,
      defaults.maxCompressedBytes,
      defaults.maxCompressedBytes,
    ),
    maxUncompressedBytes: bounded(
      overrides.maxUncompressedBytes,
      defaults.maxUncompressedBytes,
      defaults.maxUncompressedBytes,
    ),
    maxCompressionRatio: bounded(
      overrides.maxCompressionRatio,
      defaults.maxCompressionRatio,
      defaults.maxCompressionRatio,
    ),
  };
}

function invalidZip(): never {
  throw new LinkedinArchiveImportError('ZIP_CONTAINER_INVALID');
}

function findEocd(tail: Buffer): number {
  for (let offset = tail.length - 22; offset >= 0; offset -= 1) {
    if (tail.readUInt32LE(offset) !== EOCD_SIGNATURE) continue;
    const commentLength = tail.readUInt16LE(offset + 20);
    if (offset + 22 + commentLength === tail.length) return offset;
  }
  return invalidZip();
}

function decodePath(bytes: Buffer): string {
  try {
    return UTF8.decode(bytes);
  } catch {
    return invalidZip();
  }
}

async function readExactly(
  file: Awaited<ReturnType<typeof open>>,
  length: number,
  position: number,
): Promise<Buffer> {
  const buffer = Buffer.allocUnsafe(length);
  const { bytesRead } = await file.read(buffer, 0, length, position);
  if (bytesRead !== length) return invalidZip();
  return buffer;
}

async function readDirectory(
  filePath: string,
  limits: EffectiveZipLimits,
): Promise<{
  readonly file: Awaited<ReturnType<typeof open>>;
  readonly entries: readonly ZipEntryDescriptor[];
}> {
  const stat = await lstat(filePath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 22)
    return invalidZip();
  if (stat.size > limits.maxContainerBytes) {
    throw new LinkedinArchiveImportError('ZIP_CONTAINER_LIMIT_EXCEEDED');
  }

  const file = await open(filePath, 'r');
  try {
    const tailLength = Math.min(stat.size, MAX_EOCD_SEARCH_BYTES);
    const tail = await readExactly(file, tailLength, stat.size - tailLength);
    const eocdOffset = findEocd(tail);
    const disk = tail.readUInt16LE(eocdOffset + 4);
    const centralDisk = tail.readUInt16LE(eocdOffset + 6);
    const entriesOnDisk = tail.readUInt16LE(eocdOffset + 8);
    const entryCount = tail.readUInt16LE(eocdOffset + 10);
    const centralSize = tail.readUInt32LE(eocdOffset + 12);
    const centralOffset = tail.readUInt32LE(eocdOffset + 16);
    if (disk !== 0 || centralDisk !== 0 || entriesOnDisk !== entryCount) {
      return invalidZip();
    }
    if (
      entryCount === 0xffff ||
      centralSize === 0xffffffff ||
      centralOffset === 0xffffffff
    ) {
      throw new LinkedinArchiveImportError('ZIP64_UNSUPPORTED');
    }
    if (entryCount > limits.maxEntries) {
      throw new LinkedinArchiveImportError('ARCHIVE_ENTRY_LIMIT_EXCEEDED');
    }
    const absoluteEocdOffset = stat.size - tailLength + eocdOffset;
    if (centralOffset + centralSize !== absoluteEocdOffset) return invalidZip();

    const central = await readExactly(file, centralSize, centralOffset);
    const entries: ZipEntryDescriptor[] = [];
    let offset = 0;
    let totalCompressed = 0;
    let totalUncompressed = 0;
    for (let index = 0; index < entryCount; index += 1) {
      if (
        offset + 46 > central.length ||
        central.readUInt32LE(offset) !== CENTRAL_SIGNATURE
      ) {
        return invalidZip();
      }
      const flags = central.readUInt16LE(offset + 8);
      const method = central.readUInt16LE(offset + 10);
      const crc32 = central.readUInt32LE(offset + 16);
      const compressedSize = central.readUInt32LE(offset + 20);
      const uncompressedSize = central.readUInt32LE(offset + 24);
      const pathLength = central.readUInt16LE(offset + 28);
      const extraLength = central.readUInt16LE(offset + 30);
      const commentLength = central.readUInt16LE(offset + 32);
      const diskStart = central.readUInt16LE(offset + 34);
      const localHeaderOffset = central.readUInt32LE(offset + 42);
      const end = offset + 46 + pathLength + extraLength + commentLength;
      if (end > central.length || diskStart !== 0) return invalidZip();
      if (
        compressedSize === 0xffffffff ||
        uncompressedSize === 0xffffffff ||
        localHeaderOffset === 0xffffffff
      ) {
        throw new LinkedinArchiveImportError('ZIP64_UNSUPPORTED');
      }
      if ((flags & 0x0001) !== 0 || (flags & 0x0040) !== 0) {
        throw new LinkedinArchiveImportError('ZIP_ENCRYPTION_UNSUPPORTED');
      }
      if (method !== 0 && method !== 8) {
        throw new LinkedinArchiveImportError('ZIP_COMPRESSION_UNSUPPORTED');
      }
      totalCompressed += compressedSize;
      totalUncompressed += uncompressedSize;
      if (totalCompressed > limits.maxCompressedBytes) {
        throw new LinkedinArchiveImportError('ZIP_CONTAINER_LIMIT_EXCEEDED');
      }
      if (totalUncompressed > limits.maxUncompressedBytes) {
        throw new LinkedinArchiveImportError('ARCHIVE_BYTE_LIMIT_EXCEEDED');
      }
      if (
        compressedSize === 0
          ? uncompressedSize !== 0
          : uncompressedSize / compressedSize > limits.maxCompressionRatio
      ) {
        throw new LinkedinArchiveImportError('ZIP_COMPRESSION_RATIO_EXCEEDED');
      }

      const path = decodePath(
        central.subarray(offset + 46, offset + 46 + pathLength),
      );
      if (!path.endsWith('/')) {
        entries.push({
          path: normalizeArchivePath(path),
          flags,
          method,
          crc32,
          compressedSize,
          uncompressedSize,
          localHeaderOffset,
        });
      } else if (path.length > 1) {
        normalizeArchivePath(path.slice(0, -1));
      }
      offset = end;
    }
    if (offset !== central.length) return invalidZip();
    return { file, entries };
  } catch (error) {
    await file.close();
    throw error;
  }
}

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

function updateCrc32(crc: number, chunk: Uint8Array): number {
  let value = crc;
  for (const byte of chunk) {
    value = (CRC_TABLE[(value ^ byte) & 0xff] as number) ^ (value >>> 8);
  }
  return value >>> 0;
}

async function localDataOffset(
  file: Awaited<ReturnType<typeof open>>,
  entry: ZipEntryDescriptor,
  centralOffset: number,
): Promise<number> {
  const header = await readExactly(file, 30, entry.localHeaderOffset);
  if (header.readUInt32LE(0) !== LOCAL_SIGNATURE) return invalidZip();
  const flags = header.readUInt16LE(6);
  const method = header.readUInt16LE(8);
  const pathLength = header.readUInt16LE(26);
  const extraLength = header.readUInt16LE(28);
  if (flags !== entry.flags || method !== entry.method) return invalidZip();
  const localPath = decodePath(
    await readExactly(file, pathLength, entry.localHeaderOffset + 30),
  );
  if (localPath !== entry.path) return invalidZip();
  const dataOffset = entry.localHeaderOffset + 30 + pathLength + extraLength;
  if (dataOffset + entry.compressedSize > centralOffset) return invalidZip();
  return dataOffset;
}

async function* streamEntry(
  filePath: string,
  file: Awaited<ReturnType<typeof open>>,
  entry: ZipEntryDescriptor,
  centralOffset: number,
): AsyncGenerator<Uint8Array> {
  const dataOffset = await localDataOffset(file, entry, centralOffset);
  if (entry.compressedSize === 0) {
    if (entry.uncompressedSize !== 0 || entry.crc32 !== 0) {
      throw new LinkedinArchiveImportError('ZIP_ENTRY_INTEGRITY_FAILED');
    }
    return;
  }
  const source = createReadStream(filePath, {
    start: dataOffset,
    end: dataOffset + entry.compressedSize - 1,
  });
  const output = entry.method === 8 ? source.pipe(createInflateRaw()) : source;
  let size = 0;
  let crc = 0xffffffff;
  try {
    for await (const value of output) {
      const chunk = value as Buffer;
      size += chunk.byteLength;
      if (size > entry.uncompressedSize) {
        throw new LinkedinArchiveImportError('ZIP_ENTRY_INTEGRITY_FAILED');
      }
      crc = updateCrc32(crc, chunk);
      yield chunk;
    }
  } catch (error) {
    if (error instanceof LinkedinArchiveImportError) throw error;
    throw new LinkedinArchiveImportError('ZIP_ENTRY_INTEGRITY_FAILED');
  } finally {
    source.destroy();
    if (output !== source) output.destroy();
  }
  if (
    size !== entry.uncompressedSize ||
    (crc ^ 0xffffffff) >>> 0 !== entry.crc32
  ) {
    throw new LinkedinArchiveImportError('ZIP_ENTRY_INTEGRITY_FAILED');
  }
}

export async function* readLinkedinArchiveZipEntries(
  filePath: string,
  limitOverrides: LinkedinArchiveZipLimits = {},
): AsyncGenerator<LinkedinArchiveEntry> {
  const limits = resolveZipLimits(limitOverrides);
  const { file, entries } = await readDirectory(filePath, limits);
  const stat = await file.stat();
  const tailLength = Math.min(stat.size, MAX_EOCD_SEARCH_BYTES);
  const tail = await readExactly(file, tailLength, stat.size - tailLength);
  const centralOffset = tail.readUInt32LE(findEocd(tail) + 16);
  try {
    for (const entry of entries) {
      yield {
        path: entry.path,
        declaredSizeBytes: entry.uncompressedSize,
        bytes: streamEntry(filePath, file, entry, centralOffset),
      };
    }
  } finally {
    await file.close();
  }
}
