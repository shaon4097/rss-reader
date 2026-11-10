/**
 * RSS Feed Reader backend — TypeScript conversion of server.js.
 *
 * Requirements: Node.js 22.13+ and @types/node.
 * The existing parser.js remains usable without modification.
 *
 * Compile to dist-server/server.js using tsconfig.server.json, then run:
 *   node dist-server/server.js
 */

import * as http from "node:http";
import * as https from "node:https";
import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import * as zlib from "node:zlib";
import * as dns from "node:dns";
import { DatabaseSync } from "node:sqlite";
import type { IncomingMessage, ServerResponse } from "node:http";
import { parseFeed, normalize, FeedParserError } from "./parser";
import type { FeedFormat, ParsedFeed, NewsItem } from "./parser";
import { AppError, errorMessage } from "./errors";
import type { ApiErrorResponse } from "./errors";

// -------------------- TypeScript types and interfaces --------------------

type FeedSource = "default" | "user";

interface SeedFeed {
  id: string;
  name: string;
  url: string;
}

interface StoredFeed extends SeedFeed {
  source: FeedSource;
  format: FeedFormat | null;
  updated_at: string | null;
}

interface FeedListItem extends StoredFeed {
  count: number;
}

type ArticleResponse = Omit<NewsItem, "guid" | "ts">;

interface FeedArticlesResponse {
  format: FeedFormat | null;
  updated_at: string | null;
  articles: ArticleResponse[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// -------------------- Setup and SQLite --------------------

dns.setDefaultResultOrder("ipv4first");

const PORT: number = Number(process.env.PORT ?? 3000);

// Works both for `tsx server.ts` at the project root and compiled dist-server/server.js.
const PROJECT_DIR: string = fs.existsSync(path.join(__dirname, "feeds.json"))
  ? __dirname
  : path.resolve(__dirname, "..");

const db = new DatabaseSync(path.join(PROJECT_DIR, "rss.db"));

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

// Older databases may be missing this column.
try {
  db.exec("ALTER TABLE feeds ADD COLUMN source TEXT DEFAULT 'default'");
} catch {
  // Already present: do nothing, just like the original server.js.
}

const list = JSON.parse(
  fs.readFileSync(path.join(PROJECT_DIR, "feeds.json"), "utf8")
) as SeedFeed[];

const upsertFeed = db.prepare(
  "INSERT INTO feeds (id, name, url) VALUES (?, ?, ?) " +
    "ON CONFLICT(id) DO UPDATE SET name = excluded.name, url = excluded.url"
);

list.forEach((feed: SeedFeed): void => {
  upsertFeed.run(feed.id, feed.name, feed.url);
});

if (list.length > 0) {
  db.prepare(
    `DELETE FROM feeds WHERE source = 'default' AND id NOT IN (${list.map(() => "?").join(",")})`
  ).run(...list.map((feed: SeedFeed) => feed.id));
} else {
  db.exec("DELETE FROM feeds WHERE source = 'default'");
}

db.exec("DELETE FROM articles WHERE feed_id NOT IN (SELECT id FROM feeds)");

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120 Safari/537.36";

// -------------------- Feed download --------------------

// Download over IPv4 with a 20-second timeout; follow up to 5 redirects.
const MAX_FEED_BYTES = 5 * 1024 * 1024;

// Timeouts, upstream HTTP errors, streaming failures and redirects have typed errors.
function httpGet(url: string, hops = 0): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let target: URL;
    try {
      target = new URL(url);
      if (target.protocol !== "https:" && target.protocol !== "http:") {
        throw new Error("Unsupported protocol");
      }
    } catch {
      reject(new AppError("INVALID_URL", 400, "The feed URL must use http or https."));
      return;
    }

    const transport = target.protocol === "https:" ? https : http;
    const req = transport.get(target, {
      headers: {
        "User-Agent": UA,
        Accept: "application/rss+xml, application/xml, text/xml, text/html, */*",
        "Accept-Encoding": "gzip",
      },
      family: 4,
      timeout: 20_000,
    }, (res: IncomingMessage) => {
      const status = res.statusCode ?? 0;

      if (status >= 300 && status < 400 && res.headers.location) {
        res.resume();
        if (hops >= 5) {
          reject(new AppError("TOO_MANY_REDIRECTS", 502, "Feed redirected too many times."));
          return;
        }
        try {
          resolve(httpGet(new URL(res.headers.location, target).href, hops + 1));
        } catch {
          reject(new AppError("INVALID_URL", 400, "Invalid feed redirect URL."));
        }
        return;
      }

      if (status !== 200) {
        res.resume();
        reject(new AppError("HTTP_ERROR", 502, `Feed source returned HTTP ${status}.`, status >= 500));
        return;
      }

      const stream = res.headers["content-encoding"] === "gzip"
        ? res.pipe(zlib.createGunzip()) : res;
      const chunks: Buffer[] = [];
      let total = 0;

      stream.on("data", (chunk: Buffer) => {
        total += chunk.length;
        if (total > MAX_FEED_BYTES) {
          reject(new AppError("FEED_TOO_LARGE", 413, "Feed XML exceeds the 5 MB size limit."));
          stream.destroy();
          res.destroy();
          return;
        }
        chunks.push(chunk);
      });
      stream.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
      stream.on("error", (error: Error) => {
        reject(new AppError("FETCH_FAILED", 502, `Feed stream failed: ${error.message}`, true));
      });
      res.on("aborted", () => {
        reject(new AppError("FETCH_FAILED", 502, "Feed response was interrupted.", true));
      });
    });

    req.on("timeout", () => {
      req.destroy(new AppError("FETCH_TIMEOUT", 504, "Feed request timed out after 20 seconds.", true));
    });
    req.on("error", (error: Error) => {
      reject(error instanceof AppError ? error
        : new AppError("FETCH_FAILED", 502, `Could not reach ${target.hostname}: ${error.message}`, true));
    });
  });
}

async function download(url: string): Promise<string> {
  let last: AppError | undefined;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await httpGet(url);
    } catch (error: unknown) {
      last = error instanceof AppError ? error
        : new AppError("FETCH_FAILED", 502, errorMessage(error), true);
      if (!last.retryable || attempt === 2) break;
      await new Promise<void>((resolve) => setTimeout(resolve, 1500));
    }
  }
  throw last ?? new AppError("FETCH_FAILED", 502, "Feed download failed.");
}

// If a URL is an HTML page, find its RSS/Atom alternate link.
function findFeedLink(html: string, base: string): string | null {
  for (const tag of html.match(/<link\b[^>]*>/gi) || []) {
    if (
      !/rel=["']?alternate/i.test(tag) ||
      !/type=["']?application\/(rss|atom)\+xml/i.test(tag)
    ) continue;

    const href = tag.match(/href=["']([^"']+)["']/i);
    if (href) return new URL(href[1].replace(/&amp;/g, "&"), base).href;
  }
  return null;
}

// -------------------- Parse, normalize, save --------------------

function parseXmlOrThrow(body: string): ParsedFeed {
  try {
    return parseFeed(body);
  } catch (error: unknown) {
    if (error instanceof FeedParserError) {
      throw new AppError(
        error.code === "UNSUPPORTED_FORMAT" ? "UNSUPPORTED_FORMAT" : "INVALID_XML",
        422,
        error.message
      );
    }
    throw new AppError("INVALID_XML", 422, "Could not parse feed XML.");
  }
}

// Fetch and parse completely BEFORE beginning the SQLite transaction.
// An invalid/broken XML feed cannot overwrite existing saved articles.
async function refresh(id: string): Promise<number> {
  const feed = db.prepare("SELECT * FROM feeds WHERE id = ?").get(id) as unknown as
    | StoredFeed | undefined;
  if (!feed) throw new AppError("FEED_NOT_FOUND", 404, "Unknown feed.");

  let body = await download(feed.url);
  let parsed: ParsedFeed;
  let resolvedUrl: string | null = null;

  try {
    parsed = parseXmlOrThrow(body);
  } catch (error: unknown) {
    const alt = findFeedLink(body, feed.url);
    if (!alt) {
      if (error instanceof AppError && error.code === "UNSUPPORTED_FORMAT" && /<html/i.test(body)) {
        throw new AppError("FEED_NOT_FOUND", 422, "No RSS feed found at this address.");
      }
      throw error;
    }
    body = await download(alt);
    parsed = parseXmlOrThrow(body);
    resolvedUrl = alt;
  }

  const { format, title, items } = parsed;
  const ins = db.prepare(`INSERT OR REPLACE INTO articles
    (feed_id, guid, title, link, image, summary, body, date, ts, author)
    VALUES (?,?,?,?,?,?,?,?,?,?)`);

  db.exec("BEGIN");
  try {
    for (const it of items) {
      const a: NewsItem = normalize(it, format);
      ins.run(id, a.guid, a.title, a.link, a.image, a.summary, a.body, a.date, a.ts, a.author);
    }
    const name = feed.source === "user" && title ? title : feed.name;
    db.prepare("UPDATE feeds SET format = ?, updated_at = ?, name = ?, url = ? WHERE id = ?")
      .run(format, new Date().toISOString(), name, resolvedUrl ?? feed.url, id);
    db.exec("COMMIT");
  } catch (error: unknown) {
    db.exec("ROLLBACK");
    throw error;
  }
  return items.length;
}

function deleteFeed(id: string): void {
  db.prepare("DELETE FROM articles WHERE feed_id = ?").run(id);
  db.prepare("DELETE FROM feeds WHERE id = ?").run(id);
}

// Refresh sequentially to avoid hitting a slow network with parallel requests.
async function refreshAll(): Promise<void> {
  const rows = db.prepare("SELECT id FROM feeds").all() as unknown as Array<{ id: string }>;
  for (const feed of rows) {
    try {
      await refresh(feed.id);
    } catch (error: unknown) {
      console.warn("[refresh]", feed.id, error instanceof AppError ? error.code : "INTERNAL_ERROR", "-", errorMessage(error));
    }
  }
}

// -------------------- HTTP API --------------------

function json(res: ServerResponse, code: number, data: unknown): void {
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data));
}

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise<unknown>((resolve, reject): void => {
    let body = "";
    let settled = false;

    req.on("data", (chunk: Buffer): void => {
      if (settled) return;
      body += chunk.toString("utf8");
      if (Buffer.byteLength(body, "utf8") > 100_000) {
        settled = true;
        reject(new AppError("REQUEST_TOO_LARGE", 413, "Request body too large."));
      }
    });

    req.on("end", (): void => {
      if (settled) return;
      try {
        resolve(JSON.parse(body || "{}") as unknown);
      } catch {
        reject(new AppError("BAD_REQUEST", 400, "Bad request body."));
      }
    });
    req.on("error", reject);
  });
}

const PUBLIC: Record<string, string> = {
  "/index.html": "text/html; charset=utf-8",
  "/style.css": "text/css; charset=utf-8",
  "/dist/app.js": "text/javascript; charset=utf-8",
};

function sendError(res: ServerResponse, error: unknown): void {
  const appError = error instanceof AppError
    ? error : new AppError("INTERNAL_ERROR", 500, "An unexpected server error occurred.");
  if (!(error instanceof AppError)) console.error("[server]", error);
  const body: ApiErrorResponse = { code: appError.code, error: appError.message };
  json(res, appError.status, body);
}

async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  try {
    const { pathname } = new URL(req.url ?? "/", "http://localhost");

    // List saved feeds.
    if (pathname === "/api/feeds" && req.method === "GET") {
      const feeds = db.prepare(`
        SELECT f.id, f.name, f.format, f.updated_at, f.source,
               (SELECT COUNT(*) FROM articles a WHERE a.feed_id = f.id) AS count
        FROM feeds f ORDER BY f.source = 'user', f.rowid
      `).all() as unknown as FeedListItem[];
      json(res, 200, feeds);
      return;
    }

    // Add a feed from the pasted URL.
    if (pathname === "/api/feeds" && req.method === "POST") {
      const payload: unknown = await readBody(req);
      if (!isRecord(payload) || typeof payload.url !== "string") {
        sendError(res, new AppError("INVALID_URL", 400, "That is not a valid URL."));
        return;
      }

      let u: URL;
      try {
        u = new URL(payload.url);
      } catch {
        sendError(res, new AppError("INVALID_URL", 400, "That is not a valid URL."));
        return;
      }

      if (!/^https?:$/.test(u.protocol)) {
        sendError(res, new AppError("INVALID_URL", 400, "Only http and https links work."));
        return;
      }

      const id = "u-" + crypto.createHash("md5").update(u.href).digest("hex").slice(0, 8);
      const old = db.prepare("SELECT id FROM feeds WHERE id = ? OR url = ?")
        .get(id, u.href) as unknown as { id: string } | undefined;

      if (old) {
        json(res, 200, { id: old.id });
        return;
      }

      db.prepare("INSERT INTO feeds (id, name, url, source) VALUES (?, ?, ?, 'user')")
        .run(id, u.hostname, u.href);

      try {
        await refresh(id);
      } catch (error: unknown) {
        if (error instanceof AppError && error.retryable) {
          // Temporary network failure: keep the URL for future retries.
          json(res, 200, { id, warning: error.message });
          return;
        }
        deleteFeed(id);
        sendError(res, error);
        return;
      }

      json(res, 200, { id });
      return;
    }

    // Remove a user-added feed.
    let match: RegExpMatchArray | null = pathname.match(/^\/api\/feeds\/([\w-]+)$/);
    if (match && req.method === "DELETE") {
      const id = match[1];
      const feed = db.prepare("SELECT source FROM feeds WHERE id = ?")
        .get(id) as unknown as { source: FeedSource } | undefined;

      if (!feed || feed.source !== "user") {
        sendError(res, new AppError("BAD_REQUEST", 400, "Only feeds you added can be removed."));
        return;
      }

      deleteFeed(id);
      json(res, 200, { ok: true });
      return;
    }

    // Return saved articles, or refresh and then return them.
    match = pathname.match(/^\/api\/feeds\/([\w-]+)\/(articles|refresh)$/);
    if (match) {
      const [, id, action] = match;
      const exists = db.prepare("SELECT 1 FROM feeds WHERE id = ?").get(id);
      if (!exists) {
        sendError(res, new AppError("FEED_NOT_FOUND", 404, "Unknown feed."));
        return;
      }

      const countRow = db.prepare("SELECT COUNT(*) AS c FROM articles WHERE feed_id = ?")
        .get(id) as unknown as { c: number };

      if ((action === "refresh" && req.method === "POST") || countRow.c === 0) {
        await refresh(id);
      }

      const feed = db.prepare("SELECT format, updated_at FROM feeds WHERE id = ?")
        .get(id) as unknown as Pick<StoredFeed, "format" | "updated_at">;
      const articles = db.prepare(`
        SELECT title, link, image, summary, body, date, author
        FROM articles WHERE feed_id = ? ORDER BY ts DESC, id DESC LIMIT 100
      `).all(id) as unknown as ArticleResponse[];

      const response: FeedArticlesResponse = {
        format: feed.format,
        updated_at: feed.updated_at,
        articles,
      };
      json(res, 200, response);
      return;
    }

    // Serve only these three public files (same whitelist as server.js).
    const file = pathname === "/" ? "/index.html" : pathname;
    const contentType = PUBLIC[file];
    if (!contentType) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }

    const staticPath = path.join(PROJECT_DIR, file.slice(1));
    const contents = fs.readFileSync(staticPath);
    res.writeHead(200, { "Content-Type": contentType });
    res.end(contents);
  } catch (error: unknown) {
    if (res.headersSent) {
      res.end();
      return;
    }
    sendError(res, error);
  }
}

http.createServer((req: IncomingMessage, res: ServerResponse): void => {
  void handleRequest(req, res);
}).listen(PORT, (): void => {
  console.log("Open http://localhost:" + PORT);
  void refreshAll();
  setInterval((): void => { void refreshAll(); }, 15 * 60 * 1000);
});
