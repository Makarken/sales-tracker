/**
 * Google Apps Script backend для сайта "Учёт ФОП".
 * Таблица пользователя уже прописана ниже.
 */
const SPREADSHEET_ID = '1ZbC93oEa1IPb8VCXLKJlcH4p0m3xteoiAWxpvvV-DzM';
const SALES_SHEET_NAME = 'Продажи';

const HEADERS = [
  'local_id','created_at','month','date','platform','title','amount','currency','bank',
  'invoice','reference','status','comment','project','platform_shot','bank_shot','extra_shots','updated_at'
];

function doGet(e) {
  return json_({ ok: true, message: 'FOP backend is working' });
}

function doPost(e) {
  try {
    const body = JSON.parse(e.postData && e.postData.contents ? e.postData.contents : '{}');
    const action = body.action;
    const payload = body.payload || {};

    if (action === 'ping') return json_({ ok: true, message: 'Google Sheets connected' });
    if (action === 'upsertSale') return json_(upsertSale_(payload));
    if (action === 'bulkUpsertSales') return json_(bulkUpsertSales_(payload));
    if (action === 'getSales') return json_(getSales_());

    return json_({ ok: false, error: 'Unknown action: ' + action });
  } catch (err) {
    return json_({ ok: false, error: String(err && err.message ? err.message : err) });
  }
}

function getSheet_() {
  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  let sh = ss.getSheetByName(SALES_SHEET_NAME);
  if (!sh) sh = ss.insertSheet(SALES_SHEET_NAME);

  const firstRow = sh.getRange(1, 1, 1, HEADERS.length).getValues()[0];
  const hasHeaders = firstRow.some(Boolean);
  if (!hasHeaders) {
    sh.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]);
    sh.setFrozenRows(1);
    sh.getRange(1, 1, 1, HEADERS.length).setFontWeight('bold').setBackground('#1e1e21').setFontColor('#eae5dc');
    sh.autoResizeColumns(1, HEADERS.length);
  } else {
    // Если заголовки уже есть, но каких-то не хватает — аккуратно добавим справа.
    const existing = sh.getRange(1, 1, 1, Math.max(sh.getLastColumn(), HEADERS.length)).getValues()[0].filter(String);
    const missing = HEADERS.filter(h => existing.indexOf(h) === -1);
    if (missing.length) sh.getRange(1, existing.length + 1, 1, missing.length).setValues([missing]);
  }
  return sh;
}

function headerMap_(sh) {
  const lastCol = sh.getLastColumn();
  const headers = sh.getRange(1, 1, 1, lastCol).getValues()[0];
  const map = {};
  headers.forEach((h, i) => { if (h) map[h] = i + 1; });
  return map;
}

function upsertSale_(sale) {
  const sh = getSheet_();
  const map = headerMap_(sh);
  const localId = String(sale.local_id || '');
  if (!localId) throw new Error('local_id is required');

  const row = findRowByLocalId_(sh, map, localId) || (sh.getLastRow() + 1);
  const now = new Date();
  const valuesByHeader = Object.assign({}, sale, { updated_at: now });

  HEADERS.forEach(h => {
    if (!map[h]) return;
    sh.getRange(row, map[h]).setValue(valuesByHeader[h] !== undefined ? valuesByHeader[h] : '');
  });

  formatRow_(sh, row, map, sale);
  return { ok: true, row, local_id: localId };
}

function bulkUpsertSales_(sales) {
  if (!Array.isArray(sales)) throw new Error('payload must be array');
  const rows = sales.map(s => upsertSale_(s));
  return { ok: true, rows };
}

function findRowByLocalId_(sh, map, localId) {
  const col = map.local_id;
  if (!col || sh.getLastRow() < 2) return null;
  const vals = sh.getRange(2, col, sh.getLastRow() - 1, 1).getValues().flat();
  const idx = vals.findIndex(v => String(v) === String(localId));
  return idx >= 0 ? idx + 2 : null;
}

function formatRow_(sh, row, map, sale) {
  try {
    if (map.amount) sh.getRange(row, map.amount).setNumberFormat('0.00');
    if (map.status) {
      const cell = sh.getRange(row, map.status);
      const status = String(sale.status || '');
      if (status === 'Учтено') cell.setBackground('#d9ead3');
      else if (status === 'Не доход ФОП') cell.setBackground('#f4cccc');
      else cell.setBackground('#fff2cc');
    }
    if (map.platform) {
      const cell = sh.getRange(row, map.platform);
      const p = String(sale.platform || '').toLowerCase();
      if (p === 'vinted') cell.setBackground('#d9f7f5');
      else if (p === 'vestiaire') cell.setBackground('#fce5cd');
    }
  } catch (e) {}
}

function getSales_() {
  const sh = getSheet_();
  const values = sh.getDataRange().getValues();
  if (values.length <= 1) return { ok: true, rows: [] };
  const headers = values[0];
  const rows = values.slice(1).map(r => {
    const obj = {};
    headers.forEach((h, i) => obj[h] = r[i]);
    return obj;
  });
  return { ok: true, rows };
}

function json_(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
