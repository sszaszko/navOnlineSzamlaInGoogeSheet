/**
 * DataProcessor.gs — Adatfeldolgozás és sheet műveletek
 *
 * Felelőssége:
 *   - Fejléc adatok sheet: digest → sor leképezés + upsert
 *   - Tétel adatok sheet:  invoiceXml → sorok + upsert
 *   - "Tételek LETÖLTVE" visszajelzés a Fejléc adatok sheetbe
 *   - Mezőleképező táblák (FEJLEC_MEZO_ERTEKEK, TETEL_MEZO_ERTEKEK)
 *   - Érték-konverziók (enum → magyar szöveg, számok, bool)
 *   - Sheet helper: fejléc-alapú oszlonazonosítás, upsert
 *   - Invoice XML parser (tételek kinyerése)
 *
 * NEM tartalmaz: NAV HTTP hívások, auth, XML request builder.
 * Függőségei: NavApi.gs (navXmlText, navFindFirst, navFindAll)
 */

// ============================================================
// KONSTANSOK
// ============================================================

var SHEET_FEJLEC = 'Fejléc adatok';
var SHEET_TETEL  = 'Tétel adatok';

// ============================================================
// MEZŐLEKÉPEZŐ TÁBLÁK
// ============================================================

/**
 * Fejléc adatok sheet — minden oszlop leképezése.
 *
 * Signature: function(digestRow) → érték
 *
 * digestRow: navDigestElementToObject() által visszaadott plain object.
 * A digest-ből hiányzó mezők (cím, árfolyam stb.) üres stringet adnak;
 * ezeket az updateFejlecFromInvoiceXml() tölti ki a részletes XML alapján.
 *
 * Az összes FEJLEC_MEZO_ERTEKEK kulcsnak egyeznie kell a sheet fejlécével.
 */
var FEJLEC_MEZO_ERTEKEK = {
  'Számla sorszáma':                               function(d) { return dpv(d.invoiceNumber); },
  'Számla kelte':                                  function(d) { return dpv(d.invoiceIssueDate); },
  'Teljesítés dátuma':                             function(d) { return dpv(d.invoiceDeliveryDate); },
  'Számla pénzneme':                               function(d) { return dpv(d.currency); },
  'Alkalmazott árfolyam':                          function(d) { return ''; },       // invoiceData XML-ből
  'Eladó adószáma (törzsszám)':                    function(d) { return dpv(d.supplierTaxNumber); },
  'Eladó adószáma (ÁFA-kód)':                     function(d) { return dpv(d.supplierVatCode); },
  'Eladó adószáma (megyekód)':                     function(d) { return dpv(d.supplierCountyCode); },
  'Eladó neve':                                    function(d) { return dpv(d.supplierName); },
  'Eladó országkódja':                             function(d) { return ''; },       // invoiceData XML-ből
  'Eladó irányítószáma':                           function(d) { return ''; },       // invoiceData XML-ből
  'Eladó települése':                              function(d) { return ''; },       // invoiceData XML-ből
  'Eladó többi címadata':                          function(d) { return ''; },       // invoiceData XML-ből
  'Vevő adószáma (törzsszám)':                     function(d) { return dpv(d.customerTaxNumber); },
  'Vevő adószáma (ÁFA-kód)':                      function(d) { return dpv(d.customerVatCode); },
  'Vevő adószáma (megyekód)':                      function(d) { return dpv(d.customerCountyCode); },
  'Vevő neve':                                     function(d) { return dpv(d.customerName); },
  'Vevő státusza':                                 function(d) { return dpVatStatusHu(d.customerVatStatus); },
  'Vevő közösségi adószáma':                       function(d) { return ''; },       // invoiceData XML-ből
  'Vevő harmadik országbeli adószáma':             function(d) { return ''; },       // invoiceData XML-ből
  'Vevő országkódja':                              function(d) { return ''; },       // invoiceData XML-ből
  'Vevő irányítószáma':                            function(d) { return ''; },       // invoiceData XML-ből
  'Vevő települése':                               function(d) { return ''; },       // invoiceData XML-ből
  'Vevő többi címadata':                           function(d) { return ''; },       // invoiceData XML-ből
  'Eredeti számla száma':                          function(d) { return dpv(d.originalInvoiceNumber); },
  'Módosító okirat kelte':                         function(d) { return ''; },       // invoiceData XML-ből
  'Módosítás sorszáma':                            function(d) { return dpv(d.modificationIndex); },
  'Számla nettó összege (a számla pénznemében)':   function(d) { return dpNum(d.invoiceNetAmount); },
  'Számla nettó (forintban)':                     function(d) { return dpNum(d.invoiceNetAmountHUF); },
  'Számla ÁFA(a számla pénznemében)':              function(d) { return dpNum(d.invoiceVatAmount); },
  'Számla ÁFA összege (forintban)':                function(d) { return dpNum(d.invoiceVatAmountHUF); },
  'Számla bruttó összege (a számla pénznemében)':  function(d) { return dpNumSum(d.invoiceNetAmount, d.invoiceVatAmount); },
  'Számla bruttó (forintban)':                    function(d) { return dpNumSum(d.invoiceNetAmountHUF, d.invoiceVatAmountHUF); },
  'Fizetési határidő':                             function(d) { return dpv(d.paymentDate); },
  'Fizetési mód':                                  function(d) { return dpPaymentMethodHu(d.paymentMethod); },
  'Kisadózó jelölése':                             function(d) { return ''; },       // invoiceData XML-ből
  'Pénzforgalmi elszámolás jelölése':              function(d) { return ''; },       // invoiceData XML-ből
  'Számla típusa':                                 function(d) { return dpInvoiceCategoryHu(d.invoiceCategory); },
  'Az adatszolgáltatás maga a számla':             function(d) { return dpBoolHu(d.completenessIndicator); },
  'Tételek LETÖLTVE':                              function(d) { return ''; }        // menuDownloadMissingDetails tölti ki
};

/**
 * Fejléc adatok sheet — invoiceData XML-ből kinyerhető mezők leképezése.
 *
 * Signature: function(invoiceHeadEl) → érték
 *
 * invoiceHeadEl: az invoiceHead XML Element (navFindFirst(root, 'invoiceHead'))
 * Ezek a mezők a digest fázisban üresek maradnak, és az updateFejlecFromInvoiceXml()
 * hívja ezt a táblát a "Tételek LETÖLTVE" lépésben.
 *
 * Csak azokat a kulcsokat kell itt felsorolni, amelyek a digest fázisban üresek.
 * A többi mező (amit a digest már kitöltött) nem kerül felülírásra.
 */
var FEJLEC_MEZO_ERTEKEK_INVOICEDATA = {
  'Alkalmazott árfolyam':                          function(h) { return dpNumParse(navXmlText(h, 'exchangeRate')); },
  'Eladó országkódja':                             function(h) { return navXmlText(h, 'supplierAddress simpleAddress countryCode') ||
                                                                         navXmlText(h, 'supplierAddress detailedAddress countryCode'); },
  'Eladó irányítószáma':                           function(h) { return navXmlText(h, 'supplierAddress simpleAddress postalCode') ||
                                                                         navXmlText(h, 'supplierAddress detailedAddress postalCode'); },
  'Eladó települése':                              function(h) { return navXmlText(h, 'supplierAddress simpleAddress city') ||
                                                                         navXmlText(h, 'supplierAddress detailedAddress city'); },
  'Eladó többi címadata':                          function(h) { return navXmlText(h, 'supplierAddress simpleAddress additionalAddressDetail') ||
                                                                         dpDetailedAddressRest(navFindFirst(h, 'supplierAddress')); },
  'Vevő közösségi adószáma':                       function(h) { return navXmlText(h, 'customerVatData communityVatNumber'); },
  'Vevő harmadik országbeli adószáma':             function(h) { return navXmlText(h, 'customerVatData thirdStateTaxId'); },
  'Vevő országkódja':                              function(h) { return navXmlText(h, 'customerAddress simpleAddress countryCode') ||
                                                                         navXmlText(h, 'customerAddress detailedAddress countryCode'); },
  'Vevő irányítószáma':                            function(h) { return navXmlText(h, 'customerAddress simpleAddress postalCode') ||
                                                                         navXmlText(h, 'customerAddress detailedAddress postalCode'); },
  'Vevő települése':                               function(h) { return navXmlText(h, 'customerAddress simpleAddress city') ||
                                                                         navXmlText(h, 'customerAddress detailedAddress city'); },
  'Vevő többi címadata':                           function(h) { return navXmlText(h, 'customerAddress simpleAddress additionalAddressDetail') ||
                                                                         dpDetailedAddressRest(navFindFirst(h, 'customerAddress')); },
  'Módosító okirat kelte':                         function(h) { return navXmlText(h, 'invoiceReference modificationIssueDate'); },
  'Kisadózó jelölése':                             function(h) { return dpBoolHu(navXmlText(h, 'smallBusinessIndicator')); },
  'Pénzforgalmi elszámolás jelölése':              function(h) { return dpBoolHu(navXmlText(h, 'cashAccountingIndicator')); },
  'Számla nettó (forintban)':                      function(h, r) {
    if (navXmlText(h, 'invoiceDetail invoiceCategory') !== 'SIMPLIFIED') return '';
    var sum = 0;
    var lines = navFindAll(r, 'line');
    for (var i = 0; i < lines.length; i++) {
      var val = dpResolveAmountsHUF(lines[i]).net;
      if (typeof val === 'number') sum += val;
    }
    return sum === 0 && lines.length === 0 ? '' : Math.round(sum * 100) / 100;
  },
  'Számla ÁFA összege (forintban)':                function(h, r) {
    if (navXmlText(h, 'invoiceDetail invoiceCategory') !== 'SIMPLIFIED') return '';
    var sum = 0;
    var lines = navFindAll(r, 'line');
    for (var i = 0; i < lines.length; i++) {
      var val = dpResolveAmountsHUF(lines[i]).vat;
      if (typeof val === 'number') sum += val;
    }
    return sum === 0 && lines.length === 0 ? '' : Math.round(sum * 100) / 100;
  },
  'Számla bruttó (forintban)':                     function(h, r) {
    if (navXmlText(h, 'invoiceDetail invoiceCategory') !== 'SIMPLIFIED') return '';
    var gross = dpNumParse(navXmlText(r, 'invoiceSummary summaryGrossData invoiceGrossAmountHUF'));
    if (gross !== '') return gross;
    var sum = 0;
    var lines = navFindAll(r, 'line');
    for (var i = 0; i < lines.length; i++) {
      var val = dpResolveAmountsHUF(lines[i]).gross;
      if (typeof val === 'number') sum += val;
    }
    return sum === 0 && lines.length === 0 ? '' : Math.round(sum * 100) / 100;
  }
};

/**
 * Tétel adatok sheet — minden oszlop leképezése.
 *
 * Signature: function(invoiceNumber, lineEl, invoiceHeadEl) → érték
 *
 * lineEl:         az aktuális <line> XML Element
 * invoiceHeadEl:  az <invoiceHead> XML Element (számlafejléc adatok)
 */
var TETEL_MEZO_ERTEKEK = {
  // ─── Számlafejlécből ────────────────────────────────────────────────────────
  'Számla kelte':                                          function(inv, l, h, r) {
    // invoiceIssueDate az InvoiceData ROOT-on van (nem az invoiceHead-en belül)
    var v = r ? navXmlText(r, 'invoiceIssueDate') : '';
    return v || navXmlText(h, 'invoiceIssueDate');  // fallback ha rootEl hiányzik
  },
  'Költség típ.':                                          function(inv, l, h) { return ''; },
  'Költség al. típ.':                                      function(inv, l, h) { return ''; },
  'Számla sorszáma':                                       function(inv, l, h) { return inv; },
  'Vevő adószáma (törzsszám)':                            function(inv, l, h) { return navXmlText(h, 'customerTaxNumber taxpayerId'); },
  'Vevő neve':                                            function(inv, l, h) { return navXmlText(h, 'customerName'); },
  'Eladó adószáma (törzsszám)':                           function(inv, l, h) { return navXmlText(h, 'supplierTaxNumber taxpayerId'); },
  'Eladó neve':                                           function(inv, l, h) { return navXmlText(h, 'supplierName'); },

  // ─── Tételazonosítók ────────────────────────────────────────────────────────
  'Tétel sorszáma':                                       function(inv, l, h) { return navXmlText(l, 'lineNumber'); },
  'Módosítással érintett tétel sorszáma':                 function(inv, l, h) { return navXmlText(l, 'lineModificationReference modifiedLineNumber') || 'n/a'; },
  'Módosítás jellege':                                    function(inv, l, h) { return navXmlText(l, 'lineModificationReference lineOperation') || 'n/a'; },
  'Megnevezés':                                           function(inv, l, h) { return navXmlText(l, 'lineDescription'); },

  // ─── Mennyiség / Egységár ───────────────────────────────────────────────────
  // A quantity / unitPrice közvetlenül a <line> alatt van.
  'Mennyiség':                                            function(inv, l, h) { return dpNumParse(navXmlText(l, 'quantity')); },
  'Mennyiségi egység':                                    function(inv, l, h) { return navXmlText(l, 'unitOfMeasureOwn') || dpUnitOfMeasureHu(navXmlText(l, 'unitOfMeasure')); },
  'Egységár':                                            function(inv, l, h) { return dpNumParse(navXmlText(l, 'unitPrice')); },

  // ─── Összegek — NORMAL számla ───────────────────────────────────────────────
  // XPath: line/lineAmountsNormal/lineNetAmountData/lineNetAmount
  //        line/lineAmountsNormal/lineVatData/lineVatAmount
  //        line/lineAmountsNormal/lineGrossAmountData/lineGrossAmountNormal
  'Nettó összeg (a számla pénznemében)':                  function(inv, l, h) { return dpResolveAmounts(l).net; },
  'Nettó összeg (forintban)':                            function(inv, l, h) { return dpResolveAmountsHUF(l).net; },

  // ─── ÁFA mérték — NORMAL: lineVatRate/vatPercentage; SIMPLIFIED: lineVatRate/vatContent ──
  'Adó mértéke':                                          function(inv, l, h) {
    var vp = navXmlText(l, 'lineAmountsNormal lineVatRate vatPercentage');
    if (vp) return vp;

    var vcStr = navXmlText(l, 'lineAmountsSimplified lineVatRate vatContent');
    if (vcStr) {
      var vc = parseFloat(vcStr);
      if (!isNaN(vc) && vc < 1 && vc >= 0) {
        var rate = vc / (1 - vc);
        return (Math.round(rate * 10000) / 10000).toString();
      }
      return vcStr;
    }

    return navXmlText(l, 'vatPercentage');
  },

  // ─── ÁFA mentesség ─────────────────────────────────────────────────────────
  // lineVatRate alatt: vatExemption (case + reason) VAGY vatOutOfScope VAGY noVatCharge stb.
  'Áfamentesség jelölés':                                 function(inv, l, h) {
    return (navFindFirst(l, 'vatExemption') ? 'Igen' : 'n/a');
  },
  'Áfamentesség esete':                                   function(inv, l, h) {
    return navXmlText(l, 'vatExemption case') || navXmlText(l, 'lineAmountsNormal lineVatRate vatExemption case') || 'n/a';
  },
  'Áfamentesség leírása':                                 function(inv, l, h) {
    return navXmlText(l, 'vatExemption reason') || navXmlText(l, 'lineAmountsNormal lineVatRate vatExemption reason') || 'n/a';
  },
  'ÁFA törvény hatályán kívüli jelölés':                  function(inv, l, h) {
    return (navFindFirst(l, 'vatOutOfScope') ? 'Igen' : 'n/a');
  },
  'ÁFA törvény hatályon kívüliségének esete':             function(inv, l, h) {
    return navXmlText(l, 'vatOutOfScope case') || 'n/a';
  },
  'ÁFA törvény hatályon kívüliségének leírása':           function(inv, l, h) {
    return navXmlText(l, 'vatOutOfScope reason') || 'n/a';
  },
  'Adóalap és felszámított adó eltérésének esete':        function(inv, l, h) {
    return navXmlText(l, 'vatAmountMismatch case') || 'n/a';
  },
  'Eltérő adóalap és felszámított adó adómérték, adótartalom': function(inv, l, h) {
    return navXmlText(l, 'vatAmountMismatch vatRate') || 'n/a';
  },

  // ─── Fordított / különbözet ─────────────────────────────────────────────────
  'Belföldi fordított adózás jelölés':                    function(inv, l, h) { return dpBoolHu(navXmlText(l, 'domesticReverseCharge')); },
  'Áthárított adót tartalmazó különbözet szerinti adózás':     function(inv, l, h) { return dpBoolHu(navXmlText(l, 'marginSchemeIndicator')); },
  'Áthárított adót nem tartalmazó különbözet szerinti adózás': function(inv, l, h) { return 'n/a'; },
  'Különbözet szerinti adózás':                           function(inv, l, h) { return navXmlText(l, 'marginSchemeType') || 'n/a'; },

  // ─── ÁFA összeg ─────────────────────────────────────────────────────────────
  // XPath: line/lineAmountsNormal/lineVatData/lineVatAmount
  'ÁFA összeg (a számla pénznemében)':                    function(inv, l, h) { return dpResolveAmounts(l).vat; },
  'ÁFA összeg (forintban)':                               function(inv, l, h) { return dpResolveAmountsHUF(l).vat; },

  // ─── Bruttó összeg ──────────────────────────────────────────────────────────
  // NORMAL:     line/lineAmountsNormal/lineGrossAmountData/lineGrossAmountNormal
  // SIMPLIFIED: line/lineAmountsSimplified/lineGrossAmountData/lineGrossAmountSimplified
  'Bruttó összeg (a számla pénznemében)':                 function(inv, l, h) { return dpResolveAmounts(l).gross; },
  'Bruttó összeg (forintban)':                            function(inv, l, h) { return dpResolveAmountsHUF(l).gross; },

  // ─── ÁFA tartalom (SIMPLIFIED) ──────────────────────────────────────────────
  'ÁFA tartalom':                                         function(inv, l, h) {
    return dpNumParse(navXmlText(l, 'lineAmountsSimplified lineVatRate vatContent')) || 'n/a';
  },

  // ─── Egyéb tételmezők ───────────────────────────────────────────────────────
  'Előleg jelleg jelölése':                               function(inv, l, h) { return dpBoolHu(navXmlText(l, 'advanceIndicator')); },
  'Tétel árfolyam':                                       function(inv, l, h) { return dpNumParse(navXmlText(l, 'lineExchangeRate')) || 'n/a'; },
  'Tétel teljesítés dátuma':                              function(inv, l, h) { return navXmlText(l, 'lineDeliveryDate') || 'n/a'; },
  'Nincs felszámított áfa az áfa törvény 17. § alapján':  function(inv, l, h) { return dpBoolHu(navXmlText(l, 'noVatCharge')); }
};

// ============================================================
// SHEET ÍRÓK — publikus API a Menu.gs számára
// ============================================================

/**
 * Digest sorok upsert-je a Fejléc adatok sheetbe.
 * Kulcs: "Számla sorszáma" — létező kulcsú sort nem ír felül.
 *
 * @param {Array}  digestRows  queryInvoiceDigest() eredménye
 * @returns {number}  újonnan beírt sorok száma
 */
function dpWriteFejlecRows(digestRows) {
  if (!digestRows || digestRows.length === 0) return 0;

  var sh       = dpGetOrCreateSheet(SHEET_FEJLEC);
  var hMap     = dpGetHeaderMap(sh);
  var keyCol   = hMap['Számla sorszáma'];
  if (!keyCol) {
    throw new Error('"Számla sorszáma" fejléc nem található a "' + SHEET_FEJLEC + '" sheetben.');
  }

  var totalCols = sh.getLastColumn() || Object.keys(hMap).length;
  var existing  = dpGetExistingKeys(sh, keyCol);
  var newRows   = [];

  for (var i = 0; i < digestRows.length; i++) {
    var d   = digestRows[i];
    var key = dpv(d.invoiceNumber);
    if (!key || existing[key]) continue;

    var row = dpBuildRow(hMap, totalCols, FEJLEC_MEZO_ERTEKEK, [d]);
    newRows.push(row);
    existing[key] = true;   // duplikált futáson belüli védelem
  }

  if (newRows.length > 0) {
    sh.getRange(sh.getLastRow() + 1, 1, newRows.length, totalCols).setValues(newRows);
  }
  return newRows.length;
}

/**
 * Tétel sorok upsert-je a Tétel adatok sheetbe.
 * Kulcs: "Számla sorszáma" + "Tétel sorszáma".
 *
 * @param {Object}  invoiceDataResult  queryInvoiceData() eredménye
 * @returns {number}  újonnan beírt sorok száma
 */
function dpWriteTetelRows(invoiceDataResult) {
  if (!invoiceDataResult || !invoiceDataResult.invoiceXml) return 0;

  var sh    = dpGetOrCreateSheet(SHEET_TETEL);
  var hMap  = dpGetHeaderMap(sh);
  var totalCols = sh.getLastColumn() || Object.keys(hMap).length;

  var keyCol1 = hMap['Számla sorszáma'];
  var keyCol2 = hMap['Tétel sorszáma'];
  if (!keyCol1 || !keyCol2) {
    throw new Error('"Számla sorszáma" vagy "Tétel sorszáma" fejléc hiányzik a "' + SHEET_TETEL + '" sheetből.');
  }

  var compositeKeys = dpGetCompositeKeys(sh, keyCol1, keyCol2);
  var lines         = dpParseInvoiceLines(invoiceDataResult.invoiceXml);
  var invNum        = invoiceDataResult.invoiceNumber;
  var newRows       = [];

  for (var i = 0; i < lines.length; i++) {
    var lineEl = lines[i].lineEl;
    var headEl = lines[i].headEl;
    var lineNum   = navXmlText(lineEl, 'lineNumber');
    var compKey   = invNum + '||' + lineNum;
    if (compositeKeys[compKey]) continue;

    var row = dpBuildRow(hMap, totalCols, TETEL_MEZO_ERTEKEK, [invNum, lineEl, headEl, lines[i].rootEl]);
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
 *
 * @param {Object}  invoiceDataResult  queryInvoiceData() eredménye
 */
function dpUpdateFejlecFromInvoiceXml(invoiceDataResult) {
  if (!invoiceDataResult || !invoiceDataResult.invoiceXml) return;

  var sh     = dpGetOrCreateSheet(SHEET_FEJLEC);
  var hMap   = dpGetHeaderMap(sh);
  var keyCol = hMap['Számla sorszáma'];
  var dlCol  = hMap['Tételek LETÖLTVE'];
  if (!keyCol) return;

  var existing = dpGetExistingKeys(sh, keyCol);
  var rowNum   = existing[invoiceDataResult.invoiceNumber];
  if (!rowNum) return;

  // XML parse és root / head elementek kinyerése
  var rootEl = dpParseInvoiceRoot(invoiceDataResult.invoiceXml);
  if (!rootEl) return;
  var headEl = navFindFirst(rootEl, 'invoiceHead') || rootEl;

  // Csak az üres cellákat töltjük vissza — meglévő értéket nem írunk felül
  var currentRow = sh.getRange(rowNum, 1, 1, sh.getLastColumn()).getValues()[0];

  var fieldNames = Object.keys(FEJLEC_MEZO_ERTEKEK_INVOICEDATA);
  for (var i = 0; i < fieldNames.length; i++) {
    var colName = fieldNames[i];
    var colIdx  = hMap[colName];
    if (!colIdx) continue;

    var currentVal = String(currentRow[colIdx - 1]).trim();
    if (currentVal !== '' && currentVal !== 'n/a') continue;  // már van adat → skip

    try {
      var newVal = FEJLEC_MEZO_ERTEKEK_INVOICEDATA[colName](headEl, rootEl);
      if (newVal !== '' && newVal != null) {
        sh.getRange(rowNum, colIdx).setValue(newVal);
      }
    } catch(e) {
      Logger.log('dpUpdateFejlecFromInvoiceXml hiba [' + colName + ']: ' + e.message);
    }
  }

  // "Tételek LETÖLTVE" — mindig kitöltjük
  if (dlCol) {
    sh.getRange(rowNum, dlCol).setValue(
      Utilities.formatDate(new Date(), 'Europe/Budapest', 'yyyy-MM-dd HH:mm:ss')
    );
  }
}

// ============================================================
// INVOICE XML PARSER
// ============================================================

/**
 * Invoice XML string-ből kinyeri az összes tételt és az invoiceHead elemet.
 * @returns {Array<{lineEl: XmlElement, headEl: XmlElement}>}
 */
function dpParseInvoiceLines(invoiceXml) {
  if (!invoiceXml) return [];
  try {
    var doc    = XmlService.parse(invoiceXml);
    var root   = doc.getRootElement();
    var lines  = navFindAll(root, 'line');
    var headEl = navFindFirst(root, 'invoiceHead') || root;
    // rootEl is átkerül: az invoiceIssueDate az InvoiceData root-on van,
    // nem az invoiceHead-en belül!
    return lines.map(function(l) { return { lineEl: l, headEl: headEl, rootEl: root }; });
  } catch(e) {
    Logger.log('dpParseInvoiceLines XML parse hiba: ' + e.message);
    return [];
  }
}

/**
 * Invoice XML string-ből kinyeri a root elemet.
 * @returns {XmlElement|null}
 */
function dpParseInvoiceRoot(invoiceXml) {
  if (!invoiceXml) return null;
  try {
    var doc  = XmlService.parse(invoiceXml);
    return doc.getRootElement();
  } catch(e) {
    Logger.log('dpParseInvoiceRoot XML parse hiba: ' + e.message);
    return null;
  }
}

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
  var vals = sheet.getRange(2, 1, last - 1, sheet.getLastColumn()).getValues();
  var keys = {};
  for (var i = 0; i < vals.length; i++) {
    var k1 = String(vals[i][keyCol1 - 1]).trim();
    var k2 = String(vals[i][keyCol2 - 1]).trim();
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

// ============================================================
// ÉRTÉK-KONVERZIÓK — dp prefix (DataProcessor)
// ============================================================

/** Null-safe string */
function dpv(x) {
  if (x == null) return '';
  var s = String(x).trim();
  return s;
}

/** Szám, üres string ha nincs */
function dpNum(x) {
  if (x == null || x === '') return '';
  var n = parseFloat(String(x).replace(/[^0-9.\-]/g, ''));
  return isNaN(n) ? '' : n;
}

/** Számparse vesszős decimálisra is */
function dpNumParse(x) {
  if (x == null || x === '') return '';
  var n = parseFloat(String(x).replace(',', '.'));
  return isNaN(n) ? dpv(x) : n;
}

/** Két szám összege */
function dpNumSum(a, b) {
  var na = parseFloat(a), nb = parseFloat(b);
  if (isNaN(na) && isNaN(nb)) return '';
  return (isNaN(na) ? 0 : na) + (isNaN(nb) ? 0 : nb);
}

/** Boolean → Igen/Nem/n/a */
function dpBoolHu(x) {
  if (x == null || x === '') return 'n/a';
  var s = String(x).toLowerCase().trim();
  if (s === 'true'  || s === 'igen') return 'Igen';
  if (s === 'false' || s === 'nem')  return 'Nem';
  return dpv(x);
}

/** CustomerVatStatusType → magyar */
function dpVatStatusHu(x) {
  var m = {
    'DOMESTIC':       'Belföldi ÁFA alany',
    'OTHER':          'Egyéb',
    'PRIVATE_PERSON': 'Magánszemély'
  };
  return m[dpv(x)] || dpv(x);
}

/** PaymentMethodType → magyar */
function dpPaymentMethodHu(x) {
  var m = {
    'TRANSFER': 'Banki átutalás',
    'CASH':     'Készpénz',
    'CARD':     'Bankkártya',
    'VOUCHER':  'Utalvány',
    'OTHER':    'Egyéb'
  };
  return m[dpv(x)] || dpv(x);
}

/** InvoiceCategoryType → magyar */
function dpInvoiceCategoryHu(x) {
  var m = {
    'NORMAL':     'Normál',
    'SIMPLIFIED': 'Egyszerűsített',
    'AGGREGATE':  'Gyűjtő'
  };
  return m[dpv(x)] || dpv(x);
}

/** UnitOfMeasureType → magyar rövidítés */
function dpUnitOfMeasureHu(x) {
  var m = {
    'PIECE':        'darab',
    'KILOGRAM':     'kg',
    'TON':          'tonna',
    'KWH':          'kWh',
    'DAY':          'nap',
    'HOUR':         'óra',
    'MINUTE':       'perc',
    'MONTH':        'hónap',
    'LITER':        'liter',
    'KILOMETER':    'km',
    'CUBIC_METER':  'm³',
    'METER':        'm',
    'LINEAR_METER': 'fm',
    'CARTON':       'karton',
    'PACK':         'csomag',
    'OWN':          ''
  };
  return m[dpv(x)] !== undefined ? m[dpv(x)] : dpv(x);
}

/**
 * Részletes cím (detailedAddress) "többi" mezőjének összefűzése
 * amikor az additionalAddressDetail nem elérhető.
 * Összefűzi: streetName + publicPlaceCategory + number + building + staircase + floor + door
 */
/**
 * Tétel szintű ÁFA összeg kiszámítása, ha a NAV nem küldte vissza.
 * Egyes számlázó programok a lineVatData-t elhagyják, ha a számla
 * currency=HUF és exchangeRate=1 (mert feleslegesnek tartják).
 * Fallback: nettó × vatPercentage, kerekítve 2 tizedesre.
 */
function dpCalcLineVat(lineEl) {
  var net  = parseFloat(navXmlText(lineEl, 'lineAmountsNormal lineNetAmountData lineNetAmount'));
  var pct  = parseFloat(navXmlText(lineEl, 'lineAmountsNormal lineVatRate vatPercentage'));
  if (isNaN(net) || isNaN(pct)) return '';
  return Math.round(net * pct * 100) / 100;
}

/**
 * Tétel szintű bruttó összeg kiszámítása, ha a NAV nem küldte vissza.
 * Fallback: nettó + ÁFA (számolt vagy kapott).
 */
function dpCalcLineGross(lineEl) {
  var net = parseFloat(navXmlText(lineEl, 'lineAmountsNormal lineNetAmountData lineNetAmount'));
  if (isNaN(net)) return '';
  var vat = parseFloat(navXmlText(lineEl, 'lineAmountsNormal lineVatData lineVatAmount'));
  if (isNaN(vat)) {
    var pct = parseFloat(navXmlText(lineEl, 'lineAmountsNormal lineVatRate vatPercentage'));
    vat = isNaN(pct) ? 0 : Math.round(net * pct * 100) / 100;
  }
  return Math.round((net + vat) * 100) / 100;
}

/**
 * Tétel összeg trojka — nettó, ÁFA, bruttó — bármelyik hiányzó pótlása.
 * A három érték közül ha bármelyik hiányzik, a másik kettőből kiszámolja.
 * Elsőbbség: XML → számolt
 * @param {XmlElement} lineEl
 * @returns {{net: number|'', vat: number|'', gross: number|''}}
 */
function dpResolveAmounts(lineEl) {
  // Kinyerjük ami megvan
  var netRaw   = navXmlText(lineEl, 'lineAmountsNormal lineNetAmountData lineNetAmount') ||
                 navXmlText(lineEl, 'lineNetAmount');
  var vatRaw   = navXmlText(lineEl, 'lineAmountsNormal lineVatData lineVatAmount') ||
                 navXmlText(lineEl, 'lineVatAmount');
  var grossRaw = navXmlText(lineEl, 'lineAmountsNormal lineGrossAmountData lineGrossAmountNormal') ||
                 navXmlText(lineEl, 'lineAmountsSimplified lineGrossAmountSimplified') ||
                 navXmlText(lineEl, 'lineGrossAmountNormal');

  var net   = netRaw   !== '' ? parseFloat(netRaw)   : NaN;
  var vat   = vatRaw   !== '' ? parseFloat(vatRaw)   : NaN;
  var gross = grossRaw !== '' ? parseFloat(grossRaw) : NaN;

  // Pótlás a hiányzókhoz
  if (isNaN(net) && !isNaN(vat) && !isNaN(gross))  net   = Math.round((gross - vat)   * 100) / 100;
  if (isNaN(vat) && !isNaN(net) && !isNaN(gross))  vat   = Math.round((gross - net)   * 100) / 100;
  if (isNaN(gross) && !isNaN(net) && !isNaN(vat))  gross = Math.round((net   + vat)   * 100) / 100;

  // Ha még mindig hiányzik valami, próbáljuk vatPercentage-el
  if (isNaN(vat) && !isNaN(net)) {
    var pct = parseFloat(navXmlText(lineEl, 'lineAmountsNormal lineVatRate vatPercentage'));
    if (!isNaN(pct)) {
      vat   = Math.round(net * pct * 100) / 100;
      if (isNaN(gross)) gross = Math.round((net + vat) * 100) / 100;
    }
  }

  // SIMPLIFIED számla: csak bruttó és vatContent van
  if (isNaN(net) && isNaN(vat)) {
    var grossSimp = parseFloat(navXmlText(lineEl, 'lineAmountsSimplified lineGrossAmountSimplified'));
    var vatC      = parseFloat(navXmlText(lineEl, 'lineAmountsSimplified lineVatRate vatContent'));
    if (!isNaN(grossSimp) && !isNaN(vatC)) {
      gross = grossSimp;
      vat   = Math.round((gross * vatC) * 100) / 100;
      net   = Math.round((gross - vat) * 100) / 100;
    }
  }

  return {
    net:   isNaN(net)   ? '' : net,
    vat:   isNaN(vat)   ? '' : vat,
    gross: isNaN(gross) ? '' : gross
  };
}

/**
 * HUF változat: ha exchangeRate=1 (HUF), ugyanaz mint a devizás.
 * Ha deviza, a HUF mezők külön XML elemben vannak.
 */
function dpResolveAmountsHUF(lineEl) {
  var netRaw   = navXmlText(lineEl, 'lineAmountsNormal lineNetAmountData lineNetAmountHUF')   || navXmlText(lineEl, 'lineNetAmountHUF');
  var vatRaw   = navXmlText(lineEl, 'lineAmountsNormal lineVatData lineVatAmountHUF')         || navXmlText(lineEl, 'lineVatAmountHUF');
  var grossRaw = navXmlText(lineEl, 'lineAmountsNormal lineGrossAmountData lineGrossAmountNormalHUF') ||
                 navXmlText(lineEl, 'lineAmountsSimplified lineGrossAmountSimplifiedHUF')     ||
                 navXmlText(lineEl, 'lineGrossAmountNormalHUF');

  var net   = netRaw   !== '' ? parseFloat(netRaw)   : NaN;
  var vat   = vatRaw   !== '' ? parseFloat(vatRaw)   : NaN;
  var gross = grossRaw !== '' ? parseFloat(grossRaw) : NaN;

  if (isNaN(net) && !isNaN(vat) && !isNaN(gross))  net   = Math.round((gross - vat) * 100) / 100;
  if (isNaN(vat) && !isNaN(net) && !isNaN(gross))  vat   = Math.round((gross - net) * 100) / 100;
  if (isNaN(gross) && !isNaN(net) && !isNaN(vat))  gross = Math.round((net + vat)   * 100) / 100;

  if (isNaN(vat) && !isNaN(net)) {
    var pct = parseFloat(navXmlText(lineEl, 'lineAmountsNormal lineVatRate vatPercentage'));
    if (!isNaN(pct)) {
      vat   = Math.round(net * pct * 100) / 100;
      if (isNaN(gross)) gross = Math.round((net + vat) * 100) / 100;
    }
  }

  if (isNaN(net) && isNaN(vat)) {
    var grossSimp = parseFloat(navXmlText(lineEl, 'lineAmountsSimplified lineGrossAmountSimplifiedHUF'));
    var vatC      = parseFloat(navXmlText(lineEl, 'lineAmountsSimplified lineVatRate vatContent'));
    if (!isNaN(grossSimp) && !isNaN(vatC) && vatC > 0) {
      gross = grossSimp;
      net   = Math.round(gross / (1 + vatC) * 100) / 100;
      vat   = Math.round((gross - net)      * 100) / 100;
    }
  }

  // Ha HUF mezők üresek, fallback: devizás értékek (exchangeRate=1 esetén azonos)
  if (isNaN(net) || isNaN(vat) || isNaN(gross)) {
    var deviza = dpResolveAmounts(lineEl);
    if (isNaN(net))   net   = typeof deviza.net   === 'number' ? deviza.net   : NaN;
    if (isNaN(vat))   vat   = typeof deviza.vat   === 'number' ? deviza.vat   : NaN;
    if (isNaN(gross)) gross = typeof deviza.gross === 'number' ? deviza.gross : NaN;
  }

  return {
    net:   isNaN(net)   ? '' : net,
    vat:   isNaN(vat)   ? '' : vat,
    gross: isNaN(gross) ? '' : gross
  };
}

function dpDetailedAddressRest(addressEl) {
  if (!addressEl) return '';
  var detailed = navFindFirst(addressEl, 'detailedAddress');
  if (!detailed) return '';
  var parts = [
    navXmlText(detailed, 'streetName'),
    navXmlText(detailed, 'publicPlaceCategory'),
    navXmlText(detailed, 'number'),
    navXmlText(detailed, 'building'),
    navXmlText(detailed, 'staircase'),
    navXmlText(detailed, 'floor'),
    navXmlText(detailed, 'door')
  ].filter(function(p) { return p !== ''; });
  return parts.join(' ');
}