/**
 * public/js/main.js
 * All filtering is done IN THE BROWSER — no server calls per filter.
 * Server is called ONLY on: page load.
 */

/* ── State ─────────────────────────────────────────────────────── */
const state = {
  all:      [],
  filtered: [],
  knownAmcs: [],
  page:     1,
  pageSize: 50,
  sortCol:  null,
  sortDir:  'asc',
  f: { amc:'', category:'', type:'', missingBrokerage:'', search:'', nsdl:'', amfi:'' },
  editing:  null,
};

/* ── DOM shortcuts ───────────────────────────────────────────────── */
const $   = id => document.getElementById(id);
const tbody        = $('tbody');
const paginEl      = $('pagination');
const heroCountEl  = $('heroSchemeCount');
const heroAmcEl    = $('heroAmcCount');
const statusDotEl  = $('statusDot');
const statusTextEl = $('statusText');
const lastRefEl    = $('lastRefreshed');

/* ── Formatters ─────────────────────────────────────────────────── */
function fmt(v) {
  if (v === null || v === undefined) return '–';
  const n = +v; if (isNaN(n)) return '–';
  return n.toFixed(4).replace(/\.?0+$/, '') || '0';
}

function fmtDiff(v) {
  if (v === null || v === undefined) return '–';
  const n = +v; if (isNaN(n)) return '–';
  return (n > 0 ? '+' : '') + n.toFixed(2);
}

function formatLaunchDate(value) {
  if (!value) return '–';
  const match = String(value).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return esc(value);
  const [, year, month, day] = match;
  return `${day} ${['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][Number(month) - 1]} ${year}`;
}

function diffCls(v) {
  const n = +v;
  if (isNaN(n) || v === null || v === undefined) return '';
  return n > 0 ? 'positive' : n < 0 ? 'negative' : 'zero';
}

function badge(tp) {
  if (!tp) return '';
  const l = tp.toLowerCase();
  const c = l.includes('close') ? 'badge-close' : l.includes('interval') ? 'badge-interval' : 'badge-open';
  return `<span class="badge ${c}">${esc(tp)}</span>`;
}

function esc(s) {
  if (!s) return '';
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function formatArnDisplay(rawArn) {
  const value = String(rawArn || '').trim();
  if (!value) return '–';
  const formatted = value
    .split(/[,;|]+/)
    .map(part => part.trim())
    .filter(Boolean)
    .map(part => /^arn/i.test(part) ? part.toUpperCase() : `ARN-${part}`)
    .join(', ');
  return esc(formatted) || '–';
}

function toast(msg, type='info', ms=3500) {
  const c = $('toast-container');
  if (!c) return;
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.innerHTML = `<span>${esc(String(msg))}</span>`;
  c.appendChild(el);
  setTimeout(() => el.remove(), ms);
}

/* ── Skeleton ────────────────────────────────────────────────────── */
function showSkeleton(n=15) {
  const isAdmin = document.querySelector('main.main')?.dataset.admin === 'true';
  const colCount = isAdmin ? 25 : 24;
  tbody.innerHTML = Array.from({length:n}, () =>
    `<tr class="skeleton-row">${'<td><div class="skeleton-cell"></div></td>'.repeat(colCount)}</tr>`
  ).join('');
}

/* ── Render editable Launch Date cell ────────────────────────────── */
function renderLaunchDateCell(s) {
  const isAdmin = document.querySelector('main.main')?.dataset.admin === 'true';
  const value = s.launchDate || '';
  const displayValue = formatLaunchDate(value);

  if (!isAdmin) {
    return `<td class="col-launch" data-col="launchDate">${displayValue}</td>`;
  }

  const isEditing = state.editing === s.srNo;

  if (isEditing) {
    return `<td class="col-launch" data-col="launchDate">
      <input type="date" class="date-input"
             data-field="launchDate" data-sr="${s.srNo}"
             value="${esc(value)}">
    </td>`;
  }

  return `<td class="col-launch launch-cell" data-col="launchDate" data-field="launchDate" data-sr="${s.srNo}">${displayValue}</td>`;
}

/* ── Render editable year cell ───────────────────────────────────── */
function renderYearCell(s, field, label) {
  const isAdmin = document.querySelector('main.main')?.dataset.admin === 'true';
  const value = s[field];
  const displayValue = value !== null && value !== undefined ? fmt(value) : '–';
  
  if (!isAdmin) {
    return `<td class="col-num" data-col="${field}">${displayValue}</td>`;
  }
  
  const isEditing = state.editing === s.srNo;
  
  if (isEditing) {
    return `<td class="col-num" data-col="${field}">
      <input type="number" step="any" class="year-input" 
             data-field="${field}" data-sr="${s.srNo}"
             value="${value !== null && value !== undefined ? value : ''}"
             placeholder="–">
    </td>`;
  }
  
  return `<td class="col-num year-cell" data-col="${field}" data-field="${field}" data-sr="${s.srNo}">${displayValue}</td>`;
}

/* ── Render Commission to BER Ratio cell ──────────────────────────── */
function renderRatioCell(value) {
  if (value === null || value === undefined || !isFinite(value)) return '–';
  return value.toFixed(4);
}

/* ── Render table ────────────────────────────────────────────────── */
function render() {
  const start = (state.page - 1) * state.pageSize;
  const page  = state.filtered.slice(start, start + state.pageSize);

  if (!page.length) {
    const colspan = document.querySelector('main.main')?.dataset.admin === 'true' ? 25 : 24;
    tbody.innerHTML = `<tr><td colspan="${colspan}"><div class="state-box">
      <span class="state-icon">🔍</span>
      <h3>No schemes found</h3>
      <p>Try adjusting your filters.</p>
    </div></td></tr>`;
    renderPagination();
    return;
  }

  const isAdmin = document.querySelector('main.main')?.dataset.admin === 'true';
  
  tbody.innerHTML = page.map((s, i) => {
    const editingThisRow = state.editing === s.srNo;
    
    return `<tr data-sr="${s.srNo}" class="${editingThisRow ? 'editing-row' : ''}">
      <td class="col-sr col-num" data-col="srNo">${start + i + 1}</td>
      <td class="col-nsdl" data-col="nsdlCode">${esc(s.nsdlCode) || '–'}</td>
      <td class="col-amfi" data-col="amfiCode">${esc(s.amfiCode) || '–'}</td>
      <td class="col-name" data-col="schemeName"><strong>${esc(s.schemeName)}</strong><small>${esc(s.amc)}</small></td>
      ${renderLaunchDateCell(s)}
      <td class="col-amc" data-col="amc">${esc(s.amc) || '–'}</td>
      <td class="col-type" data-col="schemeType">${badge(s.schemeType)}</td>
      <td class="col-cat" data-col="schemeCategory">${esc(s.schemeCategory) || '–'}</td>
      <td class="col-period" data-col="brokeragePeriod">${esc(s.brokeragePeriod) || '–'}</td>
      <td class="col-period" data-col="brokerageArn">${formatArnDisplay(s.brokerageArn)}</td>
      <td class="col-num ${diffCls(s.terDiff)}" data-col="terDiff">${fmtDiff(s.terDiff)}</td>
      <td class="col-num ${diffCls(s.berDiff)}" data-col="berDiff">${fmtDiff(s.berDiff)}</td>
      <td class="col-num col-ber" data-col="regularBER">${s.regularBER !== null && s.regularBER !== undefined ? fmt(s.regularBER) : '–'}</td>
      ${renderYearCell(s, 'year1', '1 YR')}
      ${renderYearCell(s, 'year2', '2 YR')}
      ${renderYearCell(s, 'year3', '3 YR')}
      ${renderYearCell(s, 'year4', '4 YR')}
      ${renderYearCell(s, 'yearOnward', '5 YR')}
      ${renderYearCell(s, 'year6Onward', '6 YR')}
      <td class="col-num col-ratio" data-col="c1">${renderRatioCell(s.c1)}</td>
      <td class="col-num col-ratio" data-col="c2">${renderRatioCell(s.c2)}</td>
      <td class="col-num col-ratio" data-col="c3">${renderRatioCell(s.c3)}</td>
      <td class="col-num col-ratio" data-col="c4">${renderRatioCell(s.c4)}</td>
      <td class="col-num col-ratio" data-col="c5">${renderRatioCell(s.c5)}</td>
      <td class="col-num col-ratio" data-col="c6">${renderRatioCell(s.c6)}</td>
      ${isAdmin ? renderActions(s) : ''}
    </tr>`;
  }).join('');

  if (isAdmin) bindTableEvents();
  renderPagination();
  mainApplyColumnVisibility();
}

function renderActions(s) {
  const isEditing = state.editing === s.srNo;
  if (isEditing) {
    return `<td class="col-actions">
      <button type="button" class="row-save-btn" data-sr="${s.srNo}">💾 Save</button>
      <button type="button" class="row-cancel-btn" data-sr="${s.srNo}">✕ Cancel</button>
    </td>`;
  }
  return `<td class="col-actions">
    <button type="button" class="row-edit-btn" data-sr="${s.srNo}">✎ Edit</button>
  </td>`;
}

/* ── Pagination ──────────────────────────────────────────────────── */
function renderPagination() {
  if (!paginEl) return;
  const total = state.filtered.length;
  const tp    = Math.ceil(total / state.pageSize) || 1;
  const cur   = state.page;
  const s     = total ? (cur - 1) * state.pageSize + 1 : 0;
  const e     = Math.min(cur * state.pageSize, total);

  let btns = `<button class="page-btn" ${cur===1?'disabled':''} onclick="goPage(${cur-1})">‹</button>`;

  const pages = [];
  if (tp <= 7) { for (let i=1;i<=tp;i++) pages.push(i); }
  else {
    pages.push(1);
    if (cur > 3) pages.push('…');
    for (let i=Math.max(2,cur-1); i<=Math.min(tp-1,cur+1); i++) pages.push(i);
    if (cur < tp-2) pages.push('…');
    if (tp > 1) pages.push(tp);
  }

  pages.forEach(p => {
    btns += p === '…'
      ? `<span class="page-ellipsis">…</span>`
      : `<button class="page-btn ${p===cur?'active':''}" onclick="goPage(${p})">${p}</button>`;
  });
  btns += `<button class="page-btn" ${cur>=tp?'disabled':''} onclick="goPage(${cur+1})">›</button>`;

  paginEl.innerHTML = `
    <div class="pagination-info">Showing <strong>${total ? `${s}–${e}` : '0'}</strong> of <strong>${total.toLocaleString()}</strong> schemes</div>
    <div class="pagination-controls">${btns}</div>`;
}

window.goPage = p => {
  const tp = Math.ceil(state.filtered.length / state.pageSize) || 1;
  if (p < 1 || p > tp) return;
  state.page = p; render();
  window.scrollTo({ top: 0, behavior: 'smooth' });
};

/* ── Sort ────────────────────────────────────────────────────────── */
window.sortBy = col => {
  state.sortDir = (state.sortCol === col && state.sortDir === 'asc') ? 'desc' : 'asc';
  state.sortCol = col;
  document.querySelectorAll('table.ter-table thead th').forEach(th => {
    th.classList.remove('sort-asc', 'sort-desc');
    if (th.dataset.col === col) th.classList.add(state.sortDir === 'asc' ? 'sort-asc' : 'sort-desc');
  });
  state.filtered.sort((a, b) => {
    let va = a[col], vb = b[col];
    if (va == null) va = state.sortDir === 'asc' ? Infinity : -Infinity;
    if (vb == null) vb = state.sortDir === 'asc' ? Infinity : -Infinity;
    if (typeof va === 'string') va = va.toLowerCase();
    if (typeof vb === 'string') vb = vb.toLowerCase();
    return (va < vb ? -1 : va > vb ? 1 : 0) * (state.sortDir === 'asc' ? 1 : -1);
  });
  state.page = 1; render();
};

/* ── INSTANT browser filtering — no server call ─────────────────── */
function applyFilters() {
  const { amc, category, type, missingBrokerage, search, nsdl, amfi } = state.f;
  const normalize = s => (s || '').toLowerCase().replace(/\s+/g, ' ').trim();
  const lo = s => (s || '').toLowerCase().trim();
  const filterAmc = amc ? normalize(amc) : '';
  const filterSearch = search ? lo(search) : '';

  state.filtered = state.all.filter(s => {
    if (filterAmc) {
      const schemeAmc = normalize(s.amc);
      if (!schemeAmc.includes(filterAmc)) {
        return false;
      }
    }

    if (filterSearch) {
      const schemeName = lo(s.schemeName);
      const schemeAmc = lo(s.amc);
      if (!schemeName.includes(filterSearch) && !schemeAmc.includes(filterSearch)) {
        return false;
      }
    }

    if (category && !lo(s.schemeCategory).includes(lo(category))) return false;
    if (type && !lo(s.schemeType).includes(lo(type))) return false;
    if (missingBrokerage === 'missing') {
      const brokerageValues = [s.year1, s.year2, s.year3, s.year4, s.yearOnward, s.year6Onward];
      if (!brokerageValues.some(value => value === null || value === undefined || value === '')) return false;
    }
    if (nsdl && !lo(s.nsdlCode).includes(lo(nsdl))) return false;
    if (amfi && !lo(s.amfiCode).includes(lo(amfi))) return false;
    return true;
  });

  state.page = 1;
  render();
  updateCounts();
}

function updateCounts() {
  const totalEl = $('totalCount');
  const showingEl = $('showingCount');
  if (totalEl) totalEl.textContent = state.filtered.length.toLocaleString();
  if (showingEl) showingEl.textContent = state.filtered.length.toLocaleString();
}

function debounce(fn, ms=200) {
  let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

/* ── Table Events - Edit/Save/Cancel ────────────────────────────── */
function bindTableEvents() {
  tbody.removeEventListener('click', handleTableClick);
  tbody.addEventListener('click', handleTableClick);
}

function handleTableClick(event) {
  const btn = event.target.closest('button');

  if (btn) {
    const srNo = parseInt(btn.dataset.sr);
    if (isNaN(srNo)) return;

    if (btn.classList.contains('row-edit-btn')) {
      startEditing(srNo);
      return;
    }

    if (btn.classList.contains('row-save-btn')) {
      saveEditing(srNo);
      return;
    }

    if (btn.classList.contains('row-cancel-btn')) {
      state.editing = null;
      render();
      toast('Cancelled', 'info');
      return;
    }
    return;
  }

  // Not a button click — check for the click-directly-on-the-cell shortcut
  // (year/launch cells are clickable even outside edit mode). This must be
  // checked against the actual click target, not a `.closest('button')`
  // result, since these cells are plain <td> elements with no button.
  const yearCell = event.target.closest('.year-cell');
  if (yearCell && !state.editing) {
    const sr = parseInt(yearCell.dataset.sr);
    if (!isNaN(sr)) startEditing(sr);
    return;
  }

  const launchCell = event.target.closest('.launch-cell');
  if (launchCell && !state.editing) {
    const sr = parseInt(launchCell.dataset.sr);
    if (!isNaN(sr)) startEditing(sr);
  }
}

function startEditing(srNo) {
  state.editing = srNo;
  render();
  
  setTimeout(() => {
    const firstInput = tbody.querySelector('.year-input');
    if (firstInput) {
      firstInput.focus();
      firstInput.select();
    }
  }, 50);
}

async function saveEditing(srNo) {
  const row = tbody.querySelector(`tr[data-sr="${srNo}"]`);
  if (!row) return;
  
  const inputs = row.querySelectorAll('.year-input');
  const dateInputs = row.querySelectorAll('.date-input');
  const values = {};
  const schemeData = state.all.find(s => s.srNo === srNo);
  if (!schemeData) return;
  
  inputs.forEach(input => {
    const field = input.dataset.field;
    const raw = input.value.trim();
    values[field] = raw === '' ? null : parseFloat(raw);
  });

  dateInputs.forEach(input => {
    const field = input.dataset.field;
    const raw = input.value.trim();
    values[field] = raw === '' ? null : raw; // YYYY-MM-DD string — <input type="date"> guarantees this format or empty
  });
  
  for (const [key, val] of Object.entries(values)) {
    if (key === 'launchDate') continue; // string field, not numeric — validated by the date input itself
    if (val !== null && (isNaN(val) || !isFinite(val))) {
      toast(`Invalid value for ${key}`, 'error');
      return;
    }
  }
  
  try {
    const btn = row.querySelector('.row-save-btn');
    if (btn) {
      btn.textContent = '⏳';
      btn.disabled = true;
    }
    
    const res = await fetch('/api/schemes/update', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        schemeName: schemeData.schemeName,
        amc: schemeData.amc,
        nsdlCode: schemeData.nsdlCode || '',
        amfiCode: schemeData.amfiCode || '',
        values,
      }),
    });
    
    const j = await res.json();
    if (!res.ok || !j.success) {
      throw new Error(j.message || 'Update failed');
    }
    
    const updatedScheme = state.all.find(s => s.srNo === srNo);
    if (updatedScheme) {
      Object.assign(updatedScheme, values);
    }
    
    state.editing = null;
    toast('✅ Scheme updated successfully', 'success');
    render();
    
  } catch (err) {
    toast(err.message || 'Update failed', 'error');
    render();
  }
}

/* ── Keyboard shortcuts for editing ─────────────────────────────── */
document.addEventListener('keydown', (e) => {
  if (state.editing === null) return;
  
  if (e.key === 'Escape') {
    state.editing = null;
    render();
    toast('Cancelled', 'info');
    return;
  }
  
  if (e.key === 'Enter') {
    const srNo = state.editing;
    saveEditing(srNo);
    e.preventDefault();
  }
  
  if (e.key === 'Tab') {
    e.preventDefault();
    const inputs = tbody.querySelectorAll('.year-input');
    const current = document.activeElement;
    if (!current || !current.classList.contains('year-input')) return;
    
    const idx = Array.from(inputs).indexOf(current);
    const nextIdx = e.shiftKey ? idx - 1 : idx + 1;
    if (nextIdx >= 0 && nextIdx < inputs.length) {
      inputs[nextIdx].focus();
      inputs[nextIdx].select();
    }
  }
});

/* ── Bind filters ────────────────────────────────────────────────── */
function bindFilters() {
  [['filterAMC','amc'], ['filterCategory','category'], ['filterType','type'], ['filterMissingBrokerage','missingBrokerage']].forEach(([id, key]) => {
    const el = $(id); if (!el) return;
    el.addEventListener('change', () => { 
      state.f[key] = el.value; 
      applyFilters(); 
    });
  });

  const debouncedApply = debounce(applyFilters, 200);
  [['filterSearch','search'], ['filterNSDL','nsdl'], ['filterAMFI','amfi']].forEach(([id, key]) => {
    const el = $(id); if (!el) return;
    el.addEventListener('input', () => { 
      state.f[key] = el.value; 
      debouncedApply(); 
    });
  });

  const ps = $('pageSize');
  if (ps) ps.addEventListener('change', () => { state.pageSize = +ps.value || 50; state.page = 1; render(); });

  const btnViewAmcDocs = $('btnViewAmcDocs');
  const updateAmcFilesLink = () => {
    const amcEl = $('filterAMC');
    const amc = amcEl ? amcEl.value.trim() : '';
    if (!btnViewAmcDocs) return;
    const enabled = !!amc;
    btnViewAmcDocs.classList.toggle('is-disabled', !enabled);
    btnViewAmcDocs.setAttribute('aria-disabled', String(!enabled));
    btnViewAmcDocs.tabIndex = enabled ? 0 : -1;
    btnViewAmcDocs.title = enabled ? '' : 'Select an AMC to open its files';
    btnViewAmcDocs.href = enabled
      ? '/?amc=' + encodeURIComponent(amc) + '&folder=' + encodeURIComponent('All Files')
      : '#';
  };
  if (btnViewAmcDocs) {
    updateAmcFilesLink();
    $('filterAMC')?.addEventListener('change', updateAmcFilesLink);
    btnViewAmcDocs.addEventListener('click', (e) => {
      if (btnViewAmcDocs.classList.contains('is-disabled')) e.preventDefault();
    });
  }
}

function bindSyncButtons() {
  const saveSyncBtn = $('btnSaveSync');
  if (saveSyncBtn) saveSyncBtn.addEventListener('click', async () => {
    saveSyncBtn.disabled = true;
    try {
      const res = await fetch('/api/sync/save', { method: 'POST' });
      const j = await res.json();
      if (!res.ok || !j.success) throw new Error(j.message || 'Save failed');
      showSyncStatus(`Saved ${j.count.toLocaleString()} schemes + ${j.oldBrokerageCount.toLocaleString()} brokerage records on ${new Date(j.savedAt).toLocaleString('en-IN')}.`);
      toast('Saved sync copy (Home + All Brokerage Data) successfully', 'success');
    } catch (err) {
      toast(err.message || 'Could not save sync copy', 'error');
    } finally {
      saveSyncBtn.disabled = false;
    }
  });

  const oldSyncBtn = $('btnGetOldSync');
  if (oldSyncBtn) oldSyncBtn.addEventListener('click', async () => {
    oldSyncBtn.disabled = true;
    try {
      const res = await fetch('/api/sync/old');
      const j = await res.json();
      if (!res.ok || !j.success) throw new Error(j.message || 'No saved sync copy found');
      loadSavedSyncIntoTable(j);
      updateStatus('ready', j.lastRefreshed);
      const savedAt = j.savedAt ? new Date(j.savedAt).toLocaleString('en-IN') : 'an earlier time';
      showSyncStatus(`Showing saved sync data from ${savedAt}. Filters and exports are active.`);
      toast(`Loaded ${state.all.length.toLocaleString()} schemes from saved sync`, 'success');
    } catch (err) {
      toast(err.message || 'Could not load saved sync copy', 'error');
    } finally {
      oldSyncBtn.disabled = false;
    }
  });

  const clearBtn = $('btnClearOldBrokerage');
  const clearModal = $('clearBrokerageModal');
  const clearConfirmBtn = $('clearBrokerageConfirmBtn');
  const clearCancelBtn = $('clearBrokerageCancelBtn');

  const openClearModal  = () => { if (clearModal) clearModal.hidden = false; };
  const closeClearModal = () => { if (clearModal) clearModal.hidden = true; };

  if (clearBtn) clearBtn.addEventListener('click', openClearModal);
  if (clearCancelBtn) clearCancelBtn.addEventListener('click', closeClearModal);
  // Clicking the dark backdrop only closes the modal — it never confirms the
  // destructive action, so an accidental click outside the box is safe.
  if (clearModal) clearModal.addEventListener('click', (e) => { if (e.target === clearModal) closeClearModal(); });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && clearModal && !clearModal.hidden) closeClearModal();
  });

  if (clearConfirmBtn) clearConfirmBtn.addEventListener('click', async () => {
    closeClearModal();
    clearBtn.disabled = true;
    try {
      const res = await fetch('/api/clear-old-brokerage', { method: 'POST' });
      const j = await res.json();
      if (!res.ok || !j.success) throw new Error(j.message || 'Clear failed');
      showSyncStatus('Old brokerage values cleared from the matrix.');
      toast('Old brokerage data cleared successfully', 'success');
      await loadData();
    } catch (err) {
      toast(err.message || 'Could not clear old brokerage data', 'error');
    } finally {
      clearBtn.disabled = false;
    }
  });
}

window.resetFilters = () => {
  ['filterAMC','filterCategory','filterType','filterMissingBrokerage'].forEach(id => { const el=$(id); if(el) el.value=''; });
  ['filterSearch','filterNSDL','filterAMFI'].forEach(id => { const el=$(id); if(el) el.value=''; });
  state.f = { ...state.f, amc:'', category:'', type:'', missingBrokerage:'', search:'', nsdl:'', amfi:'' };
  state.editing = null;
  applyFilters();
  toast('Filters cleared', 'info');
};

/* ── Load data from server ──────────────────────────────────────── */
async function loadKnownAMCs() {
  try {
    const j = await fetch('/api/amcs').then(r => r.json());
    if (j.success && Array.isArray(j.data)) {
      state.knownAmcs = j.data;
    }
  } catch (e) {
    state.knownAmcs = [];
  }
}

function showSyncStatus(message) {
  const el = $('syncStatus');
  if (el) el.textContent = message;
}

function loadSavedSyncIntoTable(j) {
  state.editing = null;
  state.all = (j.data || []).map((s, idx) => ({
    srNo: s.i || idx + 1, nsdlCode: s.nsdlCode || s.n || '', amfiCode: s.amfiCode || s.a || '',
    schemeName: s.schemeName || s.nm || '', launchDate: s.launchDate || s.ld || '',
    amc: s.amc || s.mc || '', schemeType: s.schemeType || s.tp || '', schemeCategory: s.schemeCategory || s.ct || '',
    brokeragePeriod: s.brokeragePeriod || '', brokerageArn: s.brokerageArn || '',
    terDiff: s.terDiff ?? s.td ?? null, berDiff: s.berDiff ?? s.bd ?? null, regularBER: s.regularBER ?? s.ber ?? null,
    year1: s.year1 ?? s.y1 ?? null, year2: s.year2 ?? s.y2 ?? null, year3: s.year3 ?? s.y3 ?? null,
    year4: s.year4 ?? s.y4 ?? null, yearOnward: s.yearOnward ?? s.y5 ?? null, year6Onward: s.year6Onward ?? s.y6 ?? null,
    c1: s.c1 ?? null, c2: s.c2 ?? null, c3: s.c3 ?? null, c4: s.c4 ?? null, c5: s.c5 ?? null, c6: s.c6 ?? null,
  }));
  state.filtered = [...state.all];
  if (heroCountEl) heroCountEl.textContent = state.all.length.toLocaleString();
  if (heroAmcEl) heroAmcEl.textContent = new Set(state.all.map(s => s.amc).filter(Boolean)).size;
  updateAMCDropdown();
  applyFilters();
  const tableScroll = document.querySelector('.table-scroll');
  if (tableScroll) tableScroll.scrollLeft = 0;
}

async function loadData() {
  showSkeleton();
  updateStatus('loading');
  state.editing = null;

  const selectedAmc = document.querySelector('main.main')?.dataset.selectedAmc?.trim() || '';
  if (selectedAmc) {
    state.f.amc = selectedAmc;
  }

  await loadKnownAMCs();

  const url = `/api/schemes?limit=9999`;

  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      const res = await fetch(url);
      const j   = await res.json();

      // A scrape failure also returns 503. Retry only the real loading state,
      // otherwise users are kept in a pointless 8/16/24 second loop.
      if (j.status === 'loading' && !j.data) {
        const wait = Math.min(attempt * 3000, 9000);
        toast(`Server data loading… retrying in ${wait/1000}s (${attempt}/5)`, 'warning', wait);
        await new Promise(r => setTimeout(r, wait));
        continue;
      }

      if (!j.success) {
        const error = new Error(j.message || 'Unknown error');
        error.noRetry = true;
        throw error;
      }

      state.all = (j.data || []).map((s, idx) => ({
        srNo:           s.i || idx + 1,
        nsdlCode:       s.nsdlCode      || s.n  || '',
        amfiCode:       s.amfiCode      || s.a  || '',
        schemeName:     s.schemeName    || s.nm || '',
        launchDate:     s.launchDate    || s.ld || '',
        amc:            s.amc           || s.mc || '',
        schemeType:     s.schemeType    || s.tp || '',
        schemeCategory: s.schemeCategory|| s.ct || '',
        brokeragePeriod: s.brokeragePeriod || '',
        brokerageArn:   s.brokerageArn     || '',
        terDiff:        s.terDiff       ?? s.td ?? null,
        berDiff:        s.berDiff       ?? s.bd ?? null,
        regularBER:     s.regularBER    ?? s.ber ?? null,
        year1:          s.year1         ?? s.y1 ?? null,
        year2:          s.year2         ?? s.y2 ?? null,
        year3:          s.year3         ?? s.y3 ?? null,
        year4:          s.year4         ?? s.y4 ?? null,
        yearOnward:     s.yearOnward    ?? s.y5 ?? null,
        year6Onward:    s.year6Onward   ?? s.y6 ?? null,
        c1:             s.c1            ?? null,
        c2:             s.c2            ?? null,
        c3:             s.c3            ?? null,
        c4:             s.c4            ?? null,
        c5:             s.c5            ?? null,
        c6:             s.c6            ?? null,
      }));

      console.log('✅ Loaded', state.all.length, 'schemes');

      state.filtered = [...state.all];

      if (heroCountEl) heroCountEl.textContent = (j.total || state.all.length).toLocaleString();
      if (heroAmcEl)   heroAmcEl.textContent   = new Set(state.all.map(s => s.amc).filter(Boolean)).size;

      updateAMCDropdown();
      updateStatus('ready', j.lastRefreshed);
      applyFilters();
      const tableScroll = document.querySelector('.table-scroll');
      if (tableScroll) tableScroll.scrollLeft = 0;
      return;

    } catch(err) {
      if (attempt < 5 && !err.noRetry) {
        toast(`Load error: ${err.message} — retrying…`, 'error', 5000);
        await new Promise(r => setTimeout(r, 5000));
      } else {
        const colspan = document.querySelector('main.main')?.dataset.admin === 'true' ? 25 : 24;
        tbody.innerHTML = `<tr><td colspan="${colspan}"><div class="state-box">
          <span class="state-icon">⚠️</span>
          <h3>Failed to load data</h3>
          <p>${esc(err.message)}. If a backup was saved earlier, use “Get Old Sync Data” above.</p>
          <button class="btn btn-primary" onclick="loadData()" style="margin-top:1rem">⟳ Retry</button>
        </div></td></tr>`;
        toast('Live data is unavailable: ' + err.message, 'error');
        updateStatus('error');
      }
    }
  }
}

function updateAMCDropdown() {
  const el = $('filterAMC');
  if (!el) return;
  const currentValue = el.value;
  
  const dataAmcs = Array.isArray(state.all) ? state.all.map(s => s.amc).filter(Boolean) : [];
  const knownAmcs = Array.isArray(state.knownAmcs) ? state.knownAmcs.filter(Boolean) : [];
  const allAmcs = [...new Set([...dataAmcs, ...knownAmcs])].sort((a, b) => a.localeCompare(b));
  
  const kotakAmcs = allAmcs.filter(a => a.toLowerCase().includes('kotak'));
  if (kotakAmcs.length) {
    console.log('✅ Kotak AMCs found:', kotakAmcs);
  } else {
    console.warn('⚠️ No Kotak AMCs found in data!');
    console.log('📋 First 10 AMCs:', allAmcs.slice(0, 10));
  }
  
  el.innerHTML = `<option value="">All AMCs</option>`;
  allAmcs.forEach(a => {
    const option = document.createElement('option');
    option.value = a;
    option.textContent = a;
    if (a === currentValue) option.selected = true;
    el.appendChild(option);
  });
}

function updateStatus(status, ts) {
  if (!statusDotEl) return;
  statusDotEl.className = `status-dot ${status}`;
  const L = { ready:'Live', loading:'Loading…', error:'Error', empty:'No data' };
  if (statusTextEl) statusTextEl.textContent = L[status] || status;
  if (lastRefEl && ts) lastRefEl.textContent = 'Updated: ' + new Date(ts).toLocaleString('en-IN');
}

window.triggerRefresh = async () => {
  toast('Refresh started…', 'info');
  try { await fetch('/api/refresh'); setTimeout(loadData, 3000); }
  catch { toast('Refresh failed', 'error'); }
};

/* ── Exports ─────────────────────────────────────────────────────── */
const HEADERS = ['SR No','NSDL Code','AMFI Code','Scheme Name','Launch Date','AMC',
                 'Scheme Type','Scheme Category','Date Period','ARN No.','TER Diff','BER Diff',
                 'BER (%)',
                 '1 YR','2 YR','3 YR','4 YR','5 YR','6 YR',
                 'C/B 1YR','C/B 2YR','C/B 3YR','C/B 4YR','C/B 5YR','C/B 6YR'];

function toRow(s, i) {
  return [i+1, s.nsdlCode, s.amfiCode, s.schemeName, formatLaunchDate(s.launchDate), s.amc,
          s.schemeType, s.schemeCategory, s.brokeragePeriod || '–', formatArnDisplay(s.brokerageArn),
          s.terDiff ?? '', s.berDiff ?? '',
          s.regularBER ?? '',
          s.year1 ?? '', s.year2 ?? '', s.year3 ?? '', s.year4 ?? '', 
          s.yearOnward ?? '', s.year6Onward ?? '',
          s.c1 ?? '', s.c2 ?? '', s.c3 ?? '', s.c4 ?? '', s.c5 ?? '', s.c6 ?? ''];
}

function xlsWrap(rows) {
  const t = `<table><thead><tr>${HEADERS.map(h=>`<th>${h}</th>`).join('')}</tr></thead><tbody>`
    + rows.map(r=>`<tr>${r.map(c=>`<td>${c??''}</td>`).join('')}</tr>`).join('') + `</tbody></table>`;
  return `<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:x="urn:schemas-microsoft-com:office:excel"><head><meta charset="utf-8"/></head><body>${t}</body></html>`;
}

function dl(content, name, mime) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([content], { type: mime }));
  a.download = name; a.click();
}

window.exportAllExcel = () => {
  if (!state.all.length) { toast('No data loaded','warning'); return; }
  dl(xlsWrap(state.all.map(toRow)), `TER_All_${state.all.length}.xls`, 'application/vnd.ms-excel;charset=utf-8');
  toast(`Exported all ${state.all.length.toLocaleString()} schemes`, 'success');
};

window.exportCSV = () => {
  const csv = [HEADERS, ...state.filtered.map(toRow)]
    .map(r => r.map(c => `"${String(c??'').replace(/"/g,'""')}"`).join(',')).join('\n');
  dl(csv, 'ter-filtered.csv', 'text/csv');
  toast(`CSV: ${state.filtered.length.toLocaleString()} schemes`, 'success');
};

window.exportExcel = () => {
  dl(xlsWrap(state.filtered.map(toRow)), `ter-filtered-${state.filtered.length}.xls`, 'application/vnd.ms-excel;charset=utf-8');
  toast(`Excel: ${state.filtered.length.toLocaleString()} schemes`, 'success');
};

window.copyTable = () => {
  const total = state.filtered.length;
  const capped = state.filtered.slice(0, 500);
  const text = [HEADERS, ...capped.map(toRow)].map(r => r.join('\t')).join('\n');
  navigator.clipboard.writeText(text)
    .then(() => {
      if (total > 500) {
        toast(`Copied first 500 of ${total.toLocaleString()} rows — use CSV/Excel export for the full data`, 'warning', 5000);
      } else {
        toast(`Copied ${total.toLocaleString()} rows`, 'success');
      }
    })
    .catch(() => toast('Copy failed', 'error'));
};

/**
 * Print always printed whatever page of rows happened to be on screen
 * (pagination only ever renders the current page into the table), so a
 * filtered set larger than one page silently lost rows in the printout.
 * This expands to every filtered row for whichever table is present on
 * the current page (Home or Old Brokerage Data), prints, then restores
 * normal pagination once the print dialog closes.
 */
window.printTable = () => {
  let restore = null;

  if (document.getElementById('tbody') && typeof state !== 'undefined' && typeof render === 'function') {
    const origPageSize = state.pageSize, origPage = state.page;
    state.pageSize = state.filtered.length || 1;
    state.page = 1;
    render();
    restore = () => { state.pageSize = origPageSize; state.page = origPage; render(); };
  } else if (document.getElementById('obTbody') && typeof obState !== 'undefined' && typeof obRender === 'function') {
    const origPageSize = obState.pageSize, origPage = obState.page;
    obState.pageSize = obState.filtered.length || 1;
    obState.page = 1;
    obRender();
    restore = () => { obState.pageSize = origPageSize; obState.page = origPage; obRender(); };
  }

  window.print();

  if (restore) {
    const after = () => { restore(); window.removeEventListener('afterprint', after); };
    window.addEventListener('afterprint', after);
  }
};

/* ── Columns visibility chooser ("Hide Columns") ─────────────────── */
window.mainToggleColMenu = function (event) {
  if (event) event.stopPropagation();
  const menu = $('mainColMenu');
  const btn = $('mainColChooserBtn');
  const arrow = $('mainColChooserArrow');
  if (!menu) return;

  const willOpen = menu.hidden === true;
  menu.hidden = !willOpen;
  if (btn) btn.setAttribute('aria-expanded', willOpen ? 'true' : 'false');
  if (arrow) arrow.textContent = willOpen ? '▴' : '▾';
};

window.mainCloseColMenu = function () {
  const menu = $('mainColMenu');
  const btn = $('mainColChooserBtn');
  const arrow = $('mainColChooserArrow');
  if (!menu || menu.hidden) return;
  menu.hidden = true;
  if (btn) btn.setAttribute('aria-expanded', 'false');
  if (arrow) arrow.textContent = '▾';
};

const mainHiddenCols = new Set();

function mainApplyColumnVisibility() {
  const table = document.querySelector('table.ter-table');
  const menu = $('mainColMenu');
  if (!table || !menu) return;
  menu.querySelectorAll('input[type="checkbox"]').forEach(cb => {
    const col = cb.value;
    const hide = mainHiddenCols.has(col);
    table.querySelectorAll(`[data-col="${col}"]`).forEach(el => {
      el.style.display = hide ? 'none' : '';
    });
  });
}

function setupMainColumnChooser() {
  const menu = $('mainColMenu');
  const btn = $('mainColChooserBtn');
  if (!menu || !btn) return;

  document.addEventListener('click', (e) => {
    if (!menu.hidden && !menu.contains(e.target) && e.target !== btn && !btn.contains(e.target)) {
      mainCloseColMenu();
    }
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !menu.hidden) mainCloseColMenu();
  });

  menu.querySelectorAll('input[type="checkbox"]').forEach(cb => {
    cb.addEventListener('change', () => {
      if (cb.checked) mainHiddenCols.add(cb.value);
      else mainHiddenCols.delete(cb.value);
      mainApplyColumnVisibility();
    });
  });

  const resetBtn = $('mainColResetBtn');
  if (resetBtn) resetBtn.addEventListener('click', () => {
    mainHiddenCols.clear();
    menu.querySelectorAll('input[type="checkbox"]').forEach(cb => { cb.checked = false; });
    mainApplyColumnVisibility();
  });
}
// Own listener, independent of the main bindFilters()/loadData() flow,
// same reasoning as the sticky-header-offset listener above.
document.addEventListener('DOMContentLoaded', setupMainColumnChooser);

/* ── Init ────────────────────────────────────────────────────────── */
// main.js is loaded on EVERY page (see views/partials/footer.ejs), but the
// scheme table, its filters, and the Save-Sync buttons only exist in the
// DOM on the Home page (views/index.ejs). Without this guard, every other
// page (login, Old Brokerage Data, admin users, about) was still running
// the full loadData()/showSkeleton() flow on load — throwing a
// "Cannot set properties of null" error against the missing #tbody
// element, firing needless /api/schemes network calls, and leaving a
// 60-second polling timer running forever in the background for the rest
// of that page's life. Guarding on the one element that only the Home
// page has keeps all of that scoped to where it belongs.
document.addEventListener('DOMContentLoaded', async () => {
  if (!tbody) return;
  bindFilters();
  bindSyncButtons();
  await loadData();

  setInterval(async () => {
    try {
      const j = await fetch('/api/status').then(r => r.json());
      if (j.status === 'ready' && state.all.length === 0) await loadData();
      else updateStatus(j.status, j.lastRefreshed);
    } catch {}
  }, 60000);
});