/**
 * FOP backend v10: Google Sheets archive + JSONP read for GitHub Pages.
 *
 * Изменения относительно v7:
 *  - Картинки больше не публичные на Drive. Хранятся PRIVATE, отдаются через JSONP как base64.
 *  - listSales поддерживает фильтр ?month=YYYY-MM (пагинация по месяцам).
 *  - bulkUpsertSales не зовёт autoResizeColumns на каждой строке.
 *  - Action нормализуется к нижнему регистру.
 *  - Опциональный shared-secret токен (по умолчанию выключен).
 *  - Новый action=getImage&fileId=... для подгрузки base64 одной картинки.
 *
 * Установка:
 *  1) Заменить весь код в Apps Script на этот файл.
 *  2) Deploy -> Manage deployments -> Edit -> New version -> Deploy.
 *  3) Новый URL вставить в настройки сайта (если изменился).
 */

const SPREADSHEET_ID = '1ZbC93oEa1IPb8VCXLKJlcH4p0m3xteoiAWxpvvV-DzM';
const SALES_SHEET_NAME = 'Продажи';
const IMAGE_FOLDER_NAME = 'FOP sales screenshots';

// Если нужна защита от чужих чтений, поставь сюда любую секретную строку
// и скопируй её же в site (settings.token). Пустая строка = без проверки.
const SHARED_TOKEN = '';

const HEADERS = [
  'local_id','created_at','month','date','platform','title','amount','currency','bank',
  'invoice','reference','status','comment','project',
  'platform_shot','bank_shot','extra_shots',
  'platform_image_id','item_image_id',           // <-- было *_url, теперь *_id (приватные)
  'platform_image_url','item_image_url',         // оставляем для обратной совместимости
  'updated_at'
];

function doGet(e) {
  try {
    const p = e && e.parameter ? e.parameter : {};
    if (!checkToken_(p)) return output_({ ok:false, error:'auth' }, p.callback);
    const action = String(p.action || 'ping').toLowerCase();
    let result;
    if (action === 'ping') result = { ok:true, message:'FOP backend v10 is working' };
    else if (action === 'listsales' || action === 'getsales') result = listSales_(p.month || '', p.local_id || p.id || '');
    else if (action === 'getimage') result = getImage_(p.fileId || p.id || '');
    else if (action === 'deletesale') result = deleteSale_({ local_id: p.local_id || p.id || '', row_number: p.row_number || p.row || '' });
    else result = { ok:false, error:'Unknown GET action: ' + action };
    return output_(result, p.callback);
  } catch (err) {
    return output_({ ok:false, error:String(err && err.message ? err.message : err) }, e && e.parameter && e.parameter.callback);
  }
}

function doPost(e) {
  try {
    const body = JSON.parse(e.postData && e.postData.contents ? e.postData.contents : '{}');
    if (!checkToken_(body)) return output_({ ok:false, error:'auth' });
    const action = String(body.action || '').toLowerCase();
    const payload = body.payload || {};
    let result;
    if (action === 'ping') result = { ok:true, message:'Google Sheets connected' };
    else if (action === 'upsertsale') result = upsertSale_(payload);
    else if (action === 'bulkupsertsales') result = bulkUpsertSales_(payload);
    else if (action === 'listsales' || action === 'getsales') result = listSales_(payload.month || '', payload.local_id || payload.id || '');
    else if (action === 'deletesale') result = deleteSale_(payload);
    else result = { ok:false, error:'Unknown POST action: ' + action };
    return output_(result);
  } catch (err) {
    return output_({ ok:false, error:String(err && err.message ? err.message : err) });
  }
}

function checkToken_(src) {
  if (!SHARED_TOKEN) return true;
  const t = String(src.token || '');
  return t === SHARED_TOKEN;
}

function getSheet_() {
  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  let sh = ss.getSheetByName(SALES_SHEET_NAME);
  if (!sh) sh = ss.insertSheet(SALES_SHEET_NAME);
  const lastCol = Math.max(sh.getLastColumn(), HEADERS.length);
  const firstRow = sh.getRange(1, 1, 1, lastCol).getValues()[0];
  const existing = firstRow.filter(String);
  if (!existing.length) {
    sh.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]);
    sh.setFrozenRows(1);
    sh.getRange(1, 1, 1, HEADERS.length).setFontWeight('bold').setBackground('#1e1e21').setFontColor('#eae5dc');
    sh.autoResizeColumns(1, HEADERS.length);
  } else {
    const missing = HEADERS.filter(h => existing.indexOf(h) === -1);
    if (missing.length) sh.getRange(1, existing.length + 1, 1, missing.length).setValues([missing]);
  }
  return sh;
}

function headerMap_(sh) {
  const headers = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
  const map = {};
  headers.forEach((h, i) => { if (h) map[h] = i + 1; });
  return map;
}

function upsertSale_(sale, skipResize) {
  const sh = getSheet_();
  const map = headerMap_(sh);
  const localId = String(sale.local_id || '');
  if (!localId) throw new Error('local_id is required');

  const row = findRowByLocalId_(sh, map, localId) || (sh.getLastRow() + 1);
  const now = new Date();

  const valuesByHeader = Object.assign({}, sale, { updated_at: now });

  // Сохраняем картинки приватно: только id, без публичной ссылки.
  if (sale.platformImage && String(sale.platformImage).indexOf('data:image/') === 0) {
    valuesByHeader.platform_image_id = saveImagePrivate_(sale.platformImage, localId + '_platform');
    valuesByHeader.platform_image_url = '';            // больше не публикуем
    valuesByHeader.platform_shot = 'private:' + valuesByHeader.platform_image_id;
  }
  if (sale.itemImage && String(sale.itemImage).indexOf('data:image/') === 0) {
    valuesByHeader.item_image_id = saveImagePrivate_(sale.itemImage, localId + '_item');
    valuesByHeader.item_image_url = '';
    valuesByHeader.extra_shots = 'private:' + valuesByHeader.item_image_id;
  }

  HEADERS.forEach(h => {
    if (!map[h]) return;
    let v = valuesByHeader[h];
    if (v === undefined) v = '';
    sh.getRange(row, map[h]).setValue(v);
  });

  formatRow_(sh, row, map, valuesByHeader, /*skipResize=*/!!skipResize);
  return { ok:true, row, local_id: localId };
}

function bulkUpsertSales_(sales) {
  if (!Array.isArray(sales)) throw new Error('payload must be array');
  const rows = sales.map(s => upsertSale_(s, /*skipResize=*/true));
  const sh = getSheet_();
  try { sh.autoResizeColumns(1, Math.min(sh.getLastColumn(), HEADERS.length)); } catch(e){}
  return { ok:true, rows };
}

function listSales_(monthFilter, localIdFilter) {
  const sh = getSheet_();
  const values = sh.getDataRange().getValues();
  if (values.length <= 1) return { ok:true, records:[] };
  const headers = values[0];
  const wantMonth = String(monthFilter || '').trim();
  const wantLocalId = String(localIdFilter || '').trim();

  const records = values.slice(1).map((r, idx) => ({ row: r, rowNumber: idx + 2 })).filter(x => x.row.some(Boolean)).map(x => {
    const r = x.row;
    const obj = { row_number: x.rowNumber };
    headers.forEach((h, i) => {
      if (!h) return;
      let v = r[i];
      if (v instanceof Date) {
        if (h === 'date') v = Utilities.formatDate(v, Session.getScriptTimeZone(), 'dd/MM/yyyy');
        else v = v.toISOString();
      }
      obj[h] = v;
    });
    // Маркеры приватных картинок: фронт по ним поймёт, что нужно дотянуть base64 через getImage.
    if (obj.platform_image_id) obj.platformImage = 'private:' + obj.platform_image_id;
    else obj.platformImage = obj.platform_image_url || obj.platform_shot || '';
    if (obj.item_image_id) obj.itemImage = 'private:' + obj.item_image_id;
    else obj.itemImage = obj.item_image_url || obj.extra_shots || '';
    return obj;
  });

  let filtered = records;
  if (wantMonth) filtered = filtered.filter(r => String(r.month || '') === wantMonth);
  if (wantLocalId) filtered = filtered.filter(r => String(r.local_id || '') === wantLocalId);

  return { ok:true, records: filtered.reverse(), total: records.length };
}


function deleteSale_(payload) {
  const sh = getSheet_();
  const map = headerMap_(sh);
  const localId = String(payload.local_id || payload.id || '').trim();
  let row = null;

  if (localId) row = findRowByLocalId_(sh, map, localId);
  if (!row && payload.row_number) {
    const n = Number(payload.row_number);
    if (n >= 2 && n <= sh.getLastRow()) row = n;
  }
  if (!row) return { ok:false, error:'record not found' };

  // Сначала забираем id картинок, чтобы после удаления строки убрать файлы из Drive.
  const platformId = map.platform_image_id ? String(sh.getRange(row, map.platform_image_id).getValue() || '') : '';
  const itemId = map.item_image_id ? String(sh.getRange(row, map.item_image_id).getValue() || '') : '';
  sh.deleteRow(row);

  const deletedFiles = [];
  [platformId, itemId].forEach(id => {
    if (!id) return;
    try {
      DriveApp.getFileById(id).setTrashed(true);
      deletedFiles.push(id);
    } catch (e) {}
  });

  return { ok:true, deleted_row: row, local_id: localId, deleted_files: deletedFiles.length };
}

function getImage_(fileId) {
  if (!fileId) return { ok:false, error:'fileId required' };
  try {
    const file = DriveApp.getFileById(String(fileId));
    const blob = file.getBlob();
    const mime = blob.getContentType() || 'image/jpeg';
    const b64 = Utilities.base64Encode(blob.getBytes());
    return { ok:true, dataUrl: 'data:' + mime + ';base64,' + b64 };
  } catch (e) {
    return { ok:false, error:'image not found: ' + e.message };
  }
}

function findRowByLocalId_(sh, map, localId) {
  const col = map.local_id;
  if (!col || sh.getLastRow() < 2) return null;
  const vals = sh.getRange(2, col, sh.getLastRow() - 1, 1).getValues().flat();
  const idx = vals.findIndex(v => String(v) === String(localId));
  return idx >= 0 ? idx + 2 : null;
}

function formatRow_(sh, row, map, sale, skipResize) {
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
    if (!skipResize) sh.autoResizeColumns(1, Math.min(sh.getLastColumn(), HEADERS.length));
  } catch (e) {}
}

function saveImagePrivate_(dataUrl, name) {
  const m = String(dataUrl).match(/^data:(image\/\w+);base64,(.+)$/);
  if (!m) return '';
  const mime = m[1];
  const ext = mime.indexOf('png') >= 0 ? '.png' : '.jpg';
  const bytes = Utilities.base64Decode(m[2]);
  const blob = Utilities.newBlob(bytes, mime, name + ext);
  const folder = getImageFolder_();
  const file = folder.createFile(blob);
  // Никаких setSharing — файл остаётся приватным владельцу скрипта.
  return file.getId();
}

function getImageFolder_() {
  const it = DriveApp.getFoldersByName(IMAGE_FOLDER_NAME);
  if (it.hasNext()) return it.next();
  return DriveApp.createFolder(IMAGE_FOLDER_NAME);
}

function output_(obj, callback) {
  const json = JSON.stringify(obj);
  if (callback) {
    return ContentService.createTextOutput(String(callback) + '(' + json + ');')
      .setMimeType(ContentService.MimeType.JAVASCRIPT);
  }
  return ContentService.createTextOutput(json).setMimeType(ContentService.MimeType.JSON);
}

/**
 * Утилита: сделать приватными все ранее опубликованные файлы в папке IMAGE_FOLDER_NAME.
 * Запустить один раз вручную из редактора Apps Script (выбрать функцию revokePublicAccess_ -> Run).
 */
function revokePublicAccess_() {
  const folder = getImageFolder_();
  const files = folder.getFiles();
  let count = 0;
  while (files.hasNext()) {
    const f = files.next();
    try {
      f.setSharing(DriveApp.Access.PRIVATE, DriveApp.Permission.NONE);
      count++;
    } catch (e) {}
  }
  Logger.log('Revoked public access on ' + count + ' files');
}
