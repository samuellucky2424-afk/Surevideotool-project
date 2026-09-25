import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

export const DESKTOP_ORIGIN = 'http://127.0.0.1:47831';
let rendererServer;

export async function closeRenderer() {
  if (!rendererServer) return;
  const server = rendererServer;
  rendererServer = undefined;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

export async function serveRenderer(root) {
  if (rendererServer) return DESKTOP_ORIGIN;
  const directory = path.resolve(root);
  const types = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2' };
  const server = createServer(async (req, res) => {
    if (req.headers.host !== '127.0.0.1:47831' || !['GET', 'HEAD'].includes(req.method)) {
      res.writeHead(403).end();
      return;
    }
    try {
      const pathname = decodeURIComponent(new URL(req.url, DESKTOP_ORIGIN).pathname);
      const file = path.resolve(directory, `.${pathname === '/' ? '/index.html' : pathname}`);
      if (!file.startsWith(directory + path.sep)) {
        res.writeHead(403).end();
        return;
      }
      const content = await readFile(file);
      res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
      res.end(req.method === 'HEAD' ? undefined : content);
    } catch {
      res.writeHead(404).end();
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(47831, '127.0.0.1', resolve);
  });
  rendererServer = server;
  return DESKTOP_ORIGIN;
}
