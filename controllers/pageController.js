/**
 * controllers/pageController.js
 * Server-side page rendering controllers.
 */

const cacheService = require('../services/cacheService');
const {
  authenticateUser,
  clearSessionCookie,
  getSessionUser,
  getUsers,
  setSessionCookie,
  createUser,
  DATA_ROLES,
} = require('../services/userService');
const { getConfiguredAmcs, getDocumentFolders, listDocuments, findAmcBySlug } = require('../services/amcDocumentService');
const oldBrokerageService = require('../services/oldBrokerageService');

// Anyone who can edit/upload data on the portal — Admins AND Data Operators
// (Data Operators just don't get access to the Users management page/API).
function canManageData(user) {
  return !!user && DATA_ROLES.includes(user.role);
}

/**
 * GET /
 * Render the main TER portal page.
 */
function renderHome(req, res, next) {
  try {
    const currentUser = getSessionUser(req);
    const status = cacheService.getStatus();
    const selectedAmc = req.params?.amc || req.query?.amc || null;
    const selectedFolder = req.query?.folder || 'general';
    const activeAmc = selectedAmc ? findAmcBySlug(selectedAmc) : null;
    const amcName = activeAmc?.name || null;
    const amcDocuments = amcName ? listDocuments(amcName, selectedFolder) : [];
    const documentFolders = amcName ? getDocumentFolders(amcName) : [];

    const latestPeriod = oldBrokerageService.getLatestDataPeriod();

    res.render('index', {
      title: 'Mutual Fund TER Portal',
      status,
      latestPeriod,
      currentUser,
      amcs: getConfiguredAmcs(),
      categories: cacheService.getCategories() || [],
      types: cacheService.getTypes() || [],
      selectedAmc: amcName,
      activeAmcSlug: activeAmc?.slug || null,
      amcDocuments,
      documentFolders,
      selectedFolder: selectedFolder,
      isAdmin: canManageData(currentUser),
      canManageAmc: canManageData(currentUser),
    });
  } catch (err) {
    next(err);
  }
}

function renderLogin(req, res, next) {
  try {
    res.render('login', {
      title: 'Login',
      currentUser: getSessionUser(req),
      error: null,
      amcs: getConfiguredAmcs(),
      activeAmcSlug: null,
    });
  } catch (err) {
    next(err);
  }
}

function login(req, res, next) {
  try {
    const { username, password } = req.body || {};
    const auth = authenticateUser(username, password);
    if (!auth.success) {
      return res.status(401).render('login', {
        title: 'Login',
        currentUser: null,
        error: auth.message || 'Login failed',
      });
    }

    setSessionCookie(res, auth.user);
    return res.redirect('/');
  } catch (err) {
    next(err);
  }
}

function logout(req, res, next) {
  try {
    clearSessionCookie(res);
    return res.redirect('/login');
  } catch (err) {
    next(err);
  }
}

function renderAdminUsers(req, res, next) {
  try {
    res.render('admin-users', {
      title: 'Manage Users',
      currentUser: getSessionUser(req),
      users: getUsers(),
      success: null,
      error: null,
      amcs: getConfiguredAmcs(),
      activeAmcSlug: null,
    });
  } catch (err) {
    next(err);
  }
}

function createAdminUser(req, res, next) {
  try {
    const { username, password, role } = req.body || {};
    const result = createUser(username, password, role);
    res.render('admin-users', {
      title: 'Manage Users',
      currentUser: getSessionUser(req),
      users: getUsers(),
      success: result.success ? result.message : null,
      error: result.success ? null : result.message,
      amcs: getConfiguredAmcs(),
      activeAmcSlug: null,
    });
  } catch (err) {
    next(err);
  }
}

/**
 * GET /old-brokerage-data
 * Renders the "Old Brokerage Data" page — date-wise historical brokerage
 * structures read from data/demo/Mutual_Fund_Brokerage_Consolidated_Verified.xlsx.
 */
function renderOldBrokerage(req, res, next) {
  try {
    const meta = oldBrokerageService.getMeta();
    const configuredAmcs = getConfiguredAmcs();
    const allAmcs = [...new Set([...(meta.amcs || []), ...configuredAmcs])].sort();
    res.render('old-brokerage', {
      title: 'Old Brokerage Data',
      currentUser: getSessionUser(req),
      amcs: configuredAmcs,
      activeAmcSlug: null,
      obAmcs: allAmcs,
      obCategories: meta.categories,
      obArns: meta.arns,
      obMeta: meta,
    });
  } catch (err) {
    next(err);
  }
}

/**
 * GET /about
 */
function renderAbout(req, res, next) {
  try {
    res.render('about', {
      title: 'About – TER Portal',
      currentUser: getSessionUser(req),
      amcs: getConfiguredAmcs(),
      activeAmcSlug: null,
    });
  } catch (err) {
    next(err);
  }
}

module.exports = { renderHome, renderLogin, login, logout, renderAdminUsers, createAdminUser, renderAbout, renderOldBrokerage };