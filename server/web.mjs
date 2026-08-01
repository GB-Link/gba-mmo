import {createReadStream} from 'node:fs';
import {stat} from 'node:fs/promises';
import {createServer} from 'node:http';
import {extname, join, normalize} from 'node:path';
import {fileURLToPath} from 'node:url';

const WEB_ROOT = fileURLToPath(new URL('../web', import.meta.url));

const MIME_TYPES = {
  '.css': 'text/css; charset=utf-8',
  '.gba': 'application/octet-stream',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.mjs': 'text/javascript; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

// Serves the web client from ../web for local development; production
// deployments host it statically.
export function createWebServer() {
  return createServer(async (req, res) => {
    let pathname;
    try {
      pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    } catch {
      res.writeHead(400).end();
      return;
    }
    if (pathname.endsWith('/')) {
      pathname += 'index.html';
    }

    const filePath = normalize(join(WEB_ROOT, pathname));
    if (!filePath.startsWith(WEB_ROOT + '/')) {
      res.writeHead(403).end();
      return;
    }

    try {
      const info = await stat(filePath);
      if (!info.isFile()) {
        throw new Error('not a file');
      }
    } catch {
      res.writeHead(404).end('Not found');
      return;
    }

    res.writeHead(200, {
      'Content-Type': MIME_TYPES[extname(filePath)] ?? 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    createReadStream(filePath).pipe(res);
  });
}
