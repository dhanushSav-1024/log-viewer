const LEVELS = { DEBUG: true, INFO: true, WARNING: true, ERROR: true, CRITICAL: true };
const BUILTINS = new Set(['DEBUG', 'INFO', 'WARNING', 'ERROR', 'CRITICAL']);
let paused = false;
let allLogs = [];
let renderedCount = 0;
let activeCLevel = null;
let customLevels = [];
let modalJson = null;

// ─── FUZZY SEARCH STATE ───
let searchQuery = '';
let matchElements = [];   // flat list of all mark.hl elements across all entries
let activeMatchIdx = -1;
let searchTimer = null;

// ─────────────────────────────────────────────────────────────
// FUZZY MATCH ENGINE
// Returns an array of char indices in `text` that match `query`
// using a consecutive-bonus, start-of-word-bonus algorithm
// similar to VSCode / Sublime Text.
// ─────────────────────────────────────────────────────────────
function fuzzyMatch(text, query) {
    if (!query) return null;
    const tL = text.toLowerCase();
    const qL = query.toLowerCase();

    // Fast path: exact substring → treat as perfect match
    const exactIdx = tL.indexOf(qL);
    if (exactIdx !== -1) {
        const indices = [];
        for (let i = 0; i < qL.length; i++) indices.push(exactIdx + i);
        return { indices, score: 1000 };
    }

    // Fuzzy: find matching character indices with gap penalty
    let ti = 0, qi = 0;
    const indices = [];
    while (ti < text.length && qi < qL.length) {
        if (tL[ti] === qL[qi]) { indices.push(ti); qi++; }
        ti++;
    }
    if (qi < qL.length) return null; // not all chars matched

    // Score: reward consecutive runs & word-start positions
    let score = 0;
    let consecutive = 0;
    for (let i = 0; i < indices.length; i++) {
        const idx = indices[i];
        const isWordStart = idx === 0 || /[\s\-_\.\/\\:,\[\]{}()]/.test(text[idx - 1]);
        if (i > 0 && indices[i] === indices[i - 1] + 1) { consecutive++; score += 5 + consecutive * 3; }
        else consecutive = 0;
        if (isWordStart) score += 8;
        score += 1;
    }
    // Penalise large gaps
    score -= (indices[indices.length - 1] - indices[0] - indices.length) * 0.1;
    return { indices, score };
}

// Build highlighted HTML from text + matched indices
// Groups consecutive indices into <mark> spans for clean rendering
function buildHighlightHtml(text, indices, isActive) {
    if (!indices || !indices.length) return esc(text);
    const idxSet = new Set(indices);
    let html = '';
    let i = 0;
    while (i < text.length) {
        if (idxSet.has(i)) {
            // Start a run of consecutive matched chars
            let runEnd = i;
            while (runEnd + 1 < text.length && idxSet.has(runEnd + 1)) runEnd++;
            const chunk = esc(text.slice(i, runEnd + 1));
            html += `<mark class="hl">${chunk}</mark>`;
            i = runEnd + 1;
        } else {
            // Non-match run until next match
            let runEnd = i;
            while (runEnd + 1 < text.length && !idxSet.has(runEnd + 1)) runEnd++;
            html += esc(text.slice(i, runEnd + 1));
            i = runEnd + 1;
        }
    }
    return html;
}

// ─────────────────────────────────────────────────────────────
// SEARCH ENTRY POINT
// ─────────────────────────────────────────────────────────────
function onSearchInput() {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(applySearch, 80);
    const q = document.getElementById('searchInp').value;
    const clearBtn = document.getElementById('searchClear');
    const kbdHint = document.getElementById('searchKbd');
    clearBtn.classList.toggle('visible', q.length > 0);
    kbdHint.classList.toggle('hidden', q.length > 0);
}

function onSearchKey(e) {
    if (e.key === 'Enter') {
        e.preventDefault();
        navigateMatch(e.shiftKey ? -1 : 1);
    } else if (e.key === 'Escape') {
        clearSearch();
    }
}

function clearSearch() {
    document.getElementById('searchInp').value = '';
    document.getElementById('searchClear').classList.remove('visible');
    document.getElementById('searchKbd').classList.remove('hidden');
    searchQuery = '';
    activeMatchIdx = -1;
    matchElements = [];
    applySearch();
}

function applySearch() {
    searchQuery = document.getElementById('searchInp').value.trim();
    matchElements = [];
    activeMatchIdx = -1;

    const entries = document.querySelectorAll('#logScroll .le');
    let totalMatches = 0;

    entries.forEach((el, entryIdx) => {
        // Restore original text first (remove old highlights)
        const msgEl = el.querySelector('.le-msg');
        if (!msgEl) return;

        // Get original text from data attribute (set on first render)
        const originalText = msgEl.dataset.originalText;
        if (originalText === undefined) return;

        // Is this entry currently visible (not hidden by level/clevel filters)?
        const levelHidden = el.style.display === 'none';

        if (!searchQuery) {
            // Clear mode
            msgEl.innerHTML = esc(originalText);
            el.classList.remove('search-match', 'search-no-match');
            return;
        }

        const result = fuzzyMatch(originalText, searchQuery);

        if (result && !levelHidden) {
            el.classList.add('search-match');
            el.classList.remove('search-no-match');
            msgEl.innerHTML = buildHighlightHtml(originalText, result.indices, false);
            const marks = msgEl.querySelectorAll('mark.hl');
            marks.forEach(m => {
                m.dataset.entryIdx = entryIdx;
                m.dataset.matchIdx = totalMatches++;
                matchElements.push(m);
            });
        } else {
            el.classList.remove('search-match');
            if (!levelHidden && searchQuery) {
                el.classList.add('search-no-match');
            }
        }
    });

    updateSearchCounter(totalMatches);
    document.getElementById('sMatches').textContent = searchQuery ? totalMatches : '—';

    // Auto-highlight first match
    if (totalMatches > 0) {
        activeMatchIdx = 0;
        setActiveMatch(0);
    }
}

function navigateMatch(dir) {
    if (!matchElements.length) return;
    activeMatchIdx = (activeMatchIdx + dir + matchElements.length) % matchElements.length;
    setActiveMatch(activeMatchIdx);
}

function setActiveMatch(idx) {
    // Remove previous active
    matchElements.forEach(m => m.classList.remove('hl-active'));
    if (idx < 0 || idx >= matchElements.length) return;
    const el = matchElements[idx];
    el.classList.add('hl-active');
    // Scroll into view smoothly
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    updateSearchCounter(matchElements.length);
}

function updateSearchCounter(total) {
    const counter = document.getElementById('searchCounter');
    const prevBtn = document.getElementById('prevMatch');
    const nextBtn = document.getElementById('nextMatch');

    if (!searchQuery) {
        counter.textContent = '';
        counter.className = 'search-counter';
        prevBtn.disabled = true;
        nextBtn.disabled = true;
        return;
    }
    if (total === 0) {
        counter.textContent = 'no match';
        counter.className = 'search-counter no-results';
        prevBtn.disabled = true;
        nextBtn.disabled = true;
    } else {
        const cur = activeMatchIdx >= 0 ? activeMatchIdx + 1 : 1;
        counter.textContent = `${cur} / ${total}`;
        counter.className = 'search-counter has-results';
        prevBtn.disabled = false;
        nextBtn.disabled = false;
    }
}

// Global keyboard shortcut: / or Ctrl+F to focus search
document.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
        if (document.getElementById('modalOverlay').classList.contains('open')) {
            closeModalDirect();
        } else {
            clearSearch();
        }
        return;
    }
    // Don't steal focus from other inputs
    const tag = document.activeElement.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;
    if (e.key === '/' || (e.ctrlKey && e.key === 'f')) {
        e.preventDefault();
        document.getElementById('searchInp').focus();
        document.getElementById('searchInp').select();
    }
});

// ─────────────────────────────────────────────────────────────
// COOKIES
// ─────────────────────────────────────────────────────────────
const ck = {
    set(k, v) { const d = new Date(); d.setTime(d.getTime() + 365 * 86400000); document.cookie = `${k}=${encodeURIComponent(JSON.stringify(v))};expires=${d.toUTCString()};path=/`; },
    get(k) { const m = document.cookie.match(new RegExp('(?:^|; )' + k + '=([^;]*)')); try { return m ? JSON.parse(decodeURIComponent(m[1])) : null; } catch { return null; } }
};

function loadCLevels() { customLevels = ck.get('sw_clevels') || []; renderCLevels(); }
function saveCLevels() { ck.set('sw_clevels', customLevels); }
function addCLevel() {
    const inp = document.getElementById('clevelInp');
    const val = inp.value.trim().toUpperCase();
    if (!val || customLevels.includes(val) || BUILTINS.has(val)) return;
    customLevels.push(val); saveCLevels(); renderCLevels(); inp.value = '';
}
function removeCLevel(t) {
    customLevels = customLevels.filter(x => x !== t);
    if (activeCLevel === t) { activeCLevel = null; updateCLLabel(); }
    saveCLevels(); renderCLevels(); refilter();
}
function filterByCLevel(t) { activeCLevel = activeCLevel === t ? null : t; updateCLLabel(); renderCLevels(); refilter(); }
function clearCLFilter() { activeCLevel = null; updateCLLabel(); renderCLevels(); refilter(); }
function updateCLLabel() { document.getElementById('activeCLLabel').textContent = activeCLevel || 'ALL'; }
function renderCLevels() {
    document.getElementById('clevelList').innerHTML = customLevels.map(t => `
    <span class="clevel${activeCLevel === t ? ' on' : ''}" onclick="filterByCLevel('${t}')">
      ${t}<span class="clevel-x" onclick="event.stopPropagation();removeCLevel('${t}')">✕</span>
    </span>`).join('');
}
function toggleChip(btn) {
    const lvl = btn.dataset.lvl;
    LEVELS[lvl] = !LEVELS[lvl];
    btn.classList.toggle('on', LEVELS[lvl]);
    ck.set('sw_levels', LEVELS);
    refilter();
}
function loadLevels() {
    const saved = ck.get('sw_levels'); if (!saved) return;
    Object.keys(saved).forEach(k => { if (k in LEVELS) LEVELS[k] = saved[k]; });
    document.querySelectorAll('.chip[data-lvl]').forEach(btn => {
        btn.classList.toggle('on', LEVELS[btn.dataset.lvl]);
    });
}
function togglePause() {
    paused = !paused;
    const btn = document.getElementById('pauseBtn');
    const dot = document.getElementById('liveDot');
    if (paused) {
        btn.textContent = 'RESUME'; btn.classList.add('active');
        dot.classList.add('paused');
        document.getElementById('statusTxt').textContent = 'PAUSED';
    } else {
        btn.textContent = 'PAUSE'; btn.classList.remove('active');
        dot.classList.remove('paused');
        document.getElementById('statusTxt').textContent = 'LIVE';
        fetchLogs();
    }
}
function pyToJson(s) {
    try {
        let j = s
            .replace(/:\s*True\b/g, ': true').replace(/:\s*False\b/g, ': false')
            .replace(/:\s*None\b/g, ': null').replace(/,\s*}/g, '}').replace(/,\s*]/g, ']');
        let out = '', i = 0;
        while (i < j.length) {
            const ch = j[i];
            if (ch === "'") {
                let str = '"'; i++;
                while (i < j.length) {
                    const c = j[i];
                    if (c === '\\' && j[i + 1] === "'") { str += "'"; i += 2; continue; }
                    if (c === '"') { str += '\\"'; i++; continue; }
                    if (c === "'") { i++; break; }
                    str += c; i++;
                }
                out += str + '"';
            } else { out += ch; i++; }
        }
        return out;
    } catch { return null; }
}
function extractOneJSON(msg, fromIdx = 0) {
    const sub = msg.slice(fromIdx);
    const rel = sub.search(/[{\[]/);
    if (rel === -1) return null;
    const start = fromIdx + rel;
    const open = msg[start], close = open === '{' ? '}' : ']';
    let depth = 0, inStr = false, strChar = '', end = -1;
    for (let i = start; i < msg.length; i++) {
        const c = msg[i];
        if (inStr) { if (c === '\\') { i++; continue; } if (c === strChar) inStr = false; }
        else {
            if (c === '"' || c === "'") { inStr = true; strChar = c; continue; }
            if (c === open) depth++;
            if (c === close) { depth--; if (depth === 0) { end = i + 1; break; } }
        }
    }
    if (end === -1) return null;
    const raw = msg.slice(start, end);
    let parsed = null;
    try { parsed = JSON.parse(raw); } catch { }
    if (!parsed) { try { parsed = JSON.parse(pyToJson(raw)); } catch { } }
    if (!parsed || typeof parsed !== 'object') return null;
    return { parsed, start, end };
}
function extractAllJSON(msg) {
    const blocks = []; let cursor = 0;
    while (cursor < msg.length) {
        const b = extractOneJSON(msg, cursor);
        if (!b) break;
        blocks.push(b); cursor = b.end;
    }
    return blocks;
}
function jLeaf(data) {
    if (data === null) return `<span class="jnull">null</span>`;
    if (typeof data === 'boolean') return `<span class="jbool">${data}</span>`;
    if (typeof data === 'number') return `<span class="jnum">${data}</span>`;
    if (typeof data === 'string') return `<span class="jstr">"${esc(data)}"</span>`;
    return null;
}
function jPreview(data) {
    if (Array.isArray(data)) return `<span class="jpunc">[</span><span class="jpreview">${data.length} items</span><span class="jpunc">]</span>`;
    return `<span class="jpunc">{</span><span class="jpreview">${Object.keys(data).length} keys</span><span class="jpunc">}</span>`;
}
function jTree(data, prefix, depth = 0) {
    if (depth > 20) return `<span class="jpunc">[…]</span>`;
    const leaf = jLeaf(data); if (leaf !== null) return leaf;
    const id = prefix + 'd' + depth + '_' + (Math.random() * 1e9 | 0);
    const isArr = Array.isArray(data);
    const entries = isArr ? data.map((v, i) => [i, v]) : Object.entries(data);
    const rows = entries.map(([k, v], i) => {
        const comma = i < entries.length - 1 ? `<span class="jpunc">,</span>` : '';
        const keyHtml = isArr ? '' : `<span class="jkey">"${esc(String(k))}"</span><span class="jpunc">: </span>`;
        const childLeaf = jLeaf(v);
        if (childLeaf !== null) {
            return `<div class="jnode"><div class="jrow"><span class="jtoggle spacer"></span>${keyHtml}${childLeaf}${comma}</div></div>`;
        }
        const cid = prefix + 'c' + i + 'd' + depth + '_' + (Math.random() * 1e9 | 0);
        return `<div class="jnode">
      <div class="jrow"><span class="jtoggle" onclick="jtog('${cid}',this)">▸</span>${keyHtml}${jPreview(v)}${comma}</div>
      <div class="jchildren" id="${cid}">${jTree(v, prefix + '_' + i, depth + 1)}</div>
    </div>`;
    }).join('');
    const oB = isArr ? '[' : '{', cB = isArr ? ']' : '}';
    const preview = isArr ? `${data.length} items` : `${Object.keys(data).length} keys`;
    return `<div class="jrow"><span class="jtoggle" onclick="jtog('${id}',this)">▸</span>
    <span class="jpunc">${oB}</span><span class="jpreview">${preview}</span><span class="jpunc">${cB}</span>
  </div>
  <div class="jchildren" id="${id}">${rows}</div>`;
}
function jtog(id, el) {
    const c = document.getElementById(id); if (!c) return;
    const open = c.classList.toggle('open');
    el.textContent = open ? '▾' : '▸';
}
function expandAll() { document.querySelectorAll('#modalBody .jchildren').forEach(el => el.classList.add('open')); document.querySelectorAll('#modalBody .jtoggle:not(.spacer)').forEach(el => el.textContent = '▾'); }
function collapseAll() { document.querySelectorAll('#modalBody .jchildren').forEach(el => el.classList.remove('open')); document.querySelectorAll('#modalBody .jtoggle:not(.spacer)').forEach(el => el.textContent = '▸'); }
function openModal(logIdx) {
    const log = allLogs[logIdx]; if (!log) return;
    const blocks = extractAllJSON(log.message); if (!blocks.length) return;
    modalJson = blocks.map(b => b.parsed);
    const prefix = 'modal_' + logIdx + '_';
    document.getElementById('modalMeta').textContent = `${log.time} · ${log.level}${log.logger ? ' · ' + log.logger : ''}`;
    document.getElementById('modalBody').innerHTML = blocks.map((b, bi) => `
    ${blocks.length > 1 ? `<div class="modal-block-label">Block ${bi + 1}</div>` : ''}
    <div class="modal-json-block">${jTree(b.parsed, prefix + bi + '_')}</div>
  `).join('');
    document.getElementById('modalOverlay').classList.add('open');
    document.body.style.overflow = 'hidden';
}
function closeModal(e) { if (e.target === document.getElementById('modalOverlay')) closeModalDirect(); }
function closeModalDirect() { document.getElementById('modalOverlay').classList.remove('open'); document.body.style.overflow = ''; }
function copyModalJson() {
    if (!modalJson) return;
    const txt = modalJson.length === 1 ? JSON.stringify(modalJson[0], null, 2) : JSON.stringify(modalJson, null, 2);
    navigator.clipboard.writeText(txt).then(() => {
        const btn = document.getElementById('modalCopyBtn');
        btn.textContent = '✓ COPIED'; btn.classList.add('ok');
        setTimeout(() => { btn.textContent = '⎘ COPY JSON'; btn.classList.remove('ok'); }, 1500);
        showToast('JSON copied');
    });
}
function toggleParsePanel(idx) {
    const panel = document.getElementById('pp' + idx); if (!panel) return;
    if (panel.dataset.built !== '1') {
        const log = allLogs[idx]; if (!log) return;
        const blocks = extractAllJSON(log.message);
        if (!blocks.length) {
            panel.innerHTML = `<span style="color:var(--text-muted);font-size:0.65rem;">No JSON found in this message.</span>`;
        } else {
            const prefix = 'e' + idx + '_';
            panel.innerHTML = blocks.map((b, bi) => `
        ${blocks.length > 1 ? `<div style="font-size:0.6rem;color:var(--text-muted);margin-bottom:4px;text-transform:uppercase;letter-spacing:.08em;">Block ${bi + 1}</div>` : ''}
        <div class="inline-json-block">${jTree(b.parsed, prefix + bi + '_')}</div>
      `).join('');
        }
        panel.dataset.built = '1';
    }
    const btn = document.getElementById('parsebtn' + idx);
    const visible = panel.style.display !== 'none' && panel.style.display !== '';
    panel.style.display = visible ? 'none' : 'block';
    if (btn) btn.classList.toggle('active', !visible);
}

function makeEntry(log, idx) {
    const lvlU = log.level.toUpperCase();
    const isBuiltin = BUILTINS.has(lvlU);
    const lvlCls = isBuiltin ? 'le-' + { DEBUG: 'd', INFO: 'i', WARNING: 'w', ERROR: 'e', CRITICAL: 'c' }[lvlU] : 'le-x';
    const bdgCls = isBuiltin ? 'bd-' + { DEBUG: 'd', INFO: 'i', WARNING: 'w', ERROR: 'e', CRITICAL: 'c' }[lvlU] : 'bd-x';
    const src = log.logger
        ? `<div class="le-src">Logger: <b>${log.logger}</b>&nbsp;·&nbsp;<b>${log.filename || ''}${log.lineno ? ':' + log.lineno : ''}</b></div>`
        : '';
    const el = document.createElement('div');
    el.className = `le ${lvlCls}`;
    el.dataset.level = lvlU;
    el.id = `le${idx}`;

    // Store original message text for search highlighting
    const msgEl = document.createElement('div');
    msgEl.className = 'le-msg';
    msgEl.dataset.originalText = log.message;
    // Initial render: escaped plain text
    msgEl.innerHTML = esc(log.message);

    el.innerHTML = `
    <div class="le-actions">
      <button class="act-btn" onclick="copyEntry(${idx})">⎘ COPY</button>
      <button class="act-btn" onclick="openModal(${idx})">⤢ MODAL</button>
    </div>
    <span class="le-time">${log.time}</span>
    <span class="le-badge ${bdgCls}">${lvlU}</span>
    <div class="le-body">
      <div class="le-msg" data-original-text="${esc(log.message)}">${esc(log.message)}</div>
      ${src}
      <button class="parse-btn" id="parsebtn${idx}" onclick="toggleParsePanel(${idx})">▸ PARSE</button>
      <div class="parse-panel" id="pp${idx}" style="display:none"></div>
    </div>`;
    return el;
}

function applyLogs(newLogs) {
    const scroll = document.getElementById('logScroll');
    if (newLogs.length < renderedCount || renderedCount === 0) {
        scroll.innerHTML = '';
        renderedCount = 0;
        if (!newLogs.length) {
            scroll.innerHTML = '<div class="empty"><span class="empty-glyph">◈</span>NO SIGNAL — WAITING FOR LOGS</div>';
            return;
        }
    }
    const atBottom = (scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight) < 80;
    const frag = document.createDocumentFragment();
    for (let i = renderedCount; i < newLogs.length; i++) frag.appendChild(makeEntry(newLogs[i], i));
    renderedCount = newLogs.length;
    scroll.appendChild(frag);
    refilter();
    // Re-apply search on new entries
    if (searchQuery) applySearch();
    if (atBottom) scroll.scrollTop = scroll.scrollHeight;
}

function refilter() {
    let vis = 0, warn = 0, err = 0, crit = 0;
    allLogs.forEach(l => { const v = l.level.toUpperCase(); if (v === 'WARNING') warn++; if (v === 'ERROR') err++; if (v === 'CRITICAL') crit++; });
    document.querySelectorAll('#logScroll .le').forEach(el => {
        const lvl = el.dataset.level;
        const chipOk = BUILTINS.has(lvl) ? (LEVELS[lvl] || false) : true;
        const clevelOk = !activeCLevel || (lvl === activeCLevel);
        const show = chipOk && clevelOk;
        el.style.display = show ? '' : 'none';
        if (show) vis++;
    });
    document.getElementById('sVis').textContent = vis;
    document.getElementById('sWarn').textContent = warn;
    document.getElementById('sErr').textContent = err;
    document.getElementById('sCrit').textContent = crit;
    // Re-run search to exclude hidden-by-filter entries
    if (searchQuery) applySearch();
}

function fetchLogs() {
    if (paused) return;
    fetch('/api/logs')
        .then(r => r.json())
        .then(data => {
            allLogs = data.logs;
            applyLogs(data.logs);
            document.getElementById('sTotal').textContent = data.total;
            document.getElementById('sTime').textContent = new Date().toLocaleTimeString();
            document.getElementById('statusTxt').textContent = 'LIVE';
        })
        .catch(() => { document.getElementById('statusTxt').textContent = 'NO CONNECTION'; });
}

function scrollBottom() { const s = document.getElementById('logScroll'); s.scrollTop = s.scrollHeight; }

function doClear() {
    if (!confirm('Clear all logs?')) return;
    fetch('/api/clear', { method: 'POST' }).then(() => {
        allLogs = []; renderedCount = 0;
        searchQuery = ''; matchElements = []; activeMatchIdx = -1;
        document.getElementById('searchInp').value = '';
        document.getElementById('searchClear').classList.remove('visible');
        document.getElementById('searchKbd').classList.remove('hidden');
        document.getElementById('searchCounter').textContent = '';
        document.getElementById('sMatches').textContent = '—';
        document.getElementById('logScroll').innerHTML = '<div class="empty"><span class="empty-glyph">◈</span>NO SIGNAL — WAITING FOR LOGS</div>';
        document.getElementById('sTotal').textContent = 0;
        document.getElementById('sVis').textContent = 0;
    });
}


async function changeLogging() {
    try {
        const res = await fetch("api/change_logging", { method: "POST" });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        const el = document.getElementById('logging');

        el.textContent = data.logging ? "logging ON" : "logging OFF";

        if (data.logging) {
            el.classList.add("active");
        } else {
            el.classList.remove("active");
        }
    } catch (e) {
        console.error("changeLogging failed:", e);
    }
}

window.addEventListener('load', async () => {
    try {
        const res = await fetch("api/logging_status");
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        const el = document.getElementById('logging');

        el.textContent = data.logging ? "logging ON" : "logging OFF";

        if (data.logging) {
            el.classList.add("active");
        } else {
            el.classList.remove("active");
        }
    } catch (e) {
        console.error("logging_status failed:", e);
        document.getElementById('logging').textContent = "logging ?";
    }
});


function copyEntry(idx) {
    const log = allLogs[idx]; if (!log) return;
    const txt = `[${log.time}] [${log.level}] ${log.message}` + (log.logger ? ` | ${log.logger} ${log.filename}:${log.lineno}` : '');
    navigator.clipboard.writeText(txt).then(() => {
        const btn = document.querySelector(`#le${idx} .act-btn`);
        if (btn) { btn.textContent = '✓'; btn.classList.add('ok'); setTimeout(() => { btn.textContent = '⎘ COPY'; btn.classList.remove('ok'); }, 1400); }
        showToast('Copied');
    });
}
let _tt;
function showToast(msg) { const el = document.getElementById('toast'); el.textContent = msg; el.classList.add('show'); clearTimeout(_tt); _tt = setTimeout(() => el.classList.remove('show'), 1800); }
function esc(s) { if (typeof s !== 'string') return String(s); return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }

loadLevels();
loadCLevels();
setInterval(fetchLogs, 2000);
fetchLogs();

// Init nav buttons disabled
document.getElementById('prevMatch').disabled = true;
document.getElementById('nextMatch').disabled = true;