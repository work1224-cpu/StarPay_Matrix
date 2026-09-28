/**
 * routes/pages.js
 */

const express = require('express');
const router = express.Router();
const { renderHome, renderLogin, login, logout, renderAdminUsers, createAdminUser, renderAbout, renderOldBrokerage } = require('../controllers/pageController');
const { renderBrokerageAnalysis } = require('../controllers/brokerageAnalysisController');
const { requireAuth } = require('../services/userService');

router.get('/', renderHome);
router.get('/login', renderLogin);
router.post('/login', login);
router.post('/logout', logout);
router.get('/admin/users', requireAuth('admin'), renderAdminUsers);
router.post('/admin/users', requireAuth('admin'), createAdminUser);
router.get('/about', renderAbout);
router.get('/old-brokerage-data', renderOldBrokerage);
router.get('/brokerage-analysis', renderBrokerageAnalysis);
router.get('/:amc', renderHome);

module.exports = router;
