/**
 * eVatVamSync.js — eVatVam (eÁFA / vámhatározat) orchestráció + menü wrapperek.
 *
 * Tartalom:
 *   - Menü és dialog callbackek
 *   - eVatVamAutoSync      : time-driven trigger végpont
 *   - eVatVamDownloadMissing : hiányzó részletek letöltése batch-csel
 *
 * Függőségei: eVatVamApi.js, eVatVamDataprocessor.js, SheetUtils.js,
 *             Config.js (EVATVAM_SHEET, EVATVAM_BATCH_SIZE), Menu.js (openSyncDialog)
 *
 * ⚠ Trigger figyelmeztetés: ha korábban autoSyncEarLast5Days trigger volt beállítva,
 *    azt törölni kell és újraregisztrálni az eVatVamAutoSync névre.
 */

// ============================================================
// MENÜ HANDLEREK
// ============================================================

function menuEVatVamQueryDigest()    { eVatVamMenuSync(); }
function menuEVatVamDownloadMissing() { eVatVamMenuSync(); }

function eVatVamMenuSync() {
  openSyncDialog('eVatVam', null);
}

// ============================================================
// TIME-DRIVEN TRIGGER VÉGPONT
// ============================================================

function eVatVamAutoSync(opts) {
  var tag = 'eVatVamAutoSync';
  var ss  = SpreadsheetApp.getActiveSpreadsheet();
  Logger.log('[' + tag + '] INDULÁS');

  var bounds;
  if (opts && opts.dateFrom && opts.dateTo) {
    bounds = {
      queryFrom:  opts.dateFrom,
      queryTo:    opts.dateTo,
      filterFrom: opts.filterFrom !== undefined ? opts.filterFrom : null,
      filterTo:   opts.filterTo   !== undefined ? opts.filterTo   : null
    };
  } else {
    bounds = getDateBoundaries({ sheetName: EVATVAM_SHEET, dateColumnHeader: 'Kézbesítés dátuma' });
  }
  Logger.log('[' + tag + '] queryFrom=' + bounds.queryFrom + ' queryTo=' + bounds.queryTo +
             ' | filterFrom=' + bounds.filterFrom + ' filterTo=' + bounds.filterTo);

  var filter = { filterFrom: bounds.filterFrom, filterTo: bounds.filterTo };

  try {
    var rows = eVatVamQueryDigest({
      declarationDateFrom:  bounds.queryFrom,
      declarationDateTo:    bounds.queryTo,
      declarationDirection: 'IMPORTER'
    });
    var writtenVam = eVatVamWriteDeclarationRows(rows, filter);
    Logger.log('[' + tag + '] Digest KÉSZ. Új sorok: ' + writtenVam + ' / ' + rows.length);

    eVatVamDownloadMissing(writtenVam);
  } catch (e) {
    Logger.log('[' + tag + '] VÉGZETES HIBA: ' + e.message);
    ss.toast('Végzetes hiba: ' + e.message, '✖ Szinkron hiba', 15);
  }
}

// ============================================================
// DIALOG BACKEND
// ============================================================

function dialogRunSyncEVatVam(opts) {
  eVatVamAutoSync(opts);
}

// ============================================================
// HIÁNYZÓ RÉSZLETEK LETÖLTÉSE
// ============================================================

/**
 * Letölti a Vámhatározatok sheet azon sorainak részleteit,
 * ahol a "Részletek LETÖLTVE" mező üres.
 *
 * @param {number} writtenVam  az eVatVamAutoSync által beírt új sorok száma (csak loghoz)
 */
function eVatVamDownloadMissing(writtenVam) {
  var tag  = 'eVatVamDownloadMissing';
  var ss   = SpreadsheetApp.getActiveSpreadsheet();
  var wVam = writtenVam || 0;

  var sh = ss.getSheetByName(EVATVAM_SHEET);
  if (!sh) {
    Logger.log('[' + tag + '] ' + EVATVAM_SHEET + ' nem található. VÉGE.');
    ss.toast('Még nem létezik a Vámhatározatok lapja.', 'Hiba', 5);
    return;
  }

  var hMap      = dpGetHeaderMap(sh);
  var idColIdx  = hMap['Határozat azonosítója'];
  var resColIdx = hMap['Határozatszám'];
  var dlColIdx  = hMap['Részletek LETÖLTVE'];
  if (!idColIdx || !resColIdx || !dlColIdx) {
    Logger.log('[' + tag + '] Hiányzó fejlécek. VÉGE.');
    ss.toast('Hiányzó fejlécek a Vámhatározatok lapon.', 'Hiba', 5);
    return;
  }

  var lastRow = sh.getLastRow();
  if (lastRow < 2) {
    if (wVam === 0) ss.toast('Nincs adat.', 'Infó', 5);
    return;
  }

  var data    = sh.getRange(2, 1, lastRow - 1, sh.getLastColumn()).getValues();
  var pending = [];
  for (var i = 0; i < data.length; i++) {
    var dl     = String(data[i][dlColIdx  - 1]).trim();
    var cdpsId = String(data[i][idColIdx  - 1]).trim();
    var resId  = String(data[i][resColIdx - 1]).trim();
    if (cdpsId && resId && dl === '') pending.push({ cdpsId: cdpsId, resolutionId: resId });
  }

  if (pending.length === 0) {
    Logger.log('[' + tag + '] Minden részlet letöltve. VÉGE.');
    var msg = 'Vámhatározatok: ' + (wVam > 0 ? wVam + ' új sor, ' : '') + 'minden részlet rendben.';
    ss.toast(msg, '✔ Szinkron kész', 8);
    return;
  }

  Logger.log('[' + tag + '] ' + pending.length + ' határozathoz hiányzik részletes XML.');
  ss.toast(pending.length + ' db hiányzó vámhatározat részlet letöltése indul...', 'Folyamatban', 5);

  var ok = 0, fail = 0;
  var lastToastTime = Date.now();

  for (var i = 0; i < pending.length; i += EVATVAM_BATCH_SIZE) {
    var chunkKeys    = pending.slice(i, i + EVATVAM_BATCH_SIZE);
    var chunkResults = [];

    for (var j = 0; j < chunkKeys.length; j++) {
      try {
        chunkResults.push(eVatVamQueryTaxCode({
          cdpsId:               chunkKeys[j].cdpsId,
          resolutionId:         chunkKeys[j].resolutionId,
          declarationDirection: 'IMPORTER'
        }));
        ok++;
      } catch (e) {
        fail++;
        Logger.log('[' + tag + '] Hiba [' + chunkKeys[j].cdpsId + ']: ' + e.message);
      }
    }

    if (chunkResults.length > 0) {
      try {
        eVatVamProcessDeclarationDataBatch(chunkResults);
      } catch (e) {
        Logger.log('[' + tag + '] Batch kiírási hiba: ' + e.message);
      }
    }

    var now       = Date.now();
    var processed = Math.min(i + EVATVAM_BATCH_SIZE, pending.length);
    if (now - lastToastTime > 15000 || processed === pending.length) {
      ss.toast('Folyamatban: ' + processed + ' / ' + pending.length + '...', 'Kis türelmet', 15);
      Logger.log('[' + tag + '] Folyamatban: ' + processed + ' / ' + pending.length);
      lastToastTime = now;
    }
  }

  var summary = 'Vámhatározatok: ' + (wVam > 0 ? wVam + ' új sor, ' : '') + ok + ' részlet letöltve' +
                (fail > 0 ? ', ' + fail + ' hiba (ld. Naplók)' : '') + '.';
  Logger.log('[' + tag + '] ÖSSZEGZÉS: ' + summary);
  ss.toast(summary, '✔ Szinkron kész', 10);
}
