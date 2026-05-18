/**
 * OsaProcessor.js — OSA sheet műveletek és adatfeldolgozás.
 *
 * Felelőssége:
 *   - Fejléc adatok sheet: digest → sor leképezés + upsert
 *   - Tétel adatok sheet:  invoiceXml → sorok + upsert
 *   - "Tételek LETÖLTVE" visszajelzés a Fejléc adatok sheetbe
 *   - Invoice XML parser (tételek + root elem kinyerése)
 *   - Batch processor (osaProcessInvoiceDataBatch) — optimalizált tömeges kiírás
 *   - osaPassesDateFilter — könyvelési dátum szűrő
 *
 * Megosztott: SheetUtils.js (dpGetHeaderMap, dpGetExistingKeys, dpBuildRow),
 *             NavXmlUtils.js (navFindFirst, navFindAll, navXmlText, navXmlFlatten),
 *             OsaFieldMaps.js (osaDirCfg + mezőleképezők),
 *             OsaFormatters.js (osaV stb.).
 */

// ============================================================
// ADATSZŰRŐ — könyvelési dátum
// ============================================================

/**
 * Megvizsgálja, hogy egy sor könyvelési szempontból belül esik-e a megadott
 * intervallumon (filterFrom..filterTo, határok részei).
 *
 * Számlák esetén a 'Teljesítés dátuma' VAGY az 'Adóesedékesség' mezőt nézi
 * (OR logika: elég az egyiknek belülre esnie).
 * Ha mindkét dátummező üres, a sor átengedésre kerül (biztonságos oldal).
 *
 * @param {Object} digestRow  osaQueryInvoiceDigest() egy sora
 * @param {Object} filter     { filterFrom: 'yyyy-MM-dd', filterTo: 'yyyy-MM-dd' } vagy null
 * @returns {boolean}  true = beírható
 */
function osaPassesDateFilter(digestRow, filter) {
  if (!filter) return true;

  var from = filter.filterFrom ? new Date(filter.filterFrom) : null;
  var to   = filter.filterTo   ? new Date(filter.filterTo)   : null;

  var parse = function(s) {
    if (!s) return null;
    var d = new Date(s);
    return isNaN(d.getTime()) ? null : d;
  };
  var inRange = function(d) {
    if (!d) return false;
    if (from && d < from) return false;
    if (to && d > to) return false;
    return true;
  };

  var delivery = parse(digestRow.invoiceDeliveryDate);  // Teljesítés dátuma
  var taxpoint = parse(digestRow.paymentDate);          // Adóesedékesség / Fizetési határidő
  var issue    = parse(digestRow.invoiceIssueDate);     // Számla kelte

  if (delivery !== null || taxpoint !== null) {
    return inRange(delivery) || inRange(taxpoint);
  }
  if (issue !== null) {
    return inRange(issue);
  }
  return true;
}

// ============================================================
// SHEET ÍRÓK — publikus API az OsaSync.js számára
// ============================================================

/**
 * Digest sorok upsert-je a Fejléc adatok sheetbe.
 * Kulcs: "Számla sorszáma" — létező kulcsú sort nem ír felül.
 *
 * @param {Array}   digestRows  osaQueryInvoiceDigest() eredménye
 * @param {string}  direction   'INBOUND' | 'OUTBOUND'
 * @param {Object}  [filter]    Opcionális könyvelési szűrő.
 * @returns {number}  újonnan beírt sorok száma
 */
function osaWriteFejlecRows(digestRows, direction, filter) {
  if (!digestRows || digestRows.length === 0) return 0;
  var cfg = osaDirCfg(direction);

  var sh       = dpGetOrCreateSheet(cfg.sheetFejlec);
  var hMap     = dpGetHeaderMap(sh);
  var keyCol   = hMap['Számla sorszáma'];
  if (!keyCol) {
    throw new Error('"Számla sorszáma" fejléc nem található a "' + cfg.sheetFejlec + '" sheetben.');
  }

  var totalCols = sh.getLastColumn() || Object.keys(hMap).length;
  var existing  = dpGetExistingKeys(sh, keyCol);
  var newRows   = [];
  var skipped   = 0;

  for (var i = 0; i < digestRows.length; i++) {
    var d   = digestRows[i];
    var key = osaV(d.invoiceNumber);
    if (!key || existing[key]) continue;

    if (filter && !osaPassesDateFilter(d, filter)) {
      skipped++;
      continue;
    }

    var row = dpBuildRow(hMap, totalCols, cfg.fejlecMap, [d]);
    newRows.push(row);
    existing[key] = true;
  }

  if (skipped > 0) {
    Logger.log('[osaWriteFejlecRows] Dátumszűrő: ' + skipped + ' sor kihagyva (kívül esik ' +
               (filter.filterFrom || 'N/A') + ' – ' + (filter.filterTo || 'N/A') + ' intervallumon).');
  }
  if (newRows.length > 0) {
    sh.getRange(sh.getLastRow() + 1, 1, newRows.length, totalCols).setValues(newRows);
  }
  return newRows.length;
}

/**
 * Tétel sorok upsert-je a Tétel adatok sheetbe.
 * Kulcs: "Számla sorszáma" + "Tétel sorszáma".
 */
function osaWriteTetelRows(invoiceDataResult, direction) {
  if (!invoiceDataResult || !invoiceDataResult.invoiceXml) return 0;
  var cfg = osaDirCfg(direction);

  var sh    = dpGetOrCreateSheet(cfg.sheetTetel);
  var hMap  = dpGetHeaderMap(sh);
  var totalCols = sh.getLastColumn() || Object.keys(hMap).length;

  var keyCol1 = hMap['Számla sorszáma'];
  var keyCol2 = hMap['Tétel sorszáma'];
  if (!keyCol1 || !keyCol2) {
    throw new Error('"Számla sorszáma" vagy "Tétel sorszáma" fejléc hiányzik a "' + cfg.sheetTetel + '" sheetből.');
  }

  var compositeKeys = dpGetCompositeKeys(sh, keyCol1, keyCol2);
  var lines         = osaParseInvoiceLines(invoiceDataResult.invoiceXml);
  var invNum        = invoiceDataResult.invoiceNumber;
  var newRows       = [];

  for (var i = 0; i < lines.length; i++) {
    var lineEl = lines[i].lineEl;
    var headEl = lines[i].headEl;
    var lineNum   = navXmlText(lineEl, 'lineNumber');
    var compKey   = invNum + '||' + lineNum;
    if (compositeKeys[compKey]) continue;

    var row = dpBuildRow(hMap, totalCols, cfg.tetelMap, [invNum, lineEl, headEl, lines[i].rootEl]);
    newRows.push(row);
    compositeKeys[compKey] = true;
  }

  if (newRows.length > 0) {
    sh.getRange(sh.getLastRow() + 1, 1, newRows.length, totalCols).setValues(newRows);
  }
  return newRows.length;
}

/**
 * A Fejléc adatok sheet hiányzó (invoiceData-ból jövő) mezőinek visszatöltése
 * az invoice XML alapján, valamint a "Tételek LETÖLTVE" mező kitöltése.
 */
function osaUpdateFejlecFromInvoiceXml(invoiceDataResult, direction) {
  if (!invoiceDataResult || !invoiceDataResult.invoiceXml) return;
  var cfg = osaDirCfg(direction);

  var sh     = dpGetOrCreateSheet(cfg.sheetFejlec);
  var hMap   = dpGetHeaderMap(sh);
  var keyCol = hMap['Számla sorszáma'];
  var dlCol  = hMap['Tételek LETÖLTVE'];
  if (!keyCol) return;

  var existing = dpGetExistingKeys(sh, keyCol);
  var rowNum   = existing[invoiceDataResult.invoiceNumber];
  if (!rowNum) return;

  var rootEl = osaParseInvoiceRoot(invoiceDataResult.invoiceXml);
  if (!rootEl) return;
  var headEl = navFindFirst(rootEl, 'invoiceHead') || rootEl;

  var currentRow = sh.getRange(rowNum, 1, 1, sh.getLastColumn()).getValues()[0];

  var fieldNames = Object.keys(cfg.fejlecInvoicedataMap);
  for (var i = 0; i < fieldNames.length; i++) {
    var colName = fieldNames[i];
    var colIdx  = hMap[colName];
    if (!colIdx) continue;

    var currentVal = String(currentRow[colIdx - 1]).trim();
    if (currentVal !== '' && currentVal !== 'n/a') continue;

    try {
      var newVal = cfg.fejlecInvoicedataMap[colName](headEl, rootEl);
      if (newVal !== '' && newVal != null) {
        sh.getRange(rowNum, colIdx).setValue(newVal);
      }
    } catch(e) {
      Logger.log('osaUpdateFejlecFromInvoiceXml hiba [' + colName + ']: ' + e.message);
    }
  }

  if (dlCol) {
    sh.getRange(rowNum, dlCol).setValue(
      Utilities.formatDate(new Date(), 'Europe/Budapest', 'yyyy-MM-dd HH:mm:ss')
    );
  }
}

/**
 * Tétel sheet üres "Számla kelte" celláinak backfill-je az invoice XML alapján.
 */
function osaUpdateTetelekFromInvoiceXml(invoiceDataResult, direction) {
  if (!invoiceDataResult || !invoiceDataResult.invoiceXml) return;
  var cfg = osaDirCfg(direction);

  var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(cfg.sheetTetel);
  if (!sh) return;

  var hMap    = dpGetHeaderMap(sh);
  var keyCol  = hMap['Számla sorszáma'];
  var dateCol = hMap['Számla kelte'];
  if (!keyCol || !dateCol) return;

  var lastRow = sh.getLastRow();
  if (lastRow < 2) return;

  var rootEl = osaParseInvoiceRoot(invoiceDataResult.invoiceXml);
  if (!rootEl) return;
  var headEl    = navFindFirst(rootEl, 'invoiceHead') || rootEl;
  var issueDate = navXmlText(rootEl, 'invoiceIssueDate') || navXmlText(headEl, 'invoiceIssueDate');
  if (!issueDate) return;

  var invNum = String(invoiceDataResult.invoiceNumber || '').trim();
  if (!invNum) return;

  var data = sh.getRange(2, 1, lastRow - 1, sh.getLastColumn()).getValues();
  for (var i = 0; i < data.length; i++) {
    var rowInvNum = String(data[i][keyCol - 1]).trim();
    if (rowInvNum !== invNum) continue;
    var currVal = String(data[i][dateCol - 1]).trim();
    if (currVal && currVal !== 'n/a') continue;
    sh.getRange(i + 2, dateCol).setValue(issueDate);
  }
}

// ============================================================
// INVOICE XML PARSER
// ============================================================

/**
 * Invoice XML string-ből kinyeri az összes tételt és az invoiceHead elemet.
 * @returns {Array<{lineEl: XmlElement, headEl: XmlElement, rootEl: XmlElement}>}
 */
function osaParseInvoiceLines(invoiceXml) {
  if (!invoiceXml) return [];
  try {
    var doc    = XmlService.parse(invoiceXml);
    var root   = doc.getRootElement();
    var lines  = navFindAll(root, 'line');
    var headEl = navFindFirst(root, 'invoiceHead') || root;
    return lines.map(function(l) { return { lineEl: l, headEl: headEl, rootEl: root }; });
  } catch(e) {
    Logger.log('osaParseInvoiceLines XML parse hiba: ' + e.message);
    return [];
  }
}

/**
 * Invoice XML string-ből kinyeri a root elemet.
 * @returns {XmlElement|null}
 */
function osaParseInvoiceRoot(invoiceXml) {
  if (!invoiceXml) return null;
  try {
    var doc  = XmlService.parse(invoiceXml);
    return doc.getRootElement();
  } catch(e) {
    Logger.log('osaParseInvoiceRoot XML parse hiba: ' + e.message);
    return null;
  }
}

// ============================================================
// BATCH FELDOLGOZÓ
// ============================================================

/**
 * BATCH feldolgozó a hiányzó tételek letöltésének felgyorsításához.
 *
 * @param {Array}        resultsArray  osaQueryInvoiceDataBatch() eredménye
 * @param {string}       direction     'INBOUND' | 'OUTBOUND'
 * @param {Object|null}  cachedState   Előző batch-től megőrzött állapot (null = első hívás).
 *                                     Tartalmazza: fejSh, tetSh, hMapTet, hMapFej, totTetCols,
 *                                     totFejCols, tetKey1, tetKey2, fejKey, fejDl,
 *                                     compositeKeys, fejData, fejIndexMap
 * @returns {Object}  Frissített cachedState a következő batch-nek.
 *
 * Optimalizálások:
 *   - cachedState: fejlec/tetel adatok egyszer olvasódnak be az első batch-nél,
 *     ezután batch-ek között memóriában maradnak (nincs ismételt getValues()).
 *   - navXmlFlatten(lineEl): XmlElement DFS helyett O(1) plain-object lookup
 *     a tétel-sorok összeállításakor — a bridge-hívások száma N×oszlop→1/sor.
 */
function osaProcessInvoiceDataBatch(resultsArray, direction, cachedState) {
  var tag = '[osaProcessInvoiceDataBatch]';
  var t0 = Date.now();
  if (!resultsArray || resultsArray.length === 0) return cachedState;
  var cfg = osaDirCfg(direction);

  // ── Sheet handle-ek (cache-ből vagy frissen) ──────────────────────────────
  var fejSh = cachedState ? cachedState.fejSh : dpGetOrCreateSheet(cfg.sheetFejlec);
  var tetSh = cachedState ? cachedState.tetSh : dpGetOrCreateSheet(cfg.sheetTetel);

  // ── Fejléc map-ok (állandók, cache-ből vagy egyszer betöltve) ─────────────
  var hMapTet    = cachedState ? cachedState.hMapTet    : dpGetHeaderMap(tetSh);
  var totTetCols = cachedState ? cachedState.totTetCols : (tetSh.getLastColumn() || Object.keys(hMapTet).length);
  var tetKey1    = cachedState ? cachedState.tetKey1    : hMapTet['Számla sorszáma'];
  var tetKey2    = cachedState ? cachedState.tetKey2    : hMapTet['Tétel sorszáma'];

  var hMapFej    = cachedState ? cachedState.hMapFej    : dpGetHeaderMap(fejSh);
  var totFejCols = cachedState ? cachedState.totFejCols : (fejSh.getLastColumn() || Object.keys(hMapFej).length);
  var fejKey     = cachedState ? cachedState.fejKey     : hMapFej['Számla sorszáma'];
  var fejDl      = cachedState ? cachedState.fejDl      : hMapFej['Tételek LETÖLTVE'];

  if (!tetKey1 || !tetKey2) throw new Error('Hiányzó fejléc a Tételek lapon.');
  if (!fejKey || !fejDl) throw new Error('Hiányzó fejléc a Fejléc lapon.');

  Logger.log(tag + ' INDUL: ' + resultsArray.length + ' eredmény | fejSh=' + cfg.sheetFejlec +
    ' (' + fejSh.getLastRow() + ' sor, ' + totFejCols + ' oszlop)' +
    ' | tetSh=' + cfg.sheetTetel + ' (' + tetSh.getLastRow() + ' sor, ' + totTetCols + ' oszlop)');

  // 1. Meglévő tétel-kulcsok (cache-ből vagy egyszer betöltve)
  var compositeKeys;
  if (cachedState && cachedState.compositeKeys) {
    compositeKeys = cachedState.compositeKeys;
    Logger.log(tag + ' CompositeKeys cache-ből: ' + Object.keys(compositeKeys).length +
      ' tétel (' + (Date.now() - t0) + 'ms)');
  } else {
    compositeKeys = dpGetCompositeKeys(tetSh, tetKey1, tetKey2);
    Logger.log(tag + ' CompositeKeys betöltve: ' + Object.keys(compositeKeys).length +
      ' meglévő tétel (' + (Date.now() - t0) + 'ms)');
  }

  // 2. Fejlécek (cache-ből vagy egyszer betöltve)
  var fejData, fejIndexMap;
  if (cachedState && cachedState.fejData) {
    fejData     = cachedState.fejData;
    fejIndexMap = cachedState.fejIndexMap;
    Logger.log(tag + ' Fejléc lap cache-ből: ' + fejData.length + ' sor (' + (Date.now() - t0) + 'ms)');
  } else {
    var lastFejRow = fejSh.getLastRow();
    fejData = (lastFejRow >= 2)
      ? fejSh.getRange(2, 1, lastFejRow - 1, totFejCols).getValues()
      : [];
    fejIndexMap = {};
    for (var k = 0; k < fejData.length; k++) {
      var num = String(fejData[k][fejKey - 1]).trim();
      if (num) fejIndexMap[num] = k;
    }
    Logger.log(tag + ' Fejléc lap olvasva: ' + fejData.length + ' sor (' + (Date.now() - t0) + 'ms)');
  }

  // 3. Egyetlen ciklus: minden XML-t csak egyszer parszolunk, tétel + fejléc egyszerre
  var newTetelRows = [];
  var modifiedFejRows = [];
  var xmlOk = 0, xmlNull = 0, markedNA = 0;
  var now = Utilities.formatDate(new Date(), 'Europe/Budapest', 'yyyy-MM-dd HH:mm:ss');

  for (var i = 0; i < resultsArray.length; i++) {
    var res = resultsArray[i];
    if (!res) continue;
    var invNum = res.invoiceNumber;
    var rowIdx = fejIndexMap[invNum];

    if (!res.invoiceXml) {
      xmlNull++;
      // HTTP 400 / nem letölthető (pl. PAPÍR számla) → n/a jelölés, ne próbálja újra
      if (rowIdx !== undefined) {
        var dlCheck = String(fejData[rowIdx][fejDl - 1]).trim();
        if (dlCheck === '' || dlCheck === 'n/a') {
          fejData[rowIdx][fejDl - 1] = 'n/a';
          modifiedFejRows.push({ sheetRow: rowIdx + 2, data: fejData[rowIdx] });
          markedNA++;
        }
      }
      continue;
    }

    var tXml = Date.now();
    var rootObj;
    try {
      var doc = XmlService.parse(res.invoiceXml);
      // EGYETLEN bridge-bejárás: XmlElement-fa → plain JS objektum. Innentől minden
      // navFindFirst / navFindAll / navXmlText / osaResolveAmounts hívás pure JS,
      // nulla JS↔Java bridge-overhead — ez a kritikus optimalizáció sok-tételes számlákhoz.
      rootObj = navElementToObject(doc.getRootElement());
    } catch(e) {
      Logger.log(tag + ' XML parse hiba [' + invNum + ']: ' + e.message);
      xmlNull++;
      continue;
    }
    xmlOk++;
    var headObj = navFindFirst(rootObj, 'invoiceHead') || rootObj;
    var lineObjs = navFindAll(rootObj, 'line');
    Logger.log(tag + ' XML[' + invNum + '] parsz: ' + lineObjs.length + ' sor, parse+conv=' + (Date.now() - tXml) + 'ms');

    // 3a. Tételsorok — minden lineObj már plain JS, a field map navXmlText hívásai
    //     polimorfan kulcs-alapú DFS-szel mennek (bridge nélkül).
    for (var j = 0; j < lineObjs.length; j++) {
      var lineObj = lineObjs[j];
      var lineNum = navXmlText(lineObj, 'lineNumber');
      var compKey = invNum + '||' + lineNum;
      if (compositeKeys[compKey]) continue;
      var row = dpBuildRow(hMapTet, totTetCols, cfg.tetelMap, [invNum, lineObj, headObj, rootObj]);
      newTetelRows.push(row);
      compositeKeys[compKey] = true;
    }

    // 3b. Fejléc frissítés — headObj és rootObj is plain JS, a fejlecInvoicedataMap
    //     navFindAll/navXmlText hívásai polimorfan működnek.
    if (rowIdx !== undefined) {
      var currentRow = fejData[rowIdx];
      var dlVal = String(currentRow[fejDl - 1]).trim();
      if (dlVal === '' || dlVal === 'n/a') {
        var fldNames = Object.keys(cfg.fejlecInvoicedataMap);
        for (var fi = 0; fi < fldNames.length; fi++) {
          var colName = fldNames[fi];
          var colIdx = hMapFej[colName];
          if (!colIdx) continue;
          var existingVal = String(currentRow[colIdx - 1]).trim();
          if (existingVal !== '' && existingVal !== 'n/a') continue;
          try {
            var newVal = cfg.fejlecInvoicedataMap[colName](headObj, rootObj);
            if (newVal !== '' && newVal != null) {
              currentRow[colIdx - 1] = newVal;
            }
          } catch(e) {
            Logger.log(tag + ' fejléc [' + colName + ']: ' + e.message);
          }
        }
        currentRow[fejDl - 1] = now;
        modifiedFejRows.push({ sheetRow: rowIdx + 2, data: currentRow });
      }
    }
  }

  Logger.log(tag + ' Feldolgozás kész: ' + xmlOk + ' OK, ' + xmlNull + ' null, ' +
    newTetelRows.length + ' új tétel, ' + modifiedFejRows.length + ' fejléc változott' +
    ' (' + markedNA + ' n/a) (' + (Date.now() - t0) + 'ms)');

  // 4. Csak a módosított fejléc-sorokat írja vissza (nem az egész lapot)
  if (modifiedFejRows.length > 0) {
    modifiedFejRows.sort(function(a, b) { return a.sheetRow - b.sheetRow; });
    var writeStart = 0;
    var writtenBlocks = 0;
    while (writeStart < modifiedFejRows.length) {
      var writeEnd = writeStart;
      while (writeEnd + 1 < modifiedFejRows.length &&
             modifiedFejRows[writeEnd + 1].sheetRow === modifiedFejRows[writeEnd].sheetRow + 1) {
        writeEnd++;
      }
      var blockData = [];
      for (var b = writeStart; b <= writeEnd; b++) blockData.push(modifiedFejRows[b].data);
      fejSh.getRange(modifiedFejRows[writeStart].sheetRow, 1, blockData.length, totFejCols).setValues(blockData);
      writtenBlocks++;
      writeStart = writeEnd + 1;
    }
    Logger.log(tag + ' Fejléc visszaírva: ' + modifiedFejRows.length + ' sor, ' +
      writtenBlocks + ' blokkban (' + (Date.now() - t0) + 'ms)');
  }

  // 5. Új tételsorok hozzáfűzése
  if (newTetelRows.length > 0) {
    Logger.log(tag + ' Tételsorok írása: ' + newTetelRows.length + ' sor...');
    tetSh.getRange(tetSh.getLastRow() + 1, 1, newTetelRows.length, totTetCols).setValues(newTetelRows);
    Logger.log(tag + ' Tételsorok írva (' + (Date.now() - t0) + 'ms)');
  }

  Logger.log(tag + ' KÉSZ: ' + newTetelRows.length + ' tétel, ' + modifiedFejRows.length +
    ' fejléc frissítve, ' + markedNA + ' n/a. Összes idő: ' + (Date.now() - t0) + 'ms');

  return {
    fejSh: fejSh, tetSh: tetSh,
    hMapTet: hMapTet, totTetCols: totTetCols, tetKey1: tetKey1, tetKey2: tetKey2,
    hMapFej: hMapFej, totFejCols: totFejCols, fejKey: fejKey, fejDl: fejDl,
    compositeKeys: compositeKeys,
    fejData: fejData,
    fejIndexMap: fejIndexMap
  };
}
