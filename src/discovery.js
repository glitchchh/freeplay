// Minimal mDNS (multicast DNS) client used to answer one question honestly:
// "is an AirPlay receiver actually being advertised on this network right now?"
//
// Senders (iPhone/iPad) find receivers exactly this way, so it is a better
// readiness signal than guessing a port — engines are free to pick any port.
import dgram from 'node:dgram';

const MDNS_ADDRESS = '224.0.0.251';
const MDNS_PORT = 5353;
const SERVICE = '_airplay._tcp.local';

function encodeName(name) {
  const parts = name.split('.').filter(Boolean).map((label) => {
    const bytes = Buffer.from(label, 'utf8');
    if (bytes.length > 63) throw new Error('DNS label too long');
    return Buffer.concat([Buffer.from([bytes.length]), bytes]);
  });
  return Buffer.concat([...parts, Buffer.from([0])]);
}

function buildQuery(id) {
  const header = Buffer.alloc(12);
  header.writeUInt16BE(id, 0);
  header.writeUInt16BE(0, 2); // standard query
  header.writeUInt16BE(1, 4); // one question
  const qname = encodeName(SERVICE);
  const tail = Buffer.alloc(4);
  tail.writeUInt16BE(12, 0); // PTR
  tail.writeUInt16BE(1, 2); // IN
  return Buffer.concat([header, qname, tail]);
}

/** Read a possibly-compressed DNS name starting at `offset`. */
function readName(buf, offset) {
  const labels = [];
  let jumped = false;
  let position = offset;
  let next = offset;
  let hops = 0;

  while (position < buf.length) {
    const length = buf[position];
    if (length === 0) {
      position += 1;
      if (!jumped) next = position;
      break;
    }
    if ((length & 0xc0) === 0xc0) {
      const pointer = ((length & 0x3f) << 8) | buf[position + 1];
      if (!jumped) next = position + 2;
      jumped = true;
      if (++hops > 20) break;
      position = pointer;
      continue;
    }
    labels.push(buf.subarray(position + 1, position + 1 + length).toString('utf8'));
    position += 1 + length;
    if (!jumped) next = position;
  }
  return [labels.join('.'), next];
}

function parseTxt(rdata) {
  const txt = {};
  let i = 0;
  while (i < rdata.length) {
    const len = rdata[i];
    if (len === 0) break;
    const entry = rdata.subarray(i + 1, i + 1 + len).toString('utf8');
    const eq = entry.indexOf('=');
    if (eq > 0) txt[entry.slice(0, eq)] = entry.slice(eq + 1);
    i += 1 + len;
  }
  return txt;
}

function parseMessage(buf) {
  if (buf.length < 12) return [];
  const counts = [buf.readUInt16BE(4), buf.readUInt16BE(6), buf.readUInt16BE(8), buf.readUInt16BE(10)];
  let offset = 12;

  // Skip questions.
  for (let i = 0; i < counts[0]; i++) {
    [, offset] = readName(buf, offset);
    offset += 4;
  }

  const records = [];
  const total = counts[1] + counts[2] + counts[3];
  for (let i = 0; i < total && offset + 10 <= buf.length; i++) {
    const [name, nameEnd] = readName(buf, offset);
    const type = buf.readUInt16BE(nameEnd);
    const rdLength = buf.readUInt16BE(nameEnd + 8);
    const rdataStart = nameEnd + 10;
    const rdata = buf.subarray(rdataStart, rdataStart + rdLength);
    offset = rdataStart + rdLength;

    if (type === 12) {
      const [target] = readName(buf, rdataStart);
      records.push({ type: 'PTR', name, target });
    } else if (type === 33 && rdLength >= 6) {
      const [target] = readName(buf, rdataStart + 6);
      records.push({ type: 'SRV', name, port: buf.readUInt16BE(rdataStart + 4), target });
    } else if (type === 16) {
      records.push({ type: 'TXT', name, txt: parseTxt(rdata) });
    } else if (type === 1 && rdLength === 4) {
      records.push({ type: 'A', name, address: [...rdata].join('.') });
    }
  }
  return records;
}

const shortName = (instance) => instance.replace(/\._airplay\._tcp\.local$/i, '');

/**
 * Ask the local network for AirPlay receivers.
 * @param {{timeoutMs?: number}} [options]
 * @returns {Promise<Array<{instance:string, name:string, port:number|null, model:string, deviceId:string, address:string|null}>>}
 */
export function discoverAirplay({ timeoutMs = 1400 } = {}) {
  return new Promise((resolve) => {
    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    const records = [];
    let settled = false;

    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        socket.close();
      } catch {
        /* already closed */
      }
      resolve(summarise(records));
    };

    const timer = setTimeout(finish, timeoutMs);
    socket.on('message', (message) => {
      try {
        records.push(...parseMessage(message));
      } catch {
        /* ignore malformed packets from other devices */
      }
    });
    socket.on('error', finish);

    socket.bind(() => {
      try {
        socket.setMulticastTTL(255);
        socket.send(buildQuery(0x4650), MDNS_PORT, MDNS_ADDRESS);
        setTimeout(() => {
          try {
            socket.send(buildQuery(0x4651), MDNS_PORT, MDNS_ADDRESS);
          } catch {
            /* socket closed */
          }
        }, 350);
      } catch {
        finish();
      }
    });
  });
}

function summarise(records) {
  const services = new Map();

  for (const record of records) {
    if (record.type === 'PTR' && record.name.toLowerCase() === SERVICE) {
      const instance = record.target;
      if (!services.has(instance)) services.set(instance, { instance, port: null, model: '', deviceId: '', address: null, host: '' });
    }
  }
  for (const record of records) {
    if (!record.name.toLowerCase().endsWith('._airplay._tcp.local')) continue;
    const service = services.get(record.name);
    if (!service) continue;
    if (record.type === 'SRV') {
      service.port = record.port;
      service.host = record.target;
    } else if (record.type === 'TXT') {
      service.model = record.txt.model || '';
      service.deviceId = record.txt.deviceid || '';
    }
  }
  for (const record of records) {
    if (record.type !== 'A') continue;
    for (const service of services.values()) {
      if (service.host === record.name) service.address = record.address;
    }
  }

  return [...services.values()].map((service) => ({ ...service, name: shortName(service.instance) }));
}
