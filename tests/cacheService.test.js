const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

// Must be set BEFORE requiring cacheService — its disk paths are read once
// at module-load time. Without this, setSchemes()/setPeriodSchemes() below
// would write straight through to the real project-root ter-cache.json /
// ter-manual-sync.json, silently overwriting live production data with
// this test's synthetic scheme rows.
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ter-cache-test-'));
process.env.TER_CACHE_PATH = path.join(tempDir, 'ter-cache.json');
process.env.TER_MANUAL_SYNC_PATH = path.join(tempDir, 'ter-manual-sync.json');
// updateSchemeValues() (used below) also lazily writes through to
// commissionOverrideService — isolate that disk file too.
process.env.COMMISSION_OVERRIDE_CACHE_PATH = path.join(tempDir, 'commission-override-cache.json');

const cacheService = require('../services/cacheService');

test('loading status is exposed on cold refresh but does not replace a ready cache', () => {
  cacheService.setStatus('loading');
  assert.equal(cacheService.getStatus().status, 'loading');

  cacheService.setSchemes([{ schemeName: 'Ready Scheme', amc: 'Ready AMC' }]);
  cacheService.setStatus('loading');
  assert.equal(cacheService.getStatus().status, 'ready');
});

test('updateSchemeValues updates matching scheme fields', () => {
  cacheService.setSchemes([
    {
      schemeName: 'Test Scheme',
      amc: 'ABC AMC',
      terDiff: 1.1,
      berDiff: 2.2,
      year1: 0.1,
      year2: 0.2,
      year3: 0.3,
      year4: 0.4,
      yearOnward: 0.5,
    },
  ]);

  const result = cacheService.updateSchemeValues({
    schemeName: 'Test Scheme',
    amc: 'ABC AMC',
    values: {
      terDiff: 3.3,
      berDiff: 4.4,
      year1: 1.1,
      year2: 2.2,
      year3: 3.3,
      year4: 4.4,
      yearOnward: 5.5,
    },
  });

  assert.equal(result.success, true);
  const updated = cacheService.getSchemes()[0];
  assert.equal(updated.terDiff, 3.3);
  assert.equal(updated.berDiff, 4.4);
  assert.equal(updated.year1, 1.1);
  assert.equal(updated.year2, 2.2);
  assert.equal(updated.year3, 3.3);
  assert.equal(updated.year4, 4.4);
  assert.equal(updated.yearOnward, 5.5);
});

test('updateSchemeValues also updates period-specific cached schemes', () => {
  cacheService.setSchemes([
    {
      schemeName: 'Period Scheme',
      amc: 'XYZ AMC',
      nsdlCode: 'NSDL001',
      amfiCode: 'AMFI001',
      year1: 0.1,
      year2: 0.2,
      year3: 0.3,
      year4: 0.4,
      yearOnward: 0.5,
    },
  ]);

  cacheService.setPeriodSchemes('2024', '07', {
    schemes: [
      {
        schemeName: 'Period Scheme',
        amc: 'XYZ AMC',
        nsdlCode: 'NSDL001',
        amfiCode: 'AMFI001',
        year1: 0.1,
        year2: 0.2,
        year3: 0.3,
        year4: 0.4,
        yearOnward: 0.5,
      },
    ],
  });

  const result = cacheService.updateSchemeValues({
    nsdlCode: 'NSDL001',
    amc: 'XYZ AMC',
    values: { year1: 9.9, yearOnward: 8.8 },
  });

  assert.equal(result.success, true);
  const baseUpdated = cacheService.getSchemes()[0];
  assert.equal(baseUpdated.year1, 9.9);
  assert.equal(baseUpdated.yearOnward, 8.8);

  const periodData = cacheService.getPeriodSchemes('2024', '07');
  assert(periodData, 'period data should exist');
  assert.equal(periodData.schemes[0].year1, 9.9);
  assert.equal(periodData.schemes[0].yearOnward, 8.8);
});

test('clearBrokerageData removes all stored scheme brokerage values', () => {
  cacheService.setSchemes([
    {
      schemeName: 'Legacy Scheme',
      amc: 'Legacy AMC',
      regularBER: 1.8,
      year1: 0.8,
      year2: 0.9,
      year3: 1.0,
      year4: 1.1,
      yearOnward: 1.2,
      year6Onward: 1.3,
    },
  ]);

  cacheService.clearBrokerageData();

  const updated = cacheService.getSchemes()[0];
  assert.equal(updated.year1, null);
  assert.equal(updated.year2, null);
  assert.equal(updated.year3, null);
  assert.equal(updated.year4, null);
  assert.equal(updated.yearOnward, null);
  assert.equal(updated.year6Onward, null);
  assert.equal(updated.c1, null);
  assert.equal(updated.c2, null);
  assert.equal(updated.c3, null);
  assert.equal(updated.c4, null);
  assert.equal(updated.c5, null);
  assert.equal(updated.c6, null);
});

test('clearing brokerage suppresses legacy parser values until a new upload', () => {
  const commissionOverrideService = require('../services/commissionOverrideService');
  const { getForcedYearValues } = require('../services/terParser');

  commissionOverrideService.clearAll();
  assert.equal(getForcedYearValues('360 One Flexicap Fund'), null);

  commissionOverrideService.setForAMC('__all__', [{
    scheme: '360 One Flexicap Fund',
    year1: 1.23,
    year2: null,
    year3: null,
    year4: null,
    yearOnward: null,
    year6Onward: null,
  }], 'test-upload.xlsx');

  assert.equal(getForcedYearValues('360 One Flexicap Fund').year1, 1.23);
});

test('all-AMC commission upload applies matching scheme names across the matrix', () => {
  const XLSX = require('xlsx');
  const cacheService = require('../services/cacheService');
  const commissionController = require('../controllers/commissionController');

  cacheService.setSchemes([
    {
      schemeName: 'Axis Flexi Cap Fund',
      amc: 'Axis Mutual Fund',
      regularBER: 1.0,
      year1: null,
      year2: null,
      year3: null,
      year4: null,
      yearOnward: null,
      year6Onward: null,
    },
    {
      schemeName: 'HDFC Balanced Advantage Fund',
      amc: 'HDFC Mutual Fund',
      regularBER: 1.0,
      year1: null,
      year2: null,
      year3: null,
      year4: null,
      yearOnward: null,
      year6Onward: null,
    },
  ]);

  const wb = XLSX.utils.book_new();
  const rows = [
    ['Scheme Name', 'Year 1', 'Year 2', 'Year 3', 'Year 4', '5th Year'],
    ['Axis Flexi Cap Fund', 0.8, 0.9, 1.0, 1.1, 1.2],
    ['HDFC Balanced Advantage Fund', 0.7, 0.8, 0.9, 1.0, 1.1],
  ];
  const ws = XLSX.utils.aoa_to_sheet(rows);
  XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');

  const res = {
    json(payload) { this.payload = payload; return payload; },
    status(code) { this.statusCode = code; return this; },
  };

  commissionController.uploadCommission({
    body: { amc: '__all__' },
    file: {
      buffer: XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }),
      originalname: 'all-amc-upload.xlsx',
    },
  }, res);

  const schemes = cacheService.getSchemes();
  assert.equal(schemes[0].year1, 0.8);
  assert.equal(schemes[0].yearOnward, 1.2);
  assert.equal(schemes[1].year1, 0.7);
  assert.equal(schemes[1].yearOnward, 1.1);
  assert.equal(res.payload.success, true);
});

test('slimScheme correctly preserves regularBER for API payload', () => {
  const { slimScheme } = require('../controllers/schemeController');
  const sampleScheme = {
    nsdlCode: 'NSDL01',
    amfiCode: '10001',
    schemeName: 'Test Scheme',
    launchDate: '2020-01-01',
    amc: 'Test AMC',
    schemeType: 'Open Ended',
    schemeCategory: 'Equity',
    regularBER: 1.78,
    directBER: 0.45,
    terDiff: 1.57,
    berDiff: 1.33,
    year1: 0.8,
  };

  const slimmed = slimScheme(sampleScheme, 0);
  assert.equal(slimmed.regularBER, 1.78);
  assert.equal(slimmed.terDiff, 1.57);
  assert.equal(slimmed.berDiff, 1.33);
});

