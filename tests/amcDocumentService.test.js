const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

// Must be set BEFORE requiring cacheService — see the same note in
// tests/cacheService.test.js. Without this, the setSchemes() call below
// would overwrite the real project-root ter-cache.json with test data.
const cacheTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ter-cache-test-'));
process.env.TER_CACHE_PATH = path.join(cacheTempDir, 'ter-cache.json');
process.env.TER_MANUAL_SYNC_PATH = path.join(cacheTempDir, 'ter-manual-sync.json');

const service = require('../services/amcDocumentService');
const cacheService = require('../services/cacheService');

test('getConfiguredAmcs includes AMCs from live scheme data, not just the static catalog', () => {
  // Regression test for a bug where the "AMC Firms" panel (and /api/amcs)
  // only ever showed the ~40 names in the static allAMCs.json catalog,
  // while the "All AMCs" filter dropdown showed every AMC actually present
  // in the live AMFI data. New/smaller AMCs (e.g. AlphaGrep, Angel One)
  // were missing from the panel — and /<amc-slug> navigation was broken
  // for them too, since findAmcBySlug() reads from the same list.
  cacheService.setSchemes([
    { schemeName: 'Test Scheme A', amc: 'AlphaGrep Mutual Fund' },
    { schemeName: 'Test Scheme B', amc: 'Angel One Mutual Fund' },
  ]);

  const amcs = service.getConfiguredAmcs();
  assert.ok(amcs.includes('AlphaGrep Mutual Fund'), 'AlphaGrep should appear even though it is not in the static catalog');
  assert.ok(amcs.includes('Angel One Mutual Fund'), 'Angel One should appear even though it is not in the static catalog');

  const found = service.findAmcBySlug('alphagrep-mutual-fund');
  assert.ok(found, 'findAmcBySlug should resolve AMCs sourced from live data, not just the static catalog');
  assert.equal(found.name, 'AlphaGrep Mutual Fund');
});

test('document title stays synchronized with uploaded PDF name', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ter-amc-docs-'));
  process.env.AMC_DOCUMENTS_ROOT = tempDir;

  const created = await service.createDocument('ABC AMC', {
    fileName: 'first-report.pdf',
    fileBuffer: Buffer.from('first'),
    uploadedBy: 'admin',
  });

  assert.equal(created.success, true);
  assert.equal(created.document.title, 'first-report.pdf');
  assert.equal(created.document.fileName, 'first-report.pdf');

  const updated = await service.updateDocument('ABC AMC', created.document.id, {
    fileName: 'updated-report.pdf',
    fileBuffer: Buffer.from('updated'),
    uploadedBy: 'admin',
  });

  assert.equal(updated.success, true);
  assert.equal(updated.document.title, 'updated-report.pdf');
  assert.equal(updated.document.fileName, 'updated-report.pdf');

  const docs = service.listDocuments('ABC AMC');
  assert.equal(docs.length, 1);
  assert.equal(docs[0].title, 'updated-report.pdf');

  fs.rmSync(tempDir, { recursive: true, force: true });
  delete process.env.AMC_DOCUMENTS_ROOT;
});

test('documents are stored separately per folder and exposed in folder lists', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ter-amc-docs-'));
  process.env.AMC_DOCUMENTS_ROOT = tempDir;

  // Awaited sequentially (not Promise.all) because each createDocument()
  // does a synchronous read-modify-...-write on the same per-folder metadata
  // file; firing them concurrently would race on that read step.
  const generalDoc = await service.createDocument('ABC AMC', {
    fileName: 'general.pdf',
    fileBuffer: Buffer.from('general'),
    folderName: 'general',
    uploadedBy: 'admin',
  });

  const arnDoc = await service.createDocument('ABC AMC', {
    fileName: 'arn.pdf',
    fileBuffer: Buffer.from('arn'),
    folderName: 'ARN-1182',
    uploadedBy: 'admin',
  });

  const secondArnDoc = await service.createDocument('ABC AMC', {
    fileName: 'arn-2.pdf',
    fileBuffer: Buffer.from('arn-2'),
    folderName: 'ARN-1182',
    uploadedBy: 'admin',
  });

  assert.equal(generalDoc.success, true);
  assert.equal(arnDoc.success, true);
  assert.equal(secondArnDoc.success, true);
  assert.equal(service.listDocuments('ABC AMC', 'general').length, 1);
  assert.equal(service.listDocuments('ABC AMC', 'ARN-1182').length, 2);
  const folders = service.getDocumentFolders('ABC AMC');
  assert.ok(folders.includes('ARN-1182'));
  assert.ok(!folders.includes('general'));
  assert.ok(!folders.includes('files'));

  fs.rmSync(tempDir, { recursive: true, force: true });
  delete process.env.AMC_DOCUMENTS_ROOT;
});

test('re-uploading the same filename updates instead of duplicating it', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ter-amc-docs-'));
  process.env.AMC_DOCUMENTS_ROOT = tempDir;

  const first = await service.createDocument('ABC AMC', {
    fileName: 'same.pdf',
    fileBuffer: Buffer.from('first'),
    folderName: 'ARN-1182',
  });
  const second = await service.createDocument('ABC AMC', {
    fileName: 'same.pdf',
    fileBuffer: Buffer.from('second'),
    folderName: 'ARN-1182',
  });

  assert.equal(first.document.id, second.document.id);
  assert.equal(service.listDocuments('ABC AMC', 'ARN-1182').length, 1);
  assert.equal(fs.readFileSync(path.join(tempDir, 'abc-amc', 'arn-1182', 'files', 'same.pdf'), 'utf8'), 'second');

  fs.rmSync(tempDir, { recursive: true, force: true });
  delete process.env.AMC_DOCUMENTS_ROOT;
});
