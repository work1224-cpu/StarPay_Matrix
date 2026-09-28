document.addEventListener('DOMContentLoaded', () => {
  const uploadInput = document.getElementById('amcDocFile');
  const listEl = document.getElementById('amcDocumentsList');
  const folderTabs = document.querySelectorAll('[data-doc-folder-tab]');
  const activeDocFolderInput = document.getElementById('activeDocFolder');
  const selectAllDocuments = document.getElementById('selectAllDocuments');
  const selectedDocumentsCount = document.getElementById('selectedDocumentsCount');
  const deleteSelectedDocuments = document.getElementById('deleteSelectedDocuments');
  const mainEl = document.querySelector('main.main');
  
  if (!listEl || !mainEl) return;

  const isAdmin = mainEl.dataset.admin === 'true';
  const selectedAmc = mainEl.dataset.selectedAmc || '';
  const activeFolder = activeDocFolderInput?.value || 'general';

  if (!selectedAmc) return;

  // Encode AMC name for URL (replace spaces, special chars)
  const amcSlug = selectedAmc.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');

  // Handle folder tab clicks
  folderTabs.forEach((button) => {
    button.addEventListener('click', () => {
      const folderName = button.getAttribute('data-doc-folder-tab');
      if (!folderName) return;
      const url = new URL(window.location.href);
      url.searchParams.set('folder', folderName);
      window.location.href = url.toString();
    });
  });

  if (!isAdmin || !uploadInput) return;

  const selectedDocumentInputs = () => Array.from(listEl.querySelectorAll('.document-select'));
  const refreshBulkDeleteState = () => {
    const selected = selectedDocumentInputs().filter((input) => input.checked);
    if (selectedDocumentsCount) selectedDocumentsCount.textContent = `Selected: ${selected.length}`;
    if (deleteSelectedDocuments) deleteSelectedDocuments.disabled = selected.length === 0;
    if (selectAllDocuments) {
      const allInputs = selectedDocumentInputs();
      selectAllDocuments.checked = allInputs.length > 0 && selected.length === allInputs.length;
      selectAllDocuments.indeterminate = selected.length > 0 && selected.length < allInputs.length;
    }
  };

  listEl.addEventListener('change', (event) => {
    if (event.target.matches('.document-select')) refreshBulkDeleteState();
  });
  selectAllDocuments?.addEventListener('change', () => {
    selectedDocumentInputs().forEach((input) => { input.checked = selectAllDocuments.checked; });
    refreshBulkDeleteState();
  });
  deleteSelectedDocuments?.addEventListener('click', async () => {
    const selected = selectedDocumentInputs().filter((input) => input.checked).map((input) => input.value);
    if (!selected.length) return;
    if (!window.confirm(`Delete ${selected.length} selected document(s)?`)) return;

    deleteSelectedDocuments.disabled = true;
    deleteSelectedDocuments.textContent = 'Deleting…';
    try {
      for (const docId of selected) {
        const response = await fetch(`/api/amcs/${encodeURIComponent(amcSlug)}/documents/${encodeURIComponent(docId)}?folder=${encodeURIComponent(activeFolder)}`, {
          method: 'DELETE',
        });
        const payload = await response.json();
        if (!response.ok || !payload.success) throw new Error(payload.message || 'Delete failed');
      }
      window.location.reload();
    } catch (error) {
      window.alert('Bulk delete error: ' + error.message);
      deleteSelectedDocuments.textContent = 'Delete Selected';
      refreshBulkDeleteState();
    }
  });

  // Handle file upload
  uploadInput.addEventListener('change', async () => {
    const files = Array.from(uploadInput.files || []);
    if (!files.length) return;

    const formData = new FormData();
    files.forEach((file) => formData.append('files', file));
    
    try {
      const response = await fetch(`/api/amcs/${encodeURIComponent(amcSlug)}/documents?folderName=${encodeURIComponent(activeFolder)}`, {
        method: 'POST',
        body: formData,
      });
      const payload = await response.json();
      if (!response.ok || !payload.success) {
        window.alert(payload.message || 'Upload failed');
        return;
      }
      window.location.reload();
    } catch (err) {
      window.alert('Upload error: ' + err.message);
    }
  });

  // Handle document actions (delete, replace)
  listEl.addEventListener('click', async (event) => {
    const button = event.target.closest('button[data-doc-action]');
    if (!button) return;

    const docId = button.getAttribute('data-doc-id');
    const action = button.getAttribute('data-doc-action');

    if (action === 'delete') {
      const confirmed = window.confirm('Delete this document?');
      if (!confirmed) return;
      try {
        const res = await fetch(`/api/amcs/${encodeURIComponent(amcSlug)}/documents/${docId}?folder=${encodeURIComponent(activeFolder)}`, { 
          method: 'DELETE' 
        });
        const payload = await res.json();
        if (!res.ok || !payload.success) {
          window.alert(payload.message || 'Delete failed');
          return;
        }
        window.location.reload();
      } catch (err) {
        window.alert('Delete error: ' + err.message);
      }
      return;
    }

    if (action === 'replace') {
      const fileInput = document.createElement('input');
      fileInput.type = 'file';
      fileInput.accept = '.pdf,.xlsx,.xls';
      fileInput.addEventListener('change', async () => {
        const replacement = fileInput.files?.[0];
        if (!replacement) return;
        const formData = new FormData();
        formData.append('file', replacement);
        try {
          const response = await fetch(`/api/amcs/${encodeURIComponent(amcSlug)}/documents/${docId}?folder=${encodeURIComponent(activeFolder)}`, {
            method: 'PUT',
            body: formData,
          });
          const payload = await response.json();
          if (!response.ok || !payload.success) {
            window.alert(payload.message || 'Replace failed');
            return;
          }
          window.location.reload();
        } catch (err) {
          window.alert('Replace error: ' + err.message);
        }
      });
      fileInput.click();
    }
  });
});
