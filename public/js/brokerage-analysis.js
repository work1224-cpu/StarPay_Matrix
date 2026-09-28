/**
 * public/js/brokerage-analysis.js
 * Charts + scheme explorer for /brokerage-analysis.
 */
(function () {
  const $ba = (id) => document.getElementById(id);

  const charts = {}; // name -> Chart.js instance, so re-renders destroy+recreate cleanly

  const COMM_LABELS = {
    year1: 'Year 1', year2: 'Year 2', year3: 'Year 3',
    year4: 'Year 4', year5: 'Year 5', year6: '6th Yr Onward',
  };

  function palette(n) {
    const base = ['#1a6fe8', '#22a06b', '#e8871a', '#c0392b', '#8e44ad', '#16a085', '#d35400', '#2c3e50', '#e67e22', '#27ae60', '#2980b9', '#f39c12'];
    const out = [];
    for (let i = 0; i < n; i++) out.push(base[i % base.length]);
    return out;
  }

  function drawOrUpdate(name, canvasId, config) {
    const el = $ba(canvasId);
    if (!el) return;
    if (charts[name]) { charts[name].destroy(); }
    charts[name] = new Chart(el.getContext('2d'), config);
  }

  function currentFilters() {
    return {
      amc: $ba('baFilterAmc')?.value || '',
      category: $ba('baFilterCategory')?.value || '',
      year: $ba('baFilterYear')?.value || '',
      commCol: $ba('baFilterCommYear')?.value || 'year1',
    };
  }

  async function loadSummary() {
    const f = currentFilters();
    const qs = new URLSearchParams();
    if (f.amc) qs.set('amc', f.amc);
    if (f.category) qs.set('category', f.category);
    if (f.year) qs.set('year', f.year);

    let data;
    try {
      const res = await fetch('/api/brokerage-analysis?' + qs.toString());
      data = await res.json();
      if (!res.ok || !data.success) throw new Error(data.message || 'Failed to load analysis data');
    } catch (err) {
      toast(err.message || 'Could not load brokerage analysis data', 'error');
      return;
    }

    $ba('baTotalRecords').textContent = data.totals.totalRecords.toLocaleString('en-IN');
    $ba('baTotalPeriods').textContent = data.totals.totalPeriods.toLocaleString('en-IN');

    renderCharts(data, f.commCol);
  }

  function renderCharts(data, commCol) {
    const commLabel = COMM_LABELS[commCol] || 'Year 1';

    // ── Trend over time (line) ──
    drawOrUpdate('trend', 'baChartTrend', {
      type: 'line',
      data: {
        labels: data.yearlyTrend.map((r) => String(r.year)),
        datasets: [{
          label: `Avg ${commLabel} Commission %`,
          data: data.yearlyTrend.map((r) => r[commCol]),
          borderColor: '#1a6fe8',
          backgroundColor: 'rgba(26,111,232,.12)',
          tension: 0.3,
          fill: true,
          pointRadius: 4,
        }],
      },
      options: baseOptions('Commission %'),
    });

    // ── Top AMCs (horizontal bar) ──
    const amcTop = data.amcComparison.filter((r) => r[commCol] != null).slice(0, 12);
    drawOrUpdate('amc', 'baChartAmc', {
      type: 'bar',
      data: {
        labels: amcTop.map((r) => r.amc),
        datasets: [{
          label: `Avg ${commLabel} Commission %`,
          data: amcTop.map((r) => r[commCol]),
          backgroundColor: palette(amcTop.length),
        }],
      },
      options: horizontalBarOptions('Commission %'),
    });

    // ── Top categories (horizontal bar) ──
    const catTop = data.categoryComparison.filter((r) => r[commCol] != null).slice(0, 12);
    drawOrUpdate('category', 'baChartCategory', {
      type: 'bar',
      data: {
        labels: catTop.map((r) => r.category),
        datasets: [{
          label: `Avg ${commLabel} Commission %`,
          data: catTop.map((r) => r[commCol]),
          backgroundColor: palette(catTop.length),
        }],
      },
      options: horizontalBarOptions('Commission %'),
    });

    // ── Holding-year structure (bar) ──
    drawOrUpdate('holding', 'baChartHolding', {
      type: 'bar',
      data: {
        labels: data.holdingYearStructure.map((r) => r.label),
        datasets: [{
          label: 'Avg Commission %',
          data: data.holdingYearStructure.map((r) => r.avg),
          backgroundColor: '#22a06b',
        }],
      },
      options: baseOptions('Commission %'),
    });

    // ── Distribution (bar) ──
    drawOrUpdate('distribution', 'baChartDistribution', {
      type: 'bar',
      data: {
        labels: data.distribution.map((r) => r.label),
        datasets: [{
          label: 'Number of Records (Year 1 %)',
          data: data.distribution.map((r) => r.count),
          backgroundColor: '#e8871a',
        }],
      },
      options: baseOptions('Records'),
    });
  }

  function baseOptions(yTitle) {
    return {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: { y: { title: { display: true, text: yTitle }, beginAtZero: true } },
    };
  }

  function horizontalBarOptions(xTitle) {
    return {
      responsive: true,
      maintainAspectRatio: false,
      indexAxis: 'y',
      plugins: { legend: { display: false } },
      scales: { x: { title: { display: true, text: xTitle }, beginAtZero: true } },
    };
  }

  // ── Scheme Explorer ──
  let schemeMeta = [];

  function populateSchemeDropdown(amcFilter) {
    const sel = $ba('baSchemeSearch');
    if (!sel) return;
    const prevValue = sel.value;
    const filtered = amcFilter
      ? schemeMeta.filter((s) => s.amc === amcFilter)
      : schemeMeta;
    sel.innerHTML = '<option value="">Select a scheme…</option>'
      + filtered.map((s) => `<option value="${escapeHtml(s.scheme)}" data-amc="${escapeHtml(s.amc)}">${escapeHtml(s.scheme)}</option>`).join('');
    // Keep the current selection if it's still valid for the new AMC filter.
    if (filtered.some((s) => s.scheme === prevValue)) sel.value = prevValue;
  }

  async function loadSchemeMeta() {
    try {
      const res = await fetch('/api/brokerage-analysis/meta');
      const data = await res.json();
      if (!res.ok || !data.success) throw new Error(data.message || 'Failed to load scheme list');
      schemeMeta = data.schemes || [];
      populateSchemeDropdown('');
    } catch (err) {
      // Non-fatal — charts still work without the scheme explorer.
      console.error(err);
    }
  }

  function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  async function loadSchemeHistory(schemeName, amcName) {
    let data;
    try {
      const qs = new URLSearchParams({ scheme: schemeName, amc: amcName || '' });
      const res = await fetch('/api/brokerage-analysis/scheme?' + qs.toString());
      data = await res.json();
      if (!res.ok || !data.success) throw new Error(data.message || 'Failed to load scheme history');
    } catch (err) {
      toast(err.message || 'Could not load scheme history', 'error');
      return;
    }

    $ba('baSchemeEmpty').hidden = true;
    $ba('baSchemeResult').hidden = false;

    const history = data.history || [];
    drawOrUpdate('scheme', 'baChartScheme', {
      type: 'line',
      data: {
        labels: history.map((r) => r.period),
        datasets: [
          { label: 'Year 1', data: history.map((r) => r.year1), borderColor: '#1a6fe8', tension: 0.25 },
          { label: 'Year 2', data: history.map((r) => r.year2), borderColor: '#22a06b', tension: 0.25 },
          { label: 'Year 3', data: history.map((r) => r.year3), borderColor: '#e8871a', tension: 0.25 },
          { label: 'Year 4', data: history.map((r) => r.year4), borderColor: '#c0392b', tension: 0.25 },
          { label: 'Year 5', data: history.map((r) => r.year5), borderColor: '#8e44ad', tension: 0.25 },
          { label: '6th Yr Onward', data: history.map((r) => r.year6), borderColor: '#16a085', tension: 0.25 },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: true, position: 'bottom' } },
        scales: { y: { title: { display: true, text: 'Commission %' }, beginAtZero: true } },
      },
    });

    const tbody = $ba('baSchemeTbody');
    if (tbody) {
      tbody.innerHTML = history.map((r) => `
        <tr>
          <td>${escapeHtml(r.period)}${r.ongoing ? ' <span class="badge badge-open">Ongoing</span>' : ''}</td>
          <td>${escapeHtml(r.amc)}</td>
          <td>${escapeHtml(r.category)}</td>
          <td>${escapeHtml(r.arn)}</td>
          <td class="col-num">${fmt(r.year1)}</td>
          <td class="col-num">${fmt(r.year2)}</td>
          <td class="col-num">${fmt(r.year3)}</td>
          <td class="col-num">${fmt(r.year4)}</td>
          <td class="col-num">${fmt(r.year5)}</td>
          <td class="col-num">${fmt(r.year6)}</td>
        </tr>`).join('');
    }
  }

  function fmt(v) {
    return v == null || Number.isNaN(v) ? '–' : v.toFixed(2);
  }

  function bindFilters() {
    ['baFilterAmc', 'baFilterCategory', 'baFilterYear', 'baFilterCommYear'].forEach((id) => {
      $ba(id)?.addEventListener('change', loadSummary);
    });
    $ba('baResetFilters')?.addEventListener('click', () => {
      ['baFilterAmc', 'baFilterCategory', 'baFilterYear'].forEach((id) => { const el = $ba(id); if (el) el.value = ''; });
      $ba('baFilterCommYear').value = 'year1';
      loadSummary();
    });

    let debounceTimer = null;
    $ba('baSchemeAmc')?.addEventListener('change', (e) => {
      populateSchemeDropdown(e.target.value);
      $ba('baSchemeEmpty').hidden = false;
      $ba('baSchemeResult').hidden = true;
    });
    $ba('baSchemeSearch')?.addEventListener('change', (e) => {
      clearTimeout(debounceTimer);
      const val = e.target.value;
      if (!val) {
        $ba('baSchemeEmpty').hidden = false;
        $ba('baSchemeResult').hidden = true;
        return;
      }
      loadSchemeHistory(val, $ba('baSchemeAmc')?.value || '');
    });
  }

  document.addEventListener('DOMContentLoaded', () => {
    bindFilters();
    loadSummary();
    loadSchemeMeta();
  });
})();