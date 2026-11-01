// Project paths + persisted user settings for Freeplay.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const PUBLIC_DIR = path.join(ROOT, 'public');
export const DATA_DIR = path.join(ROOT, 'data');
export const ENGINE_DIR = path.join(ROOT, 'engine');
export const DOWNLOAD_DIR = path.join(ROOT, 'downloads');

const CONFIG_PATH = path.join(DATA_DIR, 'config.json');

export const DEFAULTS = {
  /** Name your iPhone/iPad sees in the Screen Mirroring list. */
  receiverName: 'Freeplay',
  /** Optional 4-digit code clients must enter (-pin). Empty = no code. */
  pin: '',
  /** Allow 4K/HEVC senders where the engine supports it (-h265). */
  h265: false,
  /** Ask the engine for a fullscreen mirror window (-fs). */
  fullscreen: false,
  /** Any extra engine flags, space separated. */
  extraArgs: '',
  /** Explicit path to an engine binary, if the user set one. */
  enginePath: '',
};

/** Sanitise and merge incoming patch values onto the current config. */
export function normaliseConfig(input, base = DEFAULTS) {
  const out = { ...base };
  if (!input || typeof input !== 'object') return out;

  if (typeof input.receiverName === 'string') {
    // Control characters would inject extra lines/flags into the engine's
    // arguments file, so collapse them before anything else.
    const name = input.receiverName.replace(/[\r\n\t]+/g, ' ').trim().slice(0, 48);
    out.receiverName = name || DEFAULTS.receiverName;
  }
  if (typeof input.pin === 'string' || input.pin === null) {
    const pin = String(input.pin ?? '').replace(/\D/g, '').slice(0, 4);
    out.pin = pin;
  }
  if (typeof input.h265 === 'boolean') out.h265 = input.h265;
  if (typeof input.fullscreen === 'boolean') out.fullscreen = input.fullscreen;
  if (typeof input.extraArgs === 'string') out.extraArgs = input.extraArgs.slice(0, 400);
  if (typeof input.enginePath === 'string') out.enginePath = input.enginePath.slice(0, 500);
  return out;
}

export function loadConfig() {
  try {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
    return normaliseConfig(JSON.parse(raw));
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveConfig(config) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const clean = normaliseConfig(config);
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(clean, null, 2) + '\n', 'utf8');
  return clean;
}

export function ensureDirs() {
  for (const dir of [DATA_DIR, ENGINE_DIR, DOWNLOAD_DIR]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}
