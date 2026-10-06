// An https front for the hosted pictures, so the hosted server can be shown under a believable public address
// (https://review.northwind.example): a throwaway self-signed certificate (Chrome is told to accept it and to resolve the
// name here), and every request passed on to the app as it came — like a reverse proxy, without the forwarding headers.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import { freePort } from '../demo/server.ts';

export interface HttpsFront {
  port: number;
  close: () => void;
}

export async function httpsFront(host: string, target: string, dir: string): Promise<HttpsFront> {
  fs.mkdirSync(dir, { recursive: true });
  const key = path.join(dir, 'key.pem');
  const cert = path.join(dir, 'cert.pem');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '2', '-subj', `/CN=${host}`], {
    stdio: 'ignore',
  });
  const to = new URL(target);
  const server = https.createServer({ key: fs.readFileSync(key), cert: fs.readFileSync(cert) }, (req, res) => {
    const up = http.request({ host: to.hostname, port: to.port, path: req.url, method: req.method, headers: req.headers }, (r) => {
      res.writeHead(r.statusCode || 502, r.headers);
      r.pipe(res);
    });
    up.on('error', () => {
      if (!res.headersSent) res.writeHead(502);
      res.end();
    });
    req.pipe(up);
  });
  const port = await freePort();
  await new Promise<void>((r) => server.listen(port, '127.0.0.1', () => r()));
  return {
    port,
    close: () => {
      server.closeAllConnections();
      server.close();
    },
  };
}
