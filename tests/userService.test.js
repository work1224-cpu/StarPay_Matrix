const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { createUser, authenticateUser, getUsers, resetUsersStore } = require('../services/userService');

test('createUser persists a viewer account and authenticateUser works', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ter-portal-users-'));
  const storePath = path.join(tempDir, 'users.json');

  resetUsersStore(storePath);

  const created = createUser('viewer1', 'pass123', 'viewer');
  assert.equal(created.success, true);
  assert.equal(created.user.username, 'viewer1');
  assert.equal(created.user.role, 'viewer');

  const storedUsers = getUsers();
  assert.equal(storedUsers.length, 2); // admin + viewer

  const auth = authenticateUser('viewer1', 'pass123');
  assert.equal(auth.success, true);
  assert.equal(auth.user.role, 'viewer');

  const badAuth = authenticateUser('viewer1', 'wrong');
  assert.equal(badAuth.success, false);

  try {
    fs.rmSync(tempDir, { recursive: true, force: true });
  } catch (err) {
    // Ignore Windows file lock EPERM on temp dir cleanup
  }
});
