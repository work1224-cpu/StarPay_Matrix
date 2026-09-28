/**
 * routes/api.js
 */

const express = require('express');
const router = express.Router();
const multer = require('multer');
const schemeCtrl = require('../controllers/schemeController');
const userCtrl = require('../controllers/userController');
const documentCtrl = require('../controllers/documentController');
const commissionCtrl = require('../controllers/commissionController');
const oldBrokerageCtrl = require('../controllers/oldBrokerageController');
const analysisCtrl = require('../controllers/brokerageAnalysisController');
const { requireAuth, DATA_ROLES } = require('../services/userService');

const documentUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024, files: 100 },
  fileFilter: (req, file, cb) => {
    const ok = /\.(pdf|xlsx|xls|png|jpg|jpeg|gif|webp)$/i.test(file.originalname);
    cb(ok ? null : new Error('Only PDF, Excel, or image files are accepted'), ok);
  },
});

// In-memory storage — files are parsed immediately, never written to disk.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 }, // 20 MB
  fileFilter: (req, file, cb) => {
    const ok = /\.(xlsx|xls)$/i.test(file.originalname);
    cb(ok ? null : new Error('Only .xlsx or .xls files are accepted'), ok);
  },
});

router.get('/schemes',    schemeCtrl.getSchemes);
router.get('/amcs',       schemeCtrl.getAMCs);
router.get('/categories', schemeCtrl.getCategories);
router.get('/types',      schemeCtrl.getTypes);
router.get('/status',     schemeCtrl.getStatus);
router.get('/dashboard',  schemeCtrl.getDashboard);
router.get('/refresh',    requireAuth(DATA_ROLES), schemeCtrl.triggerRefresh);
router.post('/clear-old-brokerage', requireAuth(DATA_ROLES), schemeCtrl.clearOldBrokerageData);
// A manual, known-good snapshot for use when AMFI scraping is unavailable.
router.post('/sync/save', requireAuth(DATA_ROLES), schemeCtrl.saveManualSync);
router.get('/sync/old',   schemeCtrl.getManualSync);
router.get('/old-brokerage', oldBrokerageCtrl.getOldBrokerage); // Old Brokerage Data (date-wise, from Excel)
router.get('/old-brokerage/sync/old', oldBrokerageCtrl.getOldBrokerageManualSync);

router.get('/brokerage-analysis',        analysisCtrl.getAnalysisSummary);
router.get('/brokerage-analysis/meta',   analysisCtrl.getAnalysisMeta);
router.get('/brokerage-analysis/scheme', analysisCtrl.getAnalysisSchemeHistory);
router.post('/old-brokerage/update', requireAuth(DATA_ROLES), oldBrokerageCtrl.updateOldBrokerage);
router.post('/old-brokerage/delete', requireAuth(DATA_ROLES), oldBrokerageCtrl.deleteOldBrokerage);
router.post('/old-brokerage/upload', requireAuth(DATA_ROLES), upload.single('file'), oldBrokerageCtrl.uploadOldBrokerage);
router.get('/old-brokerage/demo-download', requireAuth(DATA_ROLES), oldBrokerageCtrl.downloadOldBrokerageDemoFile);
router.get('/periods',    schemeCtrl.getPeriods);   // Financial years list
router.get('/months',     schemeCtrl.getMonths);    // Months for a given financial year
router.get('/users',      requireAuth('admin'), userCtrl.getUsers);
router.post('/users',     requireAuth('admin'), userCtrl.createUser);
router.put('/users/:username/password', requireAuth('admin'), userCtrl.updateUserPasswordHandler);
router.delete('/users/:username', requireAuth('admin'), userCtrl.deleteUserHandler);
router.post('/schemes/update', requireAuth(DATA_ROLES), schemeCtrl.updateScheme);
router.post('/upload/launch-dates', requireAuth(DATA_ROLES), upload.single('file'), schemeCtrl.uploadLaunchDates);
router.get('/amcs/:amc/documents', documentCtrl.listAmcDocuments);
router.post('/amcs/:amc/documents', requireAuth(DATA_ROLES), documentUpload.array('files', 100), documentCtrl.createAmcDocument);
router.post('/upload/amc-documents', requireAuth(DATA_ROLES), documentUpload.array('files', 100), documentCtrl.uploadAmcDocuments);
router.put('/amcs/:amc/documents/:documentId', requireAuth(DATA_ROLES), documentUpload.single('file'), documentCtrl.updateAmcDocument);
router.delete('/amcs/:amc/documents/:documentId', requireAuth(DATA_ROLES), documentCtrl.deleteAmcDocument);
router.get('/amcs/:amc/documents/:documentId/file', documentCtrl.getAmcDocumentFile);
router.get('/amcs/:amc/documents/:documentId/download', documentCtrl.getAmcDocumentFile);

// Commission Structure Upload
router.post('/upload/commission', requireAuth(DATA_ROLES), upload.single('file'), commissionCtrl.uploadCommission);
router.post('/upload/brokerage-matrix', requireAuth(DATA_ROLES), upload.single('file'), commissionCtrl.uploadBrokerageMatrix);

// Demo/sample file download (admin or data operator)
router.get('/download/demo-commission-file', requireAuth(DATA_ROLES), commissionCtrl.downloadDemoCommissionFile);

// Friendly error for multer failures (bad file type, too large, etc.)
router.use((err, req, res, next) => {
  if (err) {
    return res.status(400).json({ success: false, message: err.message || 'Upload failed' });
  }
  next();
});

module.exports = router;