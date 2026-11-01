// The AirPlay engine layer.
//
// Freeplay does not reimplement AirPlay: screen mirroring is FairPlay-encrypted
// H.264, and the only working open-source receiver is UxPlay (C++/GStreamer).
// So Freeplay owns discovery, configuration, process lifecycle and status, and
// lets UxPlay do the protocol + decode work.
//
// Readiness is verified the same way an iPhone finds a receiver: by asking the
// network over mDNS. Engines pick their own RTSP port (the Windows build uses a
// random one), so probing a fixed port would be wrong.
import { EventEmitter } from 'node:events';
import { spawn, execFile } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { ENGINE_DIR } from './config.js';
import { discoverAirplay } from './discovery.js';

const IS_WIN = process.platform === 'win32';
const EXE = IS_WIN ? '.exe' : '';
const DISCOVERY_WINDOW = 1400;
const POLL_INTERVAL = 4000;

/** Depth-limited search for an engine binary inside `dir`. */
function findBinaryIn(dir, target, depth = 0) {
  if (depth > 4) return null;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const entry of entries) {
    if (entry.isFile() && entry.name.toLowerCase() === target) return path.join(dir, entry.name);
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const hit = findBinaryIn(path.join(dir, entry.name), target, depth + 1);
    if (hit) return hit;
  }
  return null;
}

function which(cmd) {
  const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  const names = IS_WIN ? [cmd, cmd + '.exe'] : [cmd];
  for (const dir of dirs) {
    for (const name of names) {
      const full = path.join(dir, name);
      try {
        if (fs.statSync(full).isFile()) return full;
      } catch {
        /* keep looking */
      }
    }
  }
  return null;
}

export function probePort(port, host = '127.0.0.1', timeout = 800) {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host });
    const finish = (ok) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeout);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
}

function run(command, args, timeout = 4000) {
  return new Promise((resolve) => {
    execFile(command, args, { timeout, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      resolve(err && !stdout ? '' : String(stdout || ''));
    });
  });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Count established TCP connections into a port (excluding loopback). */
export async function probeClients(port) {
  if (!port) return 0;
  try {
    if (IS_WIN) {
      // Windows netstat prints localized state names ("HERGESTELLT", "ABHÖREN"…),
      // so classify rows structurally instead: a listening row has a zero
      // foreign address, and dead/TIME_WAIT rows have no owning PID.
      const out = await run('netstat', ['-ano', '-p', 'TCP']);
      const needle = `:${port}`;
      return out.split(/\r?\n/).filter((line) => {
        const parts = line.trim().split(/\s+/);
        if (parts.length < 5 || parts[0].toUpperCase() !== 'TCP') return false;
        const [, local, remote, , pid] = parts;
        if (!local.endsWith(needle)) return false;
        if (remote === '0.0.0.0:0' || remote === '[::]:0' || remote === '*:*') return false;
        if (pid === '0') return false;
        if (remote.startsWith('127.0.0.1') || remote.startsWith('[::1]')) return false;
        return true;
      }).length;
    }
    if (process.platform === 'linux') {
      const out = await run('ss', ['-Htn', 'state', 'established']);
      const needle = `:${port}`;
      return out
        .split('\n')
        .map((l) => l.trim().split(/\s+/))
        .filter((parts) => parts.length >= 4 && parts[2].endsWith(needle) && !parts[3].startsWith('127.0.0.1'))
        .length;
    }
    const out = await run('netstat', ['-an', '-p', 'tcp']);
    const needle = `.${port}`;
    return out.split('\n').filter((line) => /ESTABLISHED/.test(line) && line.includes(needle) && !line.includes('127.0.0.1')).length;
  } catch {
    return 0;
  }
}

const LABELS = {
  cli: 'UxPlay',
  gui: 'UxPlay for Windows',
};

const normaliseName = (value) => String(value || '').trim().toLowerCase();

export class Engine extends EventEmitter {
  constructor() {
    super();
    this.proc = null;
    this.state = 'stopped';
    this.engine = null;
    this.advert = null;
    this.receiverName = '';
    this.startedAt = 0;
    this.stopping = false;
    this.lastError = '';
    this.notes = [];
    this.clients = 0;
    this.lastConnectionAt = 0;
    this.version = '';
    this.logLines = [];
    this.timers = { ready: null, poll: null };
  }

  log(line, level = 'info') {
    const entry = { t: Date.now(), level, line: String(line).replace(/\s+$/, '') };
    if (!entry.line) return;
    this.logLines.push(entry);
    if (this.logLines.length > 400) this.logLines.shift();
    this.emit('event', { type: 'log', entry });

    const version = /UxPlay\s+v?(\d+\.\d+[\w.\-]*)/i.exec(entry.line);
    if (version) this.version = version[1];
    if (/accepted .*client|client .*connected|connection request from/i.test(entry.line)) {
      this.lastConnectionAt = Date.now();
    }
  }

  /** Locate a usable engine: explicit path → bundled portable → PATH → install dirs. */
  detect(preferredPath = '') {
    const candidates = [];
    const portableName = IS_WIN ? 'uxplay-windows.exe' : 'uxplay';

    if (preferredPath) {
      candidates.push({ kind: path.basename(preferredPath).toLowerCase().includes('uxplay-windows') ? 'gui' : 'cli', full: preferredPath, source: 'configured' });
    }

    const bundled = findBinaryIn(ENGINE_DIR, portableName) || findBinaryIn(ENGINE_DIR, `uxplay${EXE}`);
    if (bundled) candidates.push({ kind: path.basename(bundled).toLowerCase().includes('uxplay-windows') ? 'gui' : 'cli', full: bundled, source: 'bundled' });

    for (const name of ['uxplay-windows', 'uxplay']) {
      const hit = which(name);
      if (hit) candidates.push({ kind: name.includes('windows') ? 'gui' : 'cli', full: hit, source: 'PATH' });
    }

    if (IS_WIN) {
      const roots = [
        process.env['ProgramFiles'],
        process.env['ProgramFiles(x86)'],
        process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs'),
      ].filter(Boolean);
      for (const root of roots) {
        for (const vendor of ['uxplay-windows', 'UxPlay', 'leapbtw']) {
          for (const exe of ['uxplay-windows.exe', 'uxplay.exe']) {
            const full = path.join(root, vendor, exe);
            try {
              if (fs.statSync(full).isFile()) {
                candidates.push({ kind: exe.includes('windows') ? 'gui' : 'cli', full, source: 'install dir' });
              }
            } catch {
              /* not installed there */
            }
          }
        }
      }
    }

    const found = candidates.find((candidate) => {
      try {
        return fs.statSync(candidate.full).isFile();
      } catch {
        return false;
      }
    });

    this.engine = found
      ? { kind: found.kind, path: found.full, source: found.source, label: LABELS[found.kind] || 'UxPlay' }
      : null;
    return this.engine;
  }

  buildArgs(config) {
    const args = ['-n', config.receiverName, '-nh'];
    if (config.pin && config.pin.length === 4) args.push('-pin', config.pin);
    if (config.h265 && this.engine?.kind === 'cli') args.push('-h265');
    if (config.fullscreen && this.engine?.kind === 'cli') args.push('-fs');
    if (config.extraArgs) args.push(...config.extraArgs.split(/\s+/).filter(Boolean));
    return args;
  }

  /**
   * The Windows GUI build ignores CLI flags and reads arguments.txt instead,
   * from %APPDATA%\leapbtw\uxplay-windows\ (a %ProgramData% file overrides it).
   */
  writeGuiArguments(config) {
    const args = this.buildArgs(config).filter((arg) => arg !== '-fs' && arg !== '-h265');
    const appData = process.env.APPDATA;
    if (!appData) {
      this.notes.push('APPDATA is not set, so engine arguments were passed on the command line instead.');
      return null;
    }
    const dir = path.join(appData, 'leapbtw', 'uxplay-windows');
    const file = path.join(dir, 'arguments.txt');
    try {
      fs.mkdirSync(dir, { recursive: true });
      if (fs.existsSync(file)) {
        const current = fs.readFileSync(file, 'utf8');
        const backup = file + '.freeplay-backup';
        if (!fs.existsSync(backup) && !current.includes('Freeplay')) {
          fs.writeFileSync(backup, current, 'utf8');
          this.notes.push(`Backed up your previous engine arguments to ${backup}`);
        }
      }
      const line = args.join(' ');
      fs.writeFileSync(file, line + '\n', 'utf8');
      this.log(`Engine arguments file: ${line}`);
    } catch (err) {
      this.notes.push(`Could not write engine arguments (${err.message}).`);
      return null;
    }

    const machineWide = path.join(process.env.ProgramData || 'C:/ProgramData', 'uxplay-windows', 'arguments.txt');
    if (fs.existsSync(machineWide)) {
      this.notes.push(`A machine-wide ${machineWide} exists and overrides the receiver name used here.`);
    }
    return file;
  }

  /**
   * The Windows GUI build splits its arguments file on whitespace, so a name
   * with a space makes it see extra flags and it exits immediately. Dash the
   * spaces instead of failing, and tell the user.
   */
  engineName(config) {
    const name = String(config.receiverName || '').trim().replace(/\s+/g, ' ');
    if (this.engine?.kind === 'gui' && name.includes(' ')) {
      const dashed = name.replace(/\s+/g, '-');
      this.notes.push(`This engine cannot take spaces in the AirPlay name, so Freeplay advertises it as “${dashed}”.`);
      return dashed;
    }
    return name;
  }

  /** Is one of our receivers advertising over mDNS? Prefers a name match. */
  async findAdvertisement() {
    const services = await discoverAirplay({ timeoutMs: DISCOVERY_WINDOW });
    if (!services.length) return null;

    if (this.advert) {
      const same = services.find((service) => service.instance === this.advert.instance);
      if (same) return same;
    }
    const wanted = normaliseName(this.receiverName);
    const named = services.find((service) => normaliseName(service.name) === wanted);
    if (named) return named;
    const prefixed = services.find((service) => normaliseName(service.name).startsWith(wanted));
    if (prefixed) return prefixed;

    // Adopt a lone receiver that is not using our name (e.g. a machine-wide
    // arguments.txt overrode it) once the name-matched wait has failed.
    if (services.length === 1 && this.startedAt && Date.now() - this.startedAt > 8000) {
      if (!this.adoptedElsewhere) {
        this.adoptedElsewhere = true;
        this.log(`Found a receiver advertising as “${services[0].name}” — using it.`, 'error');
      }
      return services[0];
    }
    return null;
  }

  async start(config) {
    if (this.proc) return this.status();
    this.notes = [];
    this.adoptedElsewhere = false;

    const engine = this.engine || this.detect(config.enginePath);
    const settings = { ...config, receiverName: this.engineName(config) };
    this.receiverName = settings.receiverName;
    if (!engine) {
      this.state = 'error';
      this.lastError = 'No AirPlay engine installed yet. Use “Install engine” to fetch one.';
      this.emit('event', { type: 'state', status: this.status() });
      throw new Error(this.lastError);
    }

    if (this.advert) {
      this.log('Another receiver is already advertising on this network — stopping it could be needed if this PC does not appear.', 'error');
    }

    const args = this.buildArgs(settings);
    if (engine.kind === 'gui') this.writeGuiArguments(settings);

    this.log(`Starting ${engine.label} → ${engine.path}`);
    this.log(`Arguments: ${args.join(' ')}`);

    let child;
    try {
      child = spawn(engine.path, args, {
        cwd: path.dirname(engine.path),
        windowsHide: false,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      this.state = 'error';
      this.lastError = err.message;
      this.emit('event', { type: 'state', status: this.status() });
      throw err;
    }

    this.proc = child;
    this.startedAt = Date.now();
    this.stopping = false;
    this.lastError = '';
    this.clients = 0;
    this.advert = null;
    this.state = 'starting';
    this.emit('event', { type: 'state', status: this.status() });

    const pipe = (stream, level) => {
      let buffer = '';
      stream.setEncoding('utf8');
      stream.on('data', (chunk) => {
        buffer += chunk;
        const parts = buffer.split(/\r?\n/);
        buffer = parts.pop() ?? '';
        for (const line of parts) this.log(line, level);
      });
    };
    if (child.stdout) pipe(child.stdout, 'info');
    if (child.stderr) pipe(child.stderr, 'error');

    child.on('error', (err) => {
      this.lastError = err.message;
      this.log(`Engine error: ${err.message}`, 'error');
      this.state = 'error';
      this.emit('event', { type: 'state', status: this.status() });
    });

    // The Windows GUI build may hand off to a detached copy of itself and exit
    // cleanly, so a clean exit is not treated as a failure.
    child.on('exit', (code, signal) => {
      this.log(`Engine process exited (code ${code ?? 'null'}${signal ? `, ${signal}` : ''})`, this.stopping || code === 0 ? 'info' : 'error');
      this.proc = null;
      this.clients = 0;
      if (this.stopping) {
        this.state = 'stopped';
      } else if (code === 0) {
        this.state = 'starting';
      } else {
        const immediate = this.startedAt && Date.now() - this.startedAt < 5000;
        this.lastError = immediate
          ? `The engine exited immediately (code ${code ?? 'null'}). It most likely rejected its arguments — check the receiver name and extra flags.`
          : `Engine stopped unexpectedly (exit code ${code ?? 'null'}).`;
        this.state = 'error';
      }
      if (this.state !== 'starting') {
        this.clearTimers();
        this.advert = null;
      }
      this.emit('event', { type: 'state', status: this.status() });
    });

    this.waitForAdvertisement();
    return this.status();
  }

  async waitForAdvertisement() {
    const deadline = Date.now() + 30_000;
    while (this.state === 'starting' && Date.now() < deadline && !this.stopping) {
      const advert = await this.findAdvertisement();
      if (advert) {
        this.advert = advert;
        this.state = 'live';
        this.clients = await probeClients(advert.port);
        this.log(`Advertising as “${advert.name}” on port ${advert.port} (${advert.model || 'AirPlay'}). Ready to mirror.`);
        this.emit('event', { type: 'state', status: this.status() });
        this.startPolling();
        return;
      }
      await sleep(700);
    }

    if (this.state !== 'starting' || this.stopping) return;
    this.state = 'error';
    this.lastError = 'The engine is running but is not advertising over Bonjour. Check the engine window and your firewall.';
    this.log(this.lastError, 'error');
    this.emit('event', { type: 'state', status: this.status() });
    this.startPolling();
  }

  startPolling() {
    this.clearTimers();
    const tick = async () => {
      if (this.stopping) return;
      const advert = await this.findAdvertisement();
      const previous = this.advert;
      this.advert = advert;

      if (advert) {
        const count = await probeClients(advert.port);
        const changed = count !== this.clients || this.state !== 'live';
        this.clients = count;
        if (this.state !== 'live') {
          this.state = 'live';
          this.log(`Advertising as “${advert.name}” on port ${advert.port}.`);
          this.emit('event', { type: 'state', status: this.status() });
        } else if (changed) {
          this.emit('event', { type: 'state', status: this.status() });
        } else {
          this.emit('event', { type: 'tick', status: this.status() });
        }
      } else if (previous) {
        this.state = 'starting';
        this.clients = 0;
        this.log('Receiver is no longer advertising. The engine may have shut down.', 'error');
        this.emit('event', { type: 'state', status: this.status() });
      } else {
        this.emit('event', { type: 'tick', status: this.status() });
      }
      if (!this.stopping) this.timers.poll = setTimeout(tick, POLL_INTERVAL);
    };
    this.timers.poll = setTimeout(tick, POLL_INTERVAL);
  }

  clearTimers() {
    if (this.timers.ready) clearTimeout(this.timers.ready);
    if (this.timers.poll) clearTimeout(this.timers.poll);
    this.timers = { ready: null, poll: null };
  }

  async stop() {
    this.clearTimers();
    const child = this.proc;
    this.stopping = true;
    this.log('Stopping engine…');

    if (child) {
      await new Promise((resolve) => {
        const done = () => resolve();
        child.once('exit', done);
        if (IS_WIN) {
          execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }, () => setTimeout(done, 400));
        } else {
          try {
            child.kill('SIGTERM');
          } catch {
            /* already gone */
          }
          setTimeout(() => {
            try {
              child.kill('SIGKILL');
            } catch {
              /* already gone */
            }
            done();
          }, 2000);
        }
        setTimeout(done, 4000);
      });
    }

    // The Windows GUI build can restart itself detached from our child handle;
    // stop any process still running that engine binary.
    if (IS_WIN && this.engine?.kind === 'gui') {
      await run('taskkill', ['/IM', path.basename(this.engine.path), '/F'], 6000);
    }

    this.proc = null;
    this.advert = null;
    this.clients = 0;
    this.state = 'stopped';
    this.stopping = false;
    this.emit('event', { type: 'state', status: this.status() });
    return this.status();
  }

  status() {
    const owner = this.proc || this.state === 'live' || this.state === 'starting';
    return {
      state: this.state,
      engine: this.engine
        ? { kind: this.engine.kind, path: this.engine.path, source: this.engine.source, label: this.engine.label }
        : null,
      version: this.version,
      port: this.advert?.port ?? null,
      advertised: this.advert
        ? {
            name: this.advert.name,
            port: this.advert.port,
            model: this.advert.model,
            address: this.advert.address,
            deviceId: this.advert.deviceId,
          }
        : null,
      pid: this.proc?.pid ?? null,
      clients: this.clients,
      uptimeMs: this.startedAt && owner ? Date.now() - this.startedAt : 0,
      lastConnectionAt: this.lastConnectionAt,
      lastError: this.lastError,
      notes: this.notes,
      log: this.logLines.slice(-120),
    };
  }
}
