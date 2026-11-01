// Freeplay's local dashboard: static UI + JSON API + Server-Sent Events.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { PUBLIC_DIR, loadConfig, saveConfig } from './config.js';
import { Engine } from './engine.js';
import { enginePlan, installEngine } from './download.js';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

export function createFreeplayServer() {
  const engine = new Engine();
  const config = loadConfig();
  const clients = new Set();
  let install = { active: false, phase: 'idle', received: 0, total: 0, error: '' };

  const broadcast = (payload) => {
    const frame = `data: ${JSON.stringify(payload)}\n\n`;
    for (const res of clients) res.write(frame);
  };

  engine.on('event', (payload) => broadcast(payload));

  const snapshot = () => ({
    platform: process.platform,
    config,
    status: engine.status(),
    plan: enginePlan(),
    install,
    version: process.env.npm_package_version || '1.0.0',
  });

  const json = (res, code, body) => {
    const payload = JSON.stringify(body);
    res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(payload);
  };

  const readBody = (req) =>
    new Promise((resolve, reject) => {
      let raw = '';
      req.on('data', (chunk) => {
        raw += chunk;
        if (raw.length > 200_000) reject(new Error('Request body too large'));
      });
      req.on('end', () => {
        if (!raw) return resolve({});
        try {
          resolve(JSON.parse(raw));
        } catch {
          reject(new Error('Body must be JSON'));
        }
      });
      req.on('error', reject);
    });

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', 'http://localhost');
    const route = url.pathname;

    try {
      if (route === '/api/events') {
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache, no-transform',
          connection: 'keep-alive',
          'x-accel-buffering': 'no',
        });
        res.write(`data: ${JSON.stringify({ type: 'snapshot', data: snapshot() })}\n\n`);
        clients.add(res);
        const keepAlive = setInterval(() => res.write(': keep-alive\n\n'), 20_000);
        req.on('close', () => {
          clearInterval(keepAlive);
          clients.delete(res);
        });
        return;
      }

      if (route.startsWith('/api/')) {
        if (req.method === 'GET' && route === '/api/state') {
          return json(res, 200, snapshot());
        }

        if (req.method === 'POST' && route === '/api/config') {
          const patch = await readBody(req);
          Object.assign(config, saveConfig({ ...config, ...patch }));
          const body = snapshot();
          broadcast({ type: 'snapshot', data: body });
          return json(res, 200, body);
        }

        if (req.method === 'POST' && route === '/api/engine/detect') {
          engine.detect(config.enginePath);
          const body = snapshot();
          broadcast({ type: 'snapshot', data: body });
          return json(res, 200, body);
        }

        if (req.method === 'POST' && route === '/api/engine/install') {
          if (install.active) return json(res, 409, { error: 'An engine download is already running.' });
          if (engine.status().state === 'live' || engine.proc) {
            return json(res, 409, { error: 'Stop the receiver before installing an engine.' });
          }
          install = { active: true, phase: 'download', received: 0, total: 0, error: '' };
          broadcast({ type: 'install', data: install });
          installEngine((progress) => {
            install = { active: progress.phase !== 'done', phase: progress.phase, received: progress.received, total: progress.total, error: '' };
            broadcast({ type: 'install', data: install });
          })
            .then((result) => {
              engine.detect(config.enginePath);
              engine.log(`Engine installed (${result.files} files) from ${result.source}`);
              install = { active: false, phase: 'done', received: 0, total: 0, error: '' };
              broadcast({ type: 'install', data: install });
              broadcast({ type: 'snapshot', data: snapshot() });
            })
            .catch((err) => {
              install = { active: false, phase: 'failed', received: 0, total: 0, error: err.message };
              engine.log(`Engine install failed: ${err.message}`, 'error');
              broadcast({ type: 'install', data: install });
            });
          return json(res, 202, { started: true });
        }

        if (req.method === 'POST' && route === '/api/receiver/start') {
          if (!engine.engine) engine.detect(config.enginePath);
          if (!engine.engine) return json(res, 412, { error: 'No AirPlay engine installed yet.' });
          try {
            await engine.start(config);
          } catch (err) {
            return json(res, 500, { error: err.message });
          }
          return json(res, 200, snapshot());
        }

        if (req.method === 'POST' && route === '/api/receiver/stop') {
          await engine.stop();
          return json(res, 200, snapshot());
        }

        return json(res, 404, { error: 'Unknown endpoint' });
      }

      // Static assets.
      const relative = route === '/' ? 'index.html' : route.replace(/^\/+/, '');
      const filePath = path.resolve(PUBLIC_DIR, relative);
      if (!filePath.startsWith(path.resolve(PUBLIC_DIR) + path.sep) && route !== '/') {
        res.writeHead(403).end('Forbidden');
        return;
      }
      fs.readFile(filePath, (err, data) => {
        if (err) {
          res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('Not found');
          return;
        }
        res.writeHead(200, {
          'content-type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
          'cache-control': 'no-cache',
        });
        res.end(data);
      });
    } catch (err) {
      json(res, 400, { error: err.message });
    }
  });

  server.on('close', () => {
    for (const res of clients) res.end();
    clients.clear();
    engine.stop();
  });

  return { server, engine, config, snapshot };
}

/** Listen on `port`, walking forward if it is taken. */
export function listen(server, port, host) {
  return new Promise((resolve, reject) => {
    let attempt = 0;
    const tryPort = (p) => {
      server.once('error', (err) => {
        if (err.code === 'EADDRINUSE' && attempt < 20) {
          attempt += 1;
          tryPort(p + 1);
        } else {
          reject(err);
        }
      });
      server.listen(p, host, () => resolve(server.address()));
    };
    tryPort(port);
  });
}
