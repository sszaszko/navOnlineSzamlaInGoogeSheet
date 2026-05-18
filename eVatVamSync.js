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

function menuEVatVamQueryDigest() { openSyncDialog('eVatVam', null); }

// ============================================================
// TIME-DRIVEN TRIGGER VÉGPONT
// ============================================================

function eVatVamAutoSync(opts) {
  var tag = 'eVatVamAutoSync';
  if (!opts && shouldSkipTriggerByEndDate(tag)) return;
  var ss  = SpreadsheetApp.getActiveSpreadsheet();
  Logger.log('[' + tag + '] INDULÁS');
  ss.toast('Vámhatározat szinkronizálás indul...', '▶ eÁFA Vám', 5);

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
    ss.toast('Határozat lista letöltése (' + bounds.queryFrom + ' – ' + bounds.queryTo + ')...',
      '⏳ Digest API', 10);
    var rows = eVatVamQueryDigest({
      declarationDateFrom:  bounds.queryFrom,
      declarationDateTo:    bounds.queryTo,
      declarationDirection: 'IMPORTER'
    });
    ss.toast('NAV-tól ' + rows.length + ' határozat megérkezett. Sheet írás...',
      '⏳ Vám mentés', 8);

    var writtenVam = eVatVamWriteDeclarationRows(rows, filter);
    Logger.log('[' + tag + '] Digest KÉSZ. Új sorok: ' + writtenVam + ' / ' + rows.length);
    ss.toast(writtenVam + ' új határozat beírva (' + rows.length + ' közül). Részletek következnek...',
      '✔ Lista kész', 8);

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

  var totalBatches = Math.ceil(pending.length / EVATVAM_BATCH_SIZE);
  Logger.log('[' + tag + '] ' + pending.length + ' határozathoz hiányzik részletes XML (' + totalBatches + ' batch).');
  ss.toast(pending.length + ' db hiányzó vámhatározat részlet letöltése indul (' + totalBatches +
    ' batch, ' + EVATVAM_BATCH_SIZE + '/batch)...', '⏳ Részlet letöltés', 8);

  var ok = 0, fail = 0;
  var batchNo = 0;

  for (var i = 0; i < pending.length; i += EVATVAM_BATCH_SIZE) {
    var chunkKeys    = pending.slice(i, i + EVATVAM_BATCH_SIZE);
    var chunkResults = [];
    batchNo++;

    ss.toast('Batch ' + batchNo + '/' + totalBatches + ' — ' + chunkKeys.length +
      ' határozat XML letöltése NAV-tól...', '⏳ Letöltés', 15);

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

    var processed = Math.min(i + EVATVAM_BATCH_SIZE, pending.length);
    if (chunkResults.length > 0) {
      ss.toast('Batch ' + batchNo + '/' + totalBatches + ' — kiírás sheetbe (' +
        processed + '/' + pending.length + ')...', '⏳ Sheet írás', 15);
      try {
        eVatVamProcessDeclarationDataBatch(chunkResults);
      } catch (e) {
        Logger.log('[' + tag + '] Batch kiírási hiba: ' + e.message);
        ss.toast('Batch ' + batchNo + ' kiírási hiba: ' + e.message, '⚠ Hiba', 8);
      }
    }
    Logger.log('[' + tag + '] Folyamatban: ' + processed + ' / ' + pending.length);
  }

  var summary = 'Vámhatározatok: ' + (wVam > 0 ? wVam + ' új sor, ' : '') + ok + ' részlet letöltve' +
                (fail > 0 ? ', ' + fail + ' hiba (ld. Naplók)' : '') + '.';
  Logger.log('[' + tag + '] ÖSSZEGZÉS: ' + summary);
  ss.toast(summary, '✔ Szinkron kész', 10);
}
