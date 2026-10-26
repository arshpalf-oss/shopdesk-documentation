/**
 * Preview gateway for port 8080.
 *
 * One origin serves both things the user needs:
 *   /                    → the shop desk app (proxied verbatim to the API process)
 *   /download            → the download page (zip button, file tree)
 *   /shopdesk-app.zip    → the archive as an attachment
 *   /files/<path>        → a single source file as text/plain
 *   /bundle.txt          → every source file in one text document
 *
 * The proxy forwards the browser's original Host header so the API's
 * same-origin check (Origin host === Host) keeps working behind the preview.
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import crypto from 'node:crypto';

const ROOT = '/home/user/shopdesk-documentation';
const APP = path.join(ROOT, 'app');
const ZIP = path.join(ROOT, 'shopdesk-app.zip');
const PORT = Number(process.env.PORT || 8080);
const UPSTREAM = process.env.SHOPDESK_API || 'http://127.0.0.1:3000';

const SKIP_DIRS = new Set(['node_modules', 'dist', 'data-demo', '.data', '.git']);
const BINARY = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.zip', '.ico', '.woff', '.woff2']);

function walk(dir, base = '') {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') && entry.name !== '.env.example' && entry.name !== '.gitignore') continue;
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      out.push(...walk(path.join(dir, entry.name), base ? `${base}/${entry.name}` : entry.name));
    } else if (entry.isFile()) {
      out.push(base ? `${base}/${entry.name}` : entry.name);
    }
  }
  return out.sort();
}

const FILES = walk(APP);
const zipStat = fs.existsSync(ZIP) ? fs.statSync(ZIP) : null;
const zipSha = zipStat ? crypto.createHash('sha256').update(fs.readFileSync(ZIP)).digest('hex') : null;

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function downloadPage() {
  const groups = new Map();
  for (const file of FILES) {
    const dir = path.dirname(file) === '.' ? '(root)' : path.dirname(file);
    if (!groups.has(dir)) groups.set(dir, []);
    groups.get(dir).push(file);
  }
  const tree = [...groups.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(
      ([dir, files]) => `
      <section class="grp"><h3>${esc(dir)}/</h3><ul>${files
        .map((f) => {
          const size = fs.statSync(path.join(APP, f)).size;
          return `<li><a href="/files/${encodeURI(f)}">${esc(path.basename(f))}</a> <span class="sz">${(size / 1024).toFixed(1)} kB</span></li>`;
        })
        .join('')}</ul></section>`
    )
    .join('');

  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>shop desk — download</title>
<style>
 :root{color-scheme:dark}
 body{margin:0;background:#0b0f14;color:#e9f0f7;font:15px/1.55 system-ui,-apple-system,'Segoe UI',sans-serif}
 .wrap{max-width:900px;margin:0 auto;padding:28px 20px 64px}
 h1{font-size:1.45rem;margin:0 0 4px} h2{font-size:1.05rem;margin:0 0 8px}
 h3{font-size:.82rem;text-transform:uppercase;letter-spacing:.06em;color:#7d8fa1;margin:16px 0 6px}
 p{color:#a8b8c8}
 .card{background:#131c26;border:1px solid #223140;border-radius:12px;padding:18px;margin:16px 0}
 .btn{display:inline-block;background:#6fd3c7;color:#04231f;font-weight:650;text-decoration:none;padding:11px 18px;border-radius:9px}
 .btn:hover{filter:brightness(1.08)}
 .btn.alt{background:#1d2b39;color:#e9f0f7;border:1px solid #2b3d4e;margin-left:8px}
 pre{background:#080b10;border:1px solid #1a2632;border-radius:8px;padding:12px;overflow-x:auto;
     font-family:ui-monospace,Menlo,monospace;font-size:.82rem}
 .sz{color:#5f7285;font-size:.75rem;margin-left:6px}
 ul{margin:0;padding-left:18px} li{margin:2px 0} a{color:#7cb8ff;text-decoration:none} a:hover{text-decoration:underline}
 .meta{color:#7d8fa1;font-size:.82rem;word-break:break-all}
 .cols{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:8px 24px}
</style></head><body><div class="wrap">
<p class="meta"><a href="/">← back to the shop desk app</a></p>
<h1>shop desk — application package</h1>
<p>Veterinary billing, inventory and double-entry accounting. ${FILES.length} source files${
    zipStat ? `, archive ${(zipStat.size / 1024).toFixed(0)} kB` : ''
  }.</p>
<div class="card">
  <h2>Download the archive</h2>
  <a class="btn" href="/shopdesk-app.zip" download>⬇ shopdesk-app.zip</a>
  <a class="btn alt" href="/bundle.txt" target="_blank" rel="noopener">All files as one text</a>
  <p class="meta" style="margin-top:12px">SHA-256 ${zipSha || 'unavailable'}</p>
  <pre>unzip shopdesk-app.zip &amp;&amp; cd app
npm ci &amp;&amp; npm run build
SHOPDESK_DATA_DIR=./data npm start</pre>
  <p class="meta">Requires Node 22+. Excludes node_modules, dist and the generated demo database.</p>
</div>
<h2>Single files</h2>
<p>If the archive download is blocked, open any file below and copy it directly.</p>
<div class="card cols">${tree}</div>
</div></body></html>`;
}

function bundle() {
  const out = ['shop desk — complete source bundle', `files: ${FILES.length}`, ''];
  for (const f of FILES) {
    if (BINARY.has(path.extname(f).toLowerCase())) continue;
    out.push('='.repeat(78), `FILE: app/${f}`, '='.repeat(78), fs.readFileSync(path.join(APP, f), 'utf8'), '');
  }
  return out.join('\n');
}

function proxy(req, res) {
  const target = new URL(UPSTREAM);
  const headers = { ...req.headers };
  // Preserve the browser-visible host so the API's origin check matches.
  headers.host = req.headers.host || target.host;
  delete headers['accept-encoding'];

  const upstream = http.request(
    {
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port,
      method: req.method,
      path: req.url,
      headers,
    },
    (upRes) => {
      const outHeaders = { ...upRes.headers };
      delete outHeaders['transfer-encoding'];
      delete outHeaders.connection;
      res.writeHead(upRes.statusCode || 502, outHeaders);
      upRes.pipe(res);
    }
  );
  upstream.on('error', (err) => {
    if (res.headersSent) return res.end();
    res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(
      `shop desk API is not reachable on ${UPSTREAM}.\n` +
        `Start it with:  cd app && SHOPDESK_DATA_DIR=./data-demo PORT=3000 node server/index.js\n\n${err.message}\n`
    );
  });
  req.pipe(upstream);
}

const server = http.createServer((req, res) => {
  const url = decodeURIComponent((req.url || '/').split('?')[0]);
  const send = (status, type, body, extra = {}) => {
    res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', ...extra });
    res.end(body);
  };

  if (url === '/download' || url === '/download/') {
    return send(200, 'text/html; charset=utf-8', downloadPage());
  }
  if (url === '/shopdesk-app.zip') {
    if (!zipStat) return send(404, 'text/plain', 'archive missing');
    return send(200, 'application/zip', fs.readFileSync(ZIP), {
      'Content-Disposition': 'attachment; filename="shopdesk-app.zip"',
      'Content-Length': String(zipStat.size),
    });
  }
  if (url === '/bundle.txt') {
    return send(200, 'text/plain; charset=utf-8', bundle(), {
      'Content-Disposition': 'inline; filename="shopdesk-bundle.txt"',
    });
  }
  if (url.startsWith('/files/')) {
    const rel = url.slice('/files/'.length);
    if (rel.includes('..') || !FILES.includes(rel)) return send(404, 'text/plain', 'not found');
    if (BINARY.has(path.extname(rel).toLowerCase())) return send(415, 'text/plain', 'binary file');
    return send(200, 'text/plain; charset=utf-8', fs.readFileSync(path.join(APP, rel), 'utf8'));
  }
  return proxy(req, res);
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[preview] http://0.0.0.0:${PORT}`);
  console.log(`[preview]   /        → shop desk app (proxy ${UPSTREAM})`);
  console.log(`[preview]   /download → package download page (${FILES.length} files, zip ${zipStat ? `${(zipStat.size / 1024).toFixed(0)} kB` : 'missing'})`);
});
