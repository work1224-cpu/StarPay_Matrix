/**
 * controllers/documentController.js
 *
 * AMC document management endpoints — /api/amcs/:amc/documents/*.
 * (Split out of the former monolithic controllers/apiController.js.)
 */

const fs = require('fs');
const logger = require('../helpers/logger');
const {
  createDocument,
  deleteDocument,
  getDocumentById,
  getDocumentFilePath,
  getDocumentFolders,
  listDocuments,
  updateDocument,
  findAmcBySlug,
  getConfiguredAmcs,
} = require('../services/amcDocumentService');

const ARN_FOLDERS = ['ARN-1182', 'ARN-1183', 'ARN-1184', 'ARN-13025', 'ARN-17196', 'ARN-280532', 'ARN-50111'];

function listAmcDocuments(req, res) {
  try {
    const { amc } = req.params;
    const folderName = req.query.folder || 'general';
    const found = findAmcBySlug(amc);
    if (!found) {
      return res.status(404).json({ success: false, message: 'AMC not found.' });
    }

    return res.json({
      success: true,
      data: listDocuments(found.name, folderName),
      folders: getDocumentFolders(found.name),
      amc: found.name,
      slug: found.slug,
      folder: folderName,
    });
  } catch (err) {
    logger.error('Failed to list AMC documents', { error: err.message });
    return res.status(500).json({ success: false, message: 'Unable to list documents.' });
  }
}

async function uploadAmcDocuments(req, res) {
  try {
    const selectedAmc = String(req.body?.amc || '__all__').trim();
    const selectedArn = String(req.body?.arn || 'all').trim();
    const files = Array.isArray(req.files) ? req.files : [];
    const amcs = selectedAmc === '__all__'
      ? getConfiguredAmcs()
      : [findAmcBySlug(selectedAmc)?.name].filter(Boolean);
    const folders = selectedArn.toLowerCase() === 'all'
      ? ['All Files']
      : ARN_FOLDERS.filter((folder) => folder.toLowerCase() === selectedArn.toLowerCase());

    if (!amcs.length) return res.status(404).json({ success: false, message: 'AMC not found.' });
    if (!folders.length) return res.status(400).json({ success: false, message: 'Please select a valid ARN folder.' });
    if (!files.length) return res.status(400).json({ success: false, message: 'Please select at least one PDF or image file.' });

    const uploadedDocuments = [];
    for (const amc of amcs) {
      for (const folderName of folders) {
        for (const file of files) {
          const result = await createDocument(amc, {
            fileName: file.originalname,
            fileBuffer: file.buffer,
            title: file.originalname,
            folderName,
            uploadedBy: req.user?.username || 'admin',
          });
          if (!result.success) return res.status(400).json(result);
          uploadedDocuments.push(result.document);
        }
      }
    }

    return res.json({
      success: true,
      data: uploadedDocuments,
      message: `${files.length} file(s) uploaded to ${amcs.length} AMC(s) and ${folders[0]} folder(s).`,
    });
  } catch (err) {
    logger.error('Failed to upload AMC documents from Data Upload', { error: err.message });
    return res.status(500).json({ success: false, message: 'Unable to upload AMC documents.' });
  }
}

async function createAmcDocument(req, res) {
  try {
    const { amc } = req.params;
    const found = findAmcBySlug(amc);
    if (!found) {
      return res.status(404).json({ success: false, message: 'AMC not found.' });
    }

    const files = Array.isArray(req.files) ? req.files : req.file ? [req.file] : [];
    if (!files.length) {
      return res.status(400).json({ success: false, message: 'At least one PDF or Excel file is required.' });
    }

    const uploadedDocuments = [];
    for (const file of files) {
      const result = await createDocument(found.name, {
        fileName: file.originalname,
        fileBuffer: file.buffer,
        title: file.originalname,
        description: req.body?.description || '',
        folderName: req.query?.folderName || req.body?.folderName || 'general',
        uploadedBy: req.user?.username || 'admin',
      });

      if (!result.success) {
        return res.status(400).json(result);
      }

      uploadedDocuments.push(result.document);
    }

    return res.json({ success: true, data: uploadedDocuments, message: `${uploadedDocuments.length} document(s) uploaded successfully.` });
  } catch (err) {
    logger.error('Failed to create AMC document', { error: err.message });
    return res.status(500).json({ success: false, message: 'Unable to create document.' });
  }
}

async function updateAmcDocument(req, res) {
  try {
    const { amc, documentId } = req.params;
    const found = findAmcBySlug(amc);
    if (!found) {
      return res.status(404).json({ success: false, message: 'AMC not found.' });
    }

    const file = req.file;
    const result = await updateDocument(found.name, documentId, {
      fileName: file ? file.originalname : undefined,
      fileBuffer: file ? file.buffer : undefined,
      title: file ? file.originalname : undefined,
      description: req.body?.description,
      folderName: req.query?.folder || req.body?.folderName || 'general',
      uploadedBy: req.user?.username || 'admin',
    });

    if (!result.success) {
      return res.status(400).json(result);
    }

    return res.json({ success: true, data: result.document, message: result.message });
  } catch (err) {
    logger.error('Failed to update AMC document', { error: err.message });
    return res.status(500).json({ success: false, message: 'Unable to update document.' });
  }
}

async function deleteAmcDocument(req, res) {
  try {
    const { amc, documentId } = req.params;
    const found = findAmcBySlug(amc);
    if (!found) {
      return res.status(404).json({ success: false, message: 'AMC not found.' });
    }

    const result = await deleteDocument(found.name, documentId, req.query.folder || 'general');
    if (!result.success) {
      return res.status(400).json(result);
    }

    return res.json({ success: true, data: result.document, message: result.message });
  } catch (err) {
    logger.error('Failed to delete AMC document', { error: err.message });
    return res.status(500).json({ success: false, message: 'Unable to delete document.' });
  }
}

function getAmcDocumentFile(req, res) {
  try {
    const { amc, documentId } = req.params;
    const found = findAmcBySlug(amc);
    if (!found) {
      return res.status(404).json({ success: false, message: 'AMC not found.' });
    }

    const folderName = req.query.folder || 'general';
    const document = getDocumentById(found.name, documentId, folderName);
    if (!document) {
      return res.status(404).json({ success: false, message: 'Document not found.' });
    }

    const filePath = getDocumentFilePath(found.name, documentId, folderName);
    if (!filePath || !fs.existsSync(filePath)) {
      return res.status(404).json({ success: false, message: 'Document file not found.' });
    }

    res.download(filePath, document.fileName);
    return undefined;
  } catch (err) {
    logger.error('Failed to fetch AMC document file', { error: err.message });
    return res.status(500).json({ success: false, message: 'Unable to fetch document.' });
  }
}

module.exports = {
  listAmcDocuments,
  uploadAmcDocuments,
  createAmcDocument,
  updateAmcDocument,
  deleteAmcDocument,
  getAmcDocumentFile,
};
