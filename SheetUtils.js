/**
 * SheetUtils.js — Megosztott Google Sheets helperek.
 *
 * Mind az OSA, mind az eVatVam, mind az OPG processzor használja ezeket.
 * Itt a dp* prefix továbbra is megmarad ("data processor"), mert nem
 * OSA-specifikus — a három alrendszer közös igényeit szolgálja ki.
 *
 *   - dpGetOrCreateSheet : sheet lekérése vagy létrehozása
 *   - dpGetHeaderMap     : fejléc → 1-alapú oszlopindex map
 *   - dpGetExistingKeys  : kulcs → sorszám map (upsert duplikáció kiszűréshez)
 *   - dpGetCompositeKeys : két oszlopos összetett kulcs map
 *   - dpBuildRow         : fieldMap alapján sor összeállítás
 *   - dpValidate         : sheet + fejléc létezés ellenőrzés
 *   - getDateBoundaries  : dinamikus dátumhatár-számítás (sheet + Script Properties)
 */

// ============================================================
// SHEET HELPERS
// ============================================================

function dpGetOrCreateSheet(name) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(name);
  if (!sh) sh = ss.insertSheet(name);
  return sh;
}

/**
 * Fejléc → oszlopindex (1-alapú) map.
 * Trim-el, case-sensitive (a sheet fejléceit veszi alapul).
 */
function dpGetHeaderMap(sheet) {
  var lastCol = sheet.getLastColumn();
  if (lastCol < 1) return {};
  var headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
  var map = {};
  for (var i = 0; i < headers.length; i++) {
    var h = String(headers[i]).trim();
    if (h !== '') map[h] = i + 1;
  }
  return map;
}

/**
 * Kulcs → sorszám map (2-tól), adott oszlop értékei alapján.
 */
function dpGetExistingKeys(sheet, keyCol) {
  var last = sheet.getLastRow();
  if (last < 2) return {};
  var vals = sheet.getRange(2, keyCol, last - 1, 1).getValues();
  var keys = {};
  for (var i = 0; i < vals.length; i++) {
    var k = String(vals[i][0]).trim();
    if (k !== '') keys[k] = i + 2;
  }
  return keys;
}

/**
 * Összetett kulcs (col1||col2) → sorszám map.
 */
function dpGetCompositeKeys(sheet, keyCol1, keyCol2) {
  var last = sheet.getLastRow();
  if (last < 2) return {};
  var minCol = Math.min(keyCol1, keyCol2);
  var maxCol = Math.max(keyCol1, keyCol2);
  var vals = sheet.getRange(2, minCol, last - 1, maxCol - minCol + 1).getValues();
  var off = minCol - 1;
  var keys = {};
  for (var i = 0; i < vals.length; i++) {
    var k1 = String(vals[i][keyCol1 - 1 - off]).trim();
    var k2 = String(vals[i][keyCol2 - 1 - off]).trim();
    if (k1 && k2) keys[k1 + '||' + k2] = i + 2;
  }
  return keys;
}

/**
 * Sor értékeit állítja össze a fieldMap alapján.
 * @param {Object}  hMap       fejléc → oszlopindex map
 * @param {number}  totalCols  az eredmény tömb hossza
 * @param {Object}  fieldMap   oszlopnév → function(args) leképező tábla
 * @param {Array}   args       a leképező függvényeknek átadott argumentumok
 * @returns {Array}  totalCols hosszú tömb
 */
function dpBuildRow(hMap, totalCols, fieldMap, args) {
  var row  = new Array(totalCols).fill('');
  var keys = Object.keys(fieldMap);
  for (var i = 0; i < keys.length; i++) {
    var colName = keys[i];
    var colIdx  = hMap[colName];
    if (!colIdx) continue;
    try {
      var val = fieldMap[colName].apply(null, args);
      row[colIdx - 1] = (val == null) ? '' : val;
    } catch(e) {
      Logger.log('[DP BUILD ROW ERROR] ' + colName + ': ' + e.message);
      row[colIdx - 1] = '';
    }
  }
  return row;
}

/**
 * Sheet és kötelező header oszlopok ellenőrzése.
 * requirements: [{ sheet: 'név', headers: ['Számla sorszáma', ...] }, ...]
 * ui (opcionális): SpreadsheetApp.getUi() — ha megadva, hiba esetén alert-et is mutat.
 *
 * @returns {Array<string>}  hiány-üzenetek; üres ha minden rendben.
 */
function dpValidate(requirements, ui) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var issues = [];
  for (var r = 0; r < requirements.length; r++) {
    var req = requirements[r];
    var sh  = ss.getSheetByName(req.sheet);
    if (!sh) {
      issues.push('Hiányzó munkalap: "' + req.sheet + '"');
      continue;
    }
    var hMap = dpGetHeaderMap(sh);
    var missing = [];
    for (var i = 0; i < (req.headers || []).length; i++) {
      var h = req.headers[i];
      if (!hMap[h]) missing.push(h);
    }
    if (missing.length > 0) {
      issues.push('"' + req.sheet + '" lap hiányzó fejléc oszlopok: ' + missing.join(', '));
    }
  }
  if (issues.length > 0) {
    var msg = 'A munkalapok / fejlécek ellenőrzése sikertelen — leállás:\n\n' + issues.join('\n');
    Logger.log('[dpValidate] ' + msg);
    if (ui) {
      try { ui.alert(msg); } catch (e) { /* time-driven contextben nincs UI */ }
    }
  }
  return issues;
}

// ============================================================
// DÁTUMHATÁR-SZÁMÍTÁS
// ============================================================

/**
 * Dinamikus dátumhatárok kiszámítása egy adatkör számára.
 *
 * A könyvelési intervallumot (filterFrom / filterTo) a következő prioritás
 * szerint határozza meg:
 *   filterFrom = max(sheet utolsó dátuma, START_DATE script property) ?? (today - 5 nap)
 *   filterTo   = min(today, END_DATE script property) ?? today
 *
 * Az API lekérdezési ablak (queryFrom / queryTo) mindkét irányban
 * BEFORE_AFTER_EXTRA_DAYS nappal tágabb. Ha ez a property hiányzik,
 * automatikusan létrehozza 30 értékkel.
 *
 * @param {Object} ctx
 *   ctx.sheetName        {string}  a sheet neve, ahonnan az utolsó dátumot kell olvasni
 *   ctx.dateColumnHeader {string}  az oszlop fejléce (pl. 'Számla kelte')
 * @returns {{ filterFrom:string, filterTo:string, queryFrom:string, queryTo:string }}
 *   Minden érték 'yyyy-MM-dd' formátumban.
 */
function getDateBoundaries(ctx) {
  var fmt = function(d) { return Utilities.formatDate(d, 'UTC', 'yyyy-MM-dd'); };
  var parse = function(s) {
    if (!s) return null;
    var d = new Date(s);
    return isNaN(d.getTime()) ? null : d;
  };

  var p = PropertiesService.getScriptProperties();

  var extraRaw = p.getProperty('BEFORE_AFTER_EXTRA_DAYS');
  var extraDays = parseInt(extraRaw, 10);
  if (isNaN(extraDays) || extraDays < 0) {
    extraDays = 30;
    p.setProperty('BEFORE_AFTER_EXTRA_DAYS', '30');
    Logger.log('[getDateBoundaries] BEFORE_AFTER_EXTRA_DAYS hiányzott, létrehozva: 30');
  }

  var startDateProp = parse(p.getProperty('START_DATE'));
  var endDateProp   = parse(p.getProperty('END_DATE'));

  var sheetLastDate = null;
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sh = ss.getSheetByName(ctx.sheetName);
    if (sh && sh.getLastRow() >= 2) {
      var hMap = dpGetHeaderMap(sh);
      var colIdx = hMap[ctx.dateColumnHeader];
      if (colIdx) {
        var vals = sh.getRange(2, colIdx, sh.getLastRow() - 1, 1).getValues();
        for (var i = vals.length - 1; i >= 0; i--) {
          var v = vals[i][0];
          var d = (v instanceof Date) ? v : parse(String(v));
          if (d && !isNaN(d.getTime())) { sheetLastDate = d; break; }
        }
      }
    }
  } catch (e) {
    Logger.log('[getDateBoundaries] Sheet dátum olvasás hiba: ' + e.message);
  }

  var filterFromStr = startDateProp ? fmt(startDateProp) : null;
  var filterToStr   = endDateProp   ? fmt(endDateProp)   : null;

  var today = new Date();
  var defaultQueryFromD = sheetLastDate || startDateProp || new Date(today.getTime() - 5 * 24 * 3600 * 1000);
  var defaultQueryToD   = new Date(today.getTime());

  if (startDateProp) {
    var minQueryFrom = new Date(startDateProp.getTime() - extraDays * 24 * 3600 * 1000);
    if (defaultQueryFromD < minQueryFrom) defaultQueryFromD = minQueryFrom;
  }
  if (endDateProp) {
    var maxQueryTo = new Date(endDateProp.getTime() + extraDays * 24 * 3600 * 1000);
    if (defaultQueryToD > maxQueryTo) defaultQueryToD = maxQueryTo;
  }

  if (defaultQueryFromD > defaultQueryToD) defaultQueryFromD = defaultQueryToD;

  return {
    filterFrom: filterFromStr,
    filterTo:   filterToStr,
    queryFrom:  fmt(defaultQueryFromD),
    queryTo:    fmt(defaultQueryToD)
  };
}
