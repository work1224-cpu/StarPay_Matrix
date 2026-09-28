/**
 * public/js/brokerage.js
 * Distributor brokerage/trail-commission table — fully static data,
 * loaded once from /api/brokerage. All filtering/sorting is client-side.
 */

const bState = {
  all:      [],
  filtered: [],
  page:     1,
  pageSize: 50,
  sortCol:  null,
  sortDir:  'asc',
  f: { amc:'', category:'', gst:'', search:'' },
};

const $b = id => document.getElementById(id);
const bTbody   = $b('bTbody');
const bPagin   = $b('bPagination');

function bFmt(v) {
  if (v === null || v === undefined) return '–';
  const n = +v; if (isNaN(n)) return '–';
  return n.toFixed(3).replace(/\.?0+$/, '') + '%';
}
function bEsc(s) {
  if (!s) return '';
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function gstBadgeClass(g) {
  if (g === 'Inclusive of GST') return 'badge-open';
  if (g === 'Exclusive of GST') return 'badge-interval';
  return 'badge-close';
}

function bRender() {
  const start = (bState.page - 1) * bState.pageSize;
  const page  = bState.filtered.slice(start, start + bState.pageSize);

  if (!page.length) {
    bTbody.innerHTML = `<tr><td colspan="11"><div class="state-box">
      <span class="state-icon">🔍</span>
      <h3>No schemes found</h3>
      <p>Try adjusting your filters.</p>
    </div></td></tr>`;
    bRenderPagination();
    return;
  }

  bTbody.innerHTML = page.map((s, i) => `<tr>
    <td class="col-sr col-num">${start + i + 1}</td>
    <td class="col-amc">${bEsc(s.amc)}</td>
    <td class="col-name"><strong>${bEsc(s.scheme)}</strong></td>
    <td class="col-cat">${bEsc(s.category) || '–'}</td>
    <td class="col-num">${bFmt(s.year1)}</td>
    <td class="col-num">${bFmt(s.year2)}</td>
    <td class="col-num">${bFmt(s.year3)}</td>
    <td class="col-num">${bFmt(s.year4)}</td>
    <td class="col-num">${bFmt(s.yearOnward)}</td>
    <td><span class="badge ${gstBadgeClass(s.gst)}">${bEsc(s.gst)}</span></td>
    <td style="max-width:320px;font-size:.78rem;color:var(--text-muted)">${bEsc(s.notes)}</td>
  </tr>`).join('');

  bRenderPagination();
}

function bRenderPagination() {
  if (!bPagin) return;
  const total = bState.filtered.length;
  const tp    = Math.ceil(total / bState.pageSize) || 1;
  const cur   = bState.page;
  const s     = total ? (cur - 1) * bState.pageSize + 1 : 0;
  const e     = Math.min(cur * bState.pageSize, total);

  let btns = `<button class="page-btn" ${cur===1?'disabled':''} onclick="bGoPage(${cur-1})">‹</button>`;
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
      : `<button class="page-btn ${p===cur?'active':''}" onclick="bGoPage(${p})">${p}</button>`;
  });
  btns += `<button class="page-btn" ${cur>=tp?'disabled':''} onclick="bGoPage(${cur+1})">›</button>`;

  bPagin.innerHTML = `
    <div class="pagination-info">Showing <strong>${total ? `${s}–${e}` : '0'}</strong> of <strong>${total.toLocaleString()}</strong> schemes</div>
    <div class="pagination-controls">${btns}</div>`;
}

window.bGoPage = p => {
  const tp = Math.ceil(bState.filtered.length / bState.pageSize) || 1;
  if (p < 1 || p > tp) return;
  bState.page = p; bRender();
  window.scrollTo({ top: 0, behavior: 'smooth' });
};

window.sortByB = col => {
  bState.sortDir = (bState.sortCol === col && bState.sortDir === 'asc') ? 'desc' : 'asc';
  bState.sortCol = col;
  bState.filtered.sort((a, b) => {
    let va = a[col], vb = b[col];
    if (va == null) va = bState.sortDir === 'asc' ? Infinity : -Infinity;
    if (vb == null) vb = bState.sortDir === 'asc' ? Infinity : -Infinity;
    if (typeof va === 'string') va = va.toLowerCase();
    if (typeof vb === 'string') vb = vb.toLowerCase();
    return (va < vb ? -1 : va > vb ? 1 : 0) * (bState.sortDir === 'asc' ? 1 : -1);
  });
  bState.page = 1; bRender();
};

function bApplyFilters() {
  const { amc, category, gst, search } = bState.f;
  const lo = s => (s || '').toLowerCase();

  bState.filtered = bState.all.filter(s => {
    if (amc      && s.amc !== amc)               return false;
    if (category && s.category !== category)     return false;
    if (gst      && s.gst !== gst)                return false;
    if (search   && !lo(s.scheme).includes(lo(search))) return false;
    return true;
  });

  bState.page = 1;
  bRender();
  bUpdateCounts();
}

function bUpdateCounts() {
  const totalEl = $b('bTotalCount');
  const showingEl = $b('bShowingCount');
  if (totalEl) totalEl.textContent = bState.filtered.length.toLocaleString();
  if (showingEl) showingEl.textContent = bState.filtered.length.toLocaleString();
}

function bDebounce(fn, ms=200) {
  let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

function bBindFilters() {
  [['bFilterAMC','amc'], ['bFilterCategory','category'], ['bFilterGST','gst']].forEach(([id, key]) => {
    const el = $b(id); if (!el) return;
    el.addEventListener('change', () => { bState.f[key] = el.value; bApplyFilters(); });
  });
  const searchEl = $b('bFilterSearch');
  if (searchEl) searchEl.addEventListener('input', bDebounce(() => {
    bState.f.search = searchEl.value; bApplyFilters();
  }, 200));
  const pageSizeEl = $b('bPageSize');
  if (pageSizeEl) pageSizeEl.addEventListener('change', () => {
    bState.pageSize = parseInt(pageSizeEl.value, 10) || 50;
    bState.page = 1; bRender();
  });
}

window.resetBrokerageFilters = () => {
  bState.f = { amc:'', category:'', gst:'', search:'' };
  ['bFilterAMC','bFilterCategory','bFilterGST'].forEach(id => { const el=$b(id); if(el) el.value=''; });
  const searchEl = $b('bFilterSearch'); if (searchEl) searchEl.value = '';
  bApplyFilters();
};

/* ── Load data ───────────────────────────────────────────────────── */
async function bLoadData() {
  bTbody.innerHTML = Array.from({length:15}, () =>
    `<tr class="skeleton-row">${'<td><div class="skeleton-cell"></div></td>'.repeat(11)}</tr>`
  ).join('');

  try {
    const res = await fetch('/api/brokerage');
    const j = await res.json();
    if (!j.success) throw new Error(j.message || 'Failed to load brokerage data');

    bState.all = j.data || [];
    bState.filtered = [...bState.all];
    bRender();
    bUpdateCounts();
  } catch (err) {
    bTbody.innerHTML = `<tr><td colspan="11"><div class="state-box">
      <span class="state-icon">⚠️</span>
      <h3>Failed to load data</h3>
      <p>${bEsc(err.message)}</p>
      <button class="btn btn-primary" onclick="bLoadData()" style="margin-top:1rem">⟳ Retry</button>
    </div></td></tr>`;
  }
}

/* ── Export ──────────────────────────────────────────────────────── */
const B_HEADERS = ['#','AMC','Scheme Name','Category','1st Yr %','2nd Yr %','3rd Yr %','4th Yr %','5th Yr Onward %','GST Treatment','Notes'];
function bToRow(s, i) {
  return [i+1, s.amc, s.scheme, s.category, s.year1 ?? '', s.year2 ?? '', s.year3 ?? '', s.year4 ?? '', s.yearOnward ?? '', s.gst, s.notes];
}
function bXlsWrap(rows) {
  const t = `<table><thead><tr>${B_HEADERS.map(h=>`<th>${h}</th>`).join('')}</tr></thead><tbody>`
    + rows.map(r=>`<tr>${r.map(c=>`<td>${c??''}</td>`).join('')}</tr>`).join('') + `</tbody></table>`;
  return `<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:x="urn:schemas-microsoft-com:office:excel"><head><meta charset="utf-8"/></head><body>${t}</body></html>`;
}
function bDl(content, name, mime) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([content], { type: mime }));
  a.download = name; a.click();
}
window.exportBrokerageAllExcel = () => {
  bDl(bXlsWrap(bState.all.map(bToRow)), `Brokerage_All_${bState.all.length}.xls`, 'application/vnd.ms-excel;charset=utf-8');
};
window.exportBrokerageCSV = () => {
  const csv = [B_HEADERS, ...bState.filtered.map(bToRow)]
    .map(r => r.map(c => `"${String(c??'').replace(/"/g,'""')}"`).join(',')).join('\n');
  bDl(csv, 'brokerage-filtered.csv', 'text/csv');
};
window.copyBrokerageTable = () => {
  const text = [B_HEADERS, ...bState.filtered.slice(0,500).map(bToRow)].map(r => r.join('\t')).join('\n');
  navigator.clipboard.writeText(text).catch(() => {});
};

/* ── Init ────────────────────────────────────────────────────────── */
document.addEventListener('DOMContentLoaded', () => {
  bBindFilters();
  bLoadData();
});
