// Serves the website, stores parsed feeds in SQLite, and exposes a small JSON API.
// Needs Node 22.13 or newer (uses the built-in node:sqlite, no npm install).

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import https from "node:https";
import zlib from "node:zlib";
import dns from "node:dns";
import type { IncomingMessage, ServerResponse } from "node:http";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { parseFeed, normalize } from "./parser.js";
import type { ParsedFeed } from "./parser.js";
import type { Article, ArticleRow, ArticlesResponse, Feed, FeedFormat } from "./types.js";

dns.setDefaultResultOrder("ipv4first");   // avoids "fetch failed" on networks with broken IPv6

// Project root: index.html, style.css, feeds.json and rss.db live there, next to src/ and dist/.
const ROOT = path.resolve(__dirname, "..");
const PORT = 3000;

const db = new DatabaseSync(path.join(ROOT, "rss.db"));
db.exec(`
  CREATE TABLE IF NOT EXISTS feeds (
    id TEXT PRIMARY KEY, name TEXT, url TEXT, format TEXT, updated_at TEXT
  );
  CREATE TABLE IF NOT EXISTS articles (
    id INTEGER PRIMARY KEY AUTOINCREMENT, feed_id TEXT, guid TEXT,
    title TEXT, link TEXT, image TEXT, summary TEXT, body TEXT,
    date TEXT, ts INTEGER, author TEXT,
    UNIQUE (feed_id, guid)
  );
`);
// "default" = comes from feeds.json, "user" = pasted by a user. Old databases get the column added.
try { db.exec("ALTER TABLE feeds ADD COLUMN source TEXT DEFAULT 'default'"); } catch {}

// Row types for the queries below. SQLite hands back plain records, so the
// query helpers cast them to the shape the statement selects.
interface FeedRow {
  id: string;
  name: string;
  url: string;
  format: FeedFormat | null;
  updated_at: string | null;
  source: "default" | "user";
}

const queryAll = <T>(sql: string, ...params: SQLInputValue[]): T[] =>
  db.prepare(sql).all(...params) as unknown as T[];

const queryOne = <T>(sql: string, ...params: SQLInputValue[]): T | undefined =>
  db.prepare(sql).get(...params) as unknown as T | undefined;

// feeds.json is the starter list. It is copied into the feeds table on every start.
interface FeedSeed { id: string; name: string; url: string }
const list = JSON.parse(fs.readFileSync(path.join(ROOT, "feeds.json"), "utf8")) as FeedSeed[];
const upsertFeed = db.prepare(
  "INSERT INTO feeds (id, name, url) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET name = excluded.name, url = excluded.url"
);
list.forEach(f => upsertFeed.run(f.id, f.name, f.url));
db.prepare(`DELETE FROM feeds WHERE source = 'default' AND id NOT IN (${list.map(() => "?").join(",")})`)
  .run(...list.map(f => f.id));
db.exec("DELETE FROM articles WHERE feed_id NOT IN (SELECT id FROM feeds)");

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120 Safari/537.36";

/** An Error carrying the HTTP status or socket error code that caused it. */
interface HttpError extends Error {
  status?: number;
  code?: string;
}

const httpError = (message: string, extra: { status?: number; code?: string } = {}): HttpError =>
  Object.assign(new Error(message), extra);

// Plain download over IPv4 with a 20 second timeout. (Node's built-in fetch gives up after 10 seconds.)
function httpGet(url: string, hops = 0): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const lib = url.startsWith("https") ? https : http;
    const req = lib.get(url, {
      headers: { "User-Agent": UA, "Accept": "application/rss+xml, application/xml, text/xml, text/html, */*", "Accept-Encoding": "gzip" },
      family: 4, timeout: 20000,
    }, (res) => {
      const code = res.statusCode ?? 0;
      if (code >= 300 && code < 400 && res.headers.location) {            // follow redirects
        res.resume();
        if (hops >= 5) return reject(httpError("too many redirects"));
        return resolve(httpGet(new URL(res.headers.location, url).href, hops + 1));
      }
      if (code !== 200) { res.resume(); return reject(httpError("status " + code, { status: code })); }
      const stream: NodeJS.ReadableStream = res.headers["content-encoding"] === "gzip" ? res.pipe(zlib.createGunzip()) : res;
      const chunks: Buffer[] = [];
      stream.on("data", (c: Buffer) => chunks.push(c));
      stream.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
      stream.on("error", reject);
    });
    req.on("timeout", () => req.destroy(httpError("timeout", { code: "TIMEOUT" })));
    req.on("error", reject);
  });
}

// Slow networks time out now and then, so try up to 3 times.
async function download(url: string): Promise<string> {
  let last: unknown;
  for (let i = 0; i < 3; i++) {
    try { return await httpGet(url); }
    catch (e) {
      const err = e as HttpError;
      last = err;
      if (err.status && err.status < 500) break;          // 404, 403 etc: retrying will not help
      await new Promise(r => setTimeout(r, 1500));
    }
  }
  throw last;
}

// If the address is a normal web page, look for <link rel="alternate" type="application/rss+xml" href="...">
function findFeedLink(html: string, base: string): string | null {
  for (const tag of html.match(/<link\b[^>]*>/gi) ?? []) {
    if (!/rel=["']?alternate/i.test(tag) || !/type=["']?application\/(rss|atom)\+xml/i.test(tag)) continue;
    const href = tag.match(/href=["']([^"']+)["']/i);
    if (href) return new URL(href[1].replace(/&amp;/g, "&"), base).href;
  }
  return null;
}

// download -> parse with the FSM -> normalize -> save
async function refresh(id: string): Promise<number> {
  const feed = queryOne<FeedRow>("SELECT * FROM feeds WHERE id = ?", id);
  if (!feed) throw new Error("Unknown feed");
  const host = new URL(feed.url).hostname;
  let body: string, parsed: ParsedFeed;
  try { body = await download(feed.url); }
  catch (e) {
    const err = e as HttpError;
    throw new Error(err.status ? `${host} returned status ${err.status}` : `Could not reach ${host} (${err.code || err.message})`);
  }
  try { parsed = parseFeed(body); }
  catch (e) {
    const alt = findFeedLink(body, feed.url);          // maybe this is a website, not a feed
    if (!alt) throw /html/i.test((e as Error).message) ? new Error("No RSS feed found at this address.") : e;
    try { body = await download(alt); }
    catch (e2) {
      const err2 = e2 as HttpError;
      throw new Error(`Could not reach ${new URL(alt).hostname} (${err2.code || err2.message})`);
    }
    parsed = parseFeed(body);
    db.prepare("UPDATE feeds SET url = ? WHERE id = ?").run(alt, id);   // remember the real feed address
  }
  const { format, title, items } = parsed;

  const ins = db.prepare(`INSERT OR REPLACE INTO articles
    (feed_id, guid, title, link, image, summary, body, date, ts, author) VALUES (?,?,?,?,?,?,?,?,?,?)`);
  db.exec("BEGIN");
  try {
    for (const it of items) {
      const a: Article = normalize(it, format);
      ins.run(id, a.guid, a.title, a.link, a.image, a.summary, a.body, a.date, a.ts, a.author);
    }
    const name = feed.source === "user" && title ? title : feed.name;   // user feeds are named after the feed itself
    db.prepare("UPDATE feeds SET format = ?, updated_at = ?, name = ? WHERE id = ?")
      .run(format, new Date().toISOString(), name, id);
    db.exec("COMMIT");
  } catch (e) { db.exec("ROLLBACK"); throw e; }
  return items.length;
}

function deleteFeed(id: string): void {
  db.prepare("DELETE FROM articles WHERE feed_id = ?").run(id);
  db.prepare("DELETE FROM feeds WHERE id = ?").run(id);
}

// one feed at a time, so a slow network is not hit with five connections at once
async function refreshAll(): Promise<void> {
  for (const f of queryAll<{ id: string }>("SELECT id FROM feeds")) {
    try { await refresh(f.id); } catch (e) { console.log("[refresh]", f.id, "-", (e as Error).message); }
  }
}

const json = (res: ServerResponse, code: number, data: unknown): void => {
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data));
};

const readBody = <T>(req: IncomingMessage): Promise<T> => new Promise<T>((ok, fail) => {
  let d = "";
  req.on("data", (c: Buffer) => { d += c; if (d.length > 1e5) req.destroy(); });
  req.on("end", () => { try { ok(JSON.parse(d || "{}") as T); } catch { fail(new Error("Bad request body")); } });
});

// index.html, style.css and the compiled front end (dist/app.js) are the only static files.
const PUBLIC: Record<string, { file: string; type: string }> = {
  "/index.html": { file: path.join(ROOT, "index.html"), type: "text/html; charset=utf-8" },
  "/style.css": { file: path.join(ROOT, "style.css"), type: "text/css; charset=utf-8" },
  "/app.js": { file: path.join(__dirname, "app.js"), type: "text/javascript; charset=utf-8" },
};

http.createServer(async (req, res) => {
  const { pathname } = new URL(req.url ?? "/", "http://localhost");
  try {
    // list all saved feeds
    if (pathname === "/api/feeds" && req.method === "GET") {
      const feeds = queryAll<Feed>(`
        SELECT f.id, f.name, f.format, f.updated_at, f.source,
               (SELECT COUNT(*) FROM articles a WHERE a.feed_id = f.id) AS count
        FROM feeds f ORDER BY f.source = 'user', f.rowid`);
      return json(res, 200, feeds);
    }

    // add a feed from a pasted URL
    if (pathname === "/api/feeds" && req.method === "POST") {
      const { url } = await readBody<{ url?: string }>(req);
      let u: URL;
      try { u = new URL(url ?? ""); } catch { return json(res, 400, { error: "That is not a valid URL." }); }
      if (!/^https?:$/.test(u.protocol)) return json(res, 400, { error: "Only http and https links work." });
      const id = "u-" + crypto.createHash("md5").update(u.href).digest("hex").slice(0, 8);
      const old = queryOne<{ id: string }>("SELECT id FROM feeds WHERE id = ? OR url = ?", id, u.href);
      if (old) return json(res, 200, { id: old.id });
      db.prepare("INSERT INTO feeds (id, name, url, source) VALUES (?, ?, ?, 'user')").run(id, u.hostname, u.href);
      try { await refresh(id); }
      catch (e) { deleteFeed(id); return json(res, 400, { error: (e as Error).message }); }   // bad URL: do not keep it
      return json(res, 200, { id });
    }

    // remove a feed the user added
    let m = pathname.match(/^\/api\/feeds\/([\w-]+)$/);
    if (m && req.method === "DELETE") {
      const f = queryOne<{ source: string }>("SELECT source FROM feeds WHERE id = ?", m[1]);
      if (!f || f.source !== "user") return json(res, 400, { error: "Only feeds you added can be removed." });
      deleteFeed(m[1]);
      return json(res, 200, { ok: true });
    }

    // articles of one feed, read from SQLite
    m = pathname.match(/^\/api\/feeds\/([\w-]+)\/(articles|refresh)$/);
    if (m) {
      const [, id, action] = m;
      if (!queryOne<{ one: number }>("SELECT 1 FROM feeds WHERE id = ?", id)) return json(res, 404, { error: "Unknown feed" });
      const count = queryOne<{ c: number }>("SELECT COUNT(*) AS c FROM articles WHERE feed_id = ?", id)?.c ?? 0;
      if ((action === "refresh" && req.method === "POST") || count === 0) await refresh(id);
      const feed = queryOne<{ format: FeedFormat | null; updated_at: string | null }>(
        "SELECT format, updated_at FROM feeds WHERE id = ?", id);
      const articles = queryAll<ArticleRow>(`SELECT title, link, image, summary, body, date, author
        FROM articles WHERE feed_id = ? ORDER BY ts DESC, id DESC LIMIT 100`, id);
      const payload: ArticlesResponse = {
        format: feed?.format ?? null,
        updated_at: feed?.updated_at ?? null,
        articles,
      };
      return json(res, 200, payload);
    }

    const file = pathname === "/" ? "/index.html" : pathname;
    const pub = PUBLIC[file];
    if (!pub) { res.writeHead(404); return res.end("Not found"); }
    res.writeHead(200, { "Content-Type": pub.type });
    res.end(fs.readFileSync(pub.file));
  } catch (e) {
    json(res, 500, { error: (e as Error).message });
  }
}).listen(PORT, () => {
  console.log("Open http://localhost:" + PORT);
  refreshAll();
  setInterval(refreshAll, 15 * 60 * 1000);   // keep the database fresh
});
