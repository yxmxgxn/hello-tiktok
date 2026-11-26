// 手元で確かめるためのサーバー。D1 の代わりに node:sqlite を使って src/worker.js を動かす。
//   node dev/server.mjs   → http://localhost:8787
// 管理用APIの合言葉は、環境変数 CRAWL_TOKEN(なければ手元だけの dev-token)。
import { createServer } from "node:http";
import { readFileSync, existsSync, mkdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { dirname, join, normalize, extname } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const port = Number(process.env.PORT || 8787);
mkdirSync(join(root, "data"), { recursive: true });
const db = new DatabaseSync(process.env.DEV_DB || join(root, "data", "dev.sqlite"));
db.exec(readFileSync(join(root, "schema.sql"), "utf8"));

class Stmt {
  constructor(sql, args = []) { this.sql = sql; this.args = args; }
  bind(...args) { return new Stmt(this.sql, args); }
  exec() {
    const s = db.prepare(this.sql);
    if (/^\s*(select|with)/i.test(this.sql)) return { results: s.all(...this.args).map((r) => ({ ...r })), meta: {} };
    const r = s.run(...this.args);
    return { results: [], meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } };
  }
  async all() { return this.exec(); }
  async run() { return this.exec(); }
  async first(col) {
    const row = this.exec().results[0];
    return row == null ? null : col ? row[col] : row;
  }
}
const D1 = {
  prepare: (sql) => new Stmt(sql),
  async batch(stmts) {
    db.exec("BEGIN");
    try {
      const out = stmts.map((s) => s.exec());
      db.exec("COMMIT");
      return out;
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  },
};
globalThis.caches = { default: { match: async () => undefined, put: async () => {} } };

const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".png": "image/png", ".ico": "image/x-icon", ".webmanifest": "application/manifest+json" };
const ASSETS = {
  async fetch(request) {
    let p = decodeURIComponent(new URL(request.url).pathname);
    if (p === "/") p = "/index";
    let file = join(root, "public", normalize(p));
    if (!extname(file)) file += ".html";
    if (!file.startsWith(join(root, "public")) || !existsSync(file)) return new Response("Not found", { status: 404 });
    return new Response(readFileSync(file), { headers: { "content-type": TYPES[extname(file)] || "application/octet-stream" } });
  },
};

const { default: worker } = await import("../src/worker.js");
const env = { DB: D1, ASSETS, CRAWL_TOKEN: process.env.CRAWL_TOKEN || "dev-token" };

createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const request = new Request(`http://localhost:${port}${req.url}`, {
    method: req.method, headers: req.headers, body: chunks.length ? Buffer.concat(chunks) : undefined,
  });
  try {
    const r = await worker.fetch(request, env, { waitUntil: (p) => p.catch(() => {}) });
    res.writeHead(r.status, Object.fromEntries(r.headers));
    res.end(Buffer.from(await r.arrayBuffer()));
  } catch (e) {
    console.error(e);
    res.writeHead(500);
    res.end("error");
  }
}).listen(port, "127.0.0.1", () => console.log(`http://localhost:${port}`));
