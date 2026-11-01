#!/usr/bin/env node
// Freeplay by Glitchchh — CLI entry point.
import { execFile } from 'node:child_process';
import { ensureDirs, loadConfig } from '../src/config.js';
import { createFreeplayServer, listen } from '../src/server.js';

const argv = process.argv.slice(2);

if (argv.includes('--help') || argv.includes('-h')) {
  console.log(`Freeplay by Glitchchh

  Usage: freeplay [options]

  Options:
    --port <n>   Dashboard port (default 7373, climbs if busy)
    --no-open    Do not open the dashboard in your browser
    --help       Show this help

  Turn your PC into a local AirPlay receiver, then open Control Center on your
  iPhone or iPad and pick Screen Mirroring → your Freeplay name.`);
  process.exit(0);
}

const portFlag = argv.indexOf('--port');
const requestedPort = portFlag >= 0 ? Number(argv[portFlag + 1]) : 7373;
const port = Number.isFinite(requestedPort) && requestedPort > 0 ? requestedPort : 7373;
const openBrowser = !argv.includes('--no-open');

ensureDirs();

const { server, engine, config } = createFreeplayServer();
engine.detect(config.enginePath);

const address = await listen(server, port, '127.0.0.1');
const url = `http://localhost:${address.port}`;

console.log(`
  ┌──────────────────────────────────────────────┐
  │  FREEPLAY                                    │
  │  your PC, as an AirPlay screen — by Glitchchh│
  └──────────────────────────────────────────────┘

  Dashboard   ${url}
  Receiver    ${config.receiverName}
  Engine      ${engine.engine ? `${engine.engine.label} (${engine.engine.source})` : 'not installed — open the dashboard to install it'}

  Open Control Center on your iPhone/iPad → Screen Mirroring.
  Press Ctrl+C to shut Freeplay down.
`);

if (openBrowser) {
  const cmd = process.platform === 'win32' ? 'cmd' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  const cmdArgs = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  execFile(cmd, cmdArgs, { windowsHide: true }, () => {});
}

let closing = false;
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    if (closing) process.exit(0);
    closing = true;
    console.log('\n  Shutting Freeplay down…');
    await engine.stop();
    server.close(() => process.exit(0));
    // EventSource clients keep the server open; drop them so close can finish.
    server.closeAllConnections?.();
    setTimeout(() => process.exit(0), 1500);
  });
}
