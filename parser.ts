/**
 * RSS / Atom / RSS1 XML feed parser using two finite state machines.
 *
 * 1. Lexer FSM: TEXT, TAG_OPEN, TAG, CDATA, COMMENT, PI
 * 2. Builder FSM: ROOT, CHANNEL, ITEM, FIELD
 *
 * Compatible with the original parser.js API:
 *   parseFeed(xml) -> { format, title, items }
 *   normalize(item, format) -> NewsItem
 *
 * Each item still contains a flat list of fields (for compatibility),
 * and nested fields now also have a `children` tree.
 */

// -------------------- Types & interfaces --------------------

export type LexerState =
  | "TEXT"
  | "TAG_OPEN"
  | "TAG"
  | "CDATA"
  | "COMMENT"
  | "PI";

export type BuilderState = "ROOT" | "CHANNEL" | "ITEM" | "FIELD";

export type FeedFormat = "rss" | "atom" | "rss1";

export interface XmlOpenToken {
  type: "open";
  name: string;
  attrs: Record<string, string>;
}

export interface XmlCloseToken {
  type: "close";
  name: string;
}

export interface XmlTextToken {
  type: "text" | "cdata";
  value: string;
}

export type XmlToken = XmlOpenToken | XmlCloseToken | XmlTextToken;
export type TokenEmitter = (token: XmlToken) => void;

/** A recursive XML node: an element can contain further XML elements. */
export interface XmlNode {
  name: string;
  attrs: Record<string, string>;
  text: string;
  children: XmlNode[];
}

export interface ParsedFeed {
  format: FeedFormat;
  title: string;
  /** Flat field lists, retained for the original normalization algorithm. */
  items: XmlNode[][];
}

export interface NewsItem {
  guid: string;
  title: string;
  link: string;
  date: string;
  ts: number;
  image: string;
  summary: string;
  body: string;
  author: string;
}

export type FeedParserErrorCode =
  | "MALFORMED_TAG"
  | "UNEXPECTED_EOF"
  | "UNSUPPORTED_FORMAT"
  | "NOT_XML_FEED"
  | "INCOMPLETE_ITEM"
  | "MISMATCHED_TAG"
  | "UNEXPECTED_CLOSING_TAG"
  | "UNCLOSED_TAG"
  | "MULTIPLE_ROOT"
  | "TEXT_OUTSIDE_ROOT";

export class FeedParserError extends Error {
  constructor(
    public readonly code: FeedParserErrorCode,
    message: string
  ) {
    super(message);
    this.name = "FeedParserError";
  }
}

// -------------------- XML helpers --------------------

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};

function decode(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (match: string, entity: string): string => {
    if (entity[0] === "#") {
      const n = /^#x/i.test(entity)
        ? parseInt(entity.slice(2), 16)
        : parseInt(entity.slice(1), 10);
      return n > 0 && n < 0x110000 ? String.fromCodePoint(n) : match;
    }
    return Object.hasOwn(ENTITIES, entity) ? ENTITIES[entity] : match;
  });
}

// media:content -> content
function local(name: string): string {
  return name.split(":").pop() ?? name;
}

function emitTag(raw: string, emit: TokenEmitter): void {
  raw = raw.trim();

  if (raw[0] === "/") {
    emit({ type: "close", name: local(raw.slice(1).trim()) });
    return;
  }

  const selfClosing = raw.endsWith("/");
  if (selfClosing) raw = raw.slice(0, -1).trim();

  const match = raw.match(/^\S+/);
  if (!match) {
    throw new FeedParserError("MALFORMED_TAG", "Malformed XML tag.");
  }

  const name = match[0];
  const attrs: Record<string, string> = {};

  for (const attr of raw.slice(name.length).matchAll(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
    attrs[local(attr[1])] = decode(attr[2] ?? attr[3] ?? "");
  }

  emit({ type: "open", name: local(name), attrs });
  if (selfClosing) emit({ type: "close", name: local(name) });
}

// -------------------- Lexer FSM --------------------

function tokenize(xml: string, onToken: TokenEmitter): void {
  // Validate tag nesting independently from the RSS/Atom builder FSM.
  const elementStack: string[] = [];
  let seenRoot = false;
  let finishedRoot = false;

  const emit: TokenEmitter = (token) => {
    if (token.type === "open") {
      if (finishedRoot) {
        throw new FeedParserError("MULTIPLE_ROOT", "XML contains multiple root elements.");
      }
      seenRoot = true;
      elementStack.push(token.name);
    } else if (token.type === "close") {
      const expected = elementStack.pop();
      if (!expected) {
        throw new FeedParserError("UNEXPECTED_CLOSING_TAG", `Unexpected closing tag </${token.name}>.`);
      }
      if (token.name !== expected) {
        throw new FeedParserError("MISMATCHED_TAG", `Expected </${expected}>, received </${token.name}>.`);
      }
      if (elementStack.length === 0) finishedRoot = true;
    } else if (elementStack.length === 0 && token.value.trim()) {
      throw new FeedParserError("TEXT_OUTSIDE_ROOT", "Non-whitespace text outside the XML root.");
    }
    onToken(token);
  };

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
          buf = "";
          state = "TAG_OPEN";
        } else {
          buf += c;
        }
        i++;
        break;

      case "TAG_OPEN":
        if (xml.startsWith("![CDATA[", i)) {
          state = "CDATA";
          i += 8;
        } else if (xml.startsWith("!--", i)) {
          state = "COMMENT";
          i += 3;
        } else if (c === "?" || c === "!") {
          state = "PI";
          i++;
        } else {
          state = "TAG";
        }
        break;

      case "TAG":
        if (quote) {
          if (c === quote) quote = "";
          buf += c;
        } else if (c === '"' || c === "'") {
          quote = c;
          buf += c;
        } else if (c === ">") {
          emitTag(buf, emit);
          buf = "";
          state = "TEXT";
        } else {
          buf += c;
        }
        i++;
        break;

      case "CDATA":
        if (xml.startsWith("]]>", i)) {
          emit({ type: "cdata", value: buf });
          buf = "";
          state = "TEXT";
          i += 3;
        } else {
          buf += c;
          i++;
        }
        break;

      case "COMMENT":
        if (xml.startsWith("-->", i)) {
          state = "TEXT";
          i += 3;
        } else {
          i++;
        }
        break;

      case "PI":
        if (c === ">") state = "TEXT";
        i++;
        break;
    }
  }

  if (state !== "TEXT") {
    throw new FeedParserError(
      "UNEXPECTED_EOF",
      "XML ended unexpectedly while in state " + state
    );
  }
  if (buf) emit({ type: "text", value: decode(buf) });
  if (elementStack.length) {
    throw new FeedParserError("UNCLOSED_TAG", `Unclosed tag <${elementStack[elementStack.length - 1]}>.`);
  }
  if (!seenRoot) throw new FeedParserError("NOT_XML_FEED", "This is not an XML feed.");
}

// -------------------- Builder FSM --------------------

const FORMATS: Record<string, FeedFormat> = {
  rss: "rss",
  feed: "atom",
  rdf: "rss1",
};

export function parseFeed(xml: string): ParsedFeed {
  // Keep mutable state in an object so TypeScript can narrow it after tokenize().
  const ctx: {
    state: BuilderState;
    format: FeedFormat | null;
    item: XmlNode[] | null;
    title: string;
    inTitle: boolean;
  } = {
    state: "ROOT",
    format: null,
    item: null,
    title: "",
    inTitle: false,
  };

  const stack: XmlNode[] = [];
  const items: XmlNode[][] = [];

  const openField = (token: XmlOpenToken): void => {
    if (!ctx.item) {
      throw new FeedParserError("INCOMPLETE_ITEM", "No active feed item.");
    }

    const field: XmlNode = {
      name: token.name,
      attrs: token.attrs,
      text: "",
      children: [],
    };

    // Preserve the original flat list and also connect nested child nodes.
    if (stack.length) stack[stack.length - 1].children.push(field);
    ctx.item.push(field);
    stack.push(field);
    ctx.state = "FIELD";
  };

  tokenize(xml, (token: XmlToken): void => {
    switch (ctx.state) {
      case "ROOT":
        if (token.type !== "open") return;
        ctx.format = FORMATS[token.name.toLowerCase()] ?? null;
        if (!ctx.format) {
          throw new FeedParserError(
            "UNSUPPORTED_FORMAT",
            "Unsupported feed format: <" + token.name + ">"
          );
        }
        ctx.state = "CHANNEL";
        return;

      case "CHANNEL":
        if (token.type === "open" && (token.name === "item" || token.name === "entry")) {
          ctx.item = [];
          ctx.state = "ITEM";
        } else if (token.type === "open" && token.name === "title" && !ctx.title) {
          ctx.inTitle = true;
        } else if (token.type === "close" && token.name === "title") {
          ctx.inTitle = false;
        } else if (ctx.inTitle && (token.type === "text" || token.type === "cdata")) {
          ctx.title += token.value;
        }
        return;

      case "ITEM":
        if (token.type === "open") {
          openField(token);
        } else if (token.type === "close") {
          if (ctx.item) items.push(ctx.item);
          ctx.item = null;
          ctx.state = "CHANNEL";
        }
        return;

      case "FIELD":
        if (token.type === "open") {
          openField(token);
        } else if (token.type === "close") {
          stack.pop();
          if (stack.length === 0) ctx.state = "ITEM";
        } else {
          const current = stack[stack.length - 1];
          if (current) current.text += token.value;
        }
        return;
    }
  });

  if (ctx.state === "ROOT" || !ctx.format) {
    throw new FeedParserError("NOT_XML_FEED", "This is not an XML feed.");
  }
  if (ctx.state !== "CHANNEL") {
    throw new FeedParserError("INCOMPLETE_ITEM", "Feed ended in the middle of an item.");
  }

  return { format: ctx.format, title: ctx.title.trim(), items };
}

// -------------------- Normalize every format to NewsItem --------------------

function text(item: XmlNode[], name: string): string {
  return (item.find((field: XmlNode) => field.name === name && field.text.trim())?.text ?? "").trim();
}

function strip(html: string): string {
  return decode(
    html.replace(/<\/(p|div|li)>|<br\s*\/?>/gi, "\n").replace(/<[^>]*>/g, "")
  )
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*/g, "\n\n")
    .trim();
}

function image(item: XmlNode[]): string {
  for (const field of item) {
    if ((field.name === "content" || field.name === "thumbnail") && field.attrs.url) {
      return field.attrs.url;
    }
  }

  const enc = item.find(
    (field: XmlNode) => field.name === "enclosure" && (field.attrs.type ?? "").startsWith("image")
  );
  if (enc) return enc.attrs.url ?? "";

  const html = text(item, "encoded") || text(item, "description") || text(item, "content") || text(item, "summary");
  const match = html.match(/<img[^>]+src=["']([^"']+)["']/i);
  return match ? match[1] : "";
}

export function normalize(item: XmlNode[], format: FeedFormat): NewsItem {
  const link = format === "atom"
    ? (
        item.find(
          (field: XmlNode) => field.name === "link" && (field.attrs.rel ?? "alternate") === "alternate"
        ) ?? item.find((field: XmlNode) => field.name === "link")
      )?.attrs.href ?? ""
    : text(item, "link");

  const title = strip(text(item, "title"));
  const date = text(item, "pubDate") || text(item, "published") || text(item, "updated") || text(item, "date");
  const body = text(item, "encoded") || text(item, "content") || text(item, "description") || text(item, "summary");

  return {
    guid: text(item, "guid") || text(item, "id") || link || title,
    title,
    link,
    date,
    ts: Date.parse(date) || 0,
    image: image(item),
    summary: strip(text(item, "description") || text(item, "summary")).slice(0, 160),
    body: strip(body),
    author: text(item, "creator") || text(item, "name") || text(item, "author"),
  };
}
