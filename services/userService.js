const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const bcrypt = require('bcryptjs');
const logger = require('../helpers/logger');
const { getDb, resetForTests } = require('./db');

const BCRYPT_ROUNDS = 12;

// Old scheme (pre-bcrypt) was an unsalted SHA-256 hex digest — always 64 hex chars.
// bcrypt hashes always start with $2a$/$2b$/$2y$, so the two are easy to tell apart.
function isLegacySha256Hash(value) {
  return typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value);
}

function legacySha256(password) {
  return crypto.createHash('sha256').update(String(password || '')).digest('hex');
}

const VALID_ROLES = ['admin', 'data_operator', 'viewer'];

// Only used for a one-time import: pre-migration installs kept accounts in
// this JSON file. If it's still there and the (now-authoritative) SQLite
// users table is empty, its contents are imported once so upgrading an
// existing install never silently loses accounts.
const legacyJsonPath = process.env.USERS_FILE_PATH || path.join(__dirname, '..', 'data', 'users.json');

function hashPassword(password) {
  return bcrypt.hashSync(String(password || ''), BCRYPT_ROUNDS);
}

function buildDefaultAdmin() {
  const adminUsername = process.env.ADMIN_USERNAME || 'admin';
  const adminPassword = process.env.ADMIN_PASSWORD || 'admin123';
  return {
    username: adminUsername,
    password: hashPassword(adminPassword),
    role: 'admin',
    createdAt: new Date().toISOString(),
    createdBy: 'system',
  };
}

function insertUserRow(db, user) {
  db.prepare(
    `INSERT INTO users (username, password, role, createdAt, createdBy, updatedAt)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(
    user.username,
    user.password,
    user.role,
    user.createdAt || new Date().toISOString(),
    user.createdBy || null,
    user.updatedAt || null
  );
}

/** One-time: seed the default admin, importing the legacy users.json file
 *  first if it exists (so existing installs keep every account they had).
 *  `skipLegacyImport` is used by the test-only resetUsersStore() below —
 *  a test reset must always produce a clean slate (just the default
 *  admin), never pull in this machine's real data/users.json. */
function seedIfEmpty(skipLegacyImport = false) {
  const db = getDb();
  const { count } = db.prepare('SELECT COUNT(*) AS count FROM users').get();
  if (count > 0) return;

  let imported = [];
  try {
    if (!skipLegacyImport && fs.existsSync(legacyJsonPath)) {
      const parsed = JSON.parse(fs.readFileSync(legacyJsonPath, 'utf8'));
      if (Array.isArray(parsed)) {
        imported = parsed
          .filter((u) => u && u.username && u.password)
          .map((u) => ({
            username: String(u.username).trim(),
            password: u.password, // kept as-is — may be legacy sha256; authenticateUser upgrades it transparently on next login
            role: VALID_ROLES.includes(u.role) ? u.role : 'viewer',
            createdAt: u.createdAt || new Date().toISOString(),
            createdBy: u.createdBy || 'migrated-from-json',
            updatedAt: u.updatedAt || null,
          }));
      }
    }
  } catch (error) {
    logger.warn('Legacy users.json import failed, starting fresh', { error: error.message });
    imported = [];
  }

  if (!imported.some((u) => u.role === 'admin')) {
    imported.unshift(buildDefaultAdmin());
  }

  for (const user of imported) {
    try {
      insertUserRow(db, user);
    } catch (error) {
      logger.warn('Skipped duplicate username during users.json import', { username: user.username });
    }
  }

  if (imported.length) {
    logger.info('User store initialized', {
      source: (!skipLegacyImport && fs.existsSync(legacyJsonPath)) ? 'migrated from users.json' : 'fresh default admin',
      count: imported.length,
    });
  }
}

function ensureReady() {
  seedIfEmpty();
  return getDb();
}

// Letters, numbers, dot, underscore, hyphen, @ (for email-style usernames).
// Deliberately excludes quotes/angle-brackets so a username can never be used
// to break out of an HTML attribute or inline-script string context.
const USERNAME_PATTERN = /^[a-zA-Z0-9._@-]+$/;

function createUser(username, password, role = 'viewer') {
  const normalized = String(username || '').trim().toLowerCase();
  if (!normalized) {
    return { success: false, message: 'Username is required.' };
  }
  if (!USERNAME_PATTERN.test(normalized)) {
    return { success: false, message: 'Username can only contain letters, numbers, and . _ - @' };
  }
  if (!password || String(password).trim().length < 4) {
    return { success: false, message: 'Password must be at least 4 characters.' };
  }

  const db = ensureReady();
  const existing = db.prepare('SELECT 1 FROM users WHERE lower(username) = ?').get(normalized);
  if (existing) {
    return { success: false, message: 'User already exists.' };
  }

  const safeRole = VALID_ROLES.includes(role) ? role : 'viewer';
  const user = {
    username: normalized,
    password: hashPassword(password),
    role: safeRole,
    createdAt: new Date().toISOString(),
    createdBy: 'admin',
  };

  insertUserRow(db, user);

  return {
    success: true,
    user: { username: user.username, role: user.role, createdAt: user.createdAt },
    message: `User ${user.username} created successfully.`,
  };
}

function updateUserPassword(username, newPassword) {
  const normalized = String(username || '').trim().toLowerCase();
  if (!normalized) {
    return { success: false, message: 'Username is required.' };
  }
  if (!newPassword || String(newPassword).trim().length < 4) {
    return { success: false, message: 'Password must be at least 4 characters.' };
  }

  const db = ensureReady();
  const target = db.prepare('SELECT * FROM users WHERE lower(username) = ?').get(normalized);
  if (!target) {
    return { success: false, message: 'User not found.' };
  }

  // Don't allow changing password for the only admin
  const { count: adminCount } = db.prepare("SELECT COUNT(*) AS count FROM users WHERE role = 'admin'").get();
  if (target.role === 'admin' && adminCount === 1) {
    return { success: false, message: 'Cannot change password for the only admin user.' };
  }

  db.prepare('UPDATE users SET password = ?, updatedAt = ? WHERE username = ?')
    .run(hashPassword(newPassword), new Date().toISOString(), target.username);

  return {
    success: true,
    message: `Password updated successfully for ${normalized}.`,
  };
}

function deleteUser(username) {
  const normalized = String(username || '').trim().toLowerCase();
  if (!normalized) {
    return { success: false, message: 'Username is required.' };
  }

  const db = ensureReady();
  const target = db.prepare('SELECT * FROM users WHERE lower(username) = ?').get(normalized);
  if (!target) {
    return { success: false, message: 'User not found.' };
  }

  // Don't allow deleting the only admin
  const { count: adminCount } = db.prepare("SELECT COUNT(*) AS count FROM users WHERE role = 'admin'").get();
  if (target.role === 'admin' && adminCount === 1) {
    return { success: false, message: 'Cannot delete the only admin user.' };
  }

  db.prepare('DELETE FROM users WHERE username = ?').run(target.username);

  return {
    success: true,
    message: `User ${normalized} deleted successfully.`,
    deletedUser: { username: target.username, role: target.role },
  };
}

function authenticateUser(username, password) {
  const normalized = String(username || '').trim().toLowerCase();
  const db = ensureReady();
  const target = db.prepare('SELECT * FROM users WHERE lower(username) = ?').get(normalized);
  if (!target) {
    return { success: false, message: 'Invalid username or password.' };
  }

  let passwordOk = false;

  if (isLegacySha256Hash(target.password)) {
    // Old, unsalted SHA-256 record — verify against the old scheme, then
    // transparently upgrade to bcrypt so this branch is only hit once per user.
    passwordOk = target.password === legacySha256(password);
    if (passwordOk) {
      const upgraded = hashPassword(password);
      db.prepare('UPDATE users SET password = ? WHERE username = ?').run(upgraded, target.username);
    }
  } else {
    passwordOk = bcrypt.compareSync(String(password || ''), target.password);
  }

  if (!passwordOk) {
    return { success: false, message: 'Invalid username or password.' };
  }

  return {
    success: true,
    user: { username: target.username, role: target.role, createdAt: target.createdAt },
  };
}

function getUsers() {
  const db = ensureReady();
  const rows = db.prepare('SELECT username, role, createdAt, createdBy, updatedAt FROM users ORDER BY createdAt ASC').all();
  return rows.map((user) => ({
    username: user.username,
    role: user.role,
    createdAt: user.createdAt,
    createdBy: user.createdBy,
    updatedAt: user.updatedAt || null,
  }));
}

const SESSION_SECRET = process.env.SESSION_SECRET || 'ter-portal-local-secret';

function getSessionUser(req) {
  const cookieHeader = req.headers.cookie || '';
  const cookies = cookieHeader.split(';').reduce((acc, item) => {
    const [key, ...rest] = item.split('=');
    if (!key) return acc;
    acc[key.trim()] = decodeURIComponent(rest.join('='));
    return acc;
  }, {});

  const token = cookies.session;
  if (!token) return null;

  try {
    const [payload, signature] = token.split('.');
    if (!payload || !signature) return null;
    const expected = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('hex');
    if (expected !== signature) return null;
    const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return { username: parsed.username, role: parsed.role };
  } catch (error) {
    return null;
  }
}

function signSession(user) {
  const payload = Buffer.from(JSON.stringify({ username: user.username, role: user.role })).toString('base64url');
  const signature = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('hex');
  return `${payload}.${signature}`;
}

function setSessionCookie(res, user) {
  const token = signSession(user);
  res.cookie('session', token, {
    httpOnly: true,
    sameSite: 'lax',
    maxAge: 7 * 24 * 60 * 60 * 1000,
  });
}

function clearSessionCookie(res) {
  res.clearCookie('session');
}

function requireAuth(requiredRole = 'viewer') {
  return function authMiddleware(req, res, next) {
    const user = getSessionUser(req);
    if (!user) {
      if (req.accepts('html')) {
        return res.redirect('/login');
      }
      return res.status(401).json({ success: false, message: 'Login required.' });
    }

    if (requiredRole !== 'viewer') {
      const allowedRoles = Array.isArray(requiredRole) ? requiredRole : [requiredRole];
      if (!allowedRoles.includes(user.role)) {
        const label = allowedRoles.map(r => r === 'data_operator' ? 'Data Operators' : r === 'admin' ? 'Admins' : r).join(' or ');
        const message = `Only ${label} can perform this action.`;
        if (req.accepts('html')) {
          return res.status(403).send(message);
        }
        return res.status(403).json({ success: false, message });
      }
    }

    req.user = user;
    next();
  };
}

/** Test-only: point the user store at a fresh SQLite database and reseed
 *  the default admin. `customPath` mirrors the old JSON-path test helper —
 *  any file path works, SQLite doesn't care about the extension. */
function resetUsersStore(customPath) {
  resetForTests(customPath);
  seedIfEmpty(true); // always a clean slate — never import this machine's real data/users.json
  return getUsers();
}

module.exports = {
  createUser,
  authenticateUser,
  getUsers,
  getSessionUser,
  setSessionCookie,
  clearSessionCookie,
  requireAuth,
  resetUsersStore,
  updateUserPassword,
  deleteUser,
  VALID_ROLES,
  DATA_ROLES: ['admin', 'data_operator'], // anyone who can edit/upload data (not just admins)
};
