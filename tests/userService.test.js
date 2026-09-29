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

test('bootstrap credentials update an untouched seeded admin on an existing database', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ter-portal-admin-'));
  const storePath = path.join(tempDir, 'users.db');
  const previousUsername = process.env.ADMIN_USERNAME;
  const previousPassword = process.env.ADMIN_PASSWORD;

  try {
    delete process.env.ADMIN_USERNAME;
    delete process.env.ADMIN_PASSWORD;
    resetUsersStore(storePath);

    process.env.ADMIN_USERNAME = 'host-admin';
    process.env.ADMIN_PASSWORD = 'host-pass-123';

    assert.equal(authenticateUser('host-admin', 'host-pass-123').success, true);
    assert.equal(authenticateUser('admin', 'admin123').success, false);
  } finally {
    if (previousUsername === undefined) delete process.env.ADMIN_USERNAME;
    else process.env.ADMIN_USERNAME = previousUsername;
    if (previousPassword === undefined) delete process.env.ADMIN_PASSWORD;
    else process.env.ADMIN_PASSWORD = previousPassword;
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch (err) {
      // Ignore Windows file lock EPERM on temp dir cleanup
    }
  }
});
