const BUILTINS = new Set(["DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL"]);
const MAX_DOM = 2000;
const TRIM_TO = 1500;

let selectedLevels = new Set();
let paused = false;
let allLogs = [];
let customLevels = [];
let modalJson = null;
let reconnectTimer = null;
let es = null;

let pendingLogs = [];
let atBottom = true;
let domRowCount = 0;

let statWarn = 0,
  statErr = 0,
  statCrit = 0;

let openParsePanels = new Set();

let searchQuery = "";

let totalReceived = 0;

let maxLogs = 1000;

function trimToMax(arr) {
  if (arr.length > maxLogs) arr.splice(0, arr.length - maxLogs);
}

function normQ(q) {
  return q.toLowerCase().replace(/\s+/g, " ").trim();
}
function matchesSearch(msg, q) {
  return !q || msg.toLowerCase().includes(q);
}
function highlightMsg(msg, q) {
  if (!q) return esc(msg);
  const lo = msg.toLowerCase();
  let html = "",
    cur = 0,
    pos;
  while ((pos = lo.indexOf(q, cur)) !== -1) {
    html += esc(msg.slice(cur, pos));
    html += `<mark class="hl">${esc(msg.slice(pos, pos + q.length))}</mark>`;
    cur = pos + q.length;
  }
  return html + esc(msg.slice(cur));
}

function onSearchInput() {
  const raw = document.getElementById("searchInp").value;
  searchQuery = normQ(raw);
  document
    .getElementById("searchClear")
    .classList.toggle("visible", raw.length > 0);
  document
    .getElementById("searchKbd")
    .classList.toggle("hidden", raw.length > 0);

  flushAndRebuild();
}
function onSearchKey(e) {
  if (e.key === "Escape") clearSearch();
}
function clearSearch() {
  document.getElementById("searchInp").value = "";
  document.getElementById("searchClear").classList.remove("visible");
  document.getElementById("searchKbd").classList.remove("hidden");
  searchQuery = "";
  flushAndRebuild();
}

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    if (document.getElementById("modalOverlay").classList.contains("open"))
      closeModalDirect();
    else clearSearch();
    return;
  }
  const tag = document.activeElement.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA") return;
  if (e.key === "/" || (e.ctrlKey && e.key === "f")) {
    e.preventDefault();
    document.getElementById("searchInp").focus();
    document.getElementById("searchInp").select();
  }
});

const ck = {
  set(k, v) {
    const d = new Date();
    d.setTime(d.getTime() + 365 * 86400000);
    document.cookie = `${k}=${encodeURIComponent(JSON.stringify(v))};expires=${d.toUTCString()};path=/`;
  },
  get(k) {
    const m = document.cookie.match(new RegExp("(?:^|; )" + k + "=([^;]*)"));
    try {
      return m ? JSON.parse(decodeURIComponent(m[1])) : null;
    } catch {
      return null;
    }
  },
};

function toggleChip(btn) {
  const lvl = btn.dataset.lvl;
  selectedLevels.has(lvl)
    ? selectedLevels.delete(lvl)
    : selectedLevels.add(lvl);
  btn.classList.toggle("on", selectedLevels.has(lvl));
  syncToolbarState();
  updateFilterLabel();
  saveSelectedLevels();
  flushAndRebuild();
}
function filterByCLevel(t) {
  selectedLevels.has(t) ? selectedLevels.delete(t) : selectedLevels.add(t);
  syncToolbarState();
  updateFilterLabel();
  renderCLevels();
  flushAndRebuild();
}
function clearCLFilter() {
  selectedLevels.clear();
  document
    .querySelectorAll(".chip[data-lvl]")
    .forEach((b) => b.classList.remove("on"));
  syncToolbarState();
  updateFilterLabel();
  renderCLevels();
  flushAndRebuild();
}
function syncToolbarState() {
  document
    .querySelector(".toolbar")
    .classList.toggle("has-filter", selectedLevels.size > 0);
}
function updateFilterLabel() {
  const el = document.getElementById("activeCLLabel");
  if (!selectedLevels.size) {
    el.textContent = "ALL";
    return;
  }
  const ordered = [
    ...[...BUILTINS].filter((l) => selectedLevels.has(l)),
    ...customLevels.filter((l) => selectedLevels.has(l)),
  ];
  el.textContent =
    ordered.length <= 3
      ? ordered.join(" · ")
      : ordered.slice(0, 3).join(" · ") + ` +${ordered.length - 3}`;
}
function updateCLLabel() {
  updateFilterLabel();
}
function saveSelectedLevels() {
  ck.set("sw_sel_levels", [...selectedLevels]);
}
function loadLevels() {
  document
    .querySelectorAll(".chip[data-lvl]")
    .forEach((b) => b.classList.remove("on"));
  const saved = ck.get("sw_sel_levels");
  if (saved && Array.isArray(saved))
    saved.forEach((l) => selectedLevels.add(l));
  document
    .querySelectorAll(".chip[data-lvl]")
    .forEach((b) =>
      b.classList.toggle("on", selectedLevels.has(b.dataset.lvl)),
    );
  syncToolbarState();
  updateFilterLabel();
}

function loadCLevels() {
  customLevels = ck.get("sw_clevels") || [];
  renderCLevels();
}
function saveCLevels() {
  ck.set("sw_clevels", customLevels);
}
function addCLevel() {
  const inp = document.getElementById("clevelInp");
  const val = inp.value.trim().toUpperCase();
  if (!val || customLevels.includes(val) || BUILTINS.has(val)) return;
  customLevels.push(val);
  saveCLevels();
  renderCLevels();
  inp.value = "";
}
function removeCLevel(t) {
  customLevels = customLevels.filter((x) => x !== t);
  if (selectedLevels.has(t)) {
    selectedLevels.delete(t);
    syncToolbarState();
    updateFilterLabel();
    saveSelectedLevels();
  }
  saveCLevels();
  renderCLevels();
  flushAndRebuild();
}
function renderCLevels() {
  document.getElementById("clevelList").innerHTML = customLevels
    .map(
      (t) => `
    <span class="clevel${selectedLevels.has(t) ? " on" : ""}" onclick="filterByCLevel('${t}')">
      ${t}<span class="clevel-x" onclick="event.stopPropagation();removeCLevel('${t}')">✕</span>
    </span>`,
    )
    .join("");
}

function togglePause() {
  paused = !paused;
  const btn = document.getElementById("pauseBtn");
  const dot = document.getElementById("liveDot");
  if (paused) {
    btn.textContent = "RESUME";
    btn.classList.add("active");
    dot.classList.add("paused");
    document.getElementById("statusTxt").textContent = "PAUSED";
    clearTimeout(reconnectTimer);
  } else {
    btn.textContent = "PAUSE";
    btn.classList.remove("active");
    dot.classList.remove("paused");
    document.getElementById("statusTxt").textContent = "LIVE";
    connectSSE();
  }
}

function pyToJson(s) {
  try {
    let j = s
      .replace(/:\s*True\b/g, ": true")
      .replace(/:\s*False\b/g, ": false")
      .replace(/:\s*None\b/g, ": null")
      .replace(/,\s*}/g, "}")
      .replace(/,\s*]/g, "]");
    let out = "",
      i = 0;
    while (i < j.length) {
      const ch = j[i];

      // NEW: pass through already-valid double-quoted strings untouched
      if (ch === '"') {
        out += ch;
        i++;
        while (i < j.length) {
          const c = j[i];
          out += c;
          i++;
          if (c === "\\") {
            if (i < j.length) {
              out += j[i];
              i++;
            }
            continue;
          }
          if (c === '"') break; // end of double-quoted string
        }
        continue;
      }

      if (ch === "'") {
        let str = '"';
        i++;
        while (i < j.length) {
          const c = j[i];
          if (c === "\\" && j[i + 1] === "'") {
            str += "'";
            i += 2;
            continue;
          }
          if (c === '"') {
            str += '\\"';
            i++;
            continue;
          }
          if (c === "'") {
            i++;
            break;
          }
          str += c;
          i++;
        }
        out += str + '"';
      } else {
        out += ch;
        i++;
      }
    }
    return out;
  } catch {
    return null;
  }
}

function extractOneJSON(msg, fromIdx = 0) {
  const sub = msg.slice(fromIdx);
  const rel = sub.search(/[{\[]/);
  if (rel === -1) return null;
  const start = fromIdx + rel;
  const open = msg[start],
    close = open === "{" ? "}" : "]";
  let depth = 0,
    inStr = false,
    strChar = "",
    end = -1;
  for (let i = start; i < msg.length; i++) {
    const c = msg[i];
    if (inStr) {
      if (c === "\\") {
        i++;
        continue;
      }
      if (c === strChar) inStr = false;
    } else {
      if (c === '"' || c === "'") {
        inStr = true;
        strChar = c;
        continue;
      }
      if (c === open) depth++;
      if (c === close) {
        depth--;
        if (depth === 0) {
          end = i + 1;
          break;
        }
      }
    }
  }
  if (end === -1) return null; // unbalanced — truly nothing usable

  const raw = msg.slice(start, end);
  let parsed = null;
  try {
    parsed = JSON.parse(raw);
  } catch {}
  if (!parsed) {
    try {
      parsed = JSON.parse(pyToJson(raw));
    } catch {}
  }
  // Always return start+end so caller can skip past the whole block
  return { parsed, start, end };
}

function extractAllJSON(msg) {
  const blocks = [];
  let cursor = 0;
  while (cursor < msg.length) {
    const b = extractOneJSON(msg, cursor);
    if (!b) break; // no { or [ found at all
    if (b.parsed !== null && typeof b.parsed === "object") {
      blocks.push(b); // only keep successful parses
    }
    cursor = b.end; // ALWAYS skip past the whole block
  }
  return blocks;
}
function jLeaf(data) {
  if (data === null) return `<span class="jnull">null</span>`;
  if (typeof data === "boolean") return `<span class="jbool">${data}</span>`;
  if (typeof data === "number") return `<span class="jnum">${data}</span>`;
  if (typeof data === "string")
    return `<span class="jstr">"${esc(data)}"</span>`;
  return null;
}
function jPreview(data) {
  if (Array.isArray(data))
    return `<span class="jpunc">[</span><span class="jpreview">${data.length} items</span><span class="jpunc">]</span>`;
  return `<span class="jpunc">{</span><span class="jpreview">${Object.keys(data).length} keys</span><span class="jpunc">}</span>`;
}
function jTree(data, prefix, depth = 0) {
  if (depth > 20) return `<span class="jpunc">[…]</span>`;
  const leaf = jLeaf(data);
  if (leaf !== null) return leaf;
  const id = prefix + "d" + depth + "_" + ((Math.random() * 1e9) | 0);
  const isArr = Array.isArray(data);
  const entries = isArr ? data.map((v, i) => [i, v]) : Object.entries(data);
  const rows = entries
    .map(([k, v], i) => {
      const comma =
        i < entries.length - 1 ? `<span class="jpunc">,</span>` : "";
      const keyHtml = isArr
        ? ""
        : `<span class="jkey">"${esc(String(k))}"</span><span class="jpunc">: </span>`;
      const childLeaf = jLeaf(v);
      if (childLeaf !== null)
        return `<div class="jnode"><div class="jrow"><span class="jtoggle spacer"></span>${keyHtml}${childLeaf}${comma}</div></div>`;
      const cid =
        prefix + "c" + i + "d" + depth + "_" + ((Math.random() * 1e9) | 0);
      return `<div class="jnode"><div class="jrow"><span class="jtoggle" onclick="jtog('${cid}',this)">▸</span>${keyHtml}${jPreview(v)}${comma}</div><div class="jchildren" id="${cid}">${jTree(v, prefix + "_" + i, depth + 1)}</div></div>`;
    })
    .join("");
  const oB = isArr ? "[" : "{",
    cB = isArr ? "]" : "}";
  const preview = isArr
    ? `${data.length} items`
    : `${Object.keys(data).length} keys`;
  return `<div class="jrow"><span class="jtoggle" onclick="jtog('${id}',this)">▸</span><span class="jpunc">${oB}</span><span class="jpreview">${preview}</span><span class="jpunc">${cB}</span></div><div class="jchildren" id="${id}">${rows}</div>`;
}
function jtog(id, el) {
  const c = document.getElementById(id);
  if (!c) return;
  el.textContent = c.classList.toggle("open") ? "▾" : "▸";
}
function expandAll() {
  document
    .querySelectorAll("#modalBody .jchildren")
    .forEach((el) => el.classList.add("open"));
  document
    .querySelectorAll("#modalBody .jtoggle:not(.spacer)")
    .forEach((el) => (el.textContent = "▾"));
}
function collapseAll() {
  document
    .querySelectorAll("#modalBody .jchildren")
    .forEach((el) => el.classList.remove("open"));
  document
    .querySelectorAll("#modalBody .jtoggle:not(.spacer)")
    .forEach((el) => (el.textContent = "▸"));
}
function openModal(logIdx) {
  const log = allLogs[logIdx];
  if (!log) return;
  const blocks = extractAllJSON(log.message);
  if (!blocks.length) return;
  modalJson = blocks.map((b) => b.parsed);
  const prefix = "modal_" + logIdx + "_";
  document.getElementById("modalMeta").textContent =
    `${log.time} · ${log.level}${log.logger ? " · " + log.logger : ""}`;
  document.getElementById("modalBody").innerHTML = blocks
    .map(
      (b, bi) => `
    ${blocks.length > 1 ? `<div class="modal-block-label">Block ${bi + 1}</div>` : ""}
    <div class="modal-json-block">${jTree(b.parsed, prefix + bi + "_")}</div>`,
    )
    .join("");
  document.getElementById("modalOverlay").classList.add("open");
  document.body.style.overflow = "hidden";
}
function closeModal(e) {
  if (e.target === document.getElementById("modalOverlay")) closeModalDirect();
}
function closeModalDirect() {
  document.getElementById("modalOverlay").classList.remove("open");
  document.body.style.overflow = "";
}
function copyModalJson() {
  if (!modalJson) return;
  const txt =
    modalJson.length === 1
      ? JSON.stringify(modalJson[0], null, 2)
      : JSON.stringify(modalJson, null, 2);
  navigator.clipboard.writeText(txt).then(() => {
    const btn = document.getElementById("modalCopyBtn");
    btn.textContent = "✓ COPIED";
    btn.classList.add("ok");
    setTimeout(() => {
      btn.textContent = "⎘ COPY JSON";
      btn.classList.remove("ok");
    }, 1500);
    showToast("JSON copied");
  });
}

function buildParsePanelContent(logIdx, panelEl) {
  const log = allLogs[logIdx];
  if (!log) return;
  const blocks = extractAllJSON(log.message);
  if (!blocks.length) {
    panelEl.innerHTML = `<span class="pp-empty">No JSON found in this message.</span>`;
  } else {
    const prefix = "e" + logIdx + "_";
    panelEl.innerHTML = blocks
      .map(
        (b, bi) => `
      ${blocks.length > 1 ? `<div class="pp-block-label">Block ${bi + 1}</div>` : ""}
      <div class="inline-json-block">${jTree(b.parsed, prefix + bi + "_")}</div>`,
      )
      .join("");
  }
}
function toggleParsePanel(idx) {
  openParsePanels.has(idx)
    ? openParsePanels.delete(idx)
    : openParsePanels.add(idx);
  const panel = document.getElementById("pp" + idx);
  const btn = document.getElementById("parsebtn" + idx);
  const isOpen = openParsePanels.has(idx);
  if (panel) {
    panel.style.display = isOpen ? "block" : "none";
    if (isOpen) buildParsePanelContent(idx, panel);
  }
  if (btn) btn.classList.toggle("active", isOpen);
}

function makeEntry(log, idx) {
  const lvlU = log.level.toUpperCase();
  const isBuiltin = BUILTINS.has(lvlU);
  const map = {
    DEBUG: "d",
    INFO: "i",
    WARNING: "w",
    ERROR: "e",
    CRITICAL: "c",
  };
  const lvlCls = isBuiltin ? "le-" + map[lvlU] : "le-x";
  const bdgCls = isBuiltin ? "bd-" + map[lvlU] : "bd-x";
  const src = log.logger
    ? `<div class="le-src">Logger: <b>${log.logger}</b>&nbsp;·&nbsp;<b>${log.filename || ""}${log.lineno ? ":" + log.lineno : ""}</b></div>`
    : "";
  const isOpen = openParsePanels.has(idx);
  const el = document.createElement("div");
  el.className = `le ${lvlCls}`;
  el.dataset.level = lvlU;
  el.id = `le${idx}`;
  el.innerHTML = `
    <div class="le-actions">
      <button class="act-btn" onclick="copyEntry(${idx})">⎘ COPY</button>
      <button class="act-btn" onclick="openModal(${idx})">⤢ MODAL</button>
    </div>
    <span class="le-time">${log.time}</span>
    <span class="le-badge ${bdgCls}">${lvlU}</span>
    <div class="le-body">
      <div class="le-msg" data-original-text="${esc(log.message)}">${highlightMsg(log.message, searchQuery)}</div>
      ${src}
      <button class="parse-btn${isOpen ? " active" : ""}" id="parsebtn${idx}" onclick="toggleParsePanel(${idx})">▸ PARSE</button>
      <div class="parse-panel" id="pp${idx}" style="display:${isOpen ? "block" : "none"}"></div>
    </div>`;
  if (isOpen) buildParsePanelContent(idx, el.querySelector(".parse-panel"));
  return el;
}

function trimDOMIfNeeded() {
  if (domRowCount <= MAX_DOM) return;
  const scroll = document.getElementById("logScroll");
  const rows = scroll.querySelectorAll(".le");
  const removeCount = domRowCount - TRIM_TO;
  const savedTop = scroll.scrollTop;
  let removedH = 0;
  for (let i = 0; i < removeCount && i < rows.length; i++) {
    removedH += rows[i].offsetHeight;
    rows[i].remove();
  }
  domRowCount -= removeCount;

  scroll.scrollTop = Math.max(0, savedTop - removedH);
}

function appendEntries(logs, indexOffset) {
  const scroll = document.getElementById("logScroll");

  const empty = scroll.querySelector(".empty");
  if (empty) empty.remove();

  const frag = document.createDocumentFragment();
  for (let i = 0; i < logs.length; i++) {
    if (!passesFilter(logs[i])) continue;
    frag.appendChild(makeEntry(logs[i], indexOffset + i));
    domRowCount++;
  }
  scroll.appendChild(frag);
  trimDOMIfNeeded();
}

function passesFilter(log) {
  const lvl = log.level.toUpperCase();
  if (selectedLevels.size > 0 && !selectedLevels.has(lvl)) return false;
  if (!matchesSearch(log.message, searchQuery)) return false;
  return true;
}

let sentinel = null;
let bottomObs = null;

function setupSentinel() {
  const scroll = document.getElementById("logScroll");

  sentinel = document.createElement("div");
  sentinel.id = "scrollSentinel";
  sentinel.className = "scroll-sentinel";
  scroll.appendChild(sentinel);

  bottomObs = new IntersectionObserver(
    (entries) => {
      const wasAtBottom = atBottom;
      atBottom = entries[0].isIntersecting;

      if (atBottom && !wasAtBottom) {
        flushPending();
      }
    },
    { root: scroll, threshold: 0 },
  );

  bottomObs.observe(sentinel);
}

function flushPending() {
  if (!pendingLogs.length) {
    updateNewBadge(0);
    return;
  }

  const scroll = document.getElementById("logScroll");
  const indexBase = allLogs.length - pendingLogs.length;

  appendEntries(pendingLogs, indexBase);
  pendingLogs = [];
  updateNewBadge(0);

  scroll.appendChild(sentinel);
  scroll.scrollTop = scroll.scrollHeight;
}

function updateNewBadge(n) {
  let badge = document.getElementById("newLogsBadge");
  if (!badge) {
    badge = document.createElement("button");
    badge.id = "newLogsBadge";
    badge.className = "new-logs-badge";
    badge.onclick = scrollBottom;
    document.body.appendChild(badge);
  }
  if (n > 0) {
    badge.style.display = "block";
    badge.textContent = `▼ ${n} new`;
  } else {
    badge.style.display = "none";
  }
}

function flushAndRebuild() {
  pendingLogs = [];
  updateNewBadge(0);

  const scroll = document.getElementById("logScroll");
  scroll.innerHTML = "";
  domRowCount = 0;

  const frag = document.createDocumentFragment();
  let added = 0;
  for (let i = 0; i < allLogs.length; i++) {
    if (!passesFilter(allLogs[i])) continue;
    frag.appendChild(makeEntry(allLogs[i], i));
    added++;
  }

  if (added === 0) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.innerHTML = `<span class="empty-glyph">◈</span>NO SIGNAL — WAITING FOR LOGS`;
    frag.appendChild(empty);
  }

  scroll.appendChild(frag);
  domRowCount = added;
  trimDOMIfNeeded();

  scroll.appendChild(sentinel);

  scroll.scrollTop = scroll.scrollHeight;
  updateStats();
}

function ingestLog(entry) {
  totalReceived++;
  allLogs.push(entry);
  trimToMax(allLogs);

  const lvl = entry.level.toUpperCase();
  if (lvl === "WARNING") statWarn++;
  if (lvl === "ERROR") statErr++;
  if (lvl === "CRITICAL") statCrit++;

  if (atBottom) {
    if (passesFilter(entry)) {
      appendEntries([entry], allLogs.length - 1);
      const scroll = document.getElementById("logScroll");
      scroll.appendChild(sentinel);
      scroll.scrollTop = scroll.scrollHeight;
    }
  } else {
    if (passesFilter(entry)) {
      pendingLogs.push(entry);
      trimToMax(pendingLogs);
      updateNewBadge(pendingLogs.length);
    }
  }

  updateStats();
}

function updateStats() {
  document.getElementById("sTotal").textContent = totalReceived;

  const vis = allLogs.filter(passesFilter).length;
  document.getElementById("sVis").textContent = vis;

  document.getElementById("sWarn").textContent = statWarn;
  document.getElementById("sErr").textContent = statErr;
  document.getElementById("sCrit").textContent = statCrit;
  document.getElementById("sMatches").textContent = searchQuery
    ? allLogs.filter((l) => matchesSearch(l.message, searchQuery)).length
    : "—";
}

async function connectSSE() {
  if (es) {
    es.close();
    es = null;
  }

  try {
    const r = await fetch("/api/senders-count");
    if (r.ok) {
      const d = await r.json();
      if (typeof d.len === "number" && d.len > 0) maxLogs = d.len;
    }
  } catch {}

  fetch("/api/logs")
    .then((r) => {
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    })
    .then((data) => {
      allLogs = [];
      totalReceived = 0;
      statWarn = 0;
      statErr = 0;
      statCrit = 0;
      openParsePanels.clear();
      pendingLogs = [];
      atBottom = true;

      data.logs.forEach((l) => {
        allLogs.push(l);
        const v = l.level.toUpperCase();
        if (v === "WARNING") statWarn++;
        if (v === "ERROR") statErr++;
        if (v === "CRITICAL") statCrit++;
      });

      trimToMax(allLogs);
      totalReceived = totalReceived + allLogs.length;
      document.getElementById("sTime").textContent =
        new Date().toLocaleTimeString();
      document.getElementById("statusTxt").textContent = "LIVE";
      flushAndRebuild();
      openSSE();
    })
    .catch(() => {
      document.getElementById("statusTxt").textContent = "NO CONNECTION";
      reconnectTimer = setTimeout(connectSSE, 2000);
    });
}

function openSSE() {
  es = new EventSource("/api/stream");
  es.onmessage = (e) => {
    if (paused) return;
    try {
      const entry = JSON.parse(e.data);
      ingestLog(entry);
      document.getElementById("sTime").textContent =
        new Date().toLocaleTimeString();
    } catch {}
  };
  es.onopen = () => {
    document.getElementById("statusTxt").textContent = "LIVE";
    clearTimeout(reconnectTimer);
  };
  es.onerror = () => {
    document.getElementById("statusTxt").textContent = "NO CONNECTION";
    es.close();
    es = null;
    reconnectTimer = setTimeout(connectSSE, 2000);
  };
}

function scrollBottom() {
  flushPending();
  const scroll = document.getElementById("logScroll");
  scroll.scrollTop = scroll.scrollHeight;
}

function doClear() {
  if (!confirm("Clear all logs?")) return;
  fetch("/api/clear", { method: "POST" }).then(() => {
    allLogs = [];
    statWarn = 0;
    statErr = 0;
    statCrit = 0;
    totalReceived = 0;
    pendingLogs = [];
    openParsePanels.clear();
    atBottom = true;
    searchQuery = "";
    document.getElementById("searchInp").value = "";
    document.getElementById("searchClear").classList.remove("visible");
    document.getElementById("searchKbd").classList.remove("hidden");
    document.getElementById("sMatches").textContent = "—";
    updateNewBadge(0);
    flushAndRebuild();
  });
}

async function changeLogging() {
  try {
    const res = await fetch("api/change_logging", { method: "POST" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const el = document.getElementById("logging");
    el.textContent = data.logging ? "logging ON" : "logging OFF";
    data.logging ? el.classList.add("active") : el.classList.remove("active");
  } catch (e) {
    console.error("changeLogging failed:", e);
  }
}

window.addEventListener("load", async () => {
  setupSentinel();
  try {
    const res = await fetch("api/logging_status");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const el = document.getElementById("logging");
    el.textContent = data.logging ? "logging ON" : "logging OFF";
    data.logging ? el.classList.add("active") : el.classList.remove("active");
  } catch (e) {
    console.error("logging_status failed:", e);
    document.getElementById("logging").textContent = "logging ?";
  }
});

function copyEntry(idx) {
  const log = allLogs[idx];
  if (!log) return;
  const txt =
    `[${log.time}] [${log.level}] ${log.message}` +
    (log.logger ? ` | ${log.logger} ${log.filename}:${log.lineno}` : "");
  navigator.clipboard.writeText(txt).then(() => {
    const btn = document.querySelector(`#le${idx} .act-btn`);
    if (btn) {
      btn.textContent = "✓";
      btn.classList.add("ok");
      setTimeout(() => {
        btn.textContent = "⎘ COPY";
        btn.classList.remove("ok");
      }, 1400);
    }
    showToast("Copied");
  });
}

let _tt;
function showToast(msg) {
  const el = document.getElementById("toast");
  el.textContent = msg;
  el.classList.add("show");
  clearTimeout(_tt);
  _tt = setTimeout(() => el.classList.remove("show"), 1800);
}

function esc(s) {
  if (typeof s !== "string") return String(s);
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

loadLevels();
loadCLevels();
connectSSE();

document.getElementById("prevMatch").disabled = true;
document.getElementById("nextMatch").disabled = true;
