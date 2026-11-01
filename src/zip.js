// Tiny dependency-free ZIP reader (store + deflate), enough to unpack the
// portable engine build. Reads through a file descriptor so a ~110 MB archive
// never has to sit in memory all at once.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const EOCD_SIG = 0x06054b50;
const CEN_SIG = 0x02014b50;

function findEocd(buf) {
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) return i;
  }
  return -1;
}

function readAt(fd, length, position) {
  const buf = Buffer.alloc(length);
  let read = 0;
  while (read < length) {
    const n = fs.readSync(fd, buf, read, length - read, position + read);
    if (n === 0) break;
    read += n;
  }
  return read === length ? buf : buf.subarray(0, read);
}

/** Reject entries that would escape the destination directory. */
function safeJoin(destDir, entryName) {
  const normalised = entryName.replace(/\\/g, '/').replace(/^\/+/, '');
  const target = path.resolve(destDir, normalised);
  const root = path.resolve(destDir) + path.sep;
  if (!target.startsWith(root)) return null;
  return target;
}

/**
 * Extract `zipPath` into `destDir`.
 * @param {string} zipPath
 * @param {string} destDir
 * @param {(bytes:number, total:number)=>void} [onProgress]
 * @returns {{files:number, entries:number}} extracted file count
 */
export function extractZip(zipPath, destDir, onProgress) {
  const fd = fs.openSync(zipPath, 'r');
  let files = 0;
  try {
    const size = fs.fstatSync(fd).size;
    const tailLen = Math.min(size, 65557);
    const tail = readAt(fd, tailLen, size - tailLen);
    const eocd = findEocd(tail);
    if (eocd < 0) throw new Error('Not a valid ZIP archive (no end-of-central-directory record).');

    const entryCount = tail.readUInt16LE(eocd + 10);
    const cdSize = tail.readUInt32LE(eocd + 12);
    const cdOffset = tail.readUInt32LE(eocd + 16);
    if (cdOffset === 0xffffffff) throw new Error('ZIP64 archives are not supported.');

    const cd = readAt(fd, cdSize, cdOffset);
    let p = 0;
    let done = 0;

    for (let i = 0; i < entryCount && p + 46 <= cd.length; i++) {
      if (cd.readUInt32LE(p) !== CEN_SIG) break;

      const method = cd.readUInt16LE(p + 10);
      const compSize = cd.readUInt32LE(p + 20);
      const nameLen = cd.readUInt16LE(p + 28);
      const extraLen = cd.readUInt16LE(p + 30);
      const commentLen = cd.readUInt16LE(p + 32);
      const localOffset = cd.readUInt32LE(p + 42);
      const name = cd.subarray(p + 46, p + 46 + nameLen).toString('utf8');
      p += 46 + nameLen + extraLen + commentLen;

      const target = safeJoin(destDir, name);
      if (!target) continue;

      if (name.endsWith('/') || name.endsWith('\\')) {
        fs.mkdirSync(target, { recursive: true });
        continue;
      }

      const localHeader = readAt(fd, 30, localOffset);
      if (localHeader.length < 30) continue;
      const localNameLen = localHeader.readUInt16LE(26);
      const localExtraLen = localHeader.readUInt16LE(28);
      const dataStart = localOffset + 30 + localNameLen + localExtraLen;

      const raw = readAt(fd, compSize, dataStart);
      let out;
      if (method === 0) {
        out = raw;
      } else if (method === 8) {
        out = zlib.inflateRawSync(raw);
      } else {
        throw new Error(`Unsupported ZIP compression method ${method} for ${name}`);
      }

      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, out);
      files++;
      done += compSize;
      onProgress?.(Math.min(done, size), size);
    }
    return { files, entries: entryCount };
  } finally {
    fs.closeSync(fd);
  }
}
