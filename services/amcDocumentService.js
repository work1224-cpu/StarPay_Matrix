const fs = require('node:fs');
const path = require('node:path');

const defaultRoot = path.join(__dirname, '..', 'data', 'amc-documents');
const amcCatalogPath = path.join(__dirname, 'allAMCs.json');
const DEFAULT_DOCUMENT_FOLDERS = ['general', 'All Files', 'ARN-1182', 'ARN-1183', 'ARN-1184', 'ARN-13025', 'ARN-50111', 'ARN-17196', 'ARN-280532'];
const ALL_FILES_FOLDER = 'All Files';
const HIDDEN_DOCUMENT_FOLDERS = new Set(['general', 'files']);

/** True for any folder that is a per-ARN folder (e.g. "ARN-1182", "arn 23035") — i.e. the ones "All Files" aggregates from. Deliberately excludes 'general' and 'All Files' itself. */
function isArnFolder(folderName) {
  return /^arn[\s-]?\d+$/i.test(String(folderName || '').trim());
}

function getDocumentsRoot() {
  return process.env.AMC_DOCUMENTS_ROOT || defaultRoot;
}

function ensureRootDir() {
  fs.mkdirSync(getDocumentsRoot(), { recursive: true });
}

function slugify(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
}

function normalizeFolderName(folderName) {
  const value = String(folderName || '').trim();
  return value || 'general';
}

function sanitizeFileName(fileName) {
  const safeBase = path.basename(String(fileName || 'document.pdf'));
  const cleaned = safeBase.replace(/[<>:"/\\|?*\x00-\x1F]/g, '-').trim();
  const hasAllowedExt = /\.(pdf|xlsx|xls|png|jpg|jpeg|gif|webp)$/i.test(cleaned);
  return hasAllowedExt ? cleaned : `${cleaned || 'document'}.pdf`;
}

function loadAmcCatalog() {
  if (!fs.existsSync(amcCatalogPath)) {
    return [];
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(amcCatalogPath, 'utf8'));
    return Array.isArray(parsed) ? parsed.filter(Boolean) : [];
  } catch (error) {
    return [];
  }
}

function getConfiguredAmcs() {
  // The static allAMCs.json catalog only has ~40 curated names and goes stale
  // as new AMCs launch. cacheService already merges that catalog with every
  // AMC name actually present in the live AMFI-scraped scheme data (see
  // mergeAMCs() in cacheService.js) — reuse that here so the "AMC Firms"
  // panel and /api/amcs match what the "All AMCs" filter dropdown shows,
  // instead of only ever showing the original 40.
  // (Required lazily to sidestep any module-load ordering issues.)
  try {
    const cacheService = require('./cacheService');
    const merged = cacheService.getAMCs();
    if (Array.isArray(merged) && merged.length > 0) {
      return merged.slice().sort((a, b) => a.localeCompare(b));
    }
  } catch (error) {
    // cacheService not ready yet (e.g. called during very early boot) —
    // fall through to the static catalog below.
  }
  return loadAmcCatalog().sort((a, b) => a.localeCompare(b));
}

function findAmcBySlug(slug) {
  const normalizedSlug = slugify(slug);
  const amc = getConfiguredAmcs().find((name) => slugify(name) === normalizedSlug);
  if (!amc) {
    return null;
  }

  return { name: amc, slug: slugify(amc) };
}

function ensureFolderStructure(amcName, folderName = 'general') {
  const safeFolderName = normalizeFolderName(folderName);
  const amcFolder = path.join(getDocumentsRoot(), slugify(amcName));
  const folderSlug = slugify(safeFolderName) || 'general';
  const folderPath = path.join(amcFolder, folderSlug);
  fs.mkdirSync(folderPath, { recursive: true });
  fs.mkdirSync(path.join(folderPath, 'files'), { recursive: true });
  return { folderPath, folderSlug, folderName: safeFolderName };
}

function getAmcFolderPath(amcName, folderName = 'general') {
  ensureRootDir();
  return ensureFolderStructure(amcName, folderName).folderPath;
}

function getAmcFilesDir(amcName, folderName = 'general') {
  const folder = getAmcFolderPath(amcName, folderName);
  const filesDir = path.join(folder, 'files');
  fs.mkdirSync(filesDir, { recursive: true });
  return filesDir;
}

function getMetadataPath(amcName, folderName = 'general') {
  return path.join(getAmcFolderPath(amcName, folderName), 'documents.json');
}

function getDocumentFolders(amcName) {
  const folders = new Set(DEFAULT_DOCUMENT_FOLDERS);
  const amcFolder = path.join(getDocumentsRoot(), slugify(amcName));
  if (fs.existsSync(amcFolder)) {
    for (const entry of fs.readdirSync(amcFolder, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        const matchedFolder = DEFAULT_DOCUMENT_FOLDERS.find((folder) => slugify(folder) === entry.name);
        const folderName = matchedFolder || entry.name.replace(/-/g, ' ').trim();
        if (folderName) folders.add(folderName);
      }
    }
  }

  return Array.from(folders)
    .map((folder) => normalizeFolderName(folder))
    .filter((folder) => folder && !HIDDEN_DOCUMENT_FOLDERS.has(slugify(folder)))
    .sort((a, b) => a.localeCompare(b));
}

function readDocuments(amcName, folderName = 'general') {
  const metadataPath = getMetadataPath(amcName, folderName);
  if (!fs.existsSync(metadataPath)) {
    return [];
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    return [];
  }
}

async function writeDocuments(amcName, documents, folderName = 'general') {
  const folder = getAmcFolderPath(amcName, folderName);
  fs.mkdirSync(folder, { recursive: true });
  await fs.promises.writeFile(getMetadataPath(amcName, folderName), JSON.stringify(documents, null, 2));
}

function listDocuments(amcName, folderName = 'general') {
  return readDocuments(amcName, folderName).slice().sort((a, b) => (a.createdAt || '').localeCompare(b.createdAt || ''));
}

function getDocumentById(amcName, documentId, folderName = 'general') {
  return listDocuments(amcName, folderName).find((document) => document.id === documentId) || null;
}

function getDocumentFilePath(amcName, documentId, folderName = 'general') {
  const document = getDocumentById(amcName, documentId, folderName);
  if (!document) {
    return null;
  }

  const filesDir = getAmcFilesDir(amcName, folderName);
  return path.join(filesDir, document.fileName);
}

async function createDocument(amcName, payload = {}) {
  const fileName = sanitizeFileName(payload.fileName || 'document.pdf');
  const folderName = normalizeFolderName(payload.folderName || 'general');
  if (!payload.fileBuffer || !Buffer.isBuffer(payload.fileBuffer)) {
    return { success: false, message: 'A file is required.' };
  }

  const documents = readDocuments(amcName, folderName);
  const filesDir = getAmcFilesDir(amcName, folderName);
  const targetPath = path.join(filesDir, fileName);

  // New uploads must not silently overwrite an existing file of the same
  // name in the same AMC + folder — that's what caused documents to get
  // clobbered without warning. Replacing a specific document on purpose
  // still works via the separate "edit document" (updateDocument) flow,
  // which is keyed by document id, not file name.
  const duplicate = documents.find((document) => document.fileName === fileName);
  if (duplicate) {
    return {
      success: false,
      message: `A file named "${fileName}" already exists in this folder. Rename the file or delete the existing one first.`,
    };
  }

  await fs.promises.writeFile(targetPath, payload.fileBuffer);

  const document = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    amcName,
    folderName,
    title: String(payload.title || fileName).trim() || fileName,
    fileName,
    description: String(payload.description || '').trim(),
    uploadedBy: String(payload.uploadedBy || 'admin').trim() || 'admin',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  documents.push(document);
  await writeDocuments(amcName, documents, folderName);

  // Keep the "All Files" folder as a standing, always-up-to-date combined
  // view of every ARN folder's PDFs: whenever a file lands in an ARN
  // folder, a copy is placed in "All Files" too, under the same file name
  // (so it's easy to tell which document is which without opening it).
  // Only ARN folders feed this — 'general' and "All Files" itself don't —
  // and this never touches or removes anything already in the ARN folder,
  // it only ever adds to "All Files".
  if (isArnFolder(folderName)) {
    await copyIntoAllFiles(amcName, document, payload.fileBuffer);
  }

  return { success: true, document, message: 'Document created successfully.' };
}

/**
 * Copies one already-saved ARN-folder document into this AMC's "All Files"
 * folder. Skips it if a document with the same source folder + file name is
 * already there (so re-running the one-time backfill, or re-uploading the
 * same file, never creates duplicates). Returns true if it copied a new
 * file, false if it was already there (a no-op).
 */
async function copyIntoAllFiles(amcName, sourceDocument, fileBuffer) {
  const existing = readDocuments(amcName, ALL_FILES_FOLDER);
  const alreadyThere = existing.some(
    (d) => d.sourceFolderName === sourceDocument.folderName && d.sourceFileName === sourceDocument.fileName
  );
  if (alreadyThere) return false;

  const filesDir = getAmcFilesDir(amcName, ALL_FILES_FOLDER);
  // Prefix with the ARN folder name so files that happen to share a plain
  // name (e.g. two AMCs' circulars both called "commission.pdf") don't
  // collide on disk once combined into one folder.
  const combinedFileName = sanitizeFileName(`${sourceDocument.folderName} - ${sourceDocument.fileName}`);
  await fs.promises.writeFile(path.join(filesDir, combinedFileName), fileBuffer);

  existing.push({
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    amcName,
    folderName: ALL_FILES_FOLDER,
    sourceFolderName: sourceDocument.folderName,
    sourceFileName: sourceDocument.fileName,
    title: `${sourceDocument.folderName} — ${sourceDocument.title}`,
    fileName: combinedFileName,
    description: sourceDocument.description || '',
    uploadedBy: sourceDocument.uploadedBy || 'admin',
    createdAt: sourceDocument.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  await writeDocuments(amcName, existing, ALL_FILES_FOLDER);
  return true;
}

async function updateDocument(amcName, documentId, payload = {}) {
  const folderName = normalizeFolderName(payload.folderName || 'general');
  const documents = readDocuments(amcName, folderName);
  const existing = documents.find((document) => document.id === documentId);
  if (!existing) {
    return { success: false, message: 'Document not found.' };
  }

  const filesDir = getAmcFilesDir(amcName, folderName);
  const nextFileName = sanitizeFileName(payload.fileName || existing.fileName || 'document.pdf');
  const nextTitle = String(payload.title || nextFileName).trim() || nextFileName;
  const previousFileName = existing.fileName;

  if (payload.fileBuffer && Buffer.isBuffer(payload.fileBuffer)) {
    const previousPath = path.join(filesDir, existing.fileName);
    if (fs.existsSync(previousPath) && previousPath !== path.join(filesDir, nextFileName)) {
      fs.rmSync(previousPath, { force: true });
    }
    await fs.promises.writeFile(path.join(filesDir, nextFileName), payload.fileBuffer);
  }

  Object.assign(existing, {
    title: nextTitle,
    fileName: nextFileName,
    description: String(payload.description !== undefined ? payload.description : existing.description || '').trim(),
    uploadedBy: String(payload.uploadedBy || existing.uploadedBy || 'admin').trim() || 'admin',
    updatedAt: new Date().toISOString(),
  });

  await writeDocuments(amcName, documents, folderName);

  // Keep "All Files" in sync with a "Replace" the same way create/delete do:
  // drop the old mirror copy (it's the previous file, now gone) and, if a
  // new file was actually uploaded, mirror that one in under the new name.
  if (isArnFolder(folderName)) {
    await removeFromAllFiles(amcName, folderName, previousFileName);
    if (payload.fileBuffer && Buffer.isBuffer(payload.fileBuffer)) {
      await copyIntoAllFiles(amcName, existing, payload.fileBuffer);
    }
  }

  return { success: true, document: existing, message: 'Document updated successfully.' };
}

async function deleteDocument(amcName, documentId, folderName = 'general') {
  const documents = readDocuments(amcName, folderName);
  const index = documents.findIndex((document) => document.id === documentId);
  if (index === -1) {
    return { success: false, message: 'Document not found.' };
  }

  const [removed] = documents.splice(index, 1);
  const filesDir = getAmcFilesDir(amcName, folderName);
  const targetPath = path.join(filesDir, removed.fileName);
  if (fs.existsSync(targetPath)) {
    fs.rmSync(targetPath, { force: true });
  }

  await writeDocuments(amcName, documents, folderName);

  // Keep "All Files" from accumulating orphaned copies: deleting a document
  // from an ARN folder removes its mirrored copy from "All Files" too. A
  // delete made directly inside "All Files" itself only removes that one
  // combined copy and never touches the original ARN folder.
  if (isArnFolder(folderName)) {
    await removeFromAllFiles(amcName, folderName, removed.fileName);
  }

  return { success: true, document: removed, message: 'Document deleted successfully.' };
}

/**
 * Removes the "All Files" mirror copy that corresponds to a given ARN
 * folder + source file name, if one exists. Used by deleteDocument() and
 * updateDocument() so "All Files" never keeps a stale copy of a file that
 * was deleted or replaced at its source. A no-op (returns false) if no
 * matching mirror copy is found — safe to call unconditionally.
 */
async function removeFromAllFiles(amcName, sourceFolderName, sourceFileName) {
  const existing = readDocuments(amcName, ALL_FILES_FOLDER);
  const index = existing.findIndex(
    (d) => d.sourceFolderName === sourceFolderName && d.sourceFileName === sourceFileName
  );
  if (index === -1) return false;

  const [removed] = existing.splice(index, 1);
  const filesDir = getAmcFilesDir(amcName, ALL_FILES_FOLDER);
  const targetPath = path.join(filesDir, removed.fileName);
  if (fs.existsSync(targetPath)) {
    fs.rmSync(targetPath, { force: true });
  }
  await writeDocuments(amcName, existing, ALL_FILES_FOLDER);
  return true;
}

module.exports = {
  getConfiguredAmcs,
  findAmcBySlug,
  getDocumentFolders,
  listDocuments,
  createDocument,
  updateDocument,
  deleteDocument,
  getDocumentById,
  getDocumentFilePath,
  slugify,
  isArnFolder,
  copyIntoAllFiles,
  ALL_FILES_FOLDER,
  getDocumentsRoot,
};