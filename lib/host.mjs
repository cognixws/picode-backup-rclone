import http from 'node:http';
import https from 'node:https';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export class HostError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

// The COGNIX[WS] Host API on loopback, with the host's own certificate.
export class HostAPI {
  constructor({ url, token, dataDir }) {
    this.url = new URL(url);
    if (!['http:', 'https:'].includes(this.url.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(this.url.hostname)) throw new Error('COGNIX[WS] must provide its loopback address.');
    this.token = token;
    if (this.url.protocol === 'https:') this.ca = readFileSync(resolve(dataDir, '../../..', 'cert.pem'));
  }
  request(path, { method = 'GET', body } = {}) {
    if (!path.startsWith('/api/ext/v1/')) throw new Error('Only the extension Host API may be used.');
    const url = new URL(path, this.url);
    const bytes = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    const transport = url.protocol === 'https:' ? https : http;
    return new Promise((ok, fail) => {
      const req = transport.request(url, {
        method, ca: this.ca, allowPartialTrustChain: !!this.ca,
        headers: { 'X-PiCode-Extension-Token': this.token, ...(bytes ? { 'Content-Type': 'application/json', 'Content-Length': bytes.length } : {}) },
      }, res => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString();
          let data = null;
          try { data = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
          if (res.statusCode >= 300) { fail(new HostError(res.statusCode, data?.error || 'The host refused this action.')); return; }
          ok(data);
        });
      });
      req.on('error', () => fail(new HostError(0, 'COGNIX[WS] did not answer.')));
      req.setTimeout(15_000, () => req.destroy());
      if (bytes) req.write(bytes);
      req.end();
    });
  }
}
