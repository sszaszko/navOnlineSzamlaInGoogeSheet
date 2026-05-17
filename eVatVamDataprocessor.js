/**
 * eVatVamDataprocessor.js — Vámhatározatok sheet műveletek
 *
 * Felelőssége:
 *   - "Vámhatározatok" sheet létrehozása és fejléc kezelése (EVATVAM_SHEET)
 *   - Digest sorok beírása / upsert (cdpsId alapján)
 *   - Részletes XML tárolása a "Teljes XML" oszlopban
 *   - Mezőleképező tábla (EVATVAM_MEZO_ERTEKEK)
 *
 * NEM tartalmaz: eVatVam API hívások, auth, UI.
 * Függőségei: eVatVamApi.js, SheetUtils.js, Config.js (EVATVAM_SHEET)
 */

// ============================================================
// MEZŐLEKÉPEZŐ TÁBLA
// ============================================================

var EVATVAM_MEZO_ERTEKEK = {
  'Határozat azonosítója':   function(d) { return eVatVamV(d.cdpsId); },
  'Határozatszám':           function(d) { return eVatVamV(d.resolutionId); },
  'Határozat típusa':        function(d) { return eVatVamDeclarationOpHu(d.declarationOperation); },
  'Importőr adószáma':       function(d) { return eVatVamV(d.importerTaxNumber); },
  'Képviselő adószáma':      function(d) { return eVatVamV(d.indirectRepresentativeTaxNumber); },
  'Importőr önadózás':       function(d) { return eVatVamBoolHu(d.importerSelfTaxationIndicator); },
  'Képviselő önadózás':      function(d) { return eVatVamBoolHu(d.indirectRepresentativeSelfTaxationIndicator); },
  'Adóesedékesség':          function(d) { return eVatVamV(d.taxpointDate); },
  'Kézbesítés dátuma':       function(d) { return eVatVamV(d.deliveryDate); },
  'Adóalap (HUF)':           function(d) { return eVatVamNum(d.totalNetAmount); },
  'ÁFA összeg (HUF)':        function(d) { return eVatVamNum(d.totalVatAmount); },
  'Részletek LETÖLTVE':      function(d) { return ''; },
  'Teljes XML':              function(d) { return ''; }
};

// ============================================================
// DÁTUMSZŰRŐ
// ============================================================

/**
 * Megvizsgálja, hogy egy vámhatározat sor belül esik-e a megadott intervallumon.
 * Az 'Adóesedékesség' VAGY a 'Kézbesítés dátuma' mezőt vizsgálja (OR logika).
 * Ha mindkettő üres, a sor átengedésre kerül.
 */
function eVatVamPassesDateFilter(row, filter) {
  if (!filter) return true;

  var from  = filter.filterFrom ? new Date(filter.filterFrom) : null;
  var to    = filter.filterTo   ? new Date(filter.filterTo)   : null;
  var parse = function(s) {
    if (!s) return null;
    var d = new Date(s);
    return isNaN(d.getTime()) ? null : d;
  };
  var inRange = function(d) {
    if (!d) return false;
    if (from && d < from) return false;
    if (to   && d > to)   return false;
    return true;
  };

  var taxpoint = parse(row.taxpointDate);
  var delivery = parse(row.deliveryDate);
  var issue    = parse(row.issueDate);

  if (taxpoint !== null || delivery !== null) return inRange(taxpoint) || inRange(delivery);
  if (issue    !== null)                      return inRange(issue);
  return true;
}

// ============================================================
// SHEET INICIALIZÁLÁS
// ============================================================

function eVatVamEnsureSheet() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(EVATVAM_SHEET);
  if (!sh) {
    sh = ss.insertSheet(EVATVAM_SHEET);
    var headers = Object.keys(EVATVAM_MEZO_ERTEKEK);
    sh.getRange(1, 1, 1, headers.length).setValues([headers]);
    sh.getRange(1, 1, 1, headers.length)
      .setFontWeight('bold')
      .setBackground('#d9ead3');
    sh.setFrozenRows(1);
  }
  return sh;
}

// ============================================================
// DIGEST SOROK BEÍRÁSA
// ============================================================

/**
 * Digest sor lista beírása / upsert a EVATVAM_SHEET sheetbe.
 * Elsődleges kulcs: "Határozat azonosítója" (cdpsId).
 * Meglévő sorok frissülnek, újak hozzáfűzésre kerülnek.
 *
 * @param {Array<Object>} rows
 * @param {Object}        [filter]  { filterFrom, filterTo } — csak új soroknál alkalmazzuk
 * @returns {number}  hány új sort írt be
 */
function eVatVamWriteDeclarationRows(rows, filter) {
  if (!rows || rows.length === 0) return 0;

  var sh      = eVatVamEnsureSheet();
  var headers = Object.keys(EVATVAM_MEZO_ERTEKEK);
  var hMap    = dpGetHeaderMap(sh);

  var idColIdx = hMap['Határozat azonosítója'];
  if (!idColIdx) throw new Error('"Határozat azonosítója" fejléc nem található a ' + EVATVAM_SHEET + ' sheetben.');

  var lastRow     = sh.getLastRow();
  var existingIds = {};
  if (lastRow >= 2) {
    var idVals = sh.getRange(2, idColIdx, lastRow - 1, 1).getValues();
    for (var i = 0; i < idVals.length; i++) {
      var id = String(idVals[i][0]).trim();
      if (id) existingIds[id] = i + 2;
    }
  }

  var newRows = 0, skipped = 0;

  for (var r = 0; r < rows.length; r++) {
    var d      = rows[r];
    var cdpsId = String(d.cdpsId || '').trim();
    if (!cdpsId) continue;

    var rowData = headers.map(function(h) {
      return EVATVAM_MEZO_ERTEKEK[h] ? EVATVAM_MEZO_ERTEKEK[h](d) : '';
    });

    if (existingIds.hasOwnProperty(cdpsId)) {
      var existingRow   = existingIds[cdpsId];
      var dlColIdx      = hMap['Részletek LETÖLTVE'];
      var xmlColIdx     = hMap['Teljes XML'];
      var existingRange = sh.getRange(existingRow, 1, 1, headers.length);
      var existingVals  = existingRange.getValues()[0];
      if (dlColIdx)  rowData[dlColIdx  - 1] = existingVals[dlColIdx  - 1];
      if (xmlColIdx) rowData[xmlColIdx - 1] = existingVals[xmlColIdx - 1];
      existingRange.setValues([rowData]);
    } else {
      if (filter && !eVatVamPassesDateFilter(d, filter)) { skipped++; continue; }
      sh.appendRow(rowData);
      existingIds[cdpsId] = sh.getLastRow();
      newRows++;
    }
  }

  if (skipped > 0) {
    Logger.log('[eVatVamWriteDeclarationRows] Dátumszűrő: ' + skipped + ' sor kihagyva (' +
               (filter.filterFrom || 'N/A') + ' – ' + (filter.filterTo || 'N/A') + ').');
  }
  return newRows;
}

// ============================================================
// RÉSZLETES XML TÁROLÁSA
// ============================================================

/**
 * QueryCustomsDeclarationTaxCode raw XML-t tárolja a sheetben.
 * @param {Object} result  { cdpsId, resolutionId, rawXml }
 */
function eVatVamWriteDeclarationDetail(result) {
  var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(EVATVAM_SHEET);
  if (!sh) throw new Error('"' + EVATVAM_SHEET + '" sheet nem található.');

  var hMap      = dpGetHeaderMap(sh);
  var idColIdx  = hMap['Határozat azonosítója'];
  var dlColIdx  = hMap['Részletek LETÖLTVE'];
  var xmlColIdx = hMap['Teljes XML'];
  if (!idColIdx || !dlColIdx || !xmlColIdx) {
    throw new Error('Szükséges fejlécek hiányoznak a ' + EVATVAM_SHEET + ' sheetből.');
  }

  var lastRow = sh.getLastRow();
  if (lastRow < 2) return;

  var cdpsId = String(result.cdpsId || '').trim();
  var idVals = sh.getRange(2, idColIdx, lastRow - 1, 1).getValues();
  for (var i = 0; i < idVals.length; i++) {
    if (String(idVals[i][0]).trim() === cdpsId) {
      var targetRow = i + 2;
      sh.getRange(targetRow, dlColIdx).setValue(
        Utilities.formatDate(new Date(), 'Europe/Budapest', 'yyyy-MM-dd HH:mm')
      );
      sh.getRange(targetRow, xmlColIdx).setValue(result.rawXml || '');
      return;
    }
  }
}

// ============================================================
// BATCH FELDOLGOZÓ
// ============================================================

function eVatVamProcessDeclarationDataBatch(resultsArray) {
  if (!resultsArray || resultsArray.length === 0) return;
  var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(EVATVAM_SHEET);
  if (!sh) return;

  var hMap      = dpGetHeaderMap(sh);
  var idColIdx  = hMap['Határozat azonosítója'];
  var dlColIdx  = hMap['Részletek LETÖLTVE'];
  var xmlColIdx = hMap['Teljes XML'];
  if (!idColIdx || !dlColIdx || !xmlColIdx) return;

  var lastRow = sh.getLastRow();
  if (lastRow < 2) return;
  var totCols = sh.getLastColumn() || Object.keys(hMap).length;

  var data     = sh.getRange(2, 1, lastRow - 1, totCols).getValues();
  var indexMap = {};
  for (var k = 0; k < data.length; k++) {
    var num = String(data[k][idColIdx - 1]).trim();
    if (num) indexMap[num] = k;
  }

  var modified = false;
  for (var i = 0; i < resultsArray.length; i++) {
    var res = resultsArray[i];
    if (!res || !res.cdpsId) continue;
    var rowIdx = indexMap[res.cdpsId];
    if (rowIdx === undefined) continue;
    data[rowIdx][xmlColIdx - 1] = res.rawXml || 'n/a';
    data[rowIdx][dlColIdx  - 1] = Utilities.formatDate(new Date(), 'Europe/Budapest', 'yyyy-MM-dd HH:mm:ss');
    modified = true;
  }

  if (modified) sh.getRange(2, 1, lastRow - 1, totCols).setValues(data);
}

// ============================================================
// ÉRTÉKKONVERZIÓK
// ============================================================

function eVatVamV(v)   { return (v === undefined || v === null) ? '' : String(v).trim(); }
function eVatVamNum(v) { var n = parseFloat(String(v || '').replace(',', '.')); return isNaN(n) ? '' : n; }

function eVatVamBoolHu(v) {
  var s = String(v || '').trim().toLowerCase();
  if (s === 'true'  || s === '1') return 'Igen';
  if (s === 'false' || s === '0') return 'Nem';
  return '';
}

function eVatVamDeclarationOpHu(v) {
  var m = { 'CREATE': 'Alaphatározat', 'MODIFY': 'Módosító határozat' };
  return m[String(v || '').trim().toUpperCase()] || eVatVamV(v);
}
