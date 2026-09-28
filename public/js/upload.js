/**
 * public/js/upload.js
 * Handles the "Commission Structure Upload" widget on the home page.
 * Each upload is scoped to a single AMC (chosen via a text input with 
 * autocomplete) so it only touches that AMC's data.
 */

async function loadAMCDatalist() {
  const dl = document.getElementById('amcDatalist');
  if (!dl) return;
  try {
    const res = await fetch('/api/amcs');
    const j = await res.json();
    if (j.success && Array.isArray(j.data)) {
      dl.innerHTML = j.data.map(a => `<option value="${a.replace(/"/g, '&quot;')}"></option>`).join('');
    }
  } catch (e) { /* non-fatal — datalist just stays empty, free typing still works */ }
}

function setupTogglePanel(btnId, panelId) {
  const btn = document.getElementById(btnId);
  const panel = document.getElementById(panelId);
  if (!btn || !panel) return;
  btn.addEventListener('click', () => {
    const isHidden = panel.hasAttribute('hidden');
    if (isHidden) panel.removeAttribute('hidden');
    else panel.setAttribute('hidden', '');
  });
}

function setupUploadBox({ amcId, fileInputId, fileNameId, submitId, statusId, endpoint }) {
  const amcInput   = amcId ? document.getElementById(amcId) : null;
  const fileInput  = document.getElementById(fileInputId);
  const fileNameEl = document.getElementById(fileNameId);
  const submitBtn  = document.getElementById(submitId);
  const statusEl   = document.getElementById(statusId);
  if (!fileInput || !submitBtn) return;

  function refreshEnabled() {
    const amcOk = amcInput ? !!amcInput.value.trim() : true;
    submitBtn.disabled = !(fileInput.files[0] && amcOk);
  }

  if (amcInput) amcInput.addEventListener('input', refreshEnabled);

  fileInput.addEventListener('change', () => {
    const f = fileInput.files[0];
    fileNameEl.textContent = f ? f.name : 'No file chosen';
    statusEl.textContent = '';
    statusEl.className = 'upload-status';
    refreshEnabled();
  });

  submitBtn.addEventListener('click', async () => {
    const f = fileInput.files[0];
    const amc = amcInput ? amcInput.value.trim() : null;
    if (!f || (amcInput && !amc)) return;

    submitBtn.disabled = true;
    submitBtn.textContent = '⏳ Uploading…';
    statusEl.textContent = '';
    statusEl.className = 'upload-status';

    try {
      const fd = new FormData();
      if (amc) fd.append('amc', amc);
      fd.append('file', f);
      // The Home Page's All AMCs option uses the consolidated workbook
      // format, which must be parsed for each AMC's latest period and ARN.
      const uploadEndpoint = amc === '__all__' && endpoint === '/api/upload/commission'
        ? '/api/upload/brokerage-matrix'
        : endpoint;
      const res = await fetch(uploadEndpoint, { method: 'POST', body: fd });
      let j = {};
      try { j = await res.json(); } catch (e) { /* ignore */ }

      if (!res.ok || !j.success) {
        throw new Error(j.message || 'Upload failed');
      }

      let msg = j.message;
      // Multi-AMC endpoint returns a per-AMC breakdown (amc, period used, arn used, scheme count)
      if (Array.isArray(j.details) && j.details.length) {
        const lines = j.details.map(d => `• ${d.amc}: ${d.schemeCount} schemes (period: ${d.period}, ARN: ${d.arn})`);
        msg += '\n' + lines.join('\n');
      }
      statusEl.textContent = '✅ ' + msg;
      statusEl.className = 'upload-status upload-status-ok';
      statusEl.style.whiteSpace = 'pre-line';

      if (typeof loadData === 'function') {
        loadData();
      }
    } catch (err) {
      statusEl.textContent = '⚠ ' + err.message;
      statusEl.className = 'upload-status upload-status-err';
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = '⬆ Upload & Update';
      fileInput.value = '';
      fileNameEl.textContent = 'No file chosen';
      refreshEnabled();
    }
  });
}

document.addEventListener('DOMContentLoaded', () => {
  loadAMCDatalist();

  setupTogglePanel('btnShowCommission', 'panelCommission');
  setupTogglePanel('btnShowAmcDocuments', 'panelAmcDocuments');
  setupTogglePanel('btnShowBrokerageMatrix', 'panelBrokerageMatrix');
  setupTogglePanel('btnShowLaunchDates', 'panelLaunchDates');

  setupUploadBox({
    amcId: 'amcCommission', 
    fileInputId: 'fileCommission', 
    fileNameId: 'fileNameCommission',
    submitId: 'submitCommission', 
    statusId: 'statusCommission', 
    endpoint: '/api/upload/commission',
  });

  setupDocumentUploadBox();

  // Multi-AMC Old Brokerage Data upload — no AMC field, it's read from the sheet.
  setupUploadBox({
    amcId: null,
    fileInputId: 'fileBrokerageMatrix',
    fileNameId: 'fileNameBrokerageMatrix',
    submitId: 'submitBrokerageMatrix',
    statusId: 'statusBrokerageMatrix',
    endpoint: '/api/upload/brokerage-matrix',
  });

  setupUploadBox({
    amcId: null,
    fileInputId: 'fileLaunchDates',
    fileNameId: 'fileNameLaunchDates',
    submitId: 'submitLaunchDates',
    statusId: 'statusLaunchDates',
    endpoint: '/api/upload/launch-dates',
  });
});

function setupDocumentUploadBox() {
  const amcInput = document.getElementById('amcDocumentUpload');
  const arnInput = document.getElementById('arnDocumentUpload');
  const fileInput = document.getElementById('fileAmcDocuments');
  const fileNameEl = document.getElementById('fileNameAmcDocuments');
  const submitBtn = document.getElementById('submitAmcDocuments');
  const statusEl = document.getElementById('statusAmcDocuments');
  if (!amcInput || !arnInput || !fileInput || !submitBtn) return;

  const refreshEnabled = () => {
    submitBtn.disabled = !(fileInput.files.length && amcInput.value && arnInput.value);
  };

  fileInput.addEventListener('change', () => {
    fileNameEl.textContent = fileInput.files.length
      ? `${fileInput.files.length} file(s) selected`
      : 'No files chosen';
    statusEl.textContent = '';
    statusEl.className = 'upload-status';
    refreshEnabled();
  });
  amcInput.addEventListener('change', refreshEnabled);
  arnInput.addEventListener('change', refreshEnabled);

  submitBtn.addEventListener('click', async () => {
    if (!fileInput.files.length) return;
    submitBtn.disabled = true;
    submitBtn.textContent = '⏳ Uploading…';
    try {
      const fd = new FormData();
      fd.append('amc', amcInput.value);
      fd.append('arn', arnInput.value);
      Array.from(fileInput.files).forEach(file => fd.append('files', file));
      const response = await fetch('/api/upload/amc-documents', { method: 'POST', body: fd });
      const payload = await response.json();
      if (!response.ok || !payload.success) throw new Error(payload.message || 'Upload failed');
      statusEl.textContent = '✅ ' + payload.message;
      statusEl.className = 'upload-status upload-status-ok';
      fileInput.value = '';
      fileNameEl.textContent = 'No files chosen';
    } catch (error) {
      statusEl.textContent = '⚠ ' + error.message;
      statusEl.className = 'upload-status upload-status-err';
    } finally {
      submitBtn.textContent = '⬆ Upload Documents';
      refreshEnabled();
    }
  });
}