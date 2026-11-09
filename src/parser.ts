// Feed parser engine, written as two finite state machines.
//
// 1) Lexer FSM    states: TEXT, TAG_OPEN, TAG, CDATA, COMMENT, PI
//                 turns raw characters into tokens: open, close, text, cdata
// 2) Builder FSM  states: ROOT, CHANNEL, ITEM, FIELD
//                 turns those tokens into a list of feed items

import type { Article, FeedFormat } from "./types.js";

/** Tag attributes, keyed by tag name without its namespace prefix. */
export type Attrs = Record<string, string>;

/** Text and CDATA carry a value; open and close carry a tag name. */
export type Token =
  | { type: "text"; value: string }
  | { type: "cdata"; value: string }
  | { type: "open"; name: string; attrs: Attrs }
  | { type: "close"; name: string };

export type OpenToken = Extract<Token, { type: "open" }>;

/** One field inside an item, e.g. <title>hello</title>. */
export interface Field {
  name: string;
  attrs: Attrs;
  text: string;
}

/** An item is simply the list of its fields, in document order. */
export type FeedItem = Field[];

export interface ParsedFeed {
  format: FeedFormat;
  title: string;
  items: FeedItem[];
}

type LexerState = "TEXT" | "TAG_OPEN" | "TAG" | "CDATA" | "COMMENT" | "PI";
type BuilderState = "ROOT" | "CHANNEL" | "ITEM" | "FIELD";

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

const decode = (s: string): string => s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e) => {
  if (e[0] === "#") {
    const n = /^#x/i.test(e) ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    return n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m;
  }
  return Object.hasOwn(ENTITIES, e) ? ENTITIES[e] : m;
});

const local = (name: string): string => name.split(":").pop() ?? name;   // media:content -> content

function emitTag(raw: string, emit: (t: Token) => void): void {
  raw = raw.trim();
  if (raw[0] === "/") return emit({ type: "close", name: local(raw.slice(1).trim()) });
  const selfClosing = raw.endsWith("/");
  if (selfClosing) raw = raw.slice(0, -1).trim();
  const name = raw.match(/^\S+/)?.[0];
  if (!name) return;                                    // "<>" or "< >": nothing to emit
  const attrs: Attrs = {};
  for (const a of raw.slice(name.length).matchAll(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
    attrs[local(a[1])] = decode(a[2] || a[3] || "");
  }
  emit({ type: "open", name: local(name), attrs });
  if (selfClosing) emit({ type: "close", name: local(name) });
}

function tokenize(xml: string, emit: (t: Token) => void): void {
  let state: LexerState = "TEXT";
  let buf = "";
  let quote = "";
  let i = 0;
  while (i < xml.length) {
    const c = xml[i];
    switch (state) {
      case "TEXT":
        if (c === "<") {
          if (buf) emit({ type: "text", value: decode(buf) });
          buf = ""; state = "TAG_OPEN";
        } else buf += c;
        i++; break;

      case "TAG_OPEN":                       // just saw "<", decide what comes next
        if (xml.startsWith("![CDATA[", i)) { state = "CDATA"; i += 8; }
        else if (xml.startsWith("!--", i)) { state = "COMMENT"; i += 3; }
        else if (c === "?" || c === "!")   { state = "PI"; i++; }   // <?xml ?> and <!DOCTYPE>
        else state = "TAG";                  // do not consume, TAG reads this char
        break;

      case "TAG":                            // inside <...>, watch quotes so ">" in attributes is safe
        if (quote) { if (c === quote) quote = ""; buf += c; }
        else if (c === '"' || c === "'") { quote = c; buf += c; }
        else if (c === ">") { emitTag(buf, emit); buf = ""; state = "TEXT"; }
        else buf += c;
        i++; break;

      case "CDATA":
        if (xml.startsWith("]]>", i)) { emit({ type: "cdata", value: buf }); buf = ""; state = "TEXT"; i += 3; }
        else { buf += c; i++; }
        break;

      case "COMMENT":
        if (xml.startsWith("-->", i)) { state = "TEXT"; i += 3; } else i++;
        break;

      case "PI":
        if (c === ">") state = "TEXT";
        i++; break;
    }
  }
  if (state !== "TEXT") throw new Error("XML ended unexpectedly while in state " + state);
}

const FORMATS: Record<string, FeedFormat> = { rss: "rss", feed: "atom", rdf: "rss1" };

export function parseFeed(xml: string): ParsedFeed {
  let state: BuilderState = "ROOT";
  let format: FeedFormat | "" = "";
  let item: FeedItem | null = null;
  let title = "";
  let inTitle = false;
  const stack: Field[] = [];
  const items: FeedItem[] = [];
  const openField = (t: OpenToken): void => {
    const f: Field = { name: t.name, attrs: t.attrs, text: "" };
    item?.push(f);
    stack.push(f);
    state = "FIELD";
  };

  tokenize(xml, (t) => {
    switch (state) {
      case "ROOT":                           // first tag decides the feed format
        if (t.type !== "open") return;
        format = FORMATS[t.name.toLowerCase()] ?? "";
        if (!format) throw new Error("Unsupported feed format: <" + t.name + ">");
        state = "CHANNEL"; return;

      case "CHANNEL":                        // waiting for the next <item> or <entry>
        if (t.type === "open" && (t.name === "item" || t.name === "entry")) { item = []; state = "ITEM"; }
        else if (t.type === "open" && t.name === "title" && !title) inTitle = true;   // feed's own title
        else if (t.type === "close" && t.name === "title") inTitle = false;
        else if (inTitle && (t.type === "text" || t.type === "cdata")) title += t.value;
        return;

      case "ITEM":                           // inside an item, between fields
        if (!item) return;
        if (t.type === "open") openField(t);
        else if (t.type === "close") { items.push(item); item = null; state = "CHANNEL"; }
        return;

      case "FIELD":                          // inside a field such as <title>
        if (t.type === "open") openField(t);
        else if (t.type === "close") { stack.pop(); if (!stack.length) state = "ITEM"; }
        else stack[stack.length - 1].text += t.value;
    }
  });

  if (state === "ROOT") throw new Error("This is not an XML feed.");
  if (state !== "CHANNEL") throw new Error("Feed ended in the middle of an item.");
  return { format: format as FeedFormat, title: title.trim(), items };
}

/* ---------- normalize: any format -> one common shape ---------- */

const text = (it: FeedItem, name: string): string => {
  const f = it.find(f => f.name === name && f.text.trim());
  return f ? f.text.trim() : "";
};

const strip = (h: string): string => decode(h.replace(/<\/(p|div|li)>|<br\s*\/?>/gi, "\n").replace(/<[^>]*>/g, ""))
  .replace(/[ \t]+/g, " ").replace(/\n\s*/g, "\n\n").trim();

function image(it: FeedItem): string {
  for (const f of it) if ((f.name === "content" || f.name === "thumbnail") && f.attrs.url) return f.attrs.url;
  const enc = it.find(f => f.name === "enclosure" && (f.attrs.type || "").startsWith("image"));
  if (enc) return enc.attrs.url || "";
  const html = text(it, "encoded") || text(it, "description") || text(it, "content") || text(it, "summary");
  return html.match(/<img[^>]+src=["']([^"']+)["']/i)?.[1] ?? "";
}

export function normalize(it: FeedItem, format: FeedFormat): Article {
  const link = format === "atom"
    ? (it.find(f => f.name === "link" && (f.attrs.rel || "alternate") === "alternate") ?? it.find(f => f.name === "link"))?.attrs.href || ""
    : text(it, "link");
  const title = strip(text(it, "title"));
  const date = text(it, "pubDate") || text(it, "published") || text(it, "updated") || text(it, "date");
  const body = text(it, "encoded") || text(it, "content") || text(it, "description") || text(it, "summary");
  return {
    guid: text(it, "guid") || text(it, "id") || link || title,
    title, link, date, ts: Date.parse(date) || 0,
    image: image(it),
    summary: strip(text(it, "description") || text(it, "summary")).slice(0, 160),
    body: strip(body),
    author: text(it, "creator") || text(it, "name") || text(it, "author"),
  };
}
