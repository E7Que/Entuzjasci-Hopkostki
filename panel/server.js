// Opcjonalny LOKALNY wrapper na panel — panel działa też bez tego, prosto pod
// https://e7que.github.io/Entuzjasci-Hopkostki/ (patrz README).
// Ten serwer tylko serwuje pliki z ./public i przekazuje resztę żądań 1:1 do bota na Supabase —
// hasło panelu wpisuje się w przeglądarce (tak samo jak w wersji hostowanej), więc nie trzeba
// go tu konfigurować.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(HERE, 'public');
export const DEFAULT_BOT_URL = 'https://ucjmbdogtzztrkorqzjq.supabase.co/functions/v1/hopkostki-bot';

const STATIC_FILES = new Set(['', 'index.html', 'app.js', 'style.css']);
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};
const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);
const MAX_BODY = 256 * 1024;

// Prosty parser .env (bez zależności). Nie nadpisuje zmiennych ustawionych w systemie.
export function loadEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (!match || line.trim().startsWith('#')) continue;
    const value = match[2].replace(/^(['"])(.*)\1$/, '$2');
    if (process.env[match[1]] === undefined) process.env[match[1]] = value;
  }
}

function sendText(res, status, contentType, body) {
  res.writeHead(status, { 'Content-Type': contentType, 'Cache-Control': 'no-store' });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Error('Za duże żądanie'));
        req.destroy();
      } else chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function serveStatic(res, name) {
  const file = path.join(PUBLIC_DIR, name === '' ? 'index.html' : name);
  if (!fs.existsSync(file)) return sendText(res, 404, 'text/plain; charset=utf-8', 'Nie znaleziono');
  sendText(res, 200, MIME[path.extname(file)] ?? 'application/octet-stream', fs.readFileSync(file));
}

export function createPanelServer({ botUrl = DEFAULT_BOT_URL, host = '127.0.0.1', fetchImpl = fetch } = {}) {
  // Przezroczysty proxy: to samo hasło (nagłówek x-panel-password), które przeglądarka wysyła sama,
  // idzie prosto do bota na Supabase pod tę samą względną ścieżkę (/status, /config, /guild, …).
  async function proxy(req, res, url) {
    const target = `${botUrl.replace(/\/+$/, '')}/panel${url.pathname}${url.search}`;
    try {
      const body = ['GET', 'HEAD'].includes(req.method) ? undefined : await readBody(req);
      const headers = { 'Content-Type': 'application/json' };
      if (req.headers['x-panel-password']) headers['x-panel-password'] = req.headers['x-panel-password'];
      const upstream = await fetchImpl(target, { method: req.method, headers, body });
      const text = await upstream.text();
      sendText(res, upstream.status, 'application/json; charset=utf-8', text || '{}');
    } catch (error) {
      sendText(res, 502, 'application/json; charset=utf-8', JSON.stringify({ error: `Nie można połączyć się z botem na Supabase: ${error.message}` }));
    }
  }

  return http.createServer((req, res) => {
    // Ochrona przed DNS rebinding: przy nasłuchu lokalnym akceptujemy tylko lokalne nagłówki Host.
    const hostname = String(req.headers.host ?? '').replace(/:\d+$/, '').toLowerCase();
    if (LOCAL_HOSTS.has(host) && !LOCAL_HOSTS.has(hostname)) {
      res.writeHead(403);
      return res.end('Niedozwolony host');
    }
    const url = new URL(req.url, 'http://localhost');
    const name = decodeURIComponent(url.pathname).replace(/^\/+/, '');
    if (req.method === 'GET' && STATIC_FILES.has(name)) return serveStatic(res, name);
    return proxy(req, res, url);
  });
}

// Uruchomienie: npm run panel
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  loadEnv(path.join(HERE, '..', '.env'));
  const port = Number(process.env.PANEL_PORT) || 3000;
  const host = process.env.PANEL_HOST || '127.0.0.1';
  const botUrl = process.env.BOT_URL || DEFAULT_BOT_URL;

  if (!LOCAL_HOSTS.has(host)) console.warn('⚠️  Panel nasłuchuje poza localhost — każdy w sieci zobaczy stronę logowania panelu!');

  const server = createPanelServer({ botUrl, host });
  server.listen(port, host, () => {
    console.log(`🖥️  Panel: http://localhost:${port}`);
    console.log(`🔗 Bot na Supabase: ${botUrl}`);
    console.log('Hasło wpisujesz w przeglądarce po otwarciu strony (Supabase → Edge Functions → Secrets → PANEL_PASSWORD, albo wygenerowane samo przez bota).');
  });
  server.on('error', (error) => console.error(`❌ Panel nie wystartował (port ${port}): ${error.message}`));
}
