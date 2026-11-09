/*
  RSS / XML parser engine

  Pipeline: fetch -> parse -> detect format -> extract items -> normalize -> render
  The UI is driven by a small state machine: IDLE -> LOADING -> SUCCESS or ERROR
*/

const $ = (id) => document.getElementById(id);
const kids = (el) => Array.from(el.children);

/* ---------- XML parsing ---------- */

// Find a child by its name without the namespace prefix (media:content -> "content")
const getText = (el, name) => {
  const c = kids(el).find(n => n.localName === name);
  return c ? c.textContent.trim() : "";
};
const getAll = (el, name) => kids(el).filter(n => n.localName === name);

const stripHtml = (html) =>
  new DOMParser().parseFromString(html, "text/html").body.textContent.trim();

function parseXml(text) {
  const doc = new DOMParser().parseFromString(text, "application/xml");
  if (doc.querySelector("parsererror")) throw new Error("That URL did not return valid XML. Check that it is a feed link.");
  return doc;
}

/* ---------- Fetching ---------- */

// Browsers block most feeds because of CORS, so the request goes through a proxy.
// It tries the local proxy first, then falls back to public ones.
async function fetchFeed(url) {
  const proxies = [
    (u) => "http://localhost:3000/rss?url=" + encodeURIComponent(u),
    (u) => "https://corsproxy.io/?" + encodeURIComponent(u),
    (u) => "https://api.allorigins.win/raw?url=" + encodeURIComponent(u),
  ];
  let lastErr = "";
  for (const make of proxies) {
    try {
      const res = await fetch(make(url));
      if (!res.ok) throw new Error("status " + res.status);
      const text = await res.text();
      if (text.trim().startsWith("<")) return text;
      throw new Error("response was not XML");
    } catch (e) { lastErr = e.message; }
  }
  throw new Error("Could not fetch the feed. Make sure the local proxy is running. (" + lastErr + ")");
}

/* ---------- Format detection and extraction ---------- */

function detectFormat(doc) {
  switch (doc.documentElement.localName.toLowerCase()) {
    case "rss":  return "rss";    // RSS 2.0
    case "feed": return "atom";   // Atom
    case "rdf":  return "rss1";   // RSS 1.0
    default: throw new Error("Unsupported feed format.");
  }
}

function extractItems(doc, format) {
  switch (format) {
    case "rss":
    case "rss1": return Array.from(doc.getElementsByTagName("item"));
    case "atom": return Array.from(doc.getElementsByTagName("entry"));
  }
}

// Looks for an image in media tags, then enclosures, then inside the HTML body
function extractImage(item) {
  for (const m of [...getAll(item, "content"), ...getAll(item, "thumbnail")]) {
    const u = m.getAttribute("url");
    if (u) return u;
  }
  const enc = getAll(item, "enclosure").find(e => (e.getAttribute("type") || "").startsWith("image"));
  if (enc) return enc.getAttribute("url");

  const html = getText(item, "encoded") || getText(item, "description")
            || getText(item, "content") || getText(item, "summary");
  const m = html.match(/<img[^>]+src=["']([^"']+)["']/i);
  return m ? m[1] : "";
}

function extractLink(item, format) {
  if (format === "atom") {
    const links = getAll(item, "link");
    const alt = links.find(l => (l.getAttribute("rel") || "alternate") === "alternate");
    return (alt || links[0])?.getAttribute("href") || "";
  }
  return getText(item, "link");
}

// Turns any feed item into one common shape so the UI never cares about the format
function normalize(item, format) {
  const rawBody = getText(item, "encoded") || getText(item, "content")
               || getText(item, "description") || getText(item, "summary");
  return {
    title:   getText(item, "title"),
    link:    extractLink(item, format),
    image:   extractImage(item),
    summary: stripHtml(getText(item, "description") || getText(item, "summary")).slice(0, 160),
    body:    stripHtml(rawBody),
    date:    getText(item, "pubDate") || getText(item, "published")
          || getText(item, "updated") || getText(item, "date"),
    author:  getText(item, "creator") || getText(item, "author"),
  };
}

const fmtDate = (s) => {
  const d = new Date(s);
  return isNaN(d) ? s : d.toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" });
};

/* ---------- State machine ---------- */

const STATE = { IDLE: "IDLE", LOADING: "LOADING", SUCCESS: "SUCCESS", ERROR: "ERROR" };
let state = STATE.IDLE;
let articles = [];

function setState(next, payload) {
  state = next;
  document.body.dataset.state = next;
  document.querySelectorAll(".rail li")
    .forEach(li => li.classList.toggle("on", li.dataset.s === next));

  switch (state) {
    case STATE.IDLE:
      $("status").textContent = "Paste a feed URL and press Load feed.";
      $("fmt").hidden = true;
      break;
    case STATE.LOADING:
      $("status").textContent = "Fetching feed...";
      $("cards").innerHTML = "";
      $("fmt").hidden = true;
      $("loadBtn").disabled = true;
      break;
    case STATE.SUCCESS:
      $("status").textContent = `Loaded ${payload.length} articles.`;
      $("loadBtn").disabled = false;
      renderCards(payload);
      break;
    case STATE.ERROR:
      $("status").textContent = payload;
      $("loadBtn").disabled = false;
      break;
  }
}

async function loadFeed(url) {
  try {
    setState(STATE.LOADING);
    const text   = await fetchFeed(url);
    const doc    = parseXml(text);
    const format = detectFormat(doc);
    const items  = extractItems(doc, format);
    articles     = items.map(i => normalize(i, format));
    $("fmt").textContent = format.toUpperCase();
    $("fmt").hidden = false;
    console.log("Format:", format, articles);
    setState(STATE.SUCCESS, articles);
  } catch (err) {
    console.error(err);
    setState(STATE.ERROR, err.message);
  }
}

/* ---------- Cards and detail view ---------- */

function renderCards(list) {
  const box = $("cards");
  box.innerHTML = "";
  list.forEach((a, i) => {
    const card = document.createElement("article");
    card.className = "card";
    card.tabIndex = 0;

    if (a.image) {
      const img = document.createElement("img");
      img.src = a.image; img.loading = "lazy"; img.alt = "";
      img.onerror = () => img.remove();   // drop broken images
      card.appendChild(img);
    }
    const h = document.createElement("h3");    h.textContent = a.title;
    const p = document.createElement("p");     p.textContent = a.summary;
    const d = document.createElement("small"); d.textContent = fmtDate(a.date);
    card.append(h, p, d);

    const open = () => openModal(articles[i]);
    card.addEventListener("click", open);
    card.addEventListener("keydown", (e) => { if (e.key === "Enter") open(); });
    box.appendChild(card);
  });
}

function openModal(a) {
  $("mImg").src = a.image || "";
  $("mImg").style.display = a.image ? "block" : "none";
  $("mTitle").textContent = a.title;
  $("mMeta").textContent = [a.author, fmtDate(a.date)].filter(Boolean).join(" • ");
  $("mBody").textContent = a.body || a.summary;
  $("mLink").href = a.link;
  $("modal").classList.remove("hidden");
}
const closeModal = () => $("modal").classList.add("hidden");
$("closeModal").onclick = closeModal;
$("modal").onclick = (e) => { if (e.target.id === "modal") closeModal(); };
document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeModal(); });

/* ---------- Grid / list toggle ---------- */

document.querySelectorAll(".view button").forEach(b => {
  b.onclick = () => {
    $("cards").className = b.dataset.view;
    document.querySelectorAll(".view button").forEach(x => x.classList.toggle("on", x === b));
  };
});

/* ---------- Init ---------- */

$("loadBtn").onclick = () => {
  let url = $("feedUrl").value.trim();
  if (!url) return setState(STATE.ERROR, "Enter a feed URL first.");
  if (!/^https?:\/\//i.test(url)) url = "https://" + url;
  loadFeed(url);
};
$("feedUrl").addEventListener("keydown", (e) => { if (e.key === "Enter") $("loadBtn").click(); });

setState(STATE.IDLE);