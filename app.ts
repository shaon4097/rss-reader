/*
  Front end. It does no parsing at all: the server parses feeds with the
  FSM in parser.ts and stores them in SQLite. This page only reads the
  feed list and the saved articles from the API and draws them.

  Page state machine: IDLE -> LOADING -> SUCCESS or ERROR
*/

// ---------- Shared types and interfaces ----------

type FeedFormat = "rss" | "atom" | "rss1";

interface Feed {
  id: string;
  name: string;
  source: "default" | "user";
  format: FeedFormat | null;
  updated_at: string | null;
  count: number;
}

interface Article {
  title: string;
  link: string;
  image: string;
  summary: string;
  body: string;
  date: string;
  author: string;
}

type PageState = "IDLE" | "LOADING" | "SUCCESS" | "ERROR";

interface FeedArticlesResponse {
  format: FeedFormat | null;
  updated_at: string | null;
  articles: Article[];
}

interface AddFeedResponse {
  id: string;
}

interface DeleteFeedResponse {
  ok: true;
}

interface ApiErrorResponse {
  error: string;
  code?: string; // Typed backend code (e.g. INVALID_XML or FETCH_TIMEOUT)
}

// ---------- Helpers and state ----------

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Element #${id} not found`);
  return element as T;
};

const STATE = {
  IDLE: "IDLE",
  LOADING: "LOADING",
  SUCCESS: "SUCCESS",
  ERROR: "ERROR",
} as const;

let feeds: Feed[] = [];
let articles: Article[] = [];
let current: string | null = null;
let selectionVersion = 0;

const fmtDate = (s: string | null | undefined): string => {
  if (!s) return "";
  const d = new Date(s);
  return Number.isNaN(d.getTime())
    ? s
    : d.toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" });
};

function isApiErrorResponse(data: unknown): data is ApiErrorResponse {
  return (
    typeof data === "object" &&
    data !== null &&
    "error" in data &&
    typeof data.error === "string"
  );
}

type Guard<T> = (value: unknown) => value is T;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const isFeedFormat = (value: unknown): value is FeedFormat =>
  value === "rss" || value === "atom" || value === "rss1";

function isFeed(value: unknown): value is Feed {
  return isObject(value) && typeof value.id === "string"
    && typeof value.name === "string"
    && (value.source === "default" || value.source === "user")
    && (value.format === null || isFeedFormat(value.format))
    && (value.updated_at === null || typeof value.updated_at === "string")
    && typeof value.count === "number";
}

function isFeedList(value: unknown): value is Feed[] {
  return Array.isArray(value) && value.every(isFeed);
}

function isArticle(value: unknown): value is Article {
  return isObject(value)
    && ["title", "link", "image", "summary", "body", "date", "author"]
      .every((field) => typeof value[field] === "string");
}

function isFeedArticlesResponse(value: unknown): value is FeedArticlesResponse {
  return isObject(value)
    && (value.format === null || isFeedFormat(value.format))
    && (value.updated_at === null || typeof value.updated_at === "string")
    && Array.isArray(value.articles)
    && value.articles.every(isArticle);
}

function isAddFeedResponse(value: unknown): value is AddFeedResponse {
  return isObject(value) && typeof value.id === "string";
}

function isDeleteFeedResponse(value: unknown): value is DeleteFeedResponse {
  return isObject(value) && value.ok === true;
}

const API = location.port === "3000" ? "" : "http://localhost:3000";

async function api<T>(
  path: string,
  opts: RequestInit | undefined,
  guard: Guard<T>
): Promise<T> {
  let res: Response;
  try {
    res = await fetch(API + path, opts);
  } catch {
    throw new Error("Cannot reach the server on port 3000. Open cmd and run: pm2 resurrect");
  }
  const data: unknown = await res.json().catch(() => ({}));

  if (!res.ok) {
    const message = isApiErrorResponse(data)
      ? data.error
      : `Request failed (${res.status})`;
    throw new Error(message);
  }

  if (!guard(data)) {
    throw new Error(`Invalid response format from ${path}`);
  }
  return data;
}

/* ---------- state machine ---------- */

function setState(next: "IDLE" | "LOADING"): void;
function setState(next: "SUCCESS", payload: FeedArticlesResponse): void;
function setState(next: "ERROR", payload: string): void;
function setState(next: PageState, payload?: FeedArticlesResponse | string): void {
  document.body.dataset.state = next;
  document.querySelectorAll<HTMLLIElement>(".rail li").forEach(li =>
    li.classList.toggle("on", li.dataset.s === next)
  );

  switch (next) {
    case STATE.IDLE:
      $("status").textContent = "Pick a feed from the list.";
      $("fmt").hidden = true;
      break;

    case STATE.LOADING:
      $("status").textContent = "Loading...";
      $("cards").innerHTML = "";
      $("fmt").hidden = true;
      $<HTMLButtonElement>("refreshBtn").disabled = true;
      break;

    case STATE.SUCCESS:
      if (!payload || typeof payload === "string") {
        throw new Error("SUCCESS state requires feed articles");
      }
      $("status").textContent = `${payload.articles.length} articles, last updated ${fmtDate(payload.updated_at)}`;
      $("fmt").textContent = (payload.format || "").toUpperCase();
      $("fmt").hidden = !payload.format;
      $<HTMLButtonElement>("refreshBtn").disabled = false;
      renderCards(payload.articles);
      break;

    case STATE.ERROR:
      $("status").textContent = typeof payload === "string" ? payload : "Unknown error";
      $<HTMLButtonElement>("refreshBtn").disabled = !current;
      break;
  }
}

/* ---------- feed list and selection ---------- */

function renderFeedList(): void {
  const ul = $<HTMLUListElement>("feedList");
  ul.innerHTML = "";

  feeds.forEach((f: Feed) => {
    const li = document.createElement("li");
    const b = document.createElement("button");
    b.textContent = f.name;
    b.className = f.id === current ? "on" : "";
    b.onclick = () => { void selectFeed(f.id); };
    li.appendChild(b);

    if (f.source === "user") { // feeds added by the user can be removed
      const x = document.createElement("span");
      x.textContent = "✕";
      x.title = "Remove this feed";
      x.className = "rm";
      x.onclick = () => { void removeFeed(f.id); };
      li.appendChild(x);
    }
    ul.appendChild(li);
  });
}

async function selectFeed(id: string, refresh = false): Promise<void> {
  current = id;
  const version = ++selectionVersion;
  try { localStorage.setItem("feed", id); } catch {} // remember it across reloads
  renderFeedList();

  try {
    setState(STATE.LOADING);
    if (refresh) {
      await api(`/api/feeds/${id}/refresh`, { method: "POST" }, isFeedArticlesResponse);
    }
    const data = await api(`/api/feeds/${id}/articles`, undefined, isFeedArticlesResponse); // read from SQLite
    if (version !== selectionVersion) return;
    articles = data.articles;
    setState(STATE.SUCCESS, data);
  } catch (err: unknown) {
    if (version === selectionVersion) setState(STATE.ERROR, errorMessage(err));
  }
}

/* ---------- cards and detail view ---------- */

function renderCards(list: Article[]): void {
  const box = $("cards");
  box.innerHTML = "";

  list.forEach((a: Article) => {
    const card = document.createElement("article");
    card.className = "card";
    card.tabIndex = 0;

    if (a.image) {
      const img = document.createElement("img");
      img.src = a.image;
      img.loading = "lazy";
      img.alt = "";
      img.onerror = () => img.remove();
      card.appendChild(img);
    }
    const h = document.createElement("h3"); h.textContent = a.title;
    const p = document.createElement("p"); p.textContent = a.summary;
    const d = document.createElement("small"); d.textContent = fmtDate(a.date);
    card.append(h, p, d);

    const open = (): void => openModal(a);
    card.addEventListener("click", open);
    card.addEventListener("keydown", (e: KeyboardEvent) => {
      if (e.key === "Enter") open();
    });
    box.appendChild(card);
  });
}

function openModal(a: Article): void {
  const img = $<HTMLImageElement>("mImg");
  img.src = a.image || "";
  img.style.display = a.image ? "block" : "none";
  $("mTitle").textContent = a.title;
  $("mMeta").textContent = [a.author, fmtDate(a.date)].filter(Boolean).join(" • ");
  $("mBody").textContent = a.body || a.summary;
  $<HTMLAnchorElement>("mLink").href = a.link;
  $("modal").classList.remove("hidden");
}

const closeModal = (): void => { $("modal").classList.add("hidden"); };
$<HTMLButtonElement>("closeModal").onclick = closeModal;
$("modal").onclick = (e: MouseEvent): void => {
  if (e.target instanceof HTMLElement && e.target.id === "modal") closeModal();
};
document.addEventListener("keydown", (e: KeyboardEvent) => {
  if (e.key === "Escape") closeModal();
});

document.querySelectorAll<HTMLButtonElement>(".view button").forEach(b => {
  b.onclick = () => {
    $("cards").className = b.dataset.view ?? "grid";
    document.querySelectorAll<HTMLButtonElement>(".view button").forEach(x =>
      x.classList.toggle("on", x === b)
    );
  };
});

/* ---------- add / remove feeds ---------- */

async function addFeed(): Promise<void> {
  let url = $<HTMLInputElement>("feedUrl").value.trim();
  if (!url) return setState(STATE.ERROR, "Enter a feed URL first.");
  if (!/^https?:\/\//i.test(url)) url = "https://" + url;
  try { localStorage.setItem("lastFeedUrl", url); } catch {}
  $<HTMLButtonElement>("addBtn").disabled = true;

  try {
    setState(STATE.LOADING);
    // the server downloads it, parses it with the FSM and saves it in SQLite
    const { id } = await api("/api/feeds", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url }),
    }, isAddFeedResponse);
    $<HTMLInputElement>("feedUrl").value = "";
    feeds = await api("/api/feeds", undefined, isFeedList);
    await selectFeed(id);
  } catch (err: unknown) {
    setState(STATE.ERROR, errorMessage(err));
  } finally {
    $<HTMLButtonElement>("addBtn").disabled = false;
  }
}

async function removeFeed(id: string): Promise<void> {
  if (!confirm("Remove this feed and its saved articles?")) return;
  try {
    await api(`/api/feeds/${id}`, { method: "DELETE" }, isDeleteFeedResponse);
    feeds = await api("/api/feeds", undefined, isFeedList);
    current = null;
    ++selectionVersion;
    renderFeedList();
    if (feeds.length) {
      await selectFeed(feeds[0].id);
    } else {
      $("cards").innerHTML = "";
      setState(STATE.IDLE);
    }
  } catch (err: unknown) {
    setState(STATE.ERROR, errorMessage(err));
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/* ---------- init ---------- */

$<HTMLButtonElement>("addBtn").onclick = () => { void addFeed(); };
$<HTMLInputElement>("feedUrl").addEventListener("keydown", (e: KeyboardEvent) => {
  if (e.key === "Enter") void addFeed();
});
$<HTMLButtonElement>("refreshBtn").onclick = () => {
  if (current) void selectFeed(current, true);
};

void (async function init(): Promise<void> {
  setState(STATE.IDLE);
  try {
    const savedUrl = localStorage.getItem("lastFeedUrl");
    if (savedUrl) $<HTMLInputElement>("feedUrl").value = savedUrl;
  } catch {}
  try {
    feeds = await api("/api/feeds", undefined, isFeedList);
    let saved: string | null = null;
    try { saved = localStorage.getItem("feed"); } catch {}
    const start = feeds.find((f: Feed) => f.id === saved) || feeds[0];
    renderFeedList();
    if (start) await selectFeed(start.id);
  } catch (err: unknown) {
    setState(STATE.ERROR, errorMessage(err));
  }
})();
