/**
 * OsaFieldMaps.js — Mezőleképező táblák + irány-konfiguráció (INBOUND / OUTBOUND).
 *
 * Itt él az a metaadat-réteg, ami megmondja, melyik sheet-oszlopba milyen érték
 * megy. A leképező függvények szignatúrái:
 *   FEJLEC_MEZO_ERTEKEK:             function(digestRow) → érték
 *   FEJLEC_MEZO_ERTEKEK_INVOICEDATA: function(invoiceHeadEl, rootEl) → érték
 *   TETEL_MEZO_ERTEKEK:              function(invoiceNumber, lineEl, headEl, rootEl) → érték
 *
 * Az OUTBOUND változatok az INBOUND-ot aliasoljuk: néhány oszlop fejléce eltér
 * (pl. "Alkalmazott árfolyam" → "Alkalm. árfolyam"), de a value függvények
 * azonosak. Az osaDirCfg(direction) ad vissza egy konfigurációs csomagot,
 * amelyet az OsaProcessor.js és OsaSync.js használ.
 */

// ============================================================
// FEJLÉC — digestRow → érték
// ============================================================

/**
 * Fejléc adatok sheet — minden oszlop leképezése.
 *
 * digestRow: osaDigestElementToObject() által visszaadott plain object.
 * A digest-ből hiányzó mezők (cím, árfolyam stb.) üres stringet adnak;
 * ezeket az osaUpdateFejlecFromInvoiceXml() tölti ki a részletes XML alapján.
 *
 * Az összes kulcsnak egyeznie kell a sheet fejlécével.
 */
var OSA_FEJLEC_MEZO_ERTEKEK = {
  'Számla sorszáma':                               function(d) { return osaV(d.invoiceNumber); },
  'Számla kelte':                                  function(d) { return osaV(d.invoiceIssueDate); },
  'Teljesítés dátuma':                             function(d) { return osaV(d.invoiceDeliveryDate); },
  'Számla pénzneme':                               function(d) { return osaV(d.currency); },
  'Alkalmazott árfolyam':                          function(d) { return ''; },       // invoiceData XML-ből
  'Eladó adószáma (törzsszám)':                    function(d) { return osaV(d.supplierTaxNumber); },
  'Eladó adószáma (ÁFA-kód)':                     function(d) { return osaV(d.supplierVatCode); },
  'Eladó adószáma (megyekód)':                     function(d) { return osaV(d.supplierCountyCode); },
  'Eladó neve':                                    function(d) { return osaV(d.supplierName); },
  'Eladó országkódja':                             function(d) { return ''; },       // invoiceData XML-ből
  'Eladó irányítószáma':                           function(d) { return ''; },       // invoiceData XML-ből
  'Eladó települése':                              function(d) { return ''; },       // invoiceData XML-ből
  'Eladó többi címadata':                          function(d) { return ''; },       // invoiceData XML-ből
  'Vevő adószáma (törzsszám)':                     function(d) { return osaV(d.customerTaxNumber); },
  'Vevő adószáma (ÁFA-kód)':                      function(d) { return osaV(d.customerVatCode); },
  'Vevő adószáma (megyekód)':                      function(d) { return osaV(d.customerCountyCode); },
  'Vevő neve':                                     function(d) { return osaCustomerNameWithFallback(d.customerName, d.customerVatStatus, d.currency); },
  'Vevő státusza':                                 function(d) { return osaVatStatusHu(d.customerVatStatus); },
  'Vevő közösségi adószáma':                       function(d) { return ''; },       // invoiceData XML-ből
  'Vevő harmadik országbeli adószáma':             function(d) { return ''; },       // invoiceData XML-ből
  'Vevő országkódja':                              function(d) { return ''; },       // invoiceData XML-ből
  'Vevő irányítószáma':                            function(d) { return ''; },       // invoiceData XML-ből
  'Vevő települése':                               function(d) { return ''; },       // invoiceData XML-ből
  'Vevő többi címadata':                           function(d) { return ''; },       // invoiceData XML-ből
  'Eredeti számla száma':                          function(d) { return osaV(d.originalInvoiceNumber); },
  'Módosító okirat kelte':                         function(d) { return ''; },       // invoiceData XML-ből
  'Módosítás sorszáma':                            function(d) { return osaV(d.modificationIndex); },
  'Számla nettó összege (a számla pénznemében)':   function(d) { return osaNum(d.invoiceNetAmount); },
  'Számla nettó (forintban)':                     function(d) { return osaNum(d.invoiceNetAmountHUF); },
  'Számla ÁFA(a számla pénznemében)':              function(d) { return osaNum(d.invoiceVatAmount); },
  'Számla ÁFA összege (forintban)':                function(d) { return osaNum(d.invoiceVatAmountHUF); },
  'Számla bruttó összege (a számla pénznemében)':  function(d) { return osaNumSum(d.invoiceNetAmount, d.invoiceVatAmount); },
  'Számla bruttó (forintban)':                    function(d) { return osaNumSum(d.invoiceNetAmountHUF, d.invoiceVatAmountHUF); },
  'Fizetési határidő':                             function(d) { return osaV(d.paymentDate); },
  'Fizetési mód':                                  function(d) { return osaPaymentMethodHu(d.paymentMethod); },
  'Kisadózó jelölése':                             function(d) { return ''; },       // invoiceData XML-ből
  'Pénzforgalmi elszámolás jelölése':              function(d) { return ''; },       // invoiceData XML-ből
  'Számla típusa':                                 function(d) { return osaInvoiceCategoryHu(d.invoiceCategory); },
  'Az adatszolgáltatás maga a számla':             function(d) { return osaBoolHu(d.completenessIndicator); },
  'Tételek LETÖLTVE':                              function(d) { return ''; }
};

/**
 * Fejléc adatok sheet — invoiceData XML-ből kinyerhető mezők leképezése.
 *
 * Csak azokat a kulcsokat soroljuk fel, amelyek a digest fázisban üresek.
 * Az osaUpdateFejlecFromInvoiceXml() használja, csak az üres cellákat tölti ki.
 */
var OSA_FEJLEC_MEZO_ERTEKEK_INVOICEDATA = {
  'Alkalmazott árfolyam':                          function(h) { return osaNumParse(navXmlText(h, 'exchangeRate')); },
  'Eladó országkódja':                             function(h) { return navXmlText(h, 'supplierAddress simpleAddress countryCode') ||
                                                                         navXmlText(h, 'supplierAddress detailedAddress countryCode'); },
  'Eladó irányítószáma':                           function(h) { return navXmlText(h, 'supplierAddress simpleAddress postalCode') ||
                                                                         navXmlText(h, 'supplierAddress detailedAddress postalCode'); },
  'Eladó települése':                              function(h) { return navXmlText(h, 'supplierAddress simpleAddress city') ||
                                                                         navXmlText(h, 'supplierAddress detailedAddress city'); },
  'Eladó többi címadata':                          function(h) { return navXmlText(h, 'supplierAddress simpleAddress additionalAddressDetail') ||
                                                                         osaDetailedAddressRest(navFindFirst(h, 'supplierAddress')); },
  'Vevő közösségi adószáma':                       function(h) { return navXmlText(h, 'customerVatData communityVatNumber'); },
  'Vevő harmadik országbeli adószáma':             function(h) { return navXmlText(h, 'customerVatData thirdStateTaxId'); },
  'Vevő országkódja':                              function(h) { return navXmlText(h, 'customerAddress simpleAddress countryCode') ||
                                                                         navXmlText(h, 'customerAddress detailedAddress countryCode'); },
  'Vevő irányítószáma':                            function(h) { return navXmlText(h, 'customerAddress simpleAddress postalCode') ||
                                                                         navXmlText(h, 'customerAddress detailedAddress postalCode'); },
  'Vevő települése':                               function(h) { return navXmlText(h, 'customerAddress simpleAddress city') ||
                                                                         navXmlText(h, 'customerAddress detailedAddress city'); },
  'Vevő többi címadata':                           function(h) { return navXmlText(h, 'customerAddress simpleAddress additionalAddressDetail') ||
                                                                         osaDetailedAddressRest(navFindFirst(h, 'customerAddress')); },
  'Módosító okirat kelte':                         function(h) { return navXmlText(h, 'invoiceReference modificationIssueDate'); },
  'Kisadózó jelölése':                             function(h) { return osaBoolHu(navXmlText(h, 'smallBusinessIndicator')); },
  'Pénzforgalmi elszámolás jelölése':              function(h) { return osaBoolHu(navXmlText(h, 'cashAccountingIndicator')); },
  'Számla nettó (forintban)':                      function(h, r) {
    if (navXmlText(h, 'invoiceDetail invoiceCategory') !== 'SIMPLIFIED') return '';
    var sum = 0;
    var lines = navFindAll(r, 'line');
    for (var i = 0; i < lines.length; i++) {
      var val = osaResolveAmountsHUF(lines[i]).net;
      if (typeof val === 'number') sum += val;
    }
    return sum === 0 && lines.length === 0 ? '' : Math.round(sum * 100) / 100;
  },
  'Számla ÁFA összege (forintban)':                function(h, r) {
    if (navXmlText(h, 'invoiceDetail invoiceCategory') !== 'SIMPLIFIED') return '';
    var sum = 0;
    var lines = navFindAll(r, 'line');
    for (var i = 0; i < lines.length; i++) {
      var val = osaResolveAmountsHUF(lines[i]).vat;
      if (typeof val === 'number') sum += val;
    }
    return sum === 0 && lines.length === 0 ? '' : Math.round(sum * 100) / 100;
  },
  'Számla bruttó (forintban)':                     function(h, r) {
    if (navXmlText(h, 'invoiceDetail invoiceCategory') !== 'SIMPLIFIED') return '';
    var gross = osaNumParse(navXmlText(r, 'invoiceSummary summaryGrossData invoiceGrossAmountHUF'));
    if (gross !== '') return gross;
    var sum = 0;
    var lines = navFindAll(r, 'line');
    for (var i = 0; i < lines.length; i++) {
      var val = osaResolveAmountsHUF(lines[i]).gross;
      if (typeof val === 'number') sum += val;
    }
    return sum === 0 && lines.length === 0 ? '' : Math.round(sum * 100) / 100;
  }
};

// ============================================================
// TÉTEL — invoiceNumber + lineEl + headEl + rootEl → érték
// ============================================================

/**
 * Tétel adatok sheet — minden oszlop leképezése.
 *
 * lineEl:        az aktuális <line> XML Element
 * headEl:        az <invoiceHead> XML Element (számlafejléc adatok)
 * rootEl:        az InvoiceData root (invoiceIssueDate itt él)
 */
var OSA_TETEL_MEZO_ERTEKEK = {
  // ─── Számlafejlécből ────────────────────────────────────────────────────────
  'Számla kelte':                                          function(inv, l, h, r) {
    var v = r ? navXmlText(r, 'invoiceIssueDate') : '';
    return v || navXmlText(h, 'invoiceIssueDate');
  },
  'Költség típ.':                                          function(inv, l, h) { return ''; },
  'Költség al. típ.':                                      function(inv, l, h) { return ''; },
  'Számla sorszáma':                                       function(inv, l, h) { return inv; },
  'Vevő adószáma (törzsszám)':                            function(inv, l, h) { return navXmlText(h, 'customerTaxNumber taxpayerId'); },
  'Vevő neve':                                            function(inv, l, h, r) {
    var name     = navXmlText(h, 'customerName');
    var status   = navXmlText(h, 'customerVatStatus');
    var currency = navXmlText(h, 'invoiceCurrency') || (r ? navXmlText(r, 'invoiceCurrency') : '');
    return osaCustomerNameWithFallback(name, status, currency);
  },
  'Eladó adószáma (törzsszám)':                           function(inv, l, h) { return navXmlText(h, 'supplierTaxNumber taxpayerId'); },
  'Eladó neve':                                           function(inv, l, h) { return navXmlText(h, 'supplierName'); },

  // ─── Tételazonosítók ────────────────────────────────────────────────────────
  'Tétel sorszáma':                                       function(inv, l, h) { return navXmlText(l, 'lineNumber'); },
  'Módosítással érintett tétel sorszáma':                 function(inv, l, h) { return navXmlText(l, 'lineModificationReference modifiedLineNumber') || 'n/a'; },
  'Módosítás jellege':                                    function(inv, l, h) { return navXmlText(l, 'lineModificationReference lineOperation') || 'n/a'; },
  'Megnevezés':                                           function(inv, l, h) { return navXmlText(l, 'lineDescription'); },

  // ─── Mennyiség / Egységár ───────────────────────────────────────────────────
  'Mennyiség':                                            function(inv, l, h) { return osaNumParse(navXmlText(l, 'quantity')); },
  'Mennyiségi egység':                                    function(inv, l, h) { return navXmlText(l, 'unitOfMeasureOwn') || osaUnitOfMeasureHu(navXmlText(l, 'unitOfMeasure')); },
  'Egységár':                                            function(inv, l, h) { return osaNumParse(navXmlText(l, 'unitPrice')); },

  // ─── Összegek — NORMAL számla ───────────────────────────────────────────────
  'Nettó összeg (a számla pénznemében)':                  function(inv, l, h) { return osaResolveAmounts(l).net; },
  'Nettó összeg (forintban)':                            function(inv, l, h) { return osaResolveAmountsHUF(l).net; },

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
  'Belföldi fordított adózás jelölés':                    function(inv, l, h) { return osaBoolHu(navXmlText(l, 'domesticReverseCharge')); },
  'Áthárított adót tartalmazó különbözet szerinti adózás':     function(inv, l, h) { return osaBoolHu(navXmlText(l, 'marginSchemeIndicator')); },
  'Áthárított adót nem tartalmazó különbözet szerinti adózás': function(inv, l, h) { return 'n/a'; },
  'Különbözet szerinti adózás':                           function(inv, l, h) { return navXmlText(l, 'marginSchemeType') || 'n/a'; },

  // ─── ÁFA összeg ─────────────────────────────────────────────────────────────
  'ÁFA összeg (a számla pénznemében)':                    function(inv, l, h) { return osaResolveAmounts(l).vat; },
  'ÁFA összeg (forintban)':                               function(inv, l, h) { return osaResolveAmountsHUF(l).vat; },

  // ─── Bruttó összeg ──────────────────────────────────────────────────────────
  'Bruttó összeg (a számla pénznemében)':                 function(inv, l, h) { return osaResolveAmounts(l).gross; },
  'Bruttó összeg (forintban)':                            function(inv, l, h) { return osaResolveAmountsHUF(l).gross; },

  // ─── ÁFA tartalom (SIMPLIFIED) ──────────────────────────────────────────────
  'ÁFA tartalom':                                         function(inv, l, h) {
    return osaNumParse(navXmlText(l, 'lineAmountsSimplified lineVatRate vatContent')) || 'n/a';
  },

  // ─── Egyéb tételmezők ───────────────────────────────────────────────────────
  'Előleg jelleg jelölése':                               function(inv, l, h) { return osaBoolHu(navXmlText(l, 'advanceIndicator')); },
  'Tétel árfolyam':                                       function(inv, l, h) { return osaNumParse(navXmlText(l, 'lineExchangeRate')) || 'n/a'; },
  'Tétel teljesítés dátuma':                              function(inv, l, h) { return navXmlText(l, 'lineDeliveryDate') || 'n/a'; },
  'Nincs felszámított áfa az áfa törvény 17. § alapján':  function(inv, l, h) { return osaBoolHu(navXmlText(l, 'noVatCharge')); }
};

// ============================================================
// KIMENŐ (OUTBOUND) MEZŐLEKÉPEZŐK — header-alias az INBOUND-hoz képest
// ============================================================
//
// A KIMENŐ sheetek header oszlopnevei néhány helyen eltérnek az INBOUND-tól
// (pl. "Alkalmazott árfolyam" → "Alkalm. árfolyam", "(forintban)" → "(Ft)").
// A value függvények ugyanazok — csak a kulcsok cserélődnek le.

var OSA_FEJLEC_OUTBOUND_HEADER_ALIAS = {
  'Alkalmazott árfolyam':              'Alkalm. árfolyam',
  'Számla nettó (forintban)':          'Számla nettó összege (Ft)',
  'Számla ÁFA(a számla pénznemében)':  'Számla ÁFA összege (a számla pénznemében)',
  'Számla bruttó (forintban)':         'Számla bruttó összege (Ft)'
};
var OSA_TETEL_OUTBOUND_HEADER_ALIAS = {
  'Nettó összeg (forintban)': 'Nettó összeg (Ft)',
  'ÁFA összeg (forintban)':   'ÁFA összeg (Ft)'
};

function osaAliasFieldMap(src, aliasMap) {
  var out = {};
  var keys = Object.keys(src);
  for (var i = 0; i < keys.length; i++) {
    var k = keys[i];
    var newKey = (aliasMap && aliasMap[k]) || k;
    out[newKey] = src[k];
  }
  return out;
}

var OSA_FEJLEC_MEZO_ERTEKEK_KIMENO             = osaAliasFieldMap(OSA_FEJLEC_MEZO_ERTEKEK,             OSA_FEJLEC_OUTBOUND_HEADER_ALIAS);
var OSA_FEJLEC_MEZO_ERTEKEK_KIMENO_INVOICEDATA = osaAliasFieldMap(OSA_FEJLEC_MEZO_ERTEKEK_INVOICEDATA, OSA_FEJLEC_OUTBOUND_HEADER_ALIAS);
var OSA_TETEL_MEZO_ERTEKEK_KIMENO              = osaAliasFieldMap(OSA_TETEL_MEZO_ERTEKEK,              OSA_TETEL_OUTBOUND_HEADER_ALIAS);

// ============================================================
// DIRECTION → KONFIGURÁCIÓS CSOMAG
// ============================================================

/**
 * Egységes konfig az OSA INBOUND/OUTBOUND ághoz. Az osa* processzor és sync
 * függvények ezt használják, hogy minden kétfelé futó kódot egyetlen úttal
 * tudjanak kezelni.
 */
function osaDirCfg(direction) {
  var isOut = String(direction || '').toUpperCase() === 'OUTBOUND';
  return isOut
    ? {
        direction: 'OUTBOUND',
        sheetFejlec: OSA_SHEET_FEJLEC_KIMENO,
        sheetTetel:  OSA_SHEET_TETEL_KIMENO,
        fejlecMap:           OSA_FEJLEC_MEZO_ERTEKEK_KIMENO,
        fejlecInvoicedataMap:OSA_FEJLEC_MEZO_ERTEKEK_KIMENO_INVOICEDATA,
        tetelMap:            OSA_TETEL_MEZO_ERTEKEK_KIMENO
      }
    : {
        direction: 'INBOUND',
        sheetFejlec: OSA_SHEET_FEJLEC,
        sheetTetel:  OSA_SHEET_TETEL,
        fejlecMap:           OSA_FEJLEC_MEZO_ERTEKEK,
        fejlecInvoicedataMap:OSA_FEJLEC_MEZO_ERTEKEK_INVOICEDATA,
        tetelMap:            OSA_TETEL_MEZO_ERTEKEK
      };
}
