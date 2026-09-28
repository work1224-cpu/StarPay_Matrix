/**
 * public/js/old-brokerage.js
 * "Old Brokerage Data" page — date-wise historical brokerage/trail data,
 * loaded once from /api/old-brokerage. All filtering (AMC, category, search,
 * and the From/To date-range) is done client-side, same pattern as the
 * main TER table and the distributor brokerage table.
 */

const obState = {
  all:      [],
  filtered: [],
  page:     1,
  pageSize: 50,
  sortCol:  'periodFrom',
  sortDir:  'desc',
  editing:  null,
  hiddenCols: new Set(),
  f: { amc:'', category:'', arn:'', search:'', from:'', to:'', missingBrokerage:'' },
};

function obIsAdmin() {
  return document.querySelector('main.main')?.dataset.admin === 'true';
}

const $ob = id => document.getElementById(id);
const obTbody = $ob('obTbody');
const obPagin = $ob('obPagination');

function obFmt(v) {
  if (v === null || v === undefined) return '–';
  const n = +v; if (isNaN(n)) return '–';
  return n.toFixed(3).replace(/\.?0+$/, '') + '%';
}
function obEsc(s) {
  if (!s) return '';
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function obHasArn(rowArn, selectedArn) {
  return String(rowArn || '')
    .split(/[,;|\n]+/)
    .map(arn => arn.trim())
    .includes(selectedArn);
}
function obPeriodLabel(s) {
  if (s.unknownPeriod) return `<span class="badge badge-close">${obEsc(s.period || 'Not specified')}</span>`;
  const suffix = s.ongoing ? ' <span class="badge badge-open">ongoing</span>' : '';
  return `${obEsc(s.period)}${suffix}`;
}

/* ── Editable year cell (admin only) ─────────────────────────────── */
function obRenderYearCell(s, field) {
  if (!obIsAdmin()) {
    return `<td class="col-num" data-col="${field}">${obFmt(s[field])}</td>`;
  }

  const isEditing = obState.editing === s.id;
  const value = s[field];

  if (isEditing) {
    return `<td class="col-num" data-col="${field}">
      <input type="number" step="any" class="year-input"
             data-field="${field}" data-id="${s.id}"
             value="${value !== null && value !== undefined ? value : ''}"
             placeholder="–">
    </td>`;
  }

  return `<td class="col-num year-cell" data-col="${field}" data-field="${field}" data-id="${s.id}">${obFmt(value)}</td>`;
}

function obRenderRatioCell(s, field) {
  const v = s[field];
  const text = (v === null || v === undefined || !isFinite(+v)) ? '–' : (+v).toFixed(4);
  return `<td class="col-num col-ratio" data-col="${field}">${text}</td>`;
}

function obRenderActions(s) {
  const isEditing = obState.editing === s.id;
  if (isEditing) {
    return `<td class="col-actions">
      <button type="button" class="row-save-btn" data-id="${s.id}">💾 Save</button>
      <button type="button" class="row-cancel-btn" data-id="${s.id}">✕ Cancel</button>
    </td>`;
  }
  return `<td class="col-actions">
    <button type="button" class="row-edit-btn" data-id="${s.id}">✎ Edit</button>
    <button type="button" class="row-delete-btn" data-id="${s.id}">🗑 Delete</button>
  </td>`;
}

function obRender() {
  const start = (obState.page - 1) * obState.pageSize;
  const page  = obState.filtered.slice(start, start + obState.pageSize);
  const isAdmin = obIsAdmin();
  const colspan = isAdmin ? 20 : 19;

  if (!page.length) {
    obTbody.innerHTML = `<tr><td colspan="${colspan}"><div class="state-box">
      <span class="state-icon">🔍</span>
      <h3>No records found</h3>
      <p>Try adjusting your filters or date range.</p>
    </div></td></tr>`;
    obRenderPagination();
    return;
  }

  obTbody.innerHTML = page.map((s, i) => {
    const editingThisRow = obState.editing === s.id;
    return `<tr class="${editingThisRow ? 'editing-row' : ''}">
    <td class="col-sr col-num" data-col="id">${start + i + 1}</td>
    <td class="col-amc" data-col="amc">${obEsc(s.amc)}</td>
    <td class="col-name" data-col="scheme"><strong>${obEsc(s.scheme)}</strong></td>
    <td class="col-cat" data-col="category">${obEsc(s.category) || '–'}</td>
    <td style="font-size:.78rem" data-col="arn">${obEsc(s.arn) || '–'}</td>
    <td style="font-size:.78rem" data-col="periodFrom">${obPeriodLabel(s)}</td>
    ${obRenderYearCell(s, 'year1')}
    ${obRenderYearCell(s, 'year2')}
    ${obRenderYearCell(s, 'year3')}
    ${obRenderYearCell(s, 'year4')}
    ${obRenderYearCell(s, 'year5')}
    ${obRenderYearCell(s, 'year6')}
    <td class="col-num" data-col="ber">${obFmt(s.ber)}</td>
    ${obRenderRatioCell(s, 'c1')}
    ${obRenderRatioCell(s, 'c2')}
    ${obRenderRatioCell(s, 'c3')}
    ${obRenderRatioCell(s, 'c4')}
    ${obRenderRatioCell(s, 'c5')}
    ${obRenderRatioCell(s, 'c6')}
    ${isAdmin ? obRenderActions(s) : ''}
  </tr>`;
  }).join('');

  if (isAdmin) obBindTableEvents();
  obRenderPagination();
  obApplyColumnVisibility();
}

function obRenderPagination() {
  if (!obPagin) return;
  const total = obState.filtered.length;
  const tp    = Math.ceil(total / obState.pageSize) || 1;
  const cur   = obState.page;
  const s     = total ? (cur - 1) * obState.pageSize + 1 : 0;
  const e     = Math.min(cur * obState.pageSize, total);

  let btns = `<button class="page-btn" ${cur===1?'disabled':''} onclick="obGoPage(${cur-1})">‹</button>`;
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
      : `<button class="page-btn ${p===cur?'active':''}" onclick="obGoPage(${p})">${p}</button>`;
  });
  btns += `<button class="page-btn" ${cur>=tp?'disabled':''} onclick="obGoPage(${cur+1})">›</button>`;

  obPagin.innerHTML = `
    <div class="pagination-info">Showing <strong>${total ? `${s}–${e}` : '0'}</strong> of <strong>${total.toLocaleString()}</strong> records</div>
    <div class="pagination-controls">${btns}</div>`;
}

window.obGoPage = p => {
  const tp = Math.ceil(obState.filtered.length / obState.pageSize) || 1;
  if (p < 1 || p > tp) return;
  obState.page = p; obRender();
  window.scrollTo({ top: 0, behavior: 'smooth' });
};

/* ── Table Events - Edit/Save/Cancel (admin only) ────────────────── */
function obBindTableEvents() {
  obTbody.removeEventListener('click', obHandleTableClick);
  obTbody.addEventListener('click', obHandleTableClick);
}

function obHandleTableClick(event) {
  const btn = event.target.closest('button');

  if (btn) {
    const id = parseInt(btn.dataset.id, 10);
    if (isNaN(id)) return;

    if (btn.classList.contains('row-edit-btn')) {
      obStartEditing(id);
      return;
    }
    if (btn.classList.contains('row-save-btn')) {
      obSaveEditing(id);
      return;
    }
    if (btn.classList.contains('row-delete-btn')) {
      obDeleteRow(id);
      return;
    }
    if (btn.classList.contains('row-cancel-btn')) {
      obState.editing = null;
      obRender();
      return;
    }
    return;
  }

  // Not a button click — check for the click-directly-on-the-cell shortcut.
  // Must be checked against the actual click target, since year cells are
  // plain <td> elements with no button (same fix as main.js's
  // handleTableClick — see its comment for why the previous version, which
  // re-used `target` after narrowing it to .closest('button'), never
  // actually reached this branch).
  const yearCell = event.target.closest('.year-cell');
  if (yearCell && !obState.editing) {
    const cid = parseInt(yearCell.dataset.id, 10);
    if (!isNaN(cid)) obStartEditing(cid);
  }
}

function obStartEditing(id) {
  obState.editing = id;
  obRender();
  setTimeout(() => {
    const firstInput = obTbody.querySelector('.year-input');
    if (firstInput) { firstInput.focus(); firstInput.select(); }
  }, 50);
}

async function obSaveEditing(id) {
  const rowData = obState.all.find(s => s.id === id);
  if (!rowData) return;

  const inputs = obTbody.querySelectorAll(`.year-input[data-id="${id}"]`);
  const values = {};
  inputs.forEach(input => {
    const field = input.dataset.field;
    const raw = input.value.trim();
    values[field] = raw === '' ? null : parseFloat(raw);
  });

  for (const [key, val] of Object.entries(values)) {
    if (val !== null && (isNaN(val) || !isFinite(val))) {
      alert(`Invalid value for ${key}`);
      return;
    }
  }

  try {
    const res = await fetch('/api/old-brokerage/update', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        amc: rowData.amc,
        scheme: rowData.scheme,
        period: rowData.period,
        values,
      }),
    });
    const j = await res.json().catch(() => null);
    if (!res.ok || !j || !j.success) {
      throw new Error((j && j.message) || `Update failed (HTTP ${res.status})`);
    }

    // Trust the server's confirmed saved values (not just what we typed),
    // so the cell always reflects what's actually persisted.
    const saved = j.data || values;
    Object.assign(rowData, saved, { edited: true });
    console.info('[old-brokerage] saved & confirmed:', rowData.scheme, saved);

    obState.editing = null;
    obRender();
  } catch (err) {
    console.error('[old-brokerage] save failed:', err);
    alert(err.message || 'Update failed');
    obRender();
  }
}

async function obDeleteRow(id) {
  const rowData = obState.all.find(s => s.id === id);
  if (!rowData) return;

  const confirmed = confirm(`Delete "${rowData.scheme}" (${rowData.amc}, ${rowData.period})?\n\nThis cannot be undone from here.`);
  if (!confirmed) return;

  try {
    const res = await fetch('/api/old-brokerage/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ amc: rowData.amc, scheme: rowData.scheme, period: rowData.period }),
    });
    const j = await res.json().catch(() => null);
    if (!res.ok || !j || !j.success) {
      throw new Error((j && j.message) || `Delete failed (HTTP ${res.status})`);
    }

    obState.all = obState.all.filter(s => s.id !== id);
    obState.filtered = obState.filtered.filter(s => s.id !== id);
    if (obState.editing === id) obState.editing = null;
    obRender();
    obUpdateCounts();
  } catch (err) {
    console.error('[old-brokerage] delete failed:', err);
    alert(err.message || 'Delete failed');
  }
}

/**
 * Applies obState.sortCol/sortDir to obState.filtered in place. Shared by
 * the header-click handler AND every place that rebuilds obState.filtered
 * (initial load, filter changes, "Get Old Sync Data") so the table's
 * default "newest Date Period first" ordering never gets silently reset
 * back to the base file's raw row order.
 */
function obApplySort() {
  const col = obState.sortCol;
  if (!col) return;
  obState.filtered.sort((a, b) => {
    let va = a[col], vb = b[col];
    if (va == null) va = obState.sortDir === 'asc' ? Infinity : -Infinity;
    if (vb == null) vb = obState.sortDir === 'asc' ? Infinity : -Infinity;
    if (typeof va === 'string') va = va.toLowerCase();
    if (typeof vb === 'string') vb = vb.toLowerCase();
    return (va < vb ? -1 : va > vb ? 1 : 0) * (obState.sortDir === 'asc' ? 1 : -1);
  });
}

window.sortByOB = col => {
  obState.sortDir = (obState.sortCol === col && obState.sortDir === 'asc') ? 'desc' : 'asc';
  obState.sortCol = col;
  obApplySort();
  obState.page = 1; obRender();
};

/**
 * Date-range overlap test.
 * - No filter set at all -> everything passes (including "unknown period" rows).
 * - Filter set (from and/or to) -> a row passes only if its own validity
 *   period (periodFrom → periodTo, or "today" when ongoing/open-ended)
 *   overlaps the selected range. Rows with no parseable date are excluded
 *   once a date filter is active, since we can't confirm they fall in range.
 */
function obDateMatch(s, from, to) {
  if (!from && !to) return true;
  if (!s.periodFrom) return false;

  const rowFrom = s.periodFrom;
  const rowTo   = s.periodTo || new Date().toISOString().slice(0, 10); // ongoing -> valid through today

  if (from && rowTo < from) return false;
  if (to && rowFrom > to) return false;
  return true;
}

function obApplyFilters() {
  const { amc, category, arn, search, from, to, missingBrokerage } = obState.f;
  const lo = s => (s || '').toLowerCase();

  obState.filtered = obState.all.filter(s => {
    if (amc      && s.amc !== amc)                       return false;
    if (category && s.category !== category)             return false;
    if (arn      && !obHasArn(s.arn, arn))               return false;
    if (search   && !lo(s.scheme).includes(lo(search)))  return false;
    if (!obDateMatch(s, from, to))                        return false;
    if (missingBrokerage === 'missing') {
      const brokerageValues = [s.year1, s.year2, s.year3, s.year4, s.year5, s.year6];
      if (!brokerageValues.some(value => value === null || value === undefined || value === '')) return false;
    }
    return true;
  });

  obApplySort();
  obState.page = 1;
  obRender();
  obUpdateCounts();
}

function obUpdateCounts() {
  const totalEl = $ob('obTotalCount');
  const showingEl = $ob('obShowingCount');
  const heroEl = $ob('obTotalHero');
  if (totalEl) totalEl.textContent = obState.filtered.length.toLocaleString();
  if (showingEl) showingEl.textContent = obState.filtered.length.toLocaleString();
  if (heroEl) heroEl.textContent = obState.all.length.toLocaleString();
}

function obDebounce(fn, ms=200) {
  let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

function obBindFilters() {
  [['obFilterAMC','amc'], ['obFilterCategory','category'], ['obFilterArn','arn'], ['obFilterMissingBrokerage','missingBrokerage']].forEach(([id, key]) => {
    const el = $ob(id); if (!el) return;
    el.addEventListener('change', () => { obState.f[key] = el.value; obApplyFilters(); });
  });

  const searchEl = $ob('obFilterSearch');
  if (searchEl) searchEl.addEventListener('input', obDebounce(() => {
    obState.f.search = searchEl.value; obApplyFilters();
  }, 200));

  const fromEl = $ob('obFrom');
  const toEl   = $ob('obTo');
  if (fromEl) fromEl.addEventListener('change', () => {
    obState.f.from = fromEl.value;
    $ob('obQuickRange').value = '';
    obApplyFilters();
  });
  if (toEl) toEl.addEventListener('change', () => {
    obState.f.to = toEl.value;
    $ob('obQuickRange').value = '';
    obApplyFilters();
  });

  const quickEl = $ob('obQuickRange');
  if (quickEl) quickEl.addEventListener('change', () => {
    const val = quickEl.value; // e.g. "2026-2027", or "" for All Time
    if (!val) {
      obState.f.from = ''; obState.f.to = '';
      if (fromEl) fromEl.value = ''; if (toEl) toEl.value = '';
    } else {
      const startYear = parseInt(val.split('-')[0], 10);
      const fromStr = `${startYear}-04-01`;
      const toStr   = `${startYear + 1}-03-31`;
      obState.f.from = fromStr; obState.f.to = toStr;
      if (fromEl) fromEl.value = fromStr; if (toEl) toEl.value = toStr;
    }
    obApplyFilters();
  });

  const pageSizeEl = $ob('obPageSize');
  if (pageSizeEl) pageSizeEl.addEventListener('change', () => {
    obState.pageSize = parseInt(pageSizeEl.value, 10) || 50;
    obState.page = 1; obRender();
  });
}

window.resetOldBrokerageFilters = () => {
  obState.f = { amc:'', category:'', arn:'', search:'', from:'', to:'', missingBrokerage:'' };
  ['obFilterAMC','obFilterCategory','obFilterArn','obFilterMissingBrokerage'].forEach(id => { const el=$ob(id); if(el) el.value=''; });
  const searchEl = $ob('obFilterSearch'); if (searchEl) searchEl.value = '';
  const fromEl = $ob('obFrom'); if (fromEl) fromEl.value = '';
  const toEl = $ob('obTo'); if (toEl) toEl.value = '';
  const quickEl = $ob('obQuickRange'); if (quickEl) quickEl.value = '';
  obApplyFilters();
};

/* ── Load data ───────────────────────────────────────────────────── */
async function obLoadData() {
  const isAdmin = obIsAdmin();
  obTbody.innerHTML = Array.from({length:15}, () =>
    `<tr class="skeleton-row">${'<td><div class="skeleton-cell"></div></td>'.repeat(isAdmin ? 20 : 19)}</tr>`
  ).join('');

  try {
    const res = await fetch('/api/old-brokerage');
    const j = await res.json();
    if (!j.success) throw new Error(j.message || 'Failed to load Old Brokerage Data');

    obState.all = j.data || [];
    obState.filtered = [...obState.all];
    obApplySort();

    if (j.meta && Array.isArray(j.meta.amcs) && j.meta.amcs.length > 0) {
      const amcSelect = $ob('obUploadAmc');
      const filterAmcSelect = $ob('obFilterAMC');
      const curUpload = amcSelect ? amcSelect.value : '__all__';
      const curFilter = filterAmcSelect ? filterAmcSelect.value : '';

      if (amcSelect) {
        amcSelect.innerHTML = '<option value="__all__">All AMCs</option>' +
          j.meta.amcs.map(a => `<option value="${obEsc(a)}">${obEsc(a)}</option>`).join('');
        amcSelect.value = curUpload;
      }
      if (filterAmcSelect) {
        filterAmcSelect.innerHTML = '<option value="">All AMCs</option>' +
          j.meta.amcs.map(a => `<option value="${obEsc(a)}">${obEsc(a)}</option>`).join('');
        filterAmcSelect.value = curFilter;
      }
    }

    obRender();
    obUpdateCounts();
  } catch (err) {
    obTbody.innerHTML = `<tr><td colspan="${obIsAdmin() ? 20 : 19}"><div class="state-box">
      <span class="state-icon">⚠️</span>
      <h3>Failed to load data</h3>
      <p>${obEsc(err.message)}</p>
      <button class="btn btn-primary" onclick="obLoadData()" style="margin-top:1rem">⟳ Retry</button>
    </div></td></tr>`;
  }
}

/* ── Export ──────────────────────────────────────────────────────── */
const OB_HEADERS = ['#','AMC','Scheme Name','Category','ARN No.','Data Period (Validity)','1st Yr %','2nd Yr %','3rd Yr %','4th Yr %','5th Yr %','6th Yr Onward %','BER (%)','C/B 1YR','C/B 2YR','C/B 3YR','C/B 4YR','C/B 5YR','C/B 6YR'];
function obToRow(s, i) {
  return [i+1, s.amc, s.scheme, s.category, s.arn, s.period, s.year1 ?? '', s.year2 ?? '', s.year3 ?? '', s.year4 ?? '', s.year5 ?? '', s.year6 ?? '', s.ber ?? '', s.c1 ?? '', s.c2 ?? '', s.c3 ?? '', s.c4 ?? '', s.c5 ?? '', s.c6 ?? ''];
}
function obXlsWrap(rows) {
  const t = `<table><thead><tr>${OB_HEADERS.map(h=>`<th>${h}</th>`).join('')}</tr></thead><tbody>`
    + rows.map(r=>`<tr>${r.map(c=>`<td>${c??''}</td>`).join('')}</tr>`).join('') + `</tbody></table>`;
  return `<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:x="urn:schemas-microsoft-com:office:excel"><head><meta charset="utf-8"/></head><body>${t}</body></html>`;
}
function obDl(content, name, mime) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([content], { type: mime }));
  a.download = name; a.click();
}
window.exportOldBrokerageAllExcel = () => {
  obDl(obXlsWrap(obState.all.map(obToRow)), `Old_Brokerage_Data_All_${obState.all.length}.xls`, 'application/vnd.ms-excel;charset=utf-8');
};
window.exportOldBrokerageCSV = () => {
  const csv = [OB_HEADERS, ...obState.filtered.map(obToRow)]
    .map(r => r.map(c => `"${String(c??'').replace(/"/g,'""')}"`).join(',')).join('\n');
  obDl(csv, 'old-brokerage-filtered.csv', 'text/csv');
};
window.copyOldBrokerageTable = () => {
  const total = obState.filtered.length;
  const capped = obState.filtered.slice(0, 500);
  const text = [OB_HEADERS, ...capped.map(obToRow)].map(r => r.join('\t')).join('\n');
  navigator.clipboard.writeText(text)
    .then(() => {
      if (typeof toast === 'function') {
        toast(total > 500
          ? `Copied first 500 of ${total.toLocaleString()} rows — use CSV/Excel export for the full data`
          : `Copied ${total.toLocaleString()} rows`, total > 500 ? 'warning' : 'success', 5000);
      }
    })
    .catch(() => { if (typeof toast === 'function') toast('Copy failed', 'error'); });
};

/* ── Data Upload panel (admin only) ─────────────────────────────── */
function obSetupUploadPanel() {
  const btn = $ob('obBtnShowCommission');
  const panel = $ob('obPanelCommission');
  const addPanel = $ob('obPanelAdd');
  if (btn && panel) {
    btn.addEventListener('click', () => {
      if (panel.hasAttribute('hidden')) {
        panel.removeAttribute('hidden');
        if (addPanel) addPanel.setAttribute('hidden', '');
      } else {
        panel.setAttribute('hidden', '');
      }
    });
  }

  const fileInput = $ob('obFileCommission');
  const fileNameEl = $ob('obFileNameCommission');
  const submitBtn = $ob('obSubmitCommission');
  const statusEl = $ob('obStatusCommission');
  const amcSelect = $ob('obUploadAmc');
  if (!fileInput || !submitBtn) return;

  fileInput.addEventListener('change', () => {
    const f = fileInput.files[0];
    fileNameEl.textContent = f ? f.name : 'No file chosen';
    statusEl.textContent = '';
    statusEl.className = 'upload-status';
    submitBtn.disabled = !f;
  });

  submitBtn.addEventListener('click', async () => {
    const f = fileInput.files[0];
    if (!f) return;

    submitBtn.disabled = true;
    submitBtn.textContent = '⏳ Uploading…';
    statusEl.textContent = '';
    statusEl.className = 'upload-status';

    try {
      const fd = new FormData();
      fd.append('file', f);
      fd.append('amc', amcSelect ? amcSelect.value : '__all__');
      const res = await fetch('/api/old-brokerage/upload', { method: 'POST', body: fd });
      const j = await res.json().catch(() => null);
      if (!res.ok || !j || !j.success) {
        throw new Error((j && j.message) || `Upload failed (HTTP ${res.status})`);
      }

      statusEl.textContent = '✅ ' + j.message;
      statusEl.className = 'upload-status upload-status-ok';
      obLoadData(); // refresh table with newly added/updated rows
    } catch (err) {
      console.error('[old-brokerage] upload failed:', err);
      statusEl.textContent = '⚠ ' + err.message;
      statusEl.className = 'upload-status upload-status-err';
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = '⬆ Upload & Update';
      fileInput.value = '';
      fileNameEl.textContent = 'No file chosen';
    }
  });
}

/* ── Add New Scheme (manual entry, no file) panel ───────────────── */
function obClearAddForm() {
  ['obAddAmc','obAddPeriod','obAddScheme','obAddCategory','obAddArn','obAddYear1','obAddYear2','obAddYear3','obAddYear4','obAddYear5','obAddYear6']
    .forEach(id => { const el = $ob(id); if (el) el.value = ''; });
  const statusEl = $ob('obStatusAdd');
  if (statusEl) { statusEl.textContent = ''; statusEl.className = 'upload-status'; }
}

function obSetupAddPanel() {
  const btn = $ob('obBtnShowAdd');
  const panel = $ob('obPanelAdd');
  const commissionPanel = $ob('obPanelCommission');
  if (btn && panel) {
    btn.addEventListener('click', () => {
      if (panel.hasAttribute('hidden')) {
        panel.removeAttribute('hidden');
        if (commissionPanel) commissionPanel.setAttribute('hidden', '');
      } else {
        panel.setAttribute('hidden', '');
      }
    });
  }

  const clearBtn = $ob('obClearAdd');
  if (clearBtn) clearBtn.addEventListener('click', obClearAddForm);

  const submitBtn = $ob('obSubmitAdd');
  const statusEl = $ob('obStatusAdd');
  if (!submitBtn) return;

  submitBtn.addEventListener('click', async () => {
    const amc = $ob('obAddAmc').value.trim();
    const period = $ob('obAddPeriod').value.trim();
    const scheme = $ob('obAddScheme').value.trim();
    const category = $ob('obAddCategory').value.trim();
    const arn = $ob('obAddArn').value.trim();

    if (!amc || !period || !scheme) {
      statusEl.textContent = '⚠ AMC, Data Period and Scheme Name are all required.';
      statusEl.className = 'upload-status upload-status-err';
      return;
    }

    const values = { category, arn };
    ['year1','year2','year3','year4','year5','year6'].forEach((f, i) => {
      const raw = $ob(`obAddYear${i + 1}`).value.trim();
      values[f] = raw === '' ? null : parseFloat(raw);
    });
    for (const [k, v] of Object.entries(values)) {
      if ((k === 'category' || k === 'arn')) continue;
      if (v !== null && (isNaN(v) || !isFinite(v))) {
        statusEl.textContent = `⚠ Invalid value for ${k}`;
        statusEl.className = 'upload-status upload-status-err';
        return;
      }
    }

    submitBtn.disabled = true;
    submitBtn.textContent = '⏳ Saving…';
    statusEl.textContent = '';
    statusEl.className = 'upload-status';

    try {
      const res = await fetch('/api/old-brokerage/update', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ amc, scheme, period, values }),
      });
      const j = await res.json().catch(() => null);
      if (!res.ok || !j || !j.success) {
        throw new Error((j && j.message) || `Save failed (HTTP ${res.status})`);
      }

      statusEl.textContent = `✅ Saved "${scheme}" for ${period}.`;
      statusEl.className = 'upload-status upload-status-ok';
      obClearAddForm();
      obLoadData(); // refresh table so the new row shows up immediately
    } catch (err) {
      console.error('[old-brokerage] add scheme failed:', err);
      statusEl.textContent = '⚠ ' + err.message;
      statusEl.className = 'upload-status upload-status-err';
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = '💾 Save New Scheme';
    }
  });
}

/* ── Columns visibility chooser ("Hide Section" for columns) ────── */
/**
 * Explicit, single-source-of-truth toggle for the "Columns" dropdown —
 * called directly via onclick="" on the button (not addEventListener), so
 * there is no possibility of it ever getting bound twice and cancelling
 * itself out. This ONLY shows/hides the dropdown panel — the actual
 * hidden columns (obState.hiddenCols, driven by the checkboxes) are
 * completely independent of the panel being open or closed.
 */
window.obToggleColMenu = function (event) {
  if (event) event.stopPropagation();
  const menu = $ob('obColMenu');
  const btn = $ob('obColChooserBtn');
  const arrow = $ob('obColChooserArrow');
  if (!menu) return;

  const willOpen = menu.hidden === true; // currently closed -> we're opening it
  menu.hidden = !willOpen;
  if (btn) btn.setAttribute('aria-expanded', willOpen ? 'true' : 'false');
  if (arrow) arrow.textContent = willOpen ? '▴' : '▾';
};

window.obCloseColMenu = function () {
  const menu = $ob('obColMenu');
  const btn = $ob('obColChooserBtn');
  const arrow = $ob('obColChooserArrow');
  if (!menu || menu.hidden) return;
  menu.hidden = true;
  if (btn) btn.setAttribute('aria-expanded', 'false');
  if (arrow) arrow.textContent = '▾';
};

function obApplyColumnVisibility() {
  const table = document.querySelector('.ter-table');
  if (!table) return;
  const menu = $ob('obColMenu');
  if (!menu) return;
  menu.querySelectorAll('input[type="checkbox"]').forEach(cb => {
    const col = cb.value;
    const hide = obState.hiddenCols.has(col);
    table.querySelectorAll(`[data-col="${col}"]`).forEach(el => {
      el.style.display = hide ? 'none' : '';
    });
  });
}

function obSetupColumnChooser() {
  const menu = $ob('obColMenu');
  const btn = $ob('obColChooserBtn');
  if (!menu || !btn) return;

  document.addEventListener('click', (e) => {
    if (!menu.hidden && !menu.contains(e.target) && e.target !== btn && !btn.contains(e.target)) {
      obCloseColMenu();
    }
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !menu.hidden) obCloseColMenu();
  });

  menu.querySelectorAll('input[type="checkbox"]').forEach(cb => {
    cb.addEventListener('change', () => {
      if (cb.checked) obState.hiddenCols.add(cb.value);
      else obState.hiddenCols.delete(cb.value);
      obApplyColumnVisibility();
    });
  });

  const resetBtn = $ob('obColResetBtn');
  if (resetBtn) resetBtn.addEventListener('click', () => {
    obState.hiddenCols.clear();
    menu.querySelectorAll('input[type="checkbox"]').forEach(cb => { cb.checked = false; });
    obApplyColumnVisibility();
  });
}

/* ── Save Sync restore (shared snapshot with the Home page) ────────── */
// main.js (loaded on every page, see views/partials/footer.ejs) defines a
// global toast() helper. Wrapped here defensively so this page never throws
// if that script ordering ever changes.
function obToastMsg(msg, type) {
  if (typeof toast === 'function') toast(msg, type);
}

function obSetupSyncButton() {
  const btn = $ob('obBtnGetOldSync');
  if (!btn) return;
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    try {
      const res = await fetch('/api/old-brokerage/sync/old');
      const j = await res.json();
      if (!res.ok || !j.success) throw new Error(j.message || 'No saved sync copy found');

      obState.all = j.data || [];
      obState.filtered = [...obState.all];
      obApplySort();
      obRender();
      obUpdateCounts();

      const statusEl = $ob('obSyncStatus');
      const savedAt = j.savedAt ? new Date(j.savedAt).toLocaleString('en-IN') : 'an earlier time';
      if (statusEl) statusEl.textContent = `Showing saved sync data from ${savedAt}. Filters and exports are active.`;
      obToastMsg(`Loaded ${obState.all.length.toLocaleString()} records from saved sync`, 'success');
    } catch (err) {
      obToastMsg(err.message || 'Could not load saved sync copy', 'error');
    } finally {
      btn.disabled = false;
    }
  });
}

/* ── Init ────────────────────────────────────────────────────────── */
document.addEventListener('DOMContentLoaded', () => {
  obBindFilters();
  obSetupUploadPanel();
  obSetupAddPanel();
  obSetupColumnChooser();
  obSetupSyncButton();
  obLoadData();
});