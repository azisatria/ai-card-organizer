'use strict';

// ═══════════════════════════════════════════════════════════════════════
//  Ai Card Organizer — Full-featured card library & inspector
//  Standalone / Tauri compatible
// ═══════════════════════════════════════════════════════════════════════

// ── Tauri bridge ─────────────────────────────────────────────────────
const TauriAvailable = typeof __TAURI__ !== 'undefined' && __TAURI__?.core;

const invoke = TauriAvailable
  ? __TAURI__.core.invoke.bind(__TAURI__.core)
  : async (cmd, args) => {
      if (cmd === 'pick_folder') return null;
      if (cmd === 'scan_folder') return [];
      if (cmd === 'get_card_metadata') return null;
      if (cmd === 'update_card_metadata') return args;
      throw new Error('Unknown dev command: ' + cmd);
    };

// ── App state ───────────────────────────────────────────────────────
const state = {
  allCards:    [],
  filtered:    [],
  pickLock:    false,
  activeTag:   null,
  card:        null,
  editMode:    false,
  compact:     false,
  searchQuery: '',
  sortBy:      localStorage.getItem('sortBy') || 'default',
  pendingImagePath: null,
};

// ── DOM refs (lazy, called at call-time) ────────────────────────────
const $  = (s, ctx) => (ctx || document).querySelector(s);
const $$ = (s, ctx) => [...(ctx || document).querySelectorAll(s)];

function el(id) { return document.getElementById(id); }

// ════════════════════════════════════════════════════════════════════
//  UTILITIES
// ════════════════════════════════════════════════════════════════════
const esc = s => String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');

const hashCode = s => { let h = 0; for (let i = 0; i < s.length; i++) h = ((h << 5) - h) + s.charCodeAt(i), h |= 0; return h; };

// Cache for base64 data URIs to avoid re-reading files
const _dataUriCache = new Map();

// Concurrency throttle for IPC calls
let _ipcQueue = 0;
const _ipcMax = 5;
const _ipcWaiters = [];

async function fileUriAsync(p) {
  if (!p) return '';
  // Already a web URL or data URI
  if (p.startsWith('http://') || p.startsWith('https://') || p.startsWith('data:')) return p;
  // If already a converted URL, return as-is
  if (p.startsWith('asset://') || p.startsWith('tauri://')) return p;
  // Check in-memory cache
  if (_dataUriCache.has(p)) return _dataUriCache.get(p);
  // Check sessionStorage cache (survives re-renders within the same session)
  if (TauriAvailable) {
    try {
      const ssKey = 'img:' + p;
      const cached = sessionStorage.getItem(ssKey);
      if (cached) {
        _dataUriCache.set(p, cached);
        return cached;
      }
    } catch (_) {}
  }
  // Use Tauri command to read file as base64
  if (TauriAvailable) {
    // Throttle: wait if too many concurrent requests
    if (_ipcQueue >= _ipcMax) {
      await new Promise(resolve => _ipcWaiters.push(resolve));
    }
    _ipcQueue++;
    try {
      const dataUri = await invoke('read_file_base64', { filePath: p });
      _dataUriCache.set(p, dataUri);
      // Persist to sessionStorage (best-effort — may throw if quota exceeded)
      try { sessionStorage.setItem('img:' + p, dataUri); } catch (_) {}
      return dataUri;
    } catch(e) {
      console.warn('read_file_base64 failed for', p, e);
      return '';
    } finally {
      _ipcQueue--;
      if (_ipcWaiters.length) _ipcWaiters.shift()();
    }
  }
  // Fallback: Convert Windows/Unix path to file:/// URL
  const normalized = p.replace(/\\/g, '/');
  if (normalized.match(/^[a-zA-Z]:\//)) {
    return 'file:///' + normalized;
  }
  if (normalized.startsWith('/')) {
    return 'file://' + normalized;
  }
  return p;
}

const fileUri = p => {
  if (!p) return '';
  // Already a web URL or data URI
  if (p.startsWith('http://') || p.startsWith('https://') || p.startsWith('data:')) return p;
  // If already a converted URL, return as-is
  if (p.startsWith('asset://') || p.startsWith('tauri://')) return p;
  // Check in-memory cache
  if (_dataUriCache.has(p)) return _dataUriCache.get(p);
  // Check sessionStorage cache (instant, no IPC needed)
  if (TauriAvailable) {
    try {
      const cached = sessionStorage.getItem('img:' + p);
      if (cached) {
        _dataUriCache.set(p, cached);
        return cached;
      }
    } catch (_) {}
  }
  // Kick off async conversion (cache will be populated when done)
  if (TauriAvailable) {
    fileUriAsync(p).then(dataUri => {
      _dataUriCache.set(p, dataUri);
    }).catch(() => {});
  }
  // Fallback: Convert Windows/Unix path to file:/// URL
  const normalized = p.replace(/\\/g, '/');
  if (normalized.match(/^[a-zA-Z]:\//)) {
    return 'file:///' + normalized;
  }
  if (normalized.startsWith('/')) {
    return 'file://' + normalized;
  }
  return p;
}

const firstChar = s => { if (!s) return '?'; return s.charAt(0).toUpperCase(); };

const shortName = (s, max = 30) => s && s.length > max ? s.slice(0, max) + '…' : (s || '—');

function coverGradient(name) {
  const palettes = [
    ['#1e1b4b','#4f46e5'], ['#14202b','#0e7490'], ['#1a1522','#a21caf'],
    ['#1a2215','#15803d'], ['#221a11','#c2410c'], ['#22151a','#b91c1c'],
    ['#171a22','#2563eb'], ['#1e1526','#7e22ce'], ['#15201a','#0f766e'],
    ['#221509','#d97706'], ['#1a1a2e','#e040fb'], ['#0f1c15','#22c55e'],
  ];
  const [a, b] = palettes[Math.abs(hashCode(name)) % palettes.length];
  return `linear-gradient(135deg, ${a} 0%, ${b} 100%)`;
}

function tagColors(tag) {
  const pairs = [
    ['#180f35','#a78bfa'], ['#0f2535','#67e8f9'], ['#35101e','#fb7185'],
    ['#0f3518','#86efac'], ['#352a0f','#fcd34d'], ['#35100f','#f87171'],
    ['#0f2035','#93c5fd'], ['#1a0f2e','#c084fc'], ['#2e170f','#fb923c'],
  ];
  return pairs[Math.abs(hashCode(tag)) % pairs.length];
}

function formatSize(bytes) {
  if (!bytes) return '—';
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / 1048576).toFixed(1) + ' MB';
}

// ── TOKEN COUNTER ────────────────────────────────────────────────────────────
function estimateTokens(str) {
  if (!str) return 0;
  return Math.ceil(str.length / 3.5);
}

function calcCardTokens(card) {
  const permanent = [
    card.name,
    card.description,
    card.personality,
    card.scenario,
    card.mes_example,
  ].reduce((sum, f) => sum + estimateTokens(f), 0);

  const extra = [
    card.first_mes,
    card.system_prompt,
    card.post_history_instructions,
    card.character_note,
  ].reduce((sum, f) => sum + estimateTokens(f), 0);

  return { permanent, total: permanent + extra };
}

function renderTokenBadge(card) {
  const { permanent, total } = calcCardTokens(card);

  const color = total > 4000 ? '#ef4444'
              : total > 2000 ? '#f59e0b'
              : '#22c55e';

  return `
    <div class="token-stats">
      <span class="token-label">Tokens</span>
      <div class="token-row">
        <span class="token-item">
          <span class="token-dot" style="background:#818cf8"></span>
          Permanent
          <strong>${permanent.toLocaleString()}</strong>
        </span>
        <span class="token-divider">·</span>
        <span class="token-item">
          <span class="token-dot" style="background:${color}"></span>
          Total
          <strong style="color:${color}">${total.toLocaleString()}</strong>
        </span>
      </div>
    </div>`;
}

// ════════════════════════════════════════════════════════════════════
//  TOAST
// ════════════════════════════════════════════════════════════════════
let _toastTimer;
function showToast(msg, kind = 'ok') {
  const t = el('toast'), m = el('toastMsg');
  if (t && m) {
    m.textContent = msg;
    t.className = 'show ' + kind;
    clearTimeout(_toastTimer);
    _toastTimer = setTimeout(() => { t.className = ''; }, 3500);
  }
}

// ════════════════════════════════════════════════════════════════════
//  MAIN VIEW STATE
// ════════════════════════════════════════════════════════════════════
function setMainView(v) {
  const empty   = el('emptyState');
  const loading = el('loadingState');
  const main    = el('mainArea');
  const grid    = el('bookGrid');
  const pv      = el('pageView');
  const pe      = el('pageEdit');
  const dp      = el('detailPanel');

  if (v === 'page-view' || v === 'page-edit') {
    if (main) main.style.display = 'none';
    if (dp) { dp.style.display = 'none'; dp.classList.remove('panel-open'); }
    if (pv) pv.classList.toggle('active', v === 'page-view');
    if (pe) pe.classList.toggle('active', v === 'page-edit');
    if (empty) { empty.style.display = 'none'; empty.classList.add('hidden'); }
    if (loading) { loading.style.display = 'none'; loading.classList.add('hidden'); }
    if (grid) { grid.style.display = 'none'; grid.classList.add('hidden'); }
    const sw = el('searchWrap'); if (sw) sw.style.display = 'none';
    const bi = el('btnImport'); if (bi) bi.classList.add('hidden');
    return;
  }

  if (pv) pv.classList.remove('active');
  if (pe) pe.classList.remove('active');
  if (main) main.style.display = 'flex';

  if (empty) {
    empty.style.display   = (v === 'empty')   ? 'flex' : 'none';
    if (v === 'empty') empty.classList.remove('hidden');
    else empty.classList.add('hidden');
  }
  if (loading) {
    loading.style.display  = (v === 'loading') ? 'flex' : 'none';
    if (v === 'loading') loading.classList.remove('hidden');
    else loading.classList.add('hidden');
  }
  if (grid)    grid.style.display     = (v === 'grid') ? '' : 'none';
  if (v === 'grid') grid?.classList.remove('hidden');
  else grid?.classList.add('hidden');

  const sw = el('searchWrap');
  if (sw) sw.style.display = v === 'grid' ? '' : 'none';

  const bi = el('btnImport');
  if (bi) bi.classList.toggle('hidden', v !== 'grid');
}

// ════════════════════════════════════════════════════════════════════
//  CARD GRID — RENDERING
// ════════════════════════════════════════════════════════════════════
let _cardIdCounter = 0;

function buildCardEl(card) {
  const name     = card.name || 'Unnamed';
  const tags     = card.tags || [];
  const width    = card.width || 0;
  const height   = card.height || 0;
  const filePath = card.file_path || '';
  const gradient = coverGradient(name);
  const cardId   = 'cw-' + (_cardIdCounter++);

  const tagHtml = tags.slice(0, 3).map(t => {
    const [bg, fg] = tagColors(t);
    return `<span class="tag-pill" style="background:${bg};color:${fg}">${esc(t)}</span>`;
  }).join('');

  const cardEl = document.createElement('article');
  cardEl.className = 'book-card';
  cardEl.dataset.name = name.toLowerCase();
  cardEl.dataset.tags = tags.join(',').toLowerCase();
  cardEl.dataset.path = filePath;
  cardEl.innerHTML = `
    <div class="cover-wrap" data-cid="${cardId}">
      <img alt="${esc(name)}" style="width:100%;height:100%;object-fit:cover;position:relative;z-index:1;">
      <div class="fallback-art absolute inset-0 items-center justify-center" style="background:${gradient}">
        <span class="text-4xl font-bold text-white/30 select-none">${esc(firstChar(name))}</span>
      </div>
      <div class="name-overlay">
        <p class="text-white text-sm font-bold leading-tight drop-shadow-lg">${esc(name)}</p>
        <p class="text-white/60 text-[10px] mt-0.5">${width} × ${height}</p>
      </div>
    </div>
    <div class="mt-2 px-0.5">
      <p class="text-[0.75rem] font-semibold text-gray-200 truncate leading-tight">${esc(name)}</p>
      ${tagHtml ? `<div class="flex flex-wrap gap-1 mt-1">${tagHtml}</div>` : ''}
    </div>`;

  const img       = cardEl.querySelector('img');
  const coverWrap = cardEl.querySelector('.cover-wrap');
  const fallback  = cardEl.querySelector('.fallback-art');

  img.onerror = function () { this.style.display = 'none'; };
  img.onload  = function () { fallback.style.display = 'none'; };

  if (filePath) {
    const observer = new IntersectionObserver((entries, obs) => {
      if (entries[0].isIntersecting) {
        fileUriAsync(filePath).then(uri => { if (uri) img.src = uri; }).catch(() => {});
        obs.unobserve(coverWrap);
      }
    }, { rootMargin: '200px' });
    observer.observe(coverWrap);
  }

  cardEl.addEventListener('click', () => openDetail(card));
  return cardEl;
}

function renderGrid(cards) {
  setMainView('grid');
  const grid = el('bookGrid');
  if (!grid) return;

  if (cards.length === 0) {
    grid.innerHTML = `<div style="display:flex;flex-direction:column;align-items:center;justify-content:center;py-24;text-align:center;width:100%;">
      <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="#2a2d3d" stroke-width="1.5" class="mb-4"><circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/></svg>
      <p style="color:#666;font-size:0.85rem;">No matching cards</p>
      <p style="color:#666;font-size:0.72rem;margin-top:6px;">Try changing the keyword or load another folder</p>
    </div>`;
    return;
  }
  const frag = document.createDocumentFragment();
  for (const c of cards) frag.appendChild(buildCardEl(c));
  grid.replaceChildren(frag);
  grid.dataset.populated = '1';
}

// ════════════════════════════════════════════════════════════════════
//  SORT
// ════════════════════════════════════════════════════════════════════
function sortCards(cards) {
  const arr = [...cards];
  switch (state.sortBy) {
    case 'name_asc':
      return arr.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
    case 'name_desc':
      return arr.sort((a, b) => (b.name || '').localeCompare(a.name || ''));
    case 'tokens_asc':
      return arr.sort((a, b) => calcCardTokens(a).total - calcCardTokens(b).total);
    case 'tokens_desc':
      return arr.sort((a, b) => calcCardTokens(b).total - calcCardTokens(a).total);
    case 'tags':
      return arr.sort((a, b) => (b.tags?.length || 0) - (a.tags?.length || 0));
    case 'creator':
      return arr.sort((a, b) => (a.creator || 'zzz').localeCompare(b.creator || 'zzz'));
    default:
      return arr;
  }
}

// ════════════════════════════════════════════════════════════════════
//  SEARCH + TAG FILTER
// ════════════════════════════════════════════════════════════════════
let _filterTimer;
function applyFilter() {
  clearTimeout(_filterTimer);
  _filterTimer = setTimeout(() => {
    const q = (el('searchInput')?.value || '').trim().toLowerCase();
    state.searchQuery = q;
    const grid = el('bookGrid');

    // In-place DOM filter: hide/show existing cards instead of rebuilding
    if (grid && grid.dataset.populated === '1' && state.sortBy === 'default') {
      let visibleCount = 0;
      const cards = grid.querySelectorAll('.book-card');
      for (const cardEl of cards) {
        const nameMatch = !q || (cardEl.dataset.name || '').includes(q);
        const tagMatch  = !q || (cardEl.dataset.tags || '').includes(q);
        const activeOk  = !state.activeTag || (cardEl.dataset.tags || '').includes(state.activeTag.toLowerCase());
        const show = (nameMatch || tagMatch) && activeOk;
        cardEl.style.display = show ? '' : 'none';
        if (show) visibleCount++;
      }
      if (visibleCount === 0) {
        grid.innerHTML = `<div style="display:flex;flex-direction:column;align-items:center;justify-content:center;padding:40px 20px;text-align:center;width:100%;grid-column:1/-1;">
          <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="#2a2d3d" stroke-width="1.5" style="margin-bottom:12px;"><circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/></svg>
          <p style="color:#666;font-size:0.85rem;">No matching cards</p>
          <p style="color:#555;font-size:0.72rem;margin-top:6px;">Try changing the keyword or tag filter</p>
        </div>`;
        grid.dataset.populated = '0';
      }
      return;
    }

    // First render or fallback: full rebuild
    if (!q && !state.activeTag) {
      state.filtered = [...state.allCards];
    } else {
      state.filtered = state.allCards.filter(c => {
        const nameOk  = (c.name || '').toLowerCase().includes(q);
        const tagOk   = (c.tags || []).some(t => t.toLowerCase().includes(q));
        const altOk   = (c.alternate_greetings || []).some(g => g.toLowerCase().includes(q));
        const activeOk = state.activeTag ? (c.tags || []).includes(state.activeTag) : true;
        return (nameOk || tagOk || altOk) && activeOk;
      });
    }
    state.filtered = sortCards(state.filtered);
    renderGrid(state.filtered);
  }, 80);
}

// ════════════════════════════════════════════════════════════════════
//  TAG CLOUD
// ════════════════════════════════════════════════════════════════════
let _lastTagHash = null;

function buildTagCloud(cards) {
  const allTags = {};
  for (const c of cards) for (const t of (c.tags || [])) allTags[t] = (allTags[t] || 0) + 1;
  const entries = Object.entries(allTags).sort((a, b) => b[1] - a[1]);

  // Skip rebuild if tags haven't changed
  const hash = JSON.stringify(entries);
  if (hash === _lastTagHash) return;
  _lastTagHash = hash;

  const tagEl = el('tagCloud');
  if (!tagEl) return;
  if (!entries.length) {
    tagEl.innerHTML = '<p style="font-size:0.7rem;color:#3e4260;font-style:italic;padding:0 4px;">No tags yet</p>';
    return;
  }
  tagEl.innerHTML = entries.map(([tag, count]) => {
    const [bg, fg] = tagColors(tag);
    const dimmed = state.activeTag && state.activeTag !== tag ? 'opacity-30' : '';
    return `<span class="tag-pill ${dimmed}" style="background:${bg};color:${fg}" data-tag="${esc(tag)}">${esc(tag)}
            <span style="opacity:0.5;margin-left:2px;font-size:0.6rem">${count}</span></span>`;
  }).join('');
  $$('.tag-pill', tagEl).forEach(el => {
    el.addEventListener('click', () => {
      const t = el.dataset.tag;
      state.activeTag = state.activeTag === t ? null : t;
      $$('.tag-pill', tagEl).forEach(p => p.classList.toggle('opacity-30', state.activeTag && state.activeTag !== p.dataset.tag));
      applyFilter();
    });
  });
}

// ════════════════════════════════════════════════════════════════════
//  FOLDER PICKER
// ════════════════════════════════════════════════════════════════════
async function pickFolder() {
  if (state.pickLock) return;
  state.pickLock = true;
  setMainView('loading');
  try {
    const path = await invoke('pick_folder');
    if (!path) { setMainView('empty'); return; }

    const tc = el('treeCount');
    if (tc) tc.textContent = '…';

    // scan_folder mengembalikan ScanResult { flat_cards, subfolder_cards, total_pngs }
    const result = await invoke('scan_folder', { path, recursive: true });
    const flat_cards   = result?.flat_cards   ?? [];
    const sub_cards    = result?.subfolder_cards ?? [];
    const total_pngs   = result?.total_pngs   ?? 0;

    const allCards = [...flat_cards, ...sub_cards.flatMap(s => s.cards)];
    state.allCards = allCards;
    state.filtered = [...state.allCards];
    _lastTagHash = null;

    const parts = path.split(/[\\/]+/).filter(Boolean);
    const label = parts[parts.length - 1] || path;
    const rl = el('treeRootLabel');
    if (rl) rl.textContent = label + (path.endsWith('/') ? '' : '/');

    // Count display: total cards found (flat + subfolder)
    const cardCount = allCards.length;
    if (tc) tc.textContent =
      `${cardCount} card${cardCount !== 1 ? 's' : ''}` +
      (total_pngs > cardCount ? ` · ${total_pngs} PNG` : '');

    buildTagCloud(state.allCards);

    if (allCards.length === 0) {
      // Folder selected but no character cards detected
      if (total_pngs > 0) {
        renderGrid_msg('No Tavern v2 character cards found',
          `${total_pngs} PNG file(s) found but none have a "chara" chunk (not a Tavern V2 character card).`);
      } else {
        renderGrid_msg('No PNG files in this folder',
          'Make sure the folder contains PNG files with Tavern V2 character metadata.');
      }
    } else {
      renderGrid(state.filtered);
    }
  } catch (err) {
    console.error(err);
    // Keep folder label visible so user knows which folder failed
    showToast('Failed to scan folder: ' + (err.message || String(err)), 'err');
    setMainView('empty');
  } finally {
    state.pickLock = false;
  }
}

// Helper: render grid-level message when no cards available
function renderGrid_msg(title, detail) {
  setMainView('grid');
  const grid = el('bookGrid');
  if (!grid) return;
  grid.innerHTML = `<div style="display:flex;flex-direction:column;align-items:center;justify-content:center;py-24;text-align:center;width:100%;">
    <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="#2a2d3d" stroke-width="1.5" class="mb-4">
      <circle cx="12" cy="12" r="10"/><path d="M16 16s-1.5-2-4-2-4 2-4 2"/><line x1="9" y1="9" x2="9.01" y2="9"/><line x1="15" y1="9" x2="15.01" y2="9"/>
    </svg>
    <p style="color:#888;font-size:0.9rem;font-weight:600;">${esc(title)}</p>
    <p style="color:#555;font-size:0.75rem;margin-top:6px;max-width:320px;line-height:1.5;">${esc(detail)}</p>
  </div>`;
}

// ════════════════════════════════════════════════════════════════════
//  FILE IMPORT
// ════════════════════════════════════════════════════════════════════
async function handleImportFile(file) {
  if (!file) return;
  const statusEl = el('importStatus');
  if (statusEl) { statusEl.textContent = ''; statusEl.className = ''; }

  try {
    if (file.name.toLowerCase().endsWith('.json')) {
      const text = await file.text();
      const json = JSON.parse(text);
      if (!json.file_path) throw new Error('JSON does not contain file_path');

      const result = await invoke('update_card_metadata', { filePath: json.file_path, updates: json });

      const idx = state.allCards.findIndex(c => c.file_path === result.file_path);
      if (idx !== -1) state.allCards[idx] = result;
      else state.allCards.unshift(result);
      state.filtered = [...state.allCards];
      buildTagCloud(state.allCards);
      renderGrid(state.filtered);

      showToast('Character updated from JSON ✓');
      if (statusEl) { statusEl.textContent = 'Success: ' + (result.name || json.name); statusEl.style.color = '#4ade80'; }
    } else if (file.name.toLowerCase().endsWith('.png')) {
      const arrayBuf = await file.arrayBuffer();
      const uint8 = new Uint8Array(arrayBuf);
      let found = false;
      let meta = null;

      const SIG = [137, 80, 78, 71, 13, 10, 26, 10];
      if (uint8.length < 8) throw new Error('Not a valid PNG file');
      for (let i = 0; i < 8; i++) { if (uint8[i] !== SIG[i]) throw new Error('Not a valid PNG file'); }

      let off = 8;
      while (off + 8 <= uint8.length) {
        const length = readU32BE(uint8, off);
        const kind = readKind(uint8, off + 4);
        const chunkEnd = off + 4 + 4 + length + 4;
        if (chunkEnd > uint8.length) break;

        if ((kind === 'tEXt' || kind === 'iTXt') && length >= 1) {
          const data = uint8.slice(off + 8, off + 8 + length);
          if (kind === 'tEXt') {
            const nullIdx = data.indexOf(0);
            if (nullIdx >= 0) {
              const keyword = new TextDecoder().decode(data.slice(0, nullIdx)).toLowerCase();
              if (keyword === 'chara') {
                found = true;
                const val = new TextDecoder().decode(data.slice(nullIdx + 1));
                meta = parseCharaChunk(val);
                break;
              }
            }
          }
        }
        off = chunkEnd;
      }

      if (!found) {
        showToast('This PNG is not a Tavern V2 character card', 'err');
        if (statusEl) { statusEl.textContent = 'Not a character card'; statusEl.style.color = '#f87171'; }
        return;
      }

      if (meta) {
        try {
          const dialogModule = await import('@tauri-apps/plugin-dialog');
          const filePath = await dialogModule.saveFile({
            title: 'Save Character Card',
            defaultPath: (meta.name || 'character').replace(/[^a-zA-Z0-9]/g, '_') + '.png',
          });

          if (!filePath) return;

          const fsModule = await import('@tauri-apps/plugin-fs');
          await fsModule.writeBinaryFile({ path: filePath, contents: Array.from(uint8) });

          const result = await invoke('get_card_metadata', { filePath: filePath });

          state.allCards.unshift(result);
          state.filtered = [...state.allCards];
          buildTagCloud(state.allCards);
          renderGrid(state.filtered);

          showToast('Character imported & saved ✓');
          if (statusEl) { statusEl.textContent = 'Success: ' + (result.name || 'Unnamed'); statusEl.style.color = '#4ade80'; }
        } catch (e) {
          // Fallback: add to list without saving
          state.allCards.unshift(meta);
          state.filtered = [...state.allCards];
          buildTagCloud(state.allCards);
          renderGrid(state.filtered);
          showToast('Character found & added (preview mode) ✓');
        }
      } else {
        showToast('Valid PNG file but could not be fully read', 'err');
      }
    } else {
      showToast('Unsupported file format. Use .png or .json', 'err');
    }
  } catch (err) {
    console.error(err);
    showToast('Import failed: ' + (err.message || String(err)), 'err');
    if (statusEl) { statusEl.textContent = 'Failed: ' + (err.message || String(err)); statusEl.style.color = '#f87171'; }
  }
}

function readU32BE(buf, off) {
  return ((buf[off] << 24) | (buf[off + 1] << 16) | (buf[off + 2] << 8) | buf[off + 3]) >>> 0;
}

function readKind(buf, off) {
  return String.fromCharCode(buf[off], buf[off+1], buf[off+2], buf[off+3]);
}

function parseCharaChunk(raw) {
  const trimmed = raw.trim();
  let val = null;
  try { val = JSON.parse(trimmed); } catch {}

  if (val) {
    if (val.data) {
      const d = val.data;
      return {
        name: d.name || '',
        description: d.description || '',
        personality: d.personality || '',
        scenario: d.scenario || '',
        first_mes: d.first_mes || '',
        mes_example: d.mes_example || '',
        creator: d.creator || '',
        creator_notes: d.creator_notes || '',
        system_prompt: d.system_prompt || '',
        post_history_instructions: d.post_history_instructions || '',
        character_version: d.character_version || '',
        tags: (d.tags && Array.isArray(d.tags)) ? d.tags : [],
        alternate_greetings: (d.alternate_greetings && Array.isArray(d.alternate_greetings)) ? d.alternate_greetings : [],
        character_note: (d.extensions && d.extensions.depth_prompt && d.extensions.depth_prompt.prompt) || '',
        character_note_depth: String((d.extensions && d.extensions.depth_prompt && d.extensions.depth_prompt.depth) || ''),
        talkativeness: (d.extensions && d.extensions.talkativeness) || '',
        chara_source: d.chara_source || '',
        tags_alt: (d.alternative && d.alternative.tags_alt && Array.isArray(d.alternative.tags_alt)) ? d.alternative.tags_alt : [],
        name_alt: (d.alternative && d.alternative.name_alt) || '',
        description_alt: (d.alternative && d.alternative.description_alt) || '',
        personality_alt: (d.alternative && d.alternative.personality_alt) || '',
        scenario_alt: (d.alternative && d.alternative.scenario_alt) || '',
        first_mes_alt: (d.alternative && d.alternative.first_mes_alt) || '',
        mes_example_alt: (d.alternative && d.alternative.mes_example_alt) || '',
        creator_alt: (d.alternative && d.alternative.creator_alt) || '',
        creator_notes_alt: (d.alternative && d.alternative.creator_notes_alt) || '',
        system_prompt_alt: (d.alternative && d.alternative.system_prompt_alt) || '',
        post_history_instructions_alt: (d.alternative && d.alternative.post_history_instructions_alt) || '',
        character_version_alt: (d.alternative && d.alternative.character_version_alt) || '',
        alternate_greetings_alt: (d.alternative && d.alternative.alternate_greetings_alt && Array.isArray(d.alternative.alternate_greetings_alt)) ? d.alternative.alternate_greetings_alt : [],
        talkativeness_alt: (d.alternative && d.alternative.extensions_alt && d.alternative.extensions_alt.talkativeness_alt) || '',
        character_note_alt: (d.alternative && d.alternative.extensions_alt && d.alternative.extensions_alt.depth_prompt_alt && d.alternative.extensions_alt.depth_prompt_alt.prompt_alt) || '',
        character_note_depth_alt: (d.alternative && d.alternative.extensions_alt && d.alternative.extensions_alt.depth_prompt_alt && d.alternative.extensions_alt.depth_prompt_alt.depth_alt) || '',
      };
    }
    // Flat v1
    return {
      name: val.name || '',
      description: val.description || '',
      personality: val.personality || '',
      scenario: val.scenario || '',
      first_mes: val.first_mes || '',
      mes_example: val.mes_example || '',
      creator: val.creator || '',
      creator_notes: val.creator_notes || '',
      system_prompt: val.system_prompt || '',
      post_history_instructions: val.post_history_instructions || '',
      character_version: val.character_version || '',
      tags: (val.tags && Array.isArray(val.tags)) ? val.tags : [],
      alternate_greetings: (val.alternate_greetings && Array.isArray(val.alternate_greetings)) ? val.alternate_greetings : [],
      character_note: val.character_note || '',
      character_note_depth: String(val.character_note_depth || ''),
      talkativeness: val.talkativeness || '',
      chara_source: val.chara_source || '',
      tags_alt: val.tags_alt || [],
      name_alt: val.name_alt || '',
      description_alt: val.description_alt || '',
      personality_alt: val.personality_alt || '',
      scenario_alt: val.scenario_alt || '',
      first_mes_alt: val.first_mes_alt || '',
      mes_example_alt: val.mes_example_alt || '',
      creator_alt: val.creator_alt || '',
      creator_notes_alt: val.creator_notes_alt || '',
      system_prompt_alt: val.system_prompt_alt || '',
      post_history_instructions_alt: val.post_history_instructions_alt || '',
      character_version_alt: val.character_version_alt || '',
      alternate_greetings_alt: val.alternate_greetings_alt || [],
      talkativeness_alt: val.talkativeness_alt || '',
      character_note_alt: val.character_note_alt || '',
      character_note_depth_alt: val.character_note_depth_alt || '',
    };
  }

  // Fallback: key=value/k:v lines
  const result = { name:'',description:'',personality:'',scenario:'',first_mes:'',mes_example:'' };
  for (const line of trimmed.split('\n')) {
    const l = line.trim();
    if (!l) continue;
    for (const sep of ['=', ':']) {
      if (l.includes(sep)) {
        const [k, ...rest] = l.split(sep);
        const v = rest.join(sep).trim().replace(/^"|"$/g, '');
        const key = k.trim().toLowerCase();
        if (key === 'name') result.name = v;
        else if (['desc','description','descriptions'].includes(key)) result.description = v;
        else if (key === 'personality') result.personality = v;
        else if (key === 'scenario') result.scenario = v;
        else if (['first_mes','firstmes','first message'].some(m => key === m)) result.first_mes = v;
        else if (['mes_example','mesexample'].includes(key)) result.mes_example = v;
        break;
      }
    }
  }
  return result;
}

// ════════════════════════════════════════════════════════════════════
//  INSPECTOR — VIEW MODE
// ════════════════════════════════════════════════════════════════════
function setInspectCover(imgPath, name, creator, version) {
  const coverEl = el('inspectorCover');
  if (!coverEl) return;
  coverEl.style.background = coverGradient(name);
  coverEl.innerHTML = '';

  const img = document.createElement('img');
  img.className = 'absolute inset-0 w-full h-full object-cover';
  img.loading = 'lazy';
  img.onerror = function () { this.style.display = 'none'; };
  coverEl.appendChild(img);

  // Async load image
  if (imgPath) {
    fileUriAsync(imgPath).then(dataUri => {
      if (dataUri) img.src = dataUri;
    }).catch(() => {});
  }

  const overlay = document.createElement('div');
  overlay.className = 'absolute inset-0 bg-gradient-to-t from-black/80 via-transparent to-black/0';
  coverEl.appendChild(overlay);

  const info = document.createElement('div');
  info.className = 'absolute inset-0 flex items-end p-4 pointer-events-none';
  info.innerHTML = `
    <div>
      <p style="font-size:1.1rem;font-weight:700;color:#fff;text-shadow:0 1px 8px rgba(0,0,0,.6);">${esc(name || '—')}</p>
      <p style="font-size:0.65rem;color:rgba(255,255,255,.6);margin-top:2px;">${creator ? 'by ' + esc(creator) + (version ? ' · v' + esc(version) : '') : ''}</p>
    </div>`;
  coverEl.appendChild(info);
}

function buildViewFields(card) {
  const cont = el('viewFields');
  if (!cont) return;
  cont.innerHTML = '';

  // Tags
  if (card.tags && card.tags.length > 0) {
    const tagsHtml = card.tags.map(t => {
      const [bg, fg] = tagColors(t);
      return `<span class="tag-pill" style="background:${bg};color:${fg}">${esc(t)}</span>`;
    }).join('');
    const tagSection = document.createElement('div');
    tagSection.className = 'flex flex-col gap-1';
    tagSection.innerHTML = `<span style="color:#666;font-weight:600;font-size:0.65rem;margin-bottom:4px;">Tags</span><div class="flex flex-wrap gap-1">${tagsHtml}</div>`;
    cont.appendChild(tagSection);
  }

  // Personality snippet
  if (card.personality) {
    const row = document.createElement('div');
    row.className = 'field-row is-long';
    row.innerHTML = `<span class="text-gray-500 shrink-0" style="font-size:0.72rem;">Personality</span><span class="text-gray-300 leading-relaxed" style="font-size:0.72rem;">${esc(shortName(card.personality, 120))}</span>`;
    cont.appendChild(row);
  }

  // Scenario snippet
  if (card.scenario) {
    const row = document.createElement('div');
    row.className = 'field-row is-long';
    row.innerHTML = `<span class="text-gray-500 shrink-0" style="font-size:0.72rem;">Scenario</span><span class="text-gray-300 leading-relaxed" style="font-size:0.72rem;">${esc(shortName(card.scenario, 120))}</span>`;
    cont.appendChild(row);
  }

  // Talkativeness bar
  if (card.talkativeness) {
    const pct = Math.round(parseFloat(card.talkativeness) * 100);
    const row = document.createElement('div');
    row.className = 'field-row is-long';
    row.innerHTML = `<span class="text-gray-500 shrink-0" style="font-size:0.72rem;">Talkativeness</span><div style="width:100%;"><div style="width:100%;height:6px;background:rgba(255,255,255,.06);border-radius:3px;overflow:hidden;"><div style="width:${pct}%;height:100%;background:linear-gradient(90deg,#6366f1,#a78bfa);border-radius:3px;"></div></div><span style="font-size:0.6rem;color:#666;margin-top:2px;">${pct}%</span></div>`;
    cont.appendChild(row);
  }

  // Alternate greetings count
  if (card.alternate_greetings && card.alternate_greetings.length > 0) {
    const n = card.alternate_greetings.length;
    const row = document.createElement('div');
    row.className = 'field-row';
     row.innerHTML = `<span class="text-gray-500 shrink-0" style="font-size:0.72rem;">Alternate Greetings</span><span class="text-gray-300 text-right" style="font-size:0.72rem;">${n} alternate</span>`;
    cont.appendChild(row);
  }

  // Version
  if (card.character_version) {
    const row = document.createElement('div');
    row.className = 'field-row';
     row.innerHTML = `<span class="text-gray-500 shrink-0" style="font-size:0.72rem;">Version</span><span class="text-gray-300 text-right" style="font-size:0.72rem;">v${esc(card.character_version)}</span>`;
    cont.appendChild(row);
  }
}

function openDetail(card) {
  state.card = card;
  state.editMode = false;

  setInspectCover(card.file_path, card.name, card.creator, card.character_version);

  const f = el('inspectorFile'), p = el('inspectorPath'),
        n = el('viewName'), c = el('viewCreator'), s = el('inspectorStatus');
  if (f) f.textContent = card.file_name || '';
  if (p) p.textContent = card.file_path || '';
  if (n) n.textContent = card.name || '—';
  if (c) c.textContent = (card.creator ? 'by ' + esc(card.creator) : '') +
    (card.character_version ? ' · v' + esc(card.character_version) : '');
  if (s) s.textContent = card.file_name ? formatSize(card.file_size) : '';

  buildViewFields(card);

  const vc = el('viewContent');
  if (vc) vc.classList.remove('hidden');

  const panel = el('detailPanel');
  if (panel) {
    panel.classList.add('panel-open');
    panel.style.display = 'flex';
    panel.style.opacity = '0';
    requestAnimationFrame(() => {
      panel.style.transition = 'opacity 200ms';
      panel.style.opacity = '1';
    });
  }
}

function openPageView(card) {
  if (!card) {
    console.error('openPageView called with null/undefined card');
    return;
  }

  const c = {
    ...card,
    name: card.name || '',
    creator: card.creator || '',
    character_version: card.character_version || '',
    chara_source: card.chara_source || '',
    description: card.description || '',
    personality: card.personality || '',
    scenario: card.scenario || '',
    first_mes: card.first_mes || '',
    mes_example: card.mes_example || '',
    system_prompt: card.system_prompt || '',
    post_history_instructions: card.post_history_instructions || '',
    creator_notes: card.creator_notes || '',
    character_note: card.character_note || '',
    talkativeness: card.talkativeness || '',
    character_note_depth: card.character_note_depth || '',
    tags: card.tags || [],
    alternate_greetings: card.alternate_greetings || [],
    name_alt: card.name_alt || '',
    description_alt: card.description_alt || '',
    personality_alt: card.personality_alt || '',
    scenario_alt: card.scenario_alt || '',
    first_mes_alt: card.first_mes_alt || '',
    mes_example_alt: card.mes_example_alt || '',
    creator_alt: card.creator_alt || '',
    creator_notes_alt: card.creator_notes_alt || '',
    system_prompt_alt: card.system_prompt_alt || '',
    post_history_instructions_alt: card.post_history_instructions_alt || '',
    character_version_alt: card.character_version_alt || '',
    tags_alt: card.tags_alt || [],
    alternate_greetings_alt: card.alternate_greetings_alt || [],
    extras: card.extras || [],
    raw_chunk_value: card.raw_chunk_value || '',
    file_name: card.file_name || '',
    file_path: card.file_path || '',
    file_size: card.file_size || 0,
  };

  state.card = c;
  state.editMode = false;
  setMainView('page-view');

  el('detailTokens').innerHTML = renderTokenBadge(c);

  const cont = el('pageViewContent');
  if (!cont) return;
  cont.innerHTML = '';

  // Create two-column layout
  const layout = document.createElement('div');
  layout.className = 'detail-layout';

  // ═══ SIDEBAR (LEFT) ═══
  const sidebar = document.createElement('div');
  sidebar.className = 'detail-sidebar';

  // Cover image - full image, not cropped
  const coverImg = document.createElement('img');
  coverImg.className = 'detail-cover-img';
  coverImg.style.background = coverGradient(c.name);
  coverImg.alt = c.name || '';
  coverImg.onerror = function () { this.style.display = 'none'; };
  sidebar.appendChild(coverImg);
  if (c.file_path) {
    fileUriAsync(c.file_path).then(dataUri => {
      if (dataUri) coverImg.src = dataUri;
    }).catch(() => {});
  }

  // Meta info box
  const metaBox = document.createElement('div');
  metaBox.className = 'detail-meta';
  const metaItems = [
    ['Name', c.name],
    ['Creator', c.creator],
    ['Version', c.character_version],
    ['Source', c.chara_source],
    ['File', c.file_name],
    ['Size', c.file_size ? formatSize(c.file_size) : ''],
  ];
  for (const [label, val] of metaItems) {
    if (!val) continue;
    const row = document.createElement('div');
    row.className = 'detail-meta-row';
    row.innerHTML = `<span class="detail-meta-label">${esc(label)}</span><span class="detail-meta-value">${esc(val)}</span>`;
    metaBox.appendChild(row);
  }
  sidebar.appendChild(metaBox);

  // Tags in sidebar
  if (c.tags && c.tags.length > 0) {
    const tagsBox = document.createElement('div');
    tagsBox.className = 'detail-tags';
    const tagsHtml = c.tags.map(t => {
      const [bg, fg] = tagColors(t);
      return `<span class="tag-pill" style="background:${bg};color:${fg}">${esc(t)}</span>`;
    }).join('');
    tagsBox.innerHTML = tagsHtml;
    sidebar.appendChild(tagsBox);
  }

  // Talkativeness bar in sidebar
  if (c.talkativeness) {
    const pct = Math.round(parseFloat(c.talkativeness) * 100);
    const talkBox = document.createElement('div');
    talkBox.className = 'detail-meta';
    talkBox.innerHTML = `<div class="detail-meta-row"><span class="detail-meta-label">Talkativeness</span><span class="detail-meta-value">${pct}%</span></div>
      <div class="page-bar-track"><div class="page-bar-fill" style="width:${pct}%;"></div></div>`;
    sidebar.appendChild(talkBox);
  }

  layout.appendChild(sidebar);

  // ═══ MAIN CONTENT (RIGHT) ═══
  const main = document.createElement('div');
  main.className = 'detail-main';

  const addSection = (title, fields) => {
    const hasAny = fields.some(([, v]) => v != null && String(v).trim());
    if (!hasAny) return;

    const section = document.createElement('div');
    section.className = 'page-section';

    const header = document.createElement('div');
    header.className = 'page-section-header';
    header.innerHTML = `<span>${esc(title)}</span><span style="margin-left:auto;font-size:0.6rem;color:#555;">▼</span>`;

    const body = document.createElement('div');
    body.className = 'page-section-body open';

    for (const [label, raw] of fields) {
      const val = raw != null ? String(raw) : '';
      if (!val.trim()) continue;
      const fWrap = document.createElement('div');
      const lbl = document.createElement('div');
      lbl.className = 'page-field-label';
      lbl.textContent = label;
      const valEl = document.createElement('div');
      valEl.className = 'page-field-value';
      valEl.textContent = val;
      fWrap.appendChild(lbl);
      fWrap.appendChild(valEl);
      body.appendChild(fWrap);
    }

    header.onclick = () => {
      body.classList.toggle('open');
      header.querySelector('span:last-child').textContent = body.classList.contains('open') ? '▼' : '▶';
    };

    section.appendChild(header);
    section.appendChild(body);
    main.appendChild(section);
  };

  // Character
  addSection('Character', [
    ['Description', c.description],
    ['Personality', c.personality],
    ['Scenario', c.scenario],
    ['First Message', c.first_mes],
    ['Dialogue Examples', c.mes_example],
  ]);

  // Advanced Settings
  addSection('Advanced Settings', [
    ['System Prompt', c.system_prompt],
    ['Jailbreak', c.post_history_instructions],
    ['Creator Notes', c.creator_notes],
    ['Character Note', c.character_note],
  ]);

  // Alternate Greetings
  if (c.alternate_greetings && c.alternate_greetings.length > 0) {
    const greetFields = c.alternate_greetings.map((g, i) => [`Alternate #${i + 1}`, g]);
    addSection(`Alternate Greetings (${c.alternate_greetings.length})`, greetFields);
  }

  // Translation / Alternative
  const altFields = [
    ['Name (alt)', c.name_alt],
    ['Description (alt)', c.description_alt],
    ['Personality (alt)', c.personality_alt],
    ['Scenario (alt)', c.scenario_alt],
    ['First Message (alt)', c.first_mes_alt],
    ['Dialogue Examples (alt)', c.mes_example_alt],
    ['Creator (alt)', c.creator_alt],
    ['Creator Notes (alt)', c.creator_notes_alt],
    ['System Prompt (alt)', c.system_prompt_alt],
    ['Jailbreak (alt)', c.post_history_instructions_alt],
    ['Version (alt)', c.character_version_alt],
  ];
  const hasAlt = altFields.some(([, v]) => v != null && String(v).trim());
  const hasAltTags = c.tags_alt && c.tags_alt.length > 0;
  const hasAltGreetings = c.alternate_greetings_alt && c.alternate_greetings_alt.length > 0;
  if (hasAlt || hasAltTags || hasAltGreetings) {
    const allAltFields = [...altFields];
    if (hasAltTags) {
      allAltFields.push(['Tags (alt)', c.tags_alt.join(', ')]);
    }
    if (hasAltGreetings) {
      c.alternate_greetings_alt.forEach((g, i) => {
        allAltFields.push([`Greeting Alt #${i + 1}`, g]);
      });
    }
    addSection('Translation / Alternative', allAltFields);
  }

  // Extras
  if (c.extras && c.extras.length > 0) {
    const extrasFields = c.extras.map(([k, v]) => [k, v]);
    addSection('Extras', extrasFields);
  }

  // Raw chunk
  if (c.raw_chunk_value) {
    const section = document.createElement('div');
    section.className = 'page-section';
    const header = document.createElement('div');
    header.className = 'page-section-header';
    header.innerHTML = `<span>Raw Chunk</span><span style="margin-left:auto;font-size:0.6rem;color:#555;">▶</span>`;
    const body = document.createElement('div');
    body.className = 'page-section-body';
    const pre = document.createElement('pre');
    pre.style.cssText = 'font-size:0.65rem;color:#888;white-space:pre-wrap;word-break:break-all;font-family:monospace;line-height:1.6;';
    pre.textContent = c.raw_chunk_value.slice(0, 5000);
    body.appendChild(pre);
    header.onclick = () => {
      body.classList.toggle('open');
      header.querySelector('span:last-child').textContent = body.classList.contains('open') ? '▼' : '▶';
    };
    section.appendChild(header);
    section.appendChild(body);
    main.appendChild(section);
  }

  layout.appendChild(main);
  cont.appendChild(layout);
}

function openPageEdit(card) {
  if (!card) return;

  const c = {
    ...card,
    name: card.name || '',
    creator: card.creator || '',
    character_version: card.character_version || '',
    chara_source: card.chara_source || '',
    description: card.description || '',
    personality: card.personality || '',
    scenario: card.scenario || '',
    first_mes: card.first_mes || '',
    mes_example: card.mes_example || '',
    system_prompt: card.system_prompt || '',
    post_history_instructions: card.post_history_instructions || '',
    creator_notes: card.creator_notes || '',
    character_note: card.character_note || '',
    talkativeness: card.talkativeness || '',
    character_note_depth: card.character_note_depth || '',
    tags: card.tags || [],
    alternate_greetings: card.alternate_greetings || [],
    name_alt: card.name_alt || '',
    description_alt: card.description_alt || '',
    personality_alt: card.personality_alt || '',
    scenario_alt: card.scenario_alt || '',
    first_mes_alt: card.first_mes_alt || '',
    mes_example_alt: card.mes_example_alt || '',
    creator_alt: card.creator_alt || '',
    creator_notes_alt: card.creator_notes_alt || '',
    system_prompt_alt: card.system_prompt_alt || '',
    post_history_instructions_alt: card.post_history_instructions_alt || '',
    character_version_alt: card.character_version_alt || '',
    tags_alt: card.tags_alt || [],
    alternate_greetings_alt: card.alternate_greetings_alt || [],
    extras: card.extras || [],
    raw_chunk_value: card.raw_chunk_value || '',
    file_name: card.file_name || '',
    file_path: card.file_path || '',
    file_size: card.file_size || 0,
  };

  state.card = c;
  state.editMode = true;
  state.pendingImagePath = null;
  setMainView('page-edit');

  const titleEl = el('pageEditTitle');
  if (titleEl) titleEl.textContent = 'Edit — ' + (c.name || 'Unnamed');

  const cont = el('pageEditContent');
  if (!cont) return;
  cont.innerHTML = '';

  // ═══ TWO-COLUMN LAYOUT ═══
  const layout = document.createElement('div');
  layout.className = 'edit-layout';

  // ── SIDEBAR (LEFT) ──
  const sidebar = document.createElement('div');
  sidebar.className = 'edit-sidebar';

  // Cover image with click-to-change
  const coverWrap = document.createElement('div');
  coverWrap.className = 'edit-cover-wrap';
  coverWrap.id = 'editCoverWrap';

  const coverImg = document.createElement('img');
  coverImg.className = 'edit-cover-img';
  coverImg.id = 'editCoverImg';
  coverImg.style.background = coverGradient(c.name);
  coverImg.alt = c.name || '';
  coverImg.onerror = function () { this.style.display = 'none'; };
  coverWrap.appendChild(coverImg);

  const overlay = document.createElement('div');
  overlay.className = 'edit-cover-overlay';
  overlay.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg><span>Change Image</span>`;
  coverWrap.appendChild(overlay);

  sidebar.appendChild(coverWrap);

  // Hidden file input for image picker
  const fileInput = document.createElement('input');
  fileInput.type = 'file';
  fileInput.id = 'editImageInput';
  fileInput.accept = 'image/*';
  fileInput.style.display = 'none';
  sidebar.appendChild(fileInput);

  // Load current cover image
  if (c.file_path) {
    fileUriAsync(c.file_path).then(dataUri => {
      if (dataUri) coverImg.src = dataUri;
    }).catch(() => {});
  }

  // Click handler for image replacement
  coverWrap.onclick = () => fileInput.click();
  fileInput.onchange = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const objectUrl = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      // Convert any format to PNG via canvas
      const canvas = document.createElement('canvas');
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      canvas.getContext('2d').drawImage(img, 0, 0);

      const pngDataUri = canvas.toDataURL('image/png'); // selalu PNG
      coverImg.src = pngDataUri;
      state.pendingImagePath = pngDataUri; // sudah pasti PNG
      URL.revokeObjectURL(objectUrl); // cleanup
    };
    img.onerror = () => URL.revokeObjectURL(objectUrl);
    img.src = objectUrl;
  };

  // Meta info box
  const metaBox = document.createElement('div');
  metaBox.className = 'edit-meta';
  const metaItems = [
    ['File', c.file_name],
    ['Size', c.file_size ? formatSize(c.file_size) : ''],
    ['Path', c.file_path],
  ];
  for (const [label, val] of metaItems) {
    if (!val) continue;
    const row = document.createElement('div');
    row.className = 'edit-meta-row';
    row.innerHTML = `<span class="edit-meta-label">${esc(label)}</span><span class="edit-meta-value" style="word-break:break-all;">${esc(val)}</span>`;
    metaBox.appendChild(row);
  }
  sidebar.appendChild(metaBox);

  // Tags in sidebar
  if (c.tags && c.tags.length > 0) {
    const tagsBox = document.createElement('div');
    tagsBox.className = 'edit-tags';
    const tagsHtml = c.tags.map(t => {
      const [bg, fg] = tagColors(t);
      return `<span class="tag-pill" style="background:${bg};color:${fg}">${esc(t)}</span>`;
    }).join('');
    tagsBox.innerHTML = tagsHtml;
    sidebar.appendChild(tagsBox);
  }

  layout.appendChild(sidebar);

  // ── MAIN FORM (RIGHT) ──
  const main = document.createElement('div');
  main.className = 'edit-main';

  const LONG_FIELDS = ['description','personality','scenario','first_mes','mes_example','creator_notes','system_prompt','post_history_instructions','character_note'];

  function addSection(title) {
    const t = document.createElement('p');
    t.style.cssText = 'color:#666;font-weight:600;font-size:0.6rem;text-transform:uppercase;letter-spacing:0.06em;margin-bottom:4px;margin-top:10px;';
    t.textContent = title;
    main.appendChild(t);
  }

  function buildRow(field, label) {
    const value = c[field] || '';
    const isLong = LONG_FIELDS.includes(field);
    const rows = isLong ? Math.max(3, Math.min(8, Math.ceil(String(value).length / 80) + 2)) : 1;

    const group = document.createElement('div');
    group.className = 'flex flex-col gap-0.5';

    const lbl = document.createElement('label');
    lbl.className = 'edit-label';
    lbl.setAttribute('for', 'edit-' + field);
    lbl.textContent = label;
    group.appendChild(lbl);

    if (isLong) {
      const ta = document.createElement('textarea');
      ta.id = 'edit-' + field;
      ta.className = 'edit-textarea h-fit';
      ta.rows = rows;
      ta.textContent = value;
      group.appendChild(ta);
    } else {
      const inp = document.createElement('input');
      inp.type = 'text';
      inp.id = 'edit-' + field;
      inp.className = 'edit-input';
      inp.value = value;
      group.appendChild(inp);
    }
    main.appendChild(group);
  }

  addSection('Basic Information');
  buildRow('name', 'Name');
  buildRow('creator', 'Creator');
  buildRow('character_version', 'Version');
  buildRow('chara_source', 'Source');

  addSection('Character');
  buildRow('description', 'Description');
  buildRow('personality', 'Personality');
  buildRow('scenario', 'Scenario');
  buildRow('first_mes', 'First Message');
  buildRow('mes_example', 'Dialogue Examples');

  addSection('Advanced Settings');
  buildRow('system_prompt', 'System Prompt');
  buildRow('post_history_instructions', 'Jailbreak');
  buildRow('creator_notes', 'Creator Notes');
  buildRow('character_note', 'Character Note');

  // Talkativeness slider
  {
    const group = document.createElement('div');
    group.className = 'flex flex-col gap-0.5';
    const lbl = document.createElement('label');
    lbl.className = 'edit-label';
    lbl.textContent = 'Talkativeness';
    group.appendChild(lbl);
    const wrap = document.createElement('div');
    wrap.className = 'flex items-center gap-3';
    const slider = document.createElement('input');
    slider.type = 'range'; slider.className = 'slider';
    slider.min = '0'; slider.max = '1'; slider.step = '0.05';
    slider.value = c.talkativeness || '0.50';
    const span = document.createElement('span');
    span.style.cssText = 'font-size:0.7rem;color:#888;width:36px;text-align:right;';
    span.textContent = Math.round(parseFloat(slider.value) * 100) + '%';
    slider.addEventListener('input', () => {
      span.textContent = Math.round(parseFloat(slider.value) * 100) + '%';
    });
    wrap.appendChild(slider);
    wrap.appendChild(span);
    group.appendChild(wrap);
    main.appendChild(group);
  }

  // Character note depth
  {
    const group = document.createElement('div');
    group.className = 'flex flex-col gap-0.5';
    const lbl = document.createElement('label');
    lbl.className = 'edit-label';
    lbl.textContent = 'Note Depth';
    group.appendChild(lbl);
    const row = document.createElement('div');
    row.className = 'flex items-center gap-2';
    const inp = document.createElement('input');
    inp.type = 'number'; inp.id = 'edit-character_note_depth';
    inp.className = 'edit-input'; inp.min = '0'; inp.max = '99';
    inp.value = c.character_note_depth || '4';
    inp.style.width = '70px';
    const hint = document.createElement('span');
    hint.style.cssText = 'font-size:0.6rem;color:#666;';
    hint.textContent = '(0-99)';
    row.appendChild(inp);
    row.appendChild(hint);
    group.appendChild(row);
    main.appendChild(group);
  }

  // Tags
  {
    const group = document.createElement('div');
    group.className = 'flex flex-col gap-0.5';
    const lbl = document.createElement('label');
    lbl.className = 'edit-label';
    lbl.setAttribute('for', 'edit-tags');
    lbl.textContent = 'Tags';
    group.appendChild(lbl);
    const ta = document.createElement('textarea');
    ta.id = 'edit-tags'; ta.className = 'edit-textarea';
    ta.rows = 2;     ta.placeholder = 'comma-separated…';
    ta.textContent = (c.tags || []).join(', ');
    group.appendChild(ta);
    main.appendChild(group);
  }

  // Alternate greetings (collapsible)
  {
    const group = document.createElement('div');
    group.className = 'flex flex-col gap-0.5';
    const hdr = document.createElement('div');
    hdr.className = 'flex items-center gap-1 cursor-pointer';
    hdr.style.cssText = 'padding:4px 0;cursor:pointer;';
    hdr.innerHTML = `<span style="color:#7b82a8;font-size:0.72rem;font-weight:500;cursor:pointer;">Alternate Greetings</span>
      <span class="alt-chevron" style="font-size:0.6rem;color:#666;margin-left:auto;transition:transform .2s;">▼</span>`;
    hdr.onclick = function () {
      const c = this.nextElementSibling;
      const ch = this.querySelector('.alt-chevron');
      c.classList.toggle('hidden');
      ch.textContent = c.classList.contains('hidden') ? '▶' : '▼';
    };
    group.appendChild(hdr);
    const content = document.createElement('div');
    content.className = 'ml-5 flex flex-col gap-1 mt-1';
    const alts = c.alternate_greetings || [];
    for (let i = 0; i < Math.max(1, alts.length); i++) {
      const ta = document.createElement('textarea');
      ta.className = 'edit-textarea'; ta.rows = 3;
      ta.id = 'edit-alt-' + i;
      ta.placeholder = 'Alternate greeting #' + (i + 1);
      ta.textContent = alts[i] || '';
      content.appendChild(ta);
    }
    const addBtn = document.createElement('button');
    addBtn.type = 'button';
    addBtn.className = 'text-xs text-accent hover:text-accent/80 mt-1 cursor-pointer bg-transparent border-none';
    addBtn.textContent = '+ Add alternate';
    addBtn.onclick = () => {
      const idx = content.querySelectorAll('textarea').length;
      const ta = document.createElement('textarea');
      ta.className = 'edit-textarea'; ta.rows = 3;
      ta.id = 'edit-alt-' + idx;
      ta.placeholder = 'Alternate greeting #' + (idx + 1);
      content.appendChild(ta);
    };
    content.appendChild(addBtn);
    group.appendChild(content);
    main.appendChild(group);
  }

  // Alt fields (collapsible)
  {
    const group = document.createElement('div');
    group.className = 'flex flex-col gap-0.5';
    const hdr = document.createElement('div');
    hdr.className = 'flex items-center gap-1 cursor-pointer';
    hdr.style.cssText = 'padding:4px 0;cursor:pointer;';
    hdr.innerHTML = `<span style="color:#7b82a8;font-size:0.72rem;font-weight:500;cursor:pointer;">Translation / Alternative</span>
      <span class="alt-chevron" style="font-size:0.6rem;color:#666;margin-left:auto;transition:transform .2s;">▼</span>`;
    hdr.onclick = function () {
      const c = this.nextElementSibling;
      const ch = this.querySelector('.alt-chevron');
      c.classList.toggle('hidden');
      ch.textContent = c.classList.contains('hidden') ? '▶' : '▼';
    };
    group.appendChild(hdr);
    const content = document.createElement('div');
    content.className = 'hidden ml-5 flex flex-col gap-1 mt-1';
    const altFields = [
      ['name_alt','Name (alt)'],['description_alt','Description (alt)'],
      ['personality_alt','Personality (alt)'],['scenario_alt','Scenario (alt)'],
      ['first_mes_alt','First Message (alt)'],['mes_example_alt','Dialogue Examples (alt)'],
      ['creator_alt','Creator (alt)'],['creator_notes_alt','Creator Notes (alt)'],
      ['system_prompt_alt','System Prompt (alt)'],['post_history_instructions_alt','Jailbreak (alt)'],
    ];
    for (const [f, l] of altFields) {
      const g = document.createElement('div');
      g.className = 'flex flex-col gap-0.5';
      const lb = document.createElement('label');
      lb.className = 'edit-label'; lb.setAttribute('for', 'edit-' + f);
      lb.textContent = l;
      g.appendChild(lb);
      const inp = document.createElement('input');
      inp.type = 'text'; inp.id = 'edit-' + f; inp.className = 'edit-input';
      inp.value = c[f] || ''; inp.style.opacity = '0.7';
      g.appendChild(inp);
      content.appendChild(g);
    }
    // Tags alt
    {
      const g = document.createElement('div');
      g.className = 'flex flex-col gap-0.5';
      const lbl = document.createElement('label');
      lbl.className = 'edit-label'; lbl.setAttribute('for', 'edit-tags_alt');
      lbl.textContent = 'Tags (alt)';
      g.appendChild(lbl);
      const ta = document.createElement('textarea');
      ta.id = 'edit-tags_alt'; ta.className = 'edit-textarea';
      ta.rows = 2;       ta.placeholder = 'Alternate tags…';
      ta.textContent = (c.tags_alt || []).join(', ');
      g.appendChild(ta);
      content.appendChild(g);
    }
    group.appendChild(content);
    main.appendChild(group);
  }

  layout.appendChild(main);
  cont.appendChild(layout);

  // Token counter — initial render
  el('editTokens').innerHTML = renderTokenBadge(c);

  // Token counter — realtime update on input
  function updateTokenCounter() {
    const liveCard = {
      name:                      el('edit-name')?.value || '',
      description:               el('edit-description')?.value || '',
      personality:               el('edit-personality')?.value || '',
      scenario:                  el('edit-scenario')?.value || '',
      first_mes:                 el('edit-first_mes')?.value || '',
      mes_example:               el('edit-mes_example')?.value || '',
      system_prompt:             el('edit-system_prompt')?.value || '',
      post_history_instructions: el('edit-post_history_instructions')?.value || '',
      character_note:            el('edit-character_note')?.value || '',
    };
    el('editTokens').innerHTML = renderTokenBadge(liveCard);
  }

  ['edit-name','edit-description','edit-personality','edit-scenario','edit-first_mes',
   'edit-mes_example','edit-system_prompt','edit-post_history_instructions','edit-character_note']
    .forEach(id => {
      el(id)?.addEventListener('input', updateTokenCounter);
    });
}

function saveEdit() {
  if (!state.card) return;

  const name = el('edit-name')?.value?.trim() || '';
  if (!name) { showToast('Character name is required', 'err'); return; }

  const altGreetings = [];
  let i = 0;
  while (true) {
    const el_ = el('edit-alt-' + i);
    if (!el_) break;
    if (el_.value.trim()) altGreetings.push(el_.value.trim());
    i++;
  }

  const sliders = document.querySelectorAll('.slider');
  let talkVal = '0.50';
  sliders.forEach(s => {
    if (s.closest('#pageEditContent') && s.closest('.alt-toggle, .alt-section') === null) {
      talkVal = s.value;
    }
  });

  const updates = {
    name,
    description:           el('edit-description')?.value?.trim() || '',
    personality:           el('edit-personality')?.value?.trim() || '',
    scenario:              el('edit-scenario')?.value?.trim() || '',
    first_mes:             el('edit-first_mes')?.value?.trim() || '',
    mes_example:           el('edit-mes_example')?.value?.trim() || '',
    system_prompt:         el('edit-system_prompt')?.value?.trim() || '',
    post_history_instructions: el('edit-post_history_instructions')?.value?.trim() || '',
    creator_notes:         el('edit-creator_notes')?.value?.trim() || '',
    character_note:        el('edit-character_note')?.value?.trim() || '',
    character_note_depth:  (el('edit-character_note_depth')?.value ?? '').trim() || '',
    creator:               el('edit-creator')?.value?.trim() || '',
    character_version:     el('edit-character_version')?.value?.trim() || '',
    chara_source:          el('edit-chara_source')?.value?.trim() || '',
    tags:                  (el('edit-tags')?.value || '').split(',').map(s => s.trim()).filter(Boolean),
    alternate_greetings:   altGreetings,
    talkativeness:         talkVal,

    tags_alt:              (el('edit-tags_alt')?.value || '').split(',').map(s => s.trim()).filter(Boolean),
    name_alt:              el('edit-name_alt')?.value?.trim() || '',
    description_alt:       el('edit-description_alt')?.value?.trim() || '',
    personality_alt:       el('edit-personality_alt')?.value?.trim() || '',
    scenario_alt:          el('edit-scenario_alt')?.value?.trim() || '',
    first_mes_alt:         el('edit-first_mes_alt')?.value?.trim() || '',
    mes_example_alt:       el('edit-mes_example_alt')?.value?.trim() || '',
    creator_alt:           el('edit-creator_alt')?.value?.trim() || '',
    creator_notes_alt:     el('edit-creator_notes_alt')?.value?.trim() || '',
    system_prompt_alt:     el('edit-system_prompt_alt')?.value?.trim() || '',
    post_history_instructions_alt: el('edit-post_history_instructions_alt')?.value?.trim() || '',
  };

  setSaving(true);

  // Step 1: Save metadata
  invoke('update_card_metadata', {
    filePath: state.card.file_path,
    updates,
  })
  .then(result => {
    // Step 2: If image was changed, replace it
    if (state.pendingImagePath) {
      return invoke('write_temp_image', { dataUri: state.pendingImagePath })
        .then(tempPath => {
          return invoke('replace_card_image', {
            filePath: state.card.file_path,
            newImagePath: tempPath,
          }).then(() => tempPath);
        })
        .then(tempPath => {
          // Clean up temp file
          invoke('delete_temp_file', { path: tempPath }).catch(() => {});
          // Invalidate image cache so preview reloads from disk
          _dataUriCache.delete(state.card.file_path);
          return result;
        })
        .catch(err => {
          console.error('Image replace failed:', err);
          showToast('Image replacement failed, but metadata was saved', 'err');
          return result;
        });
    }
    return result;
  })
  .then(result => {
    const idx = state.allCards.findIndex(c => c.file_path === state.card.file_path);
    if (idx !== -1) state.allCards[idx] = result;
    else state.allCards.unshift(result);
    state.filtered = [...state.allCards];
    buildTagCloud(state.allCards);
    renderGrid(state.filtered);

    state.pendingImagePath = null;
    state.card = result;
    state.editMode = false;
    showToast('Saved successfully ✓');
    openPageView(result);
  })
  .catch(err => {
    console.error(err);
    showToast('Save failed: ' + (err.message || String(err)), 'err');
  })
  .finally(() => setSaving(false));
}

function setSaving(saving) {
  const btn = el('btnSaveEditPage'), lbl = el('saveLabel'),
        icon = el('saveIcon'), st = el('saveStatus');
  if (btn) btn.disabled = saving;
  if (saving) {
    if (btn) btn.innerHTML = '<div class="spinner" style="width:12px;height:12px;border-width:2px;"></div><span>Saving…</span>';
  } else {
    if (btn) btn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg><span>Save</span>';
  }
}

function enterEditMode() {
  if (!state.card) return;
  openPageEdit(state.card);
}

function exitEditMode() {
  state.editMode = false;
  if (state.card) openPageView(state.card);
}

// ════════════════════════════════════════════════════════════════════
//  CLOSE INSPECTOR
// ════════════════════════════════════════════════════════════════════
function closeDetail() {
  const panel = el('detailPanel');
  if (panel) {
    panel.classList.remove('panel-open');
    setTimeout(() => { panel.style.display = 'none'; }, 200);
  }
  state.card = null;
  state.editMode = false;
}

// ════════════════════════════════════════════════════════════════════
//  NSFW BLUR TOGGLE
// ════════════════════════════════════════════════════════════════════
let blurEnabled = localStorage.getItem('nsfwBlur') !== 'false';

function applyBlur() {
  document.documentElement.classList.toggle('nsfw-blur', blurEnabled);
  const btn = el('btnBlur');
  if (btn) btn.title = blurEnabled ? 'Blur active — click to disable' : 'Blur inactive — click to enable';
}

function toggleBlur() {
  blurEnabled = !blurEnabled;
  localStorage.setItem('nsfwBlur', blurEnabled);
  applyBlur();
}

// ════════════════════════════════════════════════════════════════════
//  THEME
// ════════════════════════════════════════════════════════════════════
function toggleTheme() {
  const html = document.documentElement;
  const current = html.getAttribute('data-theme') || html.getAttribute('data-bs-theme') || 'dark';
  const next = current === 'dark' ? 'light' : 'dark';
  html.setAttribute('data-theme', next);
  html.setAttribute('data-bs-theme', next);
  localStorage.setItem('theme', next);

  // Update header bg based on theme
  const header = document.querySelector('header');
  if (header) {
    header.style.background = next === 'dark' ? 'rgba(17,19,26,.92)' : 'rgba(248,249,250,.92)';
    header.style.borderBottomColor = next === 'dark' ? 'rgba(255,255,255,.05)' : 'rgba(0,0,0,.08)';
  }
}

function applySavedTheme() {
  const saved = localStorage.getItem('theme');
  if (saved) {
    document.documentElement.setAttribute('data-theme', saved);
    document.documentElement.setAttribute('data-bs-theme', saved);
  }
  const isDark = (saved || 'dark') === 'dark';
  const header = document.querySelector('header');
  if (header) {
    header.style.background = isDark ? 'rgba(17,19,26,.92)' : 'rgba(248,249,250,.92)';
    header.style.borderBottomColor = isDark ? 'rgba(255,255,255,.05)' : 'rgba(0,0,0,.08)';
  }
}

// ════════════════════════════════════════════════════════════════════
//  KEYBOARD SHORTCUTS
// ════════════════════════════════════════════════════════════════════
document.addEventListener('keydown', e => {
  const isInput = ['INPUT','TEXTAREA','SELECT'].includes(document.activeElement?.tagName);

  if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
    e.preventDefault();
    if (!isInput) { const si = el('searchInput'); if (si) { si.focus(); si.select(); } }
  }
  if (e.key === 'Escape') {
    if (el('pageEdit')?.classList.contains('active')) {
      closeDetail(); setMainView('grid');
    }
  }
  if ((e.ctrlKey || e.metaKey) && e.key === 's' && (state.editMode || el('pageEdit')?.classList.contains('active'))) {
    e.preventDefault();
    if (!el('btnSaveEditPage')?.disabled) saveEdit();
  }
});

// ════════════════════════════════════════════════════════════════════
//  EVENT WIRING
// ════════════════════════════════════════════════════════════════════
function wireEvents() {
  if (el('btnPickDir')) el('btnPickDir').onclick = pickFolder;
  if (el('emptyPickDir')) el('emptyPickDir').onclick = pickFolder;

  if (el('btnImport')) el('btnImport').onclick = () => {
    const m = el('importModal');
    if (m) m.classList.remove('hidden');
  };

  const dz = el('importDropZone');
  const fi = el('importFileInput');
  const ib = el('importFileBtn');

  if (dz && fi) dz.addEventListener('click', () => fi.click());
  if (ib) ib.addEventListener('click', (e) => { e.stopPropagation(); fi?.click(); });
  if (fi) fi.addEventListener('change', async e => {
    if (fi.files && fi.files[0]) await handleImportFile(fi.files[0]);
  });

  const im = el('importModal');
  if (im) {
    im.addEventListener('dragover', e => { e.preventDefault(); dz?.classList.add('drag-over'); });
    im.addEventListener('dragleave', () => { dz?.classList.remove('drag-over'); });
    im.addEventListener('drop', async e => {
      e.preventDefault();
      dz?.classList.remove('drag-over');
      if (e.dataTransfer?.files?.[0]) await handleImportFile(e.dataTransfer.files[0]);
    });
  }

  if (el('importModalClose')) el('importModalClose').onclick = () => {
    const m = el('importModal');
    if (m) m.classList.add('hidden');
  };

  if (el('btnCloseDetail')) el('btnCloseDetail').onclick = closeDetail;
  if (el('btnViewDetail')) el('btnViewDetail').onclick = () => { if (state.card) openPageView(state.card); };
  if (el('btnEditCard')) el('btnEditCard').onclick = () => { if (state.card) openPageEdit(state.card); };
  if (el('btnBackFromView')) el('btnBackFromView').onclick = () => { closeDetail(); setMainView('grid'); };
  if (el('btnEditFromView')) el('btnEditFromView').onclick = () => { if (state.card) openPageEdit(state.card); };
  if (el('btnBackFromEdit')) el('btnBackFromEdit').onclick = () => { closeDetail(); setMainView('grid'); };
  if (el('btnCancelEditPage')) el('btnCancelEditPage').onclick = () => { closeDetail(); setMainView('grid'); };
  if (el('btnSaveEditPage')) el('btnSaveEditPage').onclick = saveEdit;

  const themeToggle = el('themeToggle');
  if (themeToggle) themeToggle.addEventListener('click', toggleTheme);

  if (el('btnBlur')) el('btnBlur').onclick = toggleBlur;

  const search = el('searchInput');
  if (search) search.addEventListener('input', applyFilter);

  const sortSel = el('sortSelect');
  if (sortSel) {
    sortSel.value = state.sortBy;
    sortSel.addEventListener('change', () => {
      state.sortBy = sortSel.value;
      localStorage.setItem('sortBy', state.sortBy);
      applyFilter();
    });
  }
}

// ════════════════════════════════════════════════════════════════════
//  INIT
// ════════════════════════════════════════════════════════════════════
function init() {
  applySavedTheme();
  applyBlur();
  // Start with empty view
  setMainView('empty');
  wireEvents();

  // Auto-pick if Tauri provides a path
  if (TauriAvailable && __TAURI__.path) {
    __TAURI__.path.appLocalDataDir().then(dir => {
      if (dir) pickFolder();
    }).catch(() => {});
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
