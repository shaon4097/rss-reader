"use strict";
/*
  Front end. It does no parsing at all: the server parses feeds with the
  FSM in parser.ts and stores them in SQLite. This page only reads the
  feed list and the saved articles from the API and draws them.

  Page state machine: IDLE -> LOADING -> SUCCESS or ERROR
*/
// ---------- Helpers and state ----------
const $ = (id) => {
    const element = document.getElementById(id);
    if (!element)
        throw new Error(`Element #${id} not found`);
    return element;
};
const STATE = {
    IDLE: "IDLE",
    LOADING: "LOADING",
    SUCCESS: "SUCCESS",
    ERROR: "ERROR",
};
let feeds = [];
let articles = [];
let current = null;
let selectionVersion = 0;
const fmtDate = (s) => {
    if (!s)
        return "";
    const d = new Date(s);
    return Number.isNaN(d.getTime())
        ? s
        : d.toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" });
};
function isApiErrorResponse(data) {
    return (typeof data === "object" &&
        data !== null &&
        "error" in data &&
        typeof data.error === "string");
}
function isObject(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
const isFeedFormat = (value) => value === "rss" || value === "atom" || value === "rss1";
function isFeed(value) {
    return isObject(value) && typeof value.id === "string"
        && typeof value.name === "string"
        && (value.source === "default" || value.source === "user")
        && (value.format === null || isFeedFormat(value.format))
        && (value.updated_at === null || typeof value.updated_at === "string")
        && typeof value.count === "number";
}
function isFeedList(value) {
    return Array.isArray(value) && value.every(isFeed);
}
function isArticle(value) {
    return isObject(value)
        && ["title", "link", "image", "summary", "body", "date", "author"]
            .every((field) => typeof value[field] === "string");
}
function isFeedArticlesResponse(value) {
    return isObject(value)
        && (value.format === null || isFeedFormat(value.format))
        && (value.updated_at === null || typeof value.updated_at === "string")
        && Array.isArray(value.articles)
        && value.articles.every(isArticle);
}
function isAddFeedResponse(value) {
    return isObject(value) && typeof value.id === "string";
}
function isDeleteFeedResponse(value) {
    return isObject(value) && value.ok === true;
}
const API = location.port === "3000" ? "" : "http://localhost:3000";
async function api(path, opts, guard) {
    let res;
    try {
        res = await fetch(API + path, opts);
    }
    catch {
        throw new Error("Cannot reach the server on port 3000. Open cmd and run: pm2 resurrect");
    }
    const data = await res.json().catch(() => ({}));
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
            if (!payload || typeof payload === "string") {
                throw new Error("SUCCESS state requires feed articles");
            }
            $("status").textContent = `${payload.articles.length} articles, last updated ${fmtDate(payload.updated_at)}`;
            $("fmt").textContent = (payload.format || "").toUpperCase();
            $("fmt").hidden = !payload.format;
            $("refreshBtn").disabled = false;
            renderCards(payload.articles);
            break;
        case STATE.ERROR:
            $("status").textContent = typeof payload === "string" ? payload : "Unknown error";
            $("refreshBtn").disabled = !current;
            break;
    }
}
/* ---------- feed list and selection ---------- */
function renderFeedList() {
    const ul = $("feedList");
    ul.innerHTML = "";
    feeds.forEach((f) => {
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
async function selectFeed(id, refresh = false) {
    current = id;
    const version = ++selectionVersion;
    try {
        localStorage.setItem("feed", id);
    }
    catch { } // remember it across reloads
    renderFeedList();
    try {
        setState(STATE.LOADING);
        if (refresh) {
            await api(`/api/feeds/${id}/refresh`, { method: "POST" }, isFeedArticlesResponse);
        }
        const data = await api(`/api/feeds/${id}/articles`, undefined, isFeedArticlesResponse); // read from SQLite
        if (version !== selectionVersion)
            return;
        articles = data.articles;
        setState(STATE.SUCCESS, data);
    }
    catch (err) {
        if (version === selectionVersion)
            setState(STATE.ERROR, errorMessage(err));
    }
}
/* ---------- cards and detail view ---------- */
function renderCards(list) {
    const box = $("cards");
    box.innerHTML = "";
    list.forEach((a) => {
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
        const h = document.createElement("h3");
        h.textContent = a.title;
        const p = document.createElement("p");
        p.textContent = a.summary;
        const d = document.createElement("small");
        d.textContent = fmtDate(a.date);
        card.append(h, p, d);
        const open = () => openModal(a);
        card.addEventListener("click", open);
        card.addEventListener("keydown", (e) => {
            if (e.key === "Enter")
                open();
        });
        box.appendChild(card);
    });
}
function openModal(a) {
    const img = $("mImg");
    img.src = a.image || "";
    img.style.display = a.image ? "block" : "none";
    $("mTitle").textContent = a.title;
    $("mMeta").textContent = [a.author, fmtDate(a.date)].filter(Boolean).join(" • ");
    $("mBody").textContent = a.body || a.summary;
    $("mLink").href = a.link;
    $("modal").classList.remove("hidden");
}
const closeModal = () => { $("modal").classList.add("hidden"); };
$("closeModal").onclick = closeModal;
$("modal").onclick = (e) => {
    if (e.target instanceof HTMLElement && e.target.id === "modal")
        closeModal();
};
document.addEventListener("keydown", (e) => {
    if (e.key === "Escape")
        closeModal();
});
document.querySelectorAll(".view button").forEach(b => {
    b.onclick = () => {
        $("cards").className = b.dataset.view ?? "grid";
        document.querySelectorAll(".view button").forEach(x => x.classList.toggle("on", x === b));
    };
});
/* ---------- add / remove feeds ---------- */
async function addFeed() {
    let url = $("feedUrl").value.trim();
    if (!url)
        return setState(STATE.ERROR, "Enter a feed URL first.");
    if (!/^https?:\/\//i.test(url))
        url = "https://" + url;
    try {
        localStorage.setItem("lastFeedUrl", url);
    }
    catch { }
    $("addBtn").disabled = true;
    try {
        setState(STATE.LOADING);
        // the server downloads it, parses it with the FSM and saves it in SQLite
        const { id } = await api("/api/feeds", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ url }),
        }, isAddFeedResponse);
        $("feedUrl").value = "";
        feeds = await api("/api/feeds", undefined, isFeedList);
        await selectFeed(id);
    }
    catch (err) {
        setState(STATE.ERROR, errorMessage(err));
    }
    finally {
        $("addBtn").disabled = false;
    }
}
async function removeFeed(id) {
    if (!confirm("Remove this feed and its saved articles?"))
        return;
    try {
        await api(`/api/feeds/${id}`, { method: "DELETE" }, isDeleteFeedResponse);
        feeds = await api("/api/feeds", undefined, isFeedList);
        current = null;
        ++selectionVersion;
        renderFeedList();
        if (feeds.length) {
            await selectFeed(feeds[0].id);
        }
        else {
            $("cards").innerHTML = "";
            setState(STATE.IDLE);
        }
    }
    catch (err) {
        setState(STATE.ERROR, errorMessage(err));
    }
}
function errorMessage(err) {
    return err instanceof Error ? err.message : String(err);
}
/* ---------- init ---------- */
$("addBtn").onclick = () => { void addFeed(); };
$("feedUrl").addEventListener("keydown", (e) => {
    if (e.key === "Enter")
        void addFeed();
});
$("refreshBtn").onclick = () => {
    if (current)
        void selectFeed(current, true);
};
void (async function init() {
    setState(STATE.IDLE);
    try {
        const savedUrl = localStorage.getItem("lastFeedUrl");
        if (savedUrl)
            $("feedUrl").value = savedUrl;
    }
    catch { }
    try {
        feeds = await api("/api/feeds", undefined, isFeedList);
        let saved = null;
        try {
            saved = localStorage.getItem("feed");
        }
        catch { }
        const start = feeds.find((f) => f.id === saved) || feeds[0];
        renderFeedList();
        if (start)
            await selectFeed(start.id);
    }
    catch (err) {
        setState(STATE.ERROR, errorMessage(err));
    }
})();
