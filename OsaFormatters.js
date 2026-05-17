/**
 * OsaFormatters.js — OSA-specifikus érték-konvertálók és kalkulátorok.
 *
 * Itt élnek a NAV invoice XML-ből kinyert nyers értékek magyar nyelvű
 * címkékre / számokra / boolean-ra alakítása, valamint a hiányzó tételösszegek
 * (nettó/ÁFA/bruttó) pótlása. Csak az OSA fejléc + tétel mezőleképezők hívják.
 *
 *   - osaV / osaNum / osaNumParse / osaNumSum  : null-safe érték / szám helper
 *   - osaBoolHu / osaVatStatusHu / osaPaymentMethodHu / osaInvoiceCategoryHu /
 *     osaUnitOfMeasureHu                       : enum → magyar címke
 *   - osaCustomerNameWithFallback              : magánszemély név fallback
 *   - osaCalcLineVat / osaCalcLineGross        : hiányzó áfa / bruttó számítás
 *   - osaResolveAmounts / osaResolveAmountsHUF : nettó/áfa/bruttó trojka pótlás
 *   - osaDetailedAddressRest                   : részletes cím "többi" mező összefűzés
 */

// ============================================================
// ALAPVETŐ ÉRTÉK-KEZELŐK
// ============================================================

/** Null-safe string */
function osaV(x) {
  if (x == null) return '';
  var s = String(x).trim();
  return s;
}

/** Szám, üres string ha nincs */
function osaNum(x) {
  if (x == null || x === '') return '';
  var n = parseFloat(String(x).replace(/[^0-9.\-]/g, ''));
  return isNaN(n) ? '' : n;
}

/** Számparse vesszős decimálisra is */
function osaNumParse(x) {
  if (x == null || x === '') return '';
  var n = parseFloat(String(x).replace(',', '.'));
  return isNaN(n) ? osaV(x) : n;
}

/** Két szám összege */
function osaNumSum(a, b) {
  var na = parseFloat(a), nb = parseFloat(b);
  if (isNaN(na) && isNaN(nb)) return '';
  return (isNaN(na) ? 0 : na) + (isNaN(nb) ? 0 : nb);
}

/** Boolean → Igen/Nem/n/a */
function osaBoolHu(x) {
  if (x == null || x === '') return 'n/a';
  var s = String(x).toLowerCase().trim();
  if (s === 'true'  || s === 'igen') return 'Igen';
  if (s === 'false' || s === 'nem')  return 'Nem';
  return osaV(x);
}

// ============================================================
// ENUM → MAGYAR CÍMKE
// ============================================================

/** CustomerVatStatusType → magyar (tömör szövegek) */
function osaVatStatusHu(x) {
  var m = {
    'DOMESTIC':       'belföldi áfaalany',
    'OTHER':          'EU áfaalany és egyéb',
    'PRIVATE_PERSON': 'magánszemély és EU-n kívüli'
  };
  return m[osaV(x)] || osaV(x);
}

/**
 * "Vevő neve" érték — ha hiányzik vagy n/a, PRIVATE_PERSON státusznál
 * pénznem szerinti placeholder-t ad vissza:
 *   HUF → "MAGYAR MAGÁNSZEMÉLY"
 *   más → "EU MAGÁNSZEMÉLY vagy EU-n kívüli"
 * Egyéb státusznál nem talál ki nevet — üres marad.
 */
function osaCustomerNameWithFallback(name, status, currency) {
  var n = osaV(name);
  if (n && n !== 'n/a') return n;
  if (osaV(status).toUpperCase() === 'PRIVATE_PERSON') {
    var cur = String(currency || '').toUpperCase().trim();
    return cur === 'HUF' ? 'MAGYAR MAGÁNSZEMÉLY' : 'EU MAGÁNSZEMÉLY vagy EU-n kívüli';
  }
  return n;
}

/** PaymentMethodType → magyar */
function osaPaymentMethodHu(x) {
  var m = {
    'TRANSFER': 'Banki átutalás',
    'CASH':     'Készpénz',
    'CARD':     'Bankkártya',
    'VOUCHER':  'Utalvány',
    'OTHER':    'Egyéb'
  };
  return m[osaV(x)] || osaV(x);
}

/** InvoiceCategoryType → magyar */
function osaInvoiceCategoryHu(x) {
  var m = {
    'NORMAL':     'Normál',
    'SIMPLIFIED': 'Egyszerűsített',
    'AGGREGATE':  'Gyűjtő'
  };
  return m[osaV(x)] || osaV(x);
}

/** UnitOfMeasureType → magyar rövidítés */
function osaUnitOfMeasureHu(x) {
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
  return m[osaV(x)] !== undefined ? m[osaV(x)] : osaV(x);
}

// ============================================================
// CÍM
// ============================================================

/**
 * Részletes cím (detailedAddress) "többi" mezőjének összefűzése
 * amikor az additionalAddressDetail nem elérhető.
 * Összefűzi: streetName + publicPlaceCategory + number + building + staircase + floor + door
 */
function osaDetailedAddressRest(addressEl) {
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

// ============================================================
// TÉTEL ÖSSZEG KALKULÁTOROK
// ============================================================

/**
 * Tétel szintű ÁFA összeg kiszámítása, ha a NAV nem küldte vissza.
 * Egyes számlázó programok a lineVatData-t elhagyják, ha a számla
 * currency=HUF és exchangeRate=1 (mert feleslegesnek tartják).
 * Fallback: nettó × vatPercentage, kerekítve 2 tizedesre.
 */
function osaCalcLineVat(lineEl) {
  var net  = parseFloat(navXmlText(lineEl, 'lineAmountsNormal lineNetAmountData lineNetAmount'));
  var pct  = parseFloat(navXmlText(lineEl, 'lineAmountsNormal lineVatRate vatPercentage'));
  if (isNaN(net) || isNaN(pct)) return '';
  return Math.round(net * pct * 100) / 100;
}

/**
 * Tétel szintű bruttó összeg kiszámítása, ha a NAV nem küldte vissza.
 * Fallback: nettó + ÁFA (számolt vagy kapott).
 */
function osaCalcLineGross(lineEl) {
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
function osaResolveAmounts(lineEl) {
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

  if (isNaN(net) && !isNaN(vat) && !isNaN(gross))  net   = Math.round((gross - vat)   * 100) / 100;
  if (isNaN(vat) && !isNaN(net) && !isNaN(gross))  vat   = Math.round((gross - net)   * 100) / 100;
  if (isNaN(gross) && !isNaN(net) && !isNaN(vat))  gross = Math.round((net   + vat)   * 100) / 100;

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
function osaResolveAmountsHUF(lineEl) {
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
    var deviza = osaResolveAmounts(lineEl);
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
