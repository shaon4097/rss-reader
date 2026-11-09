/*
  Front end. It does no parsing at all: the server parses feeds with the
  FSM in parser.js and stores them in SQLite. This page only reads the
  feed list and the saved articles from the API and draws them.

  Page state machine: IDLE -> LOADING -> SUCCESS or ERROR
*/

const $ = (id) => document.getElementById(id);
const STATE = { IDLE: "IDLE", LOADING: "LOADING", SUCCESS: "SUCCESS", ERROR: "ERROR" };
let feeds = [], articles = [], current = null;

const fmtDate = (s) => {
  const d = new Date(s);
  return !s || isNaN(d) ? s || "" : d.toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" });
};

async function api(path, opts) {
  const res = await fetch(path, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "Request failed (" + res.status + ")");
  return data;
}

/* ---------- state machine ---------- */

function setState(next, payload) {
  document.body.dataset.state = next;
  document.querySelectorAll(".rail li").forEach(li => li.classList.toggle("on", li.dataset.s === next));

  switch (next) {
    case STATE.IDLE:
      $("status").textContent = "Pick a feed from the list.";
      $("fmt").hidden = true;
      break;
    case STATE.LOADING:
      $("status").textContent = "Loading...";
      $("cards").innerHTML = "";
      $("fmt").hidden = true;
      $("refreshBtn").disabled = true;
      break;
    case STATE.SUCCESS:
      $("status").textContent = `${payload.articles.length} articles, last updated ${fmtDate(payload.updated_at)}`;
      $("fmt").textContent = (payload.format || "").toUpperCase();
      $("fmt").hidden = !payload.format;
      $("refreshBtn").disabled = false;
      renderCards(payload.articles);
      break;
    case STATE.ERROR:
      $("status").textContent = payload;
      $("refreshBtn").disabled = !current;
      break;
  }
}

/* ---------- feed list and selection ---------- */

function renderFeedList() {
  const ul = $("feedList");
  ul.innerHTML = "";
  feeds.forEach(f => {
    const li = document.createElement("li");
    const b = document.createElement("button");
    b.textContent = f.name;
    b.className = f.id === current ? "on" : "";
    b.onclick = () => selectFeed(f.id);
    li.appendChild(b);
    if (f.source === "user") {                 // feeds added by the user can be removed
      const x = document.createElement("span");
      x.textContent = "✕"; x.title = "Remove this feed"; x.className = "rm";
      x.onclick = () => removeFeed(f.id);
      li.appendChild(x);
    }
    ul.appendChild(li);
  });
}

async function selectFeed(id, refresh = false) {
  current = id;
  try { localStorage.setItem("feed", id); } catch {}   // remember it across reloads
  renderFeedList();
  try {
    setState(STATE.LOADING);
    if (refresh) await api(`/api/feeds/${id}/refresh`, { method: "POST" });
    const data = await api(`/api/feeds/${id}/articles`);   // read from SQLite
    articles = data.articles;
    setState(STATE.SUCCESS, data);
  } catch (err) {
    setState(STATE.ERROR, err.message);
  }
}

/* ---------- cards and detail view ---------- */

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
      img.onerror = () => img.remove();
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

document.querySelectorAll(".view button").forEach(b => {
  b.onclick = () => {
    $("cards").className = b.dataset.view;
    document.querySelectorAll(".view button").forEach(x => x.classList.toggle("on", x === b));
  };
});

/* ---------- add / remove feeds ---------- */

async function addFeed() {
  let url = $("feedUrl").value.trim();
  if (!url) return setState(STATE.ERROR, "Enter a feed URL first.");
  if (!/^https?:\/\//i.test(url)) url = "https://" + url;
  $("addBtn").disabled = true;
  try {
    setState(STATE.LOADING);
    // the server downloads it, parses it with the FSM and saves it in SQLite
    const { id } = await api("/api/feeds", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url }),
    });
    $("feedUrl").value = "";
    feeds = await api("/api/feeds");
    await selectFeed(id);
  } catch (err) {
    setState(STATE.ERROR, err.message);
  } finally {
    $("addBtn").disabled = false;
  }
}

async function removeFeed(id) {
  if (!confirm("Remove this feed and its saved articles?")) return;
  try {
    await api(`/api/feeds/${id}`, { method: "DELETE" });
    feeds = await api("/api/feeds");
    current = null;
    renderFeedList();
    if (feeds.length) selectFeed(feeds[0].id); else { $("cards").innerHTML = ""; setState(STATE.IDLE); }
  } catch (err) { setState(STATE.ERROR, err.message); }
}

/* ---------- init ---------- */

$("addBtn").onclick = addFeed;
$("feedUrl").addEventListener("keydown", (e) => { if (e.key === "Enter") addFeed(); });
$("refreshBtn").onclick = () => current && selectFeed(current, true);

(async function init() {
  setState(STATE.IDLE);
  try {
    feeds = await api("/api/feeds");
    let saved = null;
    try { saved = localStorage.getItem("feed"); } catch {}
    const start = feeds.find(f => f.id === saved) || feeds[0];
    renderFeedList();
    if (start) selectFeed(start.id);
  } catch (err) {
    setState(STATE.ERROR, err.message);
  }
})();