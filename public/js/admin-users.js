let currentUsername = '';

// Delegated click handler for the per-row action buttons — using
// data-username here (rather than an inline onclick="...('username')")
// keeps usernames out of JS-string context entirely, so a username
// containing a quote can't break out and inject script.
document.querySelector('tbody')?.addEventListener('click', (event) => {
  const btn = event.target.closest('button[data-action]');
  if (!btn) return;
  const username = btn.dataset.username;
  if (btn.dataset.action === 'change-password') {
    showChangePassword(username);
  } else if (btn.dataset.action === 'delete-user') {
    deleteUser(username);
  }
});

function showChangePassword(username) {
  currentUsername = username;
  document.getElementById('modalUsername').textContent = username;
  document.getElementById('passwordModal').style.display = 'flex';
  document.getElementById('newPassword').value = '';
  document.getElementById('confirmPassword').value = '';
  setTimeout(() => document.getElementById('newPassword').focus(), 100);
}

function closePasswordModal() {
  document.getElementById('passwordModal').style.display = 'none';
  currentUsername = '';
}

async function submitPasswordChange(event) {
  event.preventDefault();
  const newPassword = document.getElementById('newPassword').value;
  const confirmPassword = document.getElementById('confirmPassword').value;

  if (newPassword !== confirmPassword) {
    toast('Passwords do not match!', 'error');
    return;
  }

  if (newPassword.length < 4) {
    toast('Password must be at least 4 characters!', 'error');
    return;
  }

  try {
    const response = await fetch(`/api/users/${encodeURIComponent(currentUsername)}/password`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: newPassword }),
    });

    const result = await response.json();
    if (!response.ok || !result.success) {
      throw new Error(result.message || 'Failed to update password');
    }

    toast('✅ Password updated successfully!', 'success');
    closePasswordModal();

    // Refresh the page after a short delay
    setTimeout(() => location.reload(), 1000);
  } catch (error) {
    toast('❌ ' + error.message, 'error');
  }
}

async function deleteUser(username) {
  if (!confirm(`Are you sure you want to delete user "${username}"? This action cannot be undone.`)) {
    return;
  }

  try {
    const response = await fetch(`/api/users/${encodeURIComponent(username)}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
    });

    const result = await response.json();
    if (!response.ok || !result.success) {
      throw new Error(result.message || 'Failed to delete user');
    }

    toast('✅ User deleted successfully!', 'success');

    // Remove the row from the table
    const row = document.querySelector(`tr[data-username="${username}"]`);
    if (row) {
      row.style.transition = 'opacity 0.3s';
      row.style.opacity = '0';
      setTimeout(() => row.remove(), 300);
    }

    // If no users left, show a message
    const tbody = document.querySelector('.user-table tbody');
    if (tbody && tbody.children.length === 0) {
      tbody.innerHTML = `<tr><td colspan="4" style="text-align:center;color:var(--text-muted);padding:2rem;">No users found.</td></tr>`;
    }
  } catch (error) {
    toast('❌ ' + error.message, 'error');
  }
}

// Close modal on escape key
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closePasswordModal();
});

// Close modal on background click
document.getElementById('passwordModal').addEventListener('click', (e) => {
  if (e.target === e.currentTarget) closePasswordModal();
});

// Toast function (if not already defined)
function toast(msg, type = 'info', ms = 3500) {
  const container = document.getElementById('toast-container');
  if (!container) return;
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.innerHTML = `<span>${msg}</span>`;
  container.appendChild(el);
  setTimeout(() => el.remove(), ms);
}
