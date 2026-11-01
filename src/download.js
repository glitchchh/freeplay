// Downloads a portable AirPlay engine build into ./engine.
//
// Windows: the community portable build of UxPlay (leapbtw/uxplay-windows).
// Linux/macOS: UxPlay is best installed from source/package; Freeplay detects it
// on PATH, so there is nothing to download there.
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { DOWNLOAD_DIR, ENGINE_DIR } from './config.js';
import { extractZip } from './zip.js';

export const ENGINES = {
  win32: {
    name: 'UxPlay for Windows',
    archive: 'uxplay-windows.zip',
    url: 'https://github.com/leapbtw/uxplay-windows/releases/download/2.0.0.1736/uxplay-windows.zip',
    homepage: 'https://github.com/leapbtw/uxplay-windows',
    approxBytes: 113_500_000,
    note: 'Third-party portable build of UxPlay (GPLv3, unsigned). Windows may warn on first launch.',
  },
  linux: {
    name: 'UxPlay',
    url: null,
    homepage: 'https://github.com/FDH2/UxPlay',
    note: 'Install with your package manager (e.g. sudo apt install uxplay) or build from source. Freeplay will detect it on PATH.',
  },
  darwin: {
    name: 'UxPlay',
    url: null,
    homepage: 'https://github.com/FDH2/UxPlay',
    note: 'Install with Homebrew (brew install uxplay) or build from source. Freeplay will detect it on PATH.',
  },
};

export function enginePlan() {
  const plan = ENGINES[process.platform] || ENGINES.linux;
  return {
    platform: process.platform,
    name: plan.name,
    downloadable: Boolean(plan.url),
    url: plan.url,
    homepage: plan.homepage,
    approxBytes: plan.approxBytes ?? null,
    note: plan.note,
  };
}

/**
 * Download + unpack the engine. `onProgress` receives
 * {phase:'download'|'extract', received, total}.
 */
export async function installEngine(onProgress) {
  const plan = enginePlan();
  if (!plan.downloadable) throw new Error('There is no one-click engine build for this platform. See the install instructions.');

  fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
  const archivePath = path.join(DOWNLOAD_DIR, path.basename(new URL(plan.url).pathname));

  onProgress?.({ phase: 'download', received: 0, total: plan.approxBytes });
  const response = await fetch(plan.url, { redirect: 'follow' });
  if (!response.ok || !response.body) {
    throw new Error(`Download failed: HTTP ${response.status} ${response.statusText}`);
  }
  const total = Number(response.headers.get('content-length')) || plan.approxBytes;
  let received = 0;

  const source = Readable.fromWeb(response.body);
  source.on('data', (chunk) => {
    received += chunk.length;
    onProgress?.({ phase: 'download', received, total });
  });
  await pipeline(source, fs.createWriteStream(archivePath));

  const actual = fs.statSync(archivePath).size;
  if (actual < 1024 * 1024) {
    throw new Error(`Downloaded archive looks truncated (${actual} bytes).`);
  }

  onProgress?.({ phase: 'extract', received: 0, total: actual });
  const dest = path.join(ENGINE_DIR, 'uxplay-windows');
  fs.mkdirSync(dest, { recursive: true });
  extractZip(archivePath, dest, (done, size) => {
    onProgress?.({ phase: 'extract', received: done, total: size || actual });
  });

  let result = { files: 0 };
  try {
    result.files = countFiles(dest);
  } catch {
    /* non-fatal */
  }
  if (result.files === 0) throw new Error('The archive unpacked but contained no files.');

  // Keep the archive around only if extraction failed; it is 100+ MB.
  try {
    fs.unlinkSync(archivePath);
  } catch {
    /* fine */
  }
  onProgress?.({ phase: 'done', received: actual, total: actual });
  return { dest, files: result.files, source: plan.homepage };
}

function countFiles(dir) {
  let count = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    count += entry.isDirectory() ? countFiles(path.join(dir, entry.name)) : 1;
  }
  return count;
}
