// One server for everything: it serves the website and fetches feeds for it.
// No npm install needed. Requires Node 18 or newer.

const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = 3000;
const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
};

http.createServer(async (req, res) => {
  const u = new URL(req.url, "http://localhost");
  res.setHeader("Access-Control-Allow-Origin", "*");

  // /rss?url=... : download the feed and hand it back to the browser
  if (u.pathname === "/rss") {
    const target = u.searchParams.get("url");
    if (!target) { res.writeHead(400); return res.end("Missing url"); }
    try {
      const r = await fetch(target, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120 Safari/537.36",
          "Accept": "application/rss+xml, application/xml, text/xml, */*",
        },
        redirect: "follow",
      });
      const text = await r.text();
      res.writeHead(r.status, { "Content-Type": "application/xml; charset=utf-8" });
      return res.end(text);
    } catch (e) {
      res.writeHead(500);
      return res.end(e.message);
    }
  }

  // anything else: serve the files in this folder (index.html, style.css, app.js)
  const file = u.pathname === "/" ? "/index.html" : u.pathname;
  const full = path.join(__dirname, path.normalize(file));
  if (!full.startsWith(__dirname)) { res.writeHead(403); return res.end(); }
  fs.readFile(full, (err, data) => {
    if (err) { res.writeHead(404); return res.end("Not found"); }
    res.writeHead(200, { "Content-Type": TYPES[path.extname(full)] || "application/octet-stream" });
    res.end(data);
  });
}).listen(PORT, () => console.log("Open http://localhost:" + PORT));