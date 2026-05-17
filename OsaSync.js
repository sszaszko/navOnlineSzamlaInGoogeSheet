/**
 * OsaSync.js — OSA orchestráció + vékony menü/dialog wrapperek.
 *
 * Tartalom:
 *   - Menü és dialog callbackek (vékony rétegek, csak átirányítanak)
 *   - osaAutoSync / osaAutoSyncOutbound : time-driven trigger végpontok
 *   - osaSync                            : fő szinkron folyamat (digest + tételek)
 *   - osaDownloadMissingDetails          : csak hiányzó tételek letöltése batch-csel
 *   - menuQuerySingleInvoice             : kézi egyetlen számla lekérdezés + pdf
 *
 * Függőségei: OsaApi.js, OsaProcessor.js, OsaFieldMaps.js, SheetUtils.js,
 *              Config.js (OSA_BATCH_SIZE), InvoicePdf.js (generateInvoicePdf),
 *              ProcessNAV_xls.js (postProcessSheets).
 *
 * ⚠ Trigger figyelmeztetés: ha korábban autoSyncLast5Days / autoSyncLast5DaysOutbound
 *    triggerek voltak beállítva, azokat törölni kell és újraregisztrálni az új
 *    osaAutoSync / osaAutoSyncOutbound nevekre.
 */

// ============================================================
// MENÜ HANDLEREK — vékony wrapperek
// ============================================================

function menuOsaQueryInvoiceDigest()             { osaMenuPromptAndSync('INBOUND'); }
function menuOsaQueryInvoiceDigestOutbound()     { osaMenuPromptAndSync('OUTBOUND'); }
function menuOsaDownloadMissingDetails()         { osaMenuPromptAndSync('INBOUND'); }
function menuOsaDownloadMissingDetailsOutbound() { osaMenuPromptAndSync('OUTBOUND'); }

/**
 * SyncDateDialog.html megnyitása számlák szinkronizálásához.
 */
function osaMenuPromptAndSync(direction) {
  var syncType = direction === 'OUTBOUND' ? 'invoice_out' : 'invoice_in';
  openSyncDialog(syncType, direction);
}

// ============================================================
// TIME-DRIVEN TRIGGER VÉGPONTOK
// ============================================================

function osaAutoSync()         { osaSync('INBOUND',  null); }
function osaAutoSyncOutbound() { osaSync('OUTBOUND', null); }

// ============================================================
// DIALOG BACKEND — SyncDateDialog.html call-backek
// ============================================================

function dialogRunSyncInvoiceIn(opts)  { osaSync('INBOUND',  opts); }
function dialogRunSyncInvoiceOut(opts) { osaSync('OUTBOUND', opts); }

// ============================================================
// FŐFOLYAMAT — szinkron (digest + hiányzó tételek letöltése)
// ============================================================

/**
 * @param {string}      direction  'INBOUND' | 'OUTBOUND'
 * @param {Object|null} opts       Opcionális: { dateFrom, dateTo, filterFrom, filterTo }.
 *                                 Menüből meghívva opts tartalmazza a felhasználó dátumait,
 *                                 trigger esetén null → getDateBoundaries() számolja ki.
 */
function osaSync(direction, opts) {
  var dirLabel = direction === 'OUTBOUND' ? 'KIMENŐ' : 'BEJÖVŐ';
  var cfg      = osaDirCfg(direction);
  var tag      = 'osaSync[' + dirLabel + ']';
  var ss       = SpreadsheetApp.getActiveSpreadsheet();

  Logger.log('[' + tag + '] INDULÁS');

  var fejlecIssues = dpValidate([
    { sheet: cfg.sheetFejlec, headers: ['Számla sorszáma', 'Tételek LETÖLTVE'] }
  ], null);
  if (fejlecIssues.length > 0) {
    Logger.log('[' + tag + '] Leállás: ' + fejlecIssues.join(' | '));
    return;
  }

  var bounds;
  if (opts && opts.dateFrom && opts.dateTo) {
    bounds = { queryFrom: opts.dateFrom, queryTo: opts.dateTo,
               filterFrom: opts.filterFrom !== undefined ? opts.filterFrom : null,
               filterTo:   opts.filterTo   !== undefined ? opts.filterTo   : null };
  } else {
    bounds = getDateBoundaries({
      sheetName:        cfg.sheetFejlec,
      dateColumnHeader: 'Számla kelte'
    });
  }
  Logger.log('[' + tag + '] queryFrom=' + bounds.queryFrom + ' queryTo=' + bounds.queryTo +
             ' | filterFrom=' + bounds.filterFrom + ' filterTo=' + bounds.filterTo);

  var filter = { filterFrom: bounds.filterFrom, filterTo: bounds.filterTo };

  try {
    var rows = osaQueryInvoiceDigest({
      dateFrom: bounds.queryFrom, dateTo: bounds.queryTo, invoiceDirection: direction
    });
    var writtenFejlec = osaWriteFejlecRows(rows, direction, filter);
    Logger.log('[' + tag + '] Digest KÉSZ. Új fejlécek: ' + writtenFejlec + ' / ' + rows.length);

    osaDownloadMissingDetails(direction, writtenFejlec);
  } catch (e) {
    Logger.log('[' + tag + '] VÉGZETES HIBA: ' + e.message);
    ss.toast('Végzetes hiba: ' + e.message, '✖ Szinkron hiba', 15);
  }
}

// ============================================================
// HIÁNYZÓ TÉTELEK LETÖLTÉSE
// ============================================================

/**
 * Letölti a Fejléc sheet azon számláinak tételeit, ahol a "Tételek LETÖLTVE"
 * mező üres vagy "n/a". Batch-csel dolgozik (OSA_BATCH_SIZE-onként).
 *
 * @param {string} direction       'INBOUND' | 'OUTBOUND'
 * @param {number} writtenFejlec   az osaSync által beírt új fejlécek száma (csak loghoz)
 */
function osaDownloadMissingDetails(direction, writtenFejlec) {
  var tag = 'osaDownloadMissingDetails[' + direction + ']';
  var ss  = SpreadsheetApp.getActiveSpreadsheet();
  var cfg = osaDirCfg(direction);
  var dirLabel = direction === 'OUTBOUND' ? 'Kimenő' : 'Bejövő';
  var wFejlec = writtenFejlec || 0;

  var fejSh = ss.getSheetByName(cfg.sheetFejlec);
  if (!fejSh) {
    ss.toast('Még nem létezik a fejlécek lapja.', 'Hiba', 5);
    return;
  }
  var hMap    = dpGetHeaderMap(fejSh);
  var keyCol  = hMap['Számla sorszáma'];
  var dlCol   = hMap['Tételek LETÖLTVE'];
  var lastRow = fejSh.getLastRow();

  if (lastRow < 2) {
    if (wFejlec === 0) ss.toast('Nincs adat.', 'Infó', 5);
    return;
  }

  var data    = fejSh.getRange(2, 1, lastRow - 1, fejSh.getLastColumn()).getValues();
  var pending = [];
  for (var i = 0; i < data.length; i++) {
    var dl  = String(data[i][dlCol - 1]).trim();
    var num = String(data[i][keyCol - 1]).trim();
    if (num && (dl === '' || dl === 'n/a')) pending.push(num);
  }

  if (pending.length === 0) {
    Logger.log('[' + tag + '] Minden tétel letöltve. VÉGE.');
    var msg = dirLabel + ': ' + (wFejlec > 0 ? wFejlec + ' új fejléc beírva, ' : '') + 'minden tétel rendben.';
    ss.toast(msg, '✔ Szinkron kész', 8);
    return;
  }

  var tetelIssues = dpValidate([
    { sheet: cfg.sheetTetel, headers: ['Számla sorszáma', 'Tétel sorszáma'] }
  ], null);
  if (tetelIssues.length > 0) {
    Logger.log('[' + tag + '] Leállás (tétel sheet): ' + tetelIssues.join(' | '));
    ss.toast('Leállás: ' + tetelIssues.join(' | '), 'Hiba', 8);
    return;
  }

  Logger.log('[' + tag + '] ' + pending.length + ' számla tételeinek letöltése...');
  ss.toast(pending.length + ' db hiányzó tétel letöltése indul...', 'Folyamatban', 5);

  var ok = 0, fail = 0;

  // End-to-end batchek: letölt N-et → azonnal ír → letölt következő N-et → ír...
  for (var i = 0; i < pending.length; i += OSA_BATCH_SIZE) {
    var chunkKeys = pending.slice(i, i + OSA_BATCH_SIZE);
    var processed = Math.min(i + OSA_BATCH_SIZE, pending.length);

    var paramsArray = [];
    for (var k = 0; k < chunkKeys.length; k++) {
      paramsArray.push({ invoiceNumber: chunkKeys[k], invoiceDirection: direction });
    }

    var chunkResults = [];
    try {
      chunkResults = osaQueryInvoiceDataBatch(paramsArray);
      for (var k = 0; k < chunkResults.length; k++) {
        if (chunkResults[k].invoiceXml) ok++;
        else fail++;
      }
    } catch (e) {
      Logger.log('[' + tag + '] Batch letöltési hiba: ' + e.message);
      fail += chunkKeys.length;
    }

    if (chunkResults.length > 0) {
      Logger.log('[' + tag + '] Batch kiírása: ' + processed + ' / ' + pending.length);
      ss.toast('Feldolgozás: ' + processed + ' / ' + pending.length + '...', 'Folyamatban', 15);
      try {
        osaProcessInvoiceDataBatch(chunkResults, direction);
      } catch (e) {
        Logger.log('[' + tag + '] Batch kiírási hiba: ' + e.message);
      }
    }
  }

  if ((ok > 0 || wFejlec > 0) && direction === 'INBOUND') postProcessSheets();

  var summary = dirLabel + ': ' + (wFejlec > 0 ? wFejlec + ' fejléc, ' : '') + ok + ' tétel letöltve' +
                (fail > 0 ? ', ' + fail + ' hiba (ld. Naplók)' : '') + '.';
  Logger.log('[' + tag + '] ÖSSZEGZÉS: ' + summary);
  ss.toast(summary, '✔ Szinkron kész', 10);
}

// ============================================================
// KÉZI — egyetlen számla lekérdezése
// ============================================================

function menuQuerySingleInvoice() {
  var ui = SpreadsheetApp.getUi();
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getActiveSheet();
  var activeCell = sheet.getActiveCell();

  var direction = 'INBOUND';
  var cfg       = osaDirCfg(direction);

  // Csak a tétel sheet a kötelező — ott biztos lesz beleírás.
  // A fejléc update (osaUpdateFejlecFromInvoiceXml) csendben kihagyja,
  // ha a fejléc sheet/oszlop nincs meg, így nem validáljuk szigorúan.
  var issues = dpValidate([
    { sheet: cfg.sheetTetel, headers: ['Számla sorszáma', 'Tétel sorszáma'] }
  ], ui);
  if (issues.length > 0) return;

  var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  var invoiceColIndex = headers.indexOf('Számla sorszáma') + 1;

  var defaultInvoiceNumber = '';
  if (invoiceColIndex > 0 && activeCell.getColumn() === invoiceColIndex && activeCell.getRow() > 1) {
    defaultInvoiceNumber = String(activeCell.getValue()).trim();
  }

  var promptText = 'Számla sorszáma:';
  if (defaultInvoiceNumber) {
    promptText = 'Számla sorszáma (Alapértelmezett: ' + defaultInvoiceNumber + '):';
  }

  var r1 = ui.prompt('Kézi számla lekérdezés', promptText, ui.ButtonSet.OK_CANCEL);
  if (r1.getSelectedButton() !== ui.Button.OK) return;
  var invoiceNumber = r1.getResponseText().trim() || defaultInvoiceNumber;
  if (!invoiceNumber) return;

  try {
    var result = osaQueryInvoiceData({ invoiceNumber: invoiceNumber, invoiceDirection: direction });
    osaWriteTetelRows(result, direction);
    osaUpdateFejlecFromInvoiceXml(result, direction);
    osaUpdateTetelekFromInvoiceXml(result, direction);

    // Pdf generálás meghívása
    generateInvoicePdf(result);

  } catch (e) {
    ui.alert('Hiba!\n\n' + e.message);
  }
}
