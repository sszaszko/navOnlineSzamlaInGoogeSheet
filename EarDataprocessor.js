/**
 * EarDataprocessor.gs — Vámhatározatok sheet műveletek
 *
 * Felelőssége:
 *   - "Vámhatározatok" sheet létrehozása és fejléc kezelése
 *   - Digest sorok beírása / upsert (cdpsId alapján)
 *   - Részletes XML tárolása a "Teljes XML" oszlopban
 *   - Mezőleképező tábla (VAM_MEZO_ERTEKEK)
 *
 * NEM tartalmaz: eÁFA API hívások, auth, UI.
 * Függőségei: EarApi.gs, NavApi.gs (dpGetHeaderMap reuse)
 */

// ============================================================
// KONSTANSOK
// ============================================================

var SHEET_VAM = 'Vámhatározatok';

// ============================================================
// MEZŐLEKÉPEZŐ TÁBLA
// ============================================================

/**
 * "Vámhatározatok" sheet oszlopainak sorrendje és leképezése.
 * Kulcs = fejléc szövege, érték = function(digestRow) → cellaérték.
 */
var VAM_MEZO_ERTEKEK = {
  'Határozat azonosítója':            function(d) { return earv(d.cdpsId); },
  'Határozatszám':                    function(d) { return earv(d.resolutionId); },
  'Határozat típusa':                 function(d) { return earDeclarationOpHu(d.declarationOperation); },
  'Importőr adószáma':                function(d) { return earv(d.importerTaxNumber); },
  'Képviselő adószáma':               function(d) { return earv(d.indirectRepresentativeTaxNumber); },
  'Importőr önadózás':                function(d) { return earBoolHu(d.importerSelfTaxationIndicator); },
  'Képviselő önadózás':               function(d) { return earBoolHu(d.indirectRepresentativeSelfTaxationIndicator); },
  'Adóesedékesség':                   function(d) { return earv(d.taxpointDate); },
  'Kézbesítés dátuma':                function(d) { return earv(d.deliveryDate); },
  'Adóalap (HUF)':                    function(d) { return earNum(d.totalNetAmount); },
  'ÁFA összeg (HUF)':                 function(d) { return earNum(d.totalVatAmount); },
  'Részletek LETÖLTVE':               function(d) { return ''; },
  'Teljes XML':                       function(d) { return ''; }
};

// ============================================================
// SHEET INICIALIZÁLÁS
// ============================================================

function earEnsureSheet() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(SHEET_VAM);
  if (!sh) {
    sh = ss.insertSheet(SHEET_VAM);
    var headers = Object.keys(VAM_MEZO_ERTEKEK);
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
 * Digest sor lista beírása / upsert a "Vámhatározatok" sheetbe.
 * Elsődleges kulcs: "Határozat azonosítója" (cdpsId).
 * Meglévő sorok frissülnek, újak hozzáfűzésre kerülnek.
 *
 * @param {Array<Object>} rows  — earDeclarationDigestToObject() outputja
 * @returns {number}  hány új sort írt be (frissítés nem számít)
 */
function earWriteDeclarationRows(rows) {
  if (!rows || rows.length === 0) return 0;

  var sh = earEnsureSheet();
  var headers = Object.keys(VAM_MEZO_ERTEKEK);
  var hMap = dpGetHeaderMap(sh);

  var idColIdx = hMap['Határozat azonosítója'];
  if (!idColIdx) throw new Error('"Határozat azonosítója" fejléc nem található a ' + SHEET_VAM + ' sheetben.');

  // Meglévő cdpsId-k beolvasása
  var lastRow = sh.getLastRow();
  var existingIds = {};
  if (lastRow >= 2) {
    var idVals = sh.getRange(2, idColIdx, lastRow - 1, 1).getValues();
    for (var i = 0; i < idVals.length; i++) {
      var id = String(idVals[i][0]).trim();
      if (id) existingIds[id] = i + 2; // 1-alapú sor index
    }
  }

  var newRows = 0;

  for (var r = 0; r < rows.length; r++) {
    var d = rows[r];
    var cdpsId = String(d.cdpsId || '').trim();
    if (!cdpsId) continue;

    var rowData = headers.map(function(h) {
      var fn = VAM_MEZO_ERTEKEK[h];
      return fn ? fn(d) : '';
    });

    if (existingIds.hasOwnProperty(cdpsId)) {
      var existingRow = existingIds[cdpsId];
      // Frissítés: "Részletek LETÖLTVE" és "Teljes XML" megőrzése
      var dlColIdx  = hMap['Részletek LETÖLTVE'];
      var xmlColIdx = hMap['Teljes XML'];

      var existingRange = sh.getRange(existingRow, 1, 1, headers.length);
      var existingVals  = existingRange.getValues()[0];

      // Csak a digest mezőket írjuk felül; detail mezőket megtartjuk
      if (dlColIdx)  rowData[dlColIdx  - 1] = existingVals[dlColIdx  - 1];
      if (xmlColIdx) rowData[xmlColIdx - 1]  = existingVals[xmlColIdx - 1];

      existingRange.setValues([rowData]);
    } else {
      sh.appendRow(rowData);
      existingIds[cdpsId] = sh.getLastRow();
      newRows++;
    }
  }

  return newRows;
}

// ============================================================
// RÉSZLETES XML TÁROLÁSA
// ============================================================

/**
 * A queryCustomsDeclarationTaxCode raw XML válaszát tárolja el
 * a megfelelő sorban ("Teljes XML" oszlop), és bejelöli "Részletek LETÖLTVE" = mai dátum.
 *
 * @param {Object} result  — { cdpsId, resolutionId, rawXml }
 */
function earWriteDeclarationDetail(result) {
  var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_VAM);
  if (!sh) throw new Error('"' + SHEET_VAM + '" sheet nem található.');

  var hMap = dpGetHeaderMap(sh);
  var idColIdx  = hMap['Határozat azonosítója'];
  var dlColIdx  = hMap['Részletek LETÖLTVE'];
  var xmlColIdx = hMap['Teljes XML'];

  if (!idColIdx || !dlColIdx || !xmlColIdx) {
    throw new Error('Szükséges fejlécek hiányoznak a ' + SHEET_VAM + ' sheetből.');
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
// ÉRTÉKKONVERZIÓK
// ============================================================

function earv(v)   { return (v === undefined || v === null) ? '' : String(v).trim(); }
function earNum(v) { var n = parseFloat(String(v || '').replace(',', '.')); return isNaN(n) ? '' : n; }

function earBoolHu(v) {
  var s = String(v || '').trim().toLowerCase();
  if (s === 'true' || s === '1')  return 'Igen';
  if (s === 'false' || s === '0') return 'Nem';
  return '';
}

function earDeclarationOpHu(v) {
  var m = { 'CREATE': 'Alaphatározat', 'MODIFY': 'Módosító határozat' };
  return m[String(v || '').trim().toUpperCase()] || earv(v);
}
