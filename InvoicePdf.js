/**
 * InvoicePdf.gs — Számla PDF generátor (NAV OSA 3.0)
 *
 * Architektúra:
 *   pdfExtract(root, num)      → adat-objektum (sablontól független)
 *   PDF_TEMPLATES[key].build(d) → HTML (5 db választható sablon)
 *   pdfShowDialog(...)         → preview + sablonváltó + PDF letöltés
 *   pdfRebuildForTemplate(...) → dialogból hívható backend, cache-elt XML-ből rebuild
 *
 * Sablonok:
 *   modern-blue  — kék kiemelésű, jelenlegi alapértelmezett
 *   classic      — fekete-fehér, szegélyezett, hagyományos magyar számla
 *   compact      — kis betű, sűrű tételsorok
 *   minimal-mono — minimalista monokróm, csak vékony vonalak
 *   corporate    — üzleti, arany kiemelés, ferde "ELEKTRONIKUS SZÁMLA" vízjel
 */

var PDF_BLUE      = '#2b6cb0';
var PDF_BLUE_DARK = '#1e4e8c';
var PDF_GREY      = '#718096';
var PDF_GREY_L    = '#a0aec0';
var PDF_BG        = '#f7fafc';
var PDF_BORDER    = '#e2e8f0';

var PDF_COUNTRY_HU = { 'HU': 'Magyarország', 'DE': 'Németország', 'AT': 'Ausztria',
  'SK': 'Szlovákia', 'RO': 'Románia', 'HR': 'Horvátország', 'SI': 'Szlovénia',
  'PL': 'Lengyelország', 'CZ': 'Csehország', 'IT': 'Olaszország',
  'FR': 'Franciaország', 'GB': 'Egyesült Királyság', 'US': 'USA', 'CN': 'Kína' };

// ============================================================
// SABLON REGISTRY
// ============================================================

var PDF_TEMPLATE_PROP    = 'INVOICE_PDF_TEMPLATE';
var PDF_DEFAULT_TEMPLATE = 'modern-blue';
var PDF_CACHE_PREFIX     = 'pdf_xml_';
var PDF_CACHE_TTL_SEC    = 3600;  // 1 óra

var PDF_TEMPLATES = {
  'modern-blue':  { label: 'Modern kék',          build: pdfBuildModernBlue  },
  'classic':      { label: 'Klasszikus',          build: pdfBuildClassic     },
  'compact':      { label: 'Tömör (1 oldalas)',   build: pdfBuildCompact     },
  'minimal-mono': { label: 'Minimalista (mono)',  build: pdfBuildMinimalMono },
  'corporate':    { label: 'Üzleti (vízjeles)',   build: pdfBuildCorporate   }
};

function pdfGetTemplate(key) {
  return PDF_TEMPLATES[key] ? key : PDF_DEFAULT_TEMPLATE;
}

function pdfGetSavedTemplateKey() {
  var v = PropertiesService.getScriptProperties().getProperty(PDF_TEMPLATE_PROP);
  return (v && PDF_TEMPLATES[v]) ? v : PDF_DEFAULT_TEMPLATE;
}

function pdfSaveTemplateKey(key) {
  if (PDF_TEMPLATES[key]) {
    PropertiesService.getScriptProperties().setProperty(PDF_TEMPLATE_PROP, key);
  }
}

// ============================================================
// BELÉPÉSI PONT
// ============================================================

function generateInvoicePdf(invoiceDataResult, templateKey) {
  if (!invoiceDataResult || !invoiceDataResult.invoiceXml) {
    SpreadsheetApp.getUi().alert('A számla nem tartalmaz XML adatokat. Nem készíthető PDF.');
    return;
  }

  var doc = XmlService.parse(invoiceDataResult.invoiceXml);

  try {
    var formatter = XmlService.getPrettyFormat().setIndent('\t');
    Logger.log("Számla XML (" + invoiceDataResult.invoiceNumber + "):\n" + formatter.format(doc));
  } catch(e) {
    Logger.log("Nem sikerült formázni az XML-t a loghoz.");
  }

  var root = doc.getRootElement();
  var data = pdfExtract(root, invoiceDataResult.invoiceNumber);

  var tplKey  = pdfGetTemplate(templateKey || pdfGetSavedTemplateKey());
  var invHtml = PDF_TEMPLATES[tplKey].build(data);
  var b64Pdf  = pdfHtmlToBase64Pdf(invHtml);

  var fileName = pdfBuildFileName(data, tplKey);

  // XML cache-elése a dialógus sablonváltáshoz
  try {
    CacheService.getUserCache().put(PDF_CACHE_PREFIX + data.invNum,
      invoiceDataResult.invoiceXml, PDF_CACHE_TTL_SEC);
  } catch(e) {
    Logger.log('PDF cache put hiba: ' + e.message);
  }

  pdfShowDialog(invHtml, b64Pdf, data.invNum, fileName, tplKey);
}

/**
 * Dialógusból hívott backend — sablonváltáskor újra renderel.
 * @param {string} invNum
 * @param {string} templateKey
 * @returns {{html:string, b64Pdf:string, fileName:string, templateKey:string}}
 */
function pdfRebuildForTemplate(invNum, templateKey) {
  var xml = CacheService.getUserCache().get(PDF_CACHE_PREFIX + invNum);
  if (!xml) {
    throw new Error('A cache-elt XML lejárt vagy nem található. Kérdezd le újra a számlát.');
  }
  var tplKey = pdfGetTemplate(templateKey);
  var doc    = XmlService.parse(xml);
  var data   = pdfExtract(doc.getRootElement(), invNum);
  var html   = PDF_TEMPLATES[tplKey].build(data);
  var b64Pdf = pdfHtmlToBase64Pdf(html);
  pdfSaveTemplateKey(tplKey);
  return {
    html:        html,
    b64Pdf:      b64Pdf,
    fileName:    pdfBuildFileName(data, tplKey),
    templateKey: tplKey
  };
}

function pdfHtmlToBase64Pdf(html) {
  return Utilities.base64Encode(
    Utilities.newBlob(html, MimeType.HTML, 'sz.html').getAs(MimeType.PDF).getBytes()
  );
}

function pdfBuildFileName(data, tplKey) {
  var shortSupName = (data.supName || 'Ismeretlen_Elado')
    .replace(/[^a-zA-Z0-9áéíóöőúüűÁÉÍÓÖŐÚÜŰ]/g, '')
    .substring(0, 15);
  return 'szamla_' + shortSupName + '_' + data.invNum + '_' + tplKey;
}

// ============================================================
// ADATKINYERÉS
// ============================================================

function pdfExtract(root, fallbackNum) {
  var detailEl   = navFindFirst(root, 'invoiceDetail');
  var supInfoEl  = navFindFirst(root, 'supplierInfo');
  var cusInfoEl  = navFindFirst(root, 'customerInfo');
  var summaryEl  = navFindFirst(root, 'invoiceSummary');
  var sumNormEl  = summaryEl ? navFindFirst(summaryEl, 'summaryNormal') : null;
  var sumSimpEl  = summaryEl ? navFindFirst(summaryEl, 'summarySimplified') : null;
  var sumGrossEl = summaryEl ? navFindFirst(summaryEl, 'summaryGrossData') : null;
  var modRefEl   = navFindFirst(root, 'invoiceReference');

  var currency = detailEl ? navXmlText(detailEl, 'currencyCode') : 'HUF';

  var netTotal   = pdfSumFrom(sumNormEl, 'invoiceNetAmount', 'invoiceNetAmountHUF');
  var vatTotal   = pdfSumFrom(sumNormEl, 'invoiceVatAmount', 'invoiceVatAmountHUF');
  var grossTotal = pdfSumFrom(sumGrossEl, 'invoiceGrossAmount', 'invoiceGrossAmountHUF');

  if (isNaN(netTotal) && sumSimpEl) {
    netTotal   = pdfSumFrom(sumSimpEl, 'invoiceNetAmount',   'invoiceNetAmountHUF');
    vatTotal   = pdfSumFrom(sumSimpEl, 'invoiceVatAmount',   'invoiceVatAmountHUF');
  }
  if (isNaN(grossTotal)) {
    grossTotal = parseFloat(navXmlText(root, 'invoiceGrossAmount')) || 0;
  }
  netTotal   = isNaN(netTotal)   ? 0 : netTotal;
  vatTotal   = isNaN(vatTotal)   ? 0 : vatTotal;
  grossTotal = isNaN(grossTotal) ? 0 : grossTotal;

  if (grossTotal > 0 && netTotal === 0) {
    var lines = navFindAll(root, 'line');
    for (var i = 0; i < lines.length; i++) {
      var a = osaResolveAmounts(lines[i]);
      if (typeof a.net === 'number') netTotal += a.net;
      if (typeof a.vat === 'number') vatTotal += a.vat;
    }
    netTotal = Math.round(netTotal * 100) / 100;
    vatTotal = Math.round(vatTotal * 100) / 100;
  }

  return {
    invNum:        navXmlText(root, 'invoiceNumber')                           || fallbackNum,
    issueDate:     navXmlText(root, 'invoiceIssueDate'),
    category:      detailEl ? navXmlText(detailEl, 'invoiceCategory')          : '',
    deliveryDate:  detailEl ? navXmlText(detailEl, 'invoiceDeliveryDate')      : '',
    deliveryPeriodStart: detailEl ? navXmlText(detailEl, 'invoiceDeliveryPeriodStart') : '',
    deliveryPeriodEnd:   detailEl ? navXmlText(detailEl, 'invoiceDeliveryPeriodEnd')   : '',
    paymentMethod: osaPaymentMethodHu(detailEl ? navXmlText(detailEl, 'paymentMethod') : ''),
    paymentDate:   detailEl ? navXmlText(detailEl, 'paymentDate')              : '',
    currency:      currency,
    exchangeRate:  detailEl ? navXmlText(detailEl, 'exchangeRate')             : '',
    cashAccounting:detailEl ? navXmlText(detailEl, 'cashAccountingIndicator')  : '',
    appearance:    detailEl ? navXmlText(detailEl, 'invoiceAppearance')        : '',

    isModification:        !!modRefEl,
    origInvoiceNumber:     modRefEl ? navXmlText(modRefEl, 'originalInvoiceNumber') : '',
    modificationIndex:     modRefEl ? navXmlText(modRefEl, 'modificationIndex')     : '',
    modifyWithoutMaster:   modRefEl ? navXmlText(modRefEl, 'modifyWithoutMaster')   : '',

    supName:       supInfoEl ? navXmlText(supInfoEl, 'supplierName')           : '',
    supTaxNum:     pdfTaxNum(supInfoEl, 'supplierTaxNumber'),
    supGroupTax:   pdfTaxNum(supInfoEl, 'groupMemberTaxNumber'),
    supCommVat:    supInfoEl ? navXmlText(supInfoEl, 'communityVatNumber')     : '',
    supBankAcc:    supInfoEl ? navXmlText(supInfoEl, 'supplierBankAccountNumber') : '',
    supAddr:       pdfParseAddr(supInfoEl ? navFindFirst(supInfoEl, 'supplierAddress') : null),

    cusName:       cusInfoEl ? navXmlText(cusInfoEl, 'customerName')           : '',
    cusTaxNum:     pdfTaxNum(cusInfoEl, 'customerTaxNumber'),
    cusCommVat:    cusInfoEl ? navXmlText(cusInfoEl, 'communityVatNumber')     : '',
    cusThirdTax:   cusInfoEl ? navXmlText(cusInfoEl, 'thirdStateTaxId')        : '',
    cusBankAcc:    cusInfoEl ? navXmlText(cusInfoEl, 'customerBankAccountNumber') : '',
    cusAddr:       pdfParseAddr(cusInfoEl ? navFindFirst(cusInfoEl, 'customerAddress') : null),

    netTotal:      netTotal,
    vatTotal:      vatTotal,
    grossTotal:    grossTotal,

    lines:         navFindAll(root, 'line')
  };
}

// ============================================================
// SEGÉDEK — adatkinyerés és formázás
// ============================================================

function pdfSumFrom(el, field, fieldHuf) {
  if (!el) return NaN;
  var v = parseFloat(navXmlText(el, field));
  if (!isNaN(v)) return v;
  return parseFloat(navXmlText(el, fieldHuf));
}

function pdfTaxNum(parentEl, tagName) {
  if (!parentEl) return '';
  var el = navFindFirst(parentEl, tagName);
  if (!el) return '';
  var id = navXmlText(el, 'taxpayerId');
  var vc = navXmlText(el, 'vatCode');
  var cc = navXmlText(el, 'countyCode');
  if (!id) return '';
  return id + (vc ? '-' + vc : '') + (cc ? '-' + cc : '');
}

function pdfParseAddr(addrEl) {
  if (!addrEl) return {};
  var simple   = navFindFirst(addrEl, 'simpleAddress');
  var detailed = navFindFirst(addrEl, 'detailedAddress');
  if (simple) {
    return {
      country:    pdfCountry(navXmlText(simple, 'countryCode')),
      postalCode: navXmlText(simple, 'postalCode'),
      city:       navXmlText(simple, 'city'),
      street:     navXmlText(simple, 'additionalAddressDetail')
    };
  }
  if (detailed) {
    return {
      country:    pdfCountry(navXmlText(detailed, 'countryCode')),
      postalCode: navXmlText(detailed, 'postalCode'),
      city:       navXmlText(detailed, 'city'),
      street:     [navXmlText(detailed, 'streetName'), navXmlText(detailed, 'publicPlaceCategory'),
                   navXmlText(detailed, 'number'), navXmlText(detailed, 'building'),
                   navXmlText(detailed, 'staircase'), navXmlText(detailed, 'floor'),
                   navXmlText(detailed, 'door')].filter(Boolean).join(' ')
    };
  }
  return {};
}

function pdfCountry(code) {
  if (!code) return '';
  return PDF_COUNTRY_HU[code.toUpperCase()] || code;
}

function pdfVatText(lineEl) {
  var vp = navXmlText(lineEl, 'lineAmountsNormal lineVatRate vatPercentage');
  if (vp) return Math.round(parseFloat(vp) * 100) + '%';
  var vc = navXmlText(lineEl, 'lineAmountsSimplified lineVatRate vatContent');
  if (vc) return Math.round(parseFloat(vc) * 100) + '%';
  var exempt = navFindFirst(lineEl, 'vatExemption');
  if (exempt) return 'Mentes';
  if (navXmlText(lineEl, 'domesticReverseCharge') === 'true') return 'FAD';
  if (navXmlText(lineEl, 'noVatCharge') === 'true') return 'TAM';
  return '';
}

function pdfFmt(n) {
  if (n == null || isNaN(n)) return '—';
  return Number(n).toLocaleString('hu-HU', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
}

function pdfAddrHtml(addr, sep) {
  sep = sep || '<br>';
  var parts = [];
  var cityLine = [addr.postalCode, addr.city].filter(Boolean).join(' ');
  if (cityLine)     parts.push(cityLine);
  if (addr.street)  parts.push(addr.street);
  if (addr.country) parts.push(addr.country);
  return parts.join(sep);
}

/** Egységes tételsor-objektum a sablonoknak (HTML render előtti, sablontól független adat). */
function pdfLineInfo(line, currency) {
  var a = osaResolveAmounts(line);
  return {
    qty:       osaNumParse(navXmlText(line, 'quantity')),
    uom:       navXmlText(line, 'unitOfMeasureOwn') || osaUnitOfMeasureHu(navXmlText(line, 'unitOfMeasure')),
    desc:      navXmlText(line, 'lineDescription'),
    unitPrice: osaNumParse(navXmlText(line, 'unitPrice')),
    nature:    navXmlText(line, 'lineNatureIndicator'),
    modOp:     navXmlText(line, 'lineModificationReference lineOperation'),
    net:       a.net,
    vat:       a.vat,
    gross:     a.gross,
    vatText:   pdfVatText(line),
    currency:  currency
  };
}

// ============================================================
// SABLON 1 — MODERN BLUE (alapértelmezett)
// ============================================================

function pdfBuildModernBlue(d) {
  var css =
    'body{font-family:Arial,sans-serif;font-size:11px;color:#333;margin:24px}' +
    '.header{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:4px}' +
    '.h-left h1{font-size:22px;font-weight:normal;margin:0 0 2px 0}' +
    '.h-right{text-align:right;font-size:10px;color:' + PDF_GREY + '}' +
    '.h-right .inv-label{text-transform:uppercase;font-size:8px;color:' + PDF_GREY_L + '}' +
    '.h-right .inv-num{font-size:13px;font-weight:bold;color:#333}' +
    '.divider{border:0;border-top:1.5px solid ' + PDF_BLUE + ';margin:12px 0}' +
    '.info-table{width:100%;border-collapse:collapse}' +
    '.party{width:50%;vertical-align:top;padding-right:20px}' +
    '.lbl{font-size:8px;text-transform:uppercase;color:' + PDF_GREY + ';margin-bottom:4px}' +
    '.pname{font-size:15px;font-weight:bold;margin-bottom:6px}' +
    '.addr{line-height:1.55;margin-bottom:10px;color:#555}' +
    '.dr{display:flex;margin-bottom:2px}' +
    '.dl{font-size:8px;text-transform:uppercase;color:' + PDF_GREY + ';width:115px;flex-shrink:0}' +
    '.dv{font-size:10px;color:' + PDF_GREY_L + '}' +
    '.dates-table{width:100%;border-collapse:collapse;font-size:11px}' +
    '.dates-table td{width:50%;padding:2px 0;vertical-align:top}' +
    '.dates-label{font-size:8px;text-transform:uppercase;color:' + PDF_GREY + ';display:inline-block;min-width:120px}' +
    '.dates-value{font-weight:bold}' +
    '.mod-bar{background:#ebf4ff;border-left:3px solid ' + PDF_BLUE + ';padding:6px 10px;margin-bottom:8px;font-size:10px}' +
    '.total-box{text-align:right;margin:10px 0 6px 0}' +
    '.total-label{text-transform:uppercase;color:' + PDF_BLUE + ';font-size:9px;font-weight:bold;margin-right:10px}' +
    '.total-amount{font-size:30px;font-weight:normal;color:#000}' +
    '.items-table{width:100%;border-collapse:collapse;font-size:10px;margin-top:8px}' +
    '.items-table th{background:' + PDF_BG + ';padding:7px 5px;text-align:right;text-transform:uppercase;' +
                    'font-size:8px;border-bottom:1.5px solid ' + PDF_BORDER + ';color:' + PDF_GREY + '}' +
    '.items-table th:nth-child(1),.items-table th:nth-child(2){text-align:left}' +
    '.items-table td{padding:7px 5px;border-bottom:1px solid ' + PDF_BORDER + ';vertical-align:top}' +
    '.items-table td:first-child{width:28px}' +
    '.nat{font-size:8px;color:' + PDF_GREY_L + ';margin-top:2px}' +
    '.badge{font-size:8px;background:#ebf4ff;color:' + PDF_BLUE + ';padding:1px 4px;border-radius:3px;margin-left:5px}' +
    '.summary-table{width:100%;border-collapse:collapse;margin-top:6px;font-size:10px}' +
    '.summary-table td{padding:3px 5px;text-align:right}' +
    '.summary-table td:first-child{font-size:8px;text-transform:uppercase;color:' + PDF_GREY + ';width:82%;text-align:right}' +
    '.center{text-align:center}.right{text-align:right}.blue{color:' + PDF_BLUE + '}' +
    '.footer-note{margin-top:12px;font-size:9px;color:' + PDF_GREY_L + '}';

  function dRow(label, value) {
    if (!value) return '';
    return '<div class="dr"><span class="dl">' + label + ':</span><span class="dv">' + value + '</span></div>';
  }
  function partyHtml(title, name, addr, rows) {
    return '<td class="party">' +
      '<div class="lbl">' + title + '</div>' +
      '<div class="pname">' + (name || '—') + '</div>' +
      '<div class="addr">' + pdfAddrHtml(addr) + '</div>' +
      (rows || '') + '</td>';
  }

  var header =
    '<div class="header">' +
      '<div class="h-left"><h1>Elektronikus számla</h1></div>' +
      '<div class="h-right"><div class="inv-label">Számla sorszáma</div>' +
      '<div class="inv-num">' + d.invNum + '</div></div></div>';

  var modBar = '';
  if (d.isModification) {
    modBar = '<div class="mod-bar">⚠ Ez a számla módosítás — Eredeti számla: <strong>' +
      d.origInvoiceNumber + '</strong>' +
      (d.modificationIndex ? ' · Módosítás sorsz.: ' + d.modificationIndex : '') + '</div>';
  }

  var parties =
    '<table class="info-table"><tr>' +
      partyHtml('Eladó', d.supName, d.supAddr,
        dRow('Adószám', d.supTaxNum) + dRow('Csoporttag adószám', d.supGroupTax) +
        dRow('Közösségi adószám', d.supCommVat) + dRow('Bankszámlaszám', d.supBankAcc)) +
      partyHtml('Vevő', d.cusName, d.cusAddr,
        dRow('Adószám', d.cusTaxNum) + dRow('Közösségi adószám', d.cusCommVat) +
        dRow('Harmadik o. adószám', d.cusThirdTax) + dRow('Bankszámlaszám', d.cusBankAcc)) +
    '</tr></table>';

  function dtRow(l1, v1, l2, v2) {
    return '<tr><td><span class="dates-label">' + l1 + '</span><span class="dates-value">' + (v1 || '—') +
      '</span></td><td><span class="dates-label">' + l2 + '</span><span class="dates-value">' + (v2 || '—') + '</span></td></tr>';
  }
  var periodText = (d.deliveryPeriodStart && d.deliveryPeriodEnd)
    ? d.deliveryPeriodStart + ' – ' + d.deliveryPeriodEnd : '';

  var dates =
    '<table class="dates-table">' +
      dtRow('Számla kelte:',   d.issueDate,   'Fizetési határidő:', d.paymentDate) +
      dtRow('Teljesítés:',     d.deliveryDate,'Fizetési mód:',      d.paymentMethod) +
      (periodText ? dtRow('Teljesítési időszak:', periodText, 'Árfolyam:',
        d.exchangeRate ? d.exchangeRate + ' (HUF/' + d.currency + ')' : '') : '') +
    '</table>';

  var totalBox =
    '<div class="total-box">' +
      '<span class="total-label">Fizetendő bruttó végösszeg:</span>' +
      '<span class="total-amount">' + pdfFmt(d.grossTotal) + ' ' + d.currency + '</span>' +
    '</div>';

  var itemRows = '';
  for (var i = 0; i < d.lines.length; i++) {
    var li = pdfLineInfo(d.lines[i], d.currency);
    var modBadge = li.modOp ? ' <span class="badge">' + li.modOp + '</span>' : '';
    itemRows += '<tr>' +
      '<td class="center blue">' + (i + 1) + '</td>' +
      '<td>' + li.desc + modBadge +
        (li.nature ? '<div class="nat">' + (li.nature === 'SERVICE' ? 'Szolgáltatás' : 'Termék') + '</div>' : '') + '</td>' +
      '<td class="right">' + pdfFmt(li.qty) + (li.uom ? ' ' + li.uom : '') + '</td>' +
      '<td class="right">' + (li.unitPrice !== '' ? pdfFmt(li.unitPrice) + ' ' + li.currency : '—') + '</td>' +
      '<td class="right">' + (li.net !== '' ? pdfFmt(li.net) + ' ' + li.currency : '—') + '</td>' +
      '<td class="right">' + li.vatText + '</td>' +
      '<td class="right">' + (li.gross !== '' ? pdfFmt(li.gross) + ' ' + li.currency : '—') + '</td>' +
    '</tr>';
  }
  var itemsTable =
    '<table class="items-table"><thead><tr><th></th><th>Megnevezés</th><th>Mennyiség</th>' +
    '<th>Egységár</th><th>Nettó ár</th><th>ÁFA</th><th>Bruttó ár</th></tr></thead><tbody>' +
    itemRows + '</tbody></table>';

  var summary =
    '<table class="summary-table">' +
      '<tr><td>Nettó összeg:</td><td>' + pdfFmt(d.netTotal) + ' ' + d.currency + '</td></tr>' +
      '<tr><td>ÁFA:</td><td>' + pdfFmt(d.vatTotal) + ' ' + d.currency + '</td></tr>' +
      '<tr><td><strong>Fizetendő bruttó végösszeg:</strong></td><td><strong>' + pdfFmt(d.grossTotal) + ' ' + d.currency + '</strong></td></tr>' +
    '</table>';

  var footer = '';
  if (d.cashAccounting) footer += dRow('Pénzforgalmi elszámolás', d.cashAccounting === 'true' ? 'Igen' : '');
  if (d.appearance)     footer += dRow('Számla megjelenési formája', d.appearance);

  return '<!DOCTYPE html><html><head><meta charset="UTF-8"><style>' + css + '</style></head><body>' +
    header + modBar + '<hr class="divider">' + parties + '<hr class="divider">' + dates +
    '<hr class="divider">' + totalBox + itemsTable + '<hr class="divider">' + summary +
    (footer ? '<hr class="divider"><div class="footer-note">' + footer + '</div>' : '') +
    '</body></html>';
}

// ============================================================
// SABLON 2 — CLASSIC (fekete-fehér, szegélyezett)
// ============================================================

function pdfBuildClassic(d) {
  var css =
    'body{font-family:"Times New Roman",Times,serif;font-size:11px;color:#000;margin:24px}' +
    'h1{text-align:center;font-size:24px;letter-spacing:6px;margin:0 0 4px 0}' +
    '.sub{text-align:center;font-size:10px;letter-spacing:2px;color:#444;margin-bottom:14px}' +
    'table{border-collapse:collapse;width:100%}' +
    '.party-tbl td{vertical-align:top;width:50%;border:1px solid #000;padding:8px}' +
    '.party-tbl .ttl{font-weight:bold;text-transform:uppercase;font-size:10px;border-bottom:1px solid #000;margin-bottom:4px;padding-bottom:2px}' +
    '.party-tbl .nm{font-size:13px;font-weight:bold;margin-bottom:4px}' +
    '.detail{font-size:10px;margin-top:2px}' +
    '.detail b{display:inline-block;width:130px}' +
    '.dates-tbl{margin-top:10px}' +
    '.dates-tbl td{border:1px solid #000;padding:5px 8px;font-size:11px}' +
    '.dates-tbl .lbl{font-weight:bold;width:140px;background:#f0f0f0}' +
    '.items-tbl{margin-top:14px}' +
    '.items-tbl th,.items-tbl td{border:1px solid #000;padding:4px 6px;font-size:10px}' +
    '.items-tbl th{background:#e0e0e0;font-weight:bold;text-align:center}' +
    '.items-tbl td.r{text-align:right}.items-tbl td.c{text-align:center}' +
    '.sum-tbl{margin-top:10px;width:50%;margin-left:auto}' +
    '.sum-tbl td{border:1px solid #000;padding:5px 8px;font-size:11px}' +
    '.sum-tbl .lbl{font-weight:bold;background:#f0f0f0}' +
    '.sum-tbl .grand{font-weight:bold;font-size:13px;background:#000;color:#fff}' +
    '.mod-bar{border:2px solid #000;padding:6px;margin:8px 0;font-size:10px;text-align:center}' +
    '.footer{margin-top:14px;font-size:9px;text-align:center;color:#444;border-top:1px solid #000;padding-top:6px}';

  function detail(lbl, v) { return v ? '<div class="detail"><b>' + lbl + ':</b> ' + v + '</div>' : ''; }
  function partyCell(ttl, name, addr, extras) {
    return '<td><div class="ttl">' + ttl + '</div><div class="nm">' + (name || '—') + '</div>' +
      '<div>' + pdfAddrHtml(addr, '<br>') + '</div>' + extras + '</td>';
  }

  var header = '<h1>S Z Á M L A</h1><div class="sub">Sorszám: ' + d.invNum + '</div>';

  var modBar = d.isModification
    ? '<div class="mod-bar">MÓDOSÍTÓ SZÁMLA — eredeti: <b>' + d.origInvoiceNumber + '</b>' +
      (d.modificationIndex ? ' · sorsz.: ' + d.modificationIndex : '') + '</div>'
    : '';

  var parties =
    '<table class="party-tbl"><tr>' +
      partyCell('Eladó (kibocsátó)', d.supName, d.supAddr,
        detail('Adószám', d.supTaxNum) + detail('Csoporttag adószám', d.supGroupTax) +
        detail('Közösségi adószám', d.supCommVat) + detail('Bankszámla', d.supBankAcc)) +
      partyCell('Vevő', d.cusName, d.cusAddr,
        detail('Adószám', d.cusTaxNum) + detail('Közösségi adószám', d.cusCommVat) +
        detail('Harmadik o. adószám', d.cusThirdTax) + detail('Bankszámla', d.cusBankAcc)) +
    '</tr></table>';

  function dRow(l, v) { return '<tr><td class="lbl">' + l + '</td><td>' + (v || '—') + '</td></tr>'; }
  var periodText = (d.deliveryPeriodStart && d.deliveryPeriodEnd)
    ? d.deliveryPeriodStart + ' – ' + d.deliveryPeriodEnd : '';
  var dates =
    '<table class="dates-tbl">' +
      dRow('Számla kelte',       d.issueDate) +
      dRow('Teljesítés dátuma',  d.deliveryDate) +
      (periodText ? dRow('Teljesítési időszak', periodText) : '') +
      dRow('Fizetési határidő',  d.paymentDate) +
      dRow('Fizetési mód',       d.paymentMethod) +
      (d.exchangeRate ? dRow('Árfolyam', d.exchangeRate + ' HUF/' + d.currency) : '') +
    '</table>';

  var itemRows = '';
  for (var i = 0; i < d.lines.length; i++) {
    var li = pdfLineInfo(d.lines[i], d.currency);
    itemRows += '<tr>' +
      '<td class="c">' + (i + 1) + '</td>' +
      '<td>' + li.desc + (li.modOp ? ' [' + li.modOp + ']' : '') + '</td>' +
      '<td class="r">' + pdfFmt(li.qty) + '</td>' +
      '<td class="c">' + (li.uom || '') + '</td>' +
      '<td class="r">' + (li.unitPrice !== '' ? pdfFmt(li.unitPrice) : '—') + '</td>' +
      '<td class="r">' + (li.net !== '' ? pdfFmt(li.net) : '—') + '</td>' +
      '<td class="c">' + li.vatText + '</td>' +
      '<td class="r">' + (li.vat !== '' ? pdfFmt(li.vat) : '—') + '</td>' +
      '<td class="r">' + (li.gross !== '' ? pdfFmt(li.gross) : '—') + '</td>' +
    '</tr>';
  }
  var itemsTable =
    '<table class="items-tbl"><thead><tr>' +
      '<th>#</th><th>Megnevezés</th><th>Menny.</th><th>Mértékegys.</th>' +
      '<th>Egységár</th><th>Nettó</th><th>ÁFA%</th><th>ÁFA</th><th>Bruttó</th>' +
    '</tr></thead><tbody>' + itemRows + '</tbody></table>';

  var sum =
    '<table class="sum-tbl">' +
      '<tr><td class="lbl">Nettó összesen</td><td>' + pdfFmt(d.netTotal) + ' ' + d.currency + '</td></tr>' +
      '<tr><td class="lbl">ÁFA összesen</td><td>' + pdfFmt(d.vatTotal) + ' ' + d.currency + '</td></tr>' +
      '<tr><td class="grand">FIZETENDŐ</td><td class="grand">' + pdfFmt(d.grossTotal) + ' ' + d.currency + '</td></tr>' +
    '</table>';

  var footer = '';
  if (d.cashAccounting === 'true') footer += 'Pénzforgalmi elszámolás. ';
  if (d.appearance) footer += 'Megjelenés: ' + d.appearance + '. ';

  return '<!DOCTYPE html><html><head><meta charset="UTF-8"><style>' + css + '</style></head><body>' +
    header + modBar + parties + dates + itemsTable + sum +
    (footer ? '<div class="footer">' + footer + '</div>' : '') +
    '</body></html>';
}

// ============================================================
// SABLON 3 — COMPACT (1 oldalas, sűrű tételek)
// ============================================================

function pdfBuildCompact(d) {
  var css =
    'body{font-family:Arial,sans-serif;font-size:9px;color:#222;margin:12px}' +
    'h1{font-size:14px;margin:0;display:inline-block}' +
    '.top{display:flex;justify-content:space-between;align-items:baseline;border-bottom:2px solid #333;padding-bottom:4px;margin-bottom:6px}' +
    '.inv{font-size:11px;font-weight:bold}' +
    '.mod{background:#fffbea;border:1px dashed #d69e2e;padding:3px 6px;margin-bottom:5px;font-size:8px}' +
    '.row{display:flex;gap:12px;margin-bottom:5px}' +
    '.box{flex:1;border:1px solid #ddd;padding:5px 6px}' +
    '.box .t{font-size:7px;text-transform:uppercase;color:#666;margin-bottom:2px;letter-spacing:1px}' +
    '.box .n{font-weight:bold;font-size:11px}' +
    '.box .a{font-size:8px;color:#333;line-height:1.35}' +
    '.box .d{font-size:8px;color:#555;margin-top:2px}' +
    '.box .d b{display:inline-block;min-width:70px;color:#666;font-weight:normal}' +
    '.meta{display:flex;flex-wrap:wrap;gap:4px 14px;font-size:8px;margin-bottom:5px}' +
    '.meta .k{color:#666}.meta .v{font-weight:bold}' +
    'table.it{width:100%;border-collapse:collapse;font-size:8px}' +
    'table.it th{background:#333;color:#fff;padding:3px 4px;text-align:right;font-weight:normal}' +
    'table.it th:nth-child(1),table.it th:nth-child(2){text-align:left}' +
    'table.it td{padding:2px 4px;border-bottom:1px solid #eee}' +
    'table.it td.r{text-align:right}.it td.c{text-align:center}' +
    '.grand{margin-top:6px;text-align:right;font-size:13px;font-weight:bold;border-top:2px solid #333;padding-top:4px}' +
    '.sub{font-size:8px;color:#666;text-align:right;margin-top:2px}';

  function detail(lbl, v) { return v ? '<div class="d"><b>' + lbl + '</b>' + v + '</div>' : ''; }

  var header =
    '<div class="top"><h1>Számla</h1><span class="inv">' + d.invNum +
    ' · ' + (d.issueDate || '—') + '</span></div>';

  var mod = d.isModification
    ? '<div class="mod">Módosítás · eredeti: ' + d.origInvoiceNumber +
      (d.modificationIndex ? ' / #' + d.modificationIndex : '') + '</div>'
    : '';

  var parties =
    '<div class="row">' +
      '<div class="box"><div class="t">Eladó</div><div class="n">' + (d.supName || '—') + '</div>' +
        '<div class="a">' + pdfAddrHtml(d.supAddr) + '</div>' +
        detail('Adósz.', d.supTaxNum) + detail('Közöss.', d.supCommVat) +
        detail('Bank', d.supBankAcc) + '</div>' +
      '<div class="box"><div class="t">Vevő</div><div class="n">' + (d.cusName || '—') + '</div>' +
        '<div class="a">' + pdfAddrHtml(d.cusAddr) + '</div>' +
        detail('Adósz.', d.cusTaxNum) + detail('Közöss.', d.cusCommVat) +
        detail('Bank', d.cusBankAcc) + '</div>' +
    '</div>';

  var meta = '<div class="meta">' +
    '<div><span class="k">Telj.:</span> <span class="v">' + (d.deliveryDate || '—') + '</span></div>' +
    '<div><span class="k">Fiz. hat.:</span> <span class="v">' + (d.paymentDate || '—') + '</span></div>' +
    '<div><span class="k">Mód:</span> <span class="v">' + (d.paymentMethod || '—') + '</span></div>' +
    '<div><span class="k">Pénznem:</span> <span class="v">' + d.currency + '</span></div>' +
    (d.exchangeRate ? '<div><span class="k">Árf.:</span> <span class="v">' + d.exchangeRate + '</span></div>' : '') +
    '</div>';

  var itemRows = '';
  for (var i = 0; i < d.lines.length; i++) {
    var li = pdfLineInfo(d.lines[i], d.currency);
    itemRows += '<tr>' +
      '<td class="c">' + (i + 1) + '</td>' +
      '<td>' + li.desc + (li.modOp ? ' (' + li.modOp + ')' : '') + '</td>' +
      '<td class="r">' + pdfFmt(li.qty) + (li.uom ? ' ' + li.uom : '') + '</td>' +
      '<td class="r">' + (li.unitPrice !== '' ? pdfFmt(li.unitPrice) : '—') + '</td>' +
      '<td class="r">' + (li.net !== '' ? pdfFmt(li.net) : '—') + '</td>' +
      '<td class="c">' + li.vatText + '</td>' +
      '<td class="r">' + (li.gross !== '' ? pdfFmt(li.gross) : '—') + '</td>' +
    '</tr>';
  }
  var itemsTable = '<table class="it"><thead><tr>' +
    '<th>#</th><th>Megnevezés</th><th>Menny.</th><th>Egységár</th>' +
    '<th>Nettó</th><th>ÁFA</th><th>Bruttó</th></tr></thead><tbody>' + itemRows + '</tbody></table>';

  var sum =
    '<div class="grand">' + pdfFmt(d.grossTotal) + ' ' + d.currency + ' fizetendő</div>' +
    '<div class="sub">Nettó: ' + pdfFmt(d.netTotal) + ' · ÁFA: ' + pdfFmt(d.vatTotal) + ' ' + d.currency + '</div>';

  return '<!DOCTYPE html><html><head><meta charset="UTF-8"><style>' + css + '</style></head><body>' +
    header + mod + parties + meta + itemsTable + sum + '</body></html>';
}

// ============================================================
// SABLON 4 — MINIMAL MONO (csak vékony vonalak, fekete-fehér)
// ============================================================

function pdfBuildMinimalMono(d) {
  var css =
    'body{font-family:"Helvetica Neue",Helvetica,Arial,sans-serif;font-size:11px;color:#111;margin:36px;line-height:1.5}' +
    '.h{display:flex;justify-content:space-between;align-items:flex-end;border-bottom:1px solid #111;padding-bottom:10px;margin-bottom:18px}' +
    '.h h1{margin:0;font-size:11px;font-weight:normal;letter-spacing:5px;text-transform:uppercase}' +
    '.h .n{font-size:18px;font-weight:300;letter-spacing:1px}' +
    '.parties{display:flex;gap:40px;margin-bottom:24px}' +
    '.parties .col{flex:1}' +
    '.parties .lab{font-size:9px;letter-spacing:3px;text-transform:uppercase;color:#666;margin-bottom:6px}' +
    '.parties .nm{font-size:13px;font-weight:500;margin-bottom:3px}' +
    '.parties .a{color:#444;font-size:10px}' +
    '.parties .e{font-size:10px;color:#666;margin-top:4px}' +
    '.parties .e b{display:inline-block;min-width:90px;font-weight:normal;color:#999}' +
    '.dates{display:flex;flex-wrap:wrap;gap:18px 30px;margin-bottom:22px;font-size:10px}' +
    '.dates .lab{display:block;font-size:8px;letter-spacing:2px;text-transform:uppercase;color:#888;margin-bottom:2px}' +
    '.dates .val{font-size:12px}' +
    '.mod{font-size:10px;color:#666;padding:4px 0;border-top:1px dotted #aaa;border-bottom:1px dotted #aaa;margin-bottom:14px}' +
    'table.it{width:100%;border-collapse:collapse;font-size:10px}' +
    'table.it th{font-weight:normal;text-align:right;padding:6px 4px;border-bottom:1px solid #111;text-transform:uppercase;font-size:8px;letter-spacing:1px;color:#666}' +
    'table.it th:nth-child(1),table.it th:nth-child(2){text-align:left}' +
    'table.it td{padding:5px 4px;border-bottom:1px dotted #ccc;vertical-align:top}' +
    'table.it td.r{text-align:right}.it td.c{text-align:center}' +
    '.grand{margin-top:18px;display:flex;justify-content:flex-end;align-items:baseline;gap:14px}' +
    '.grand .lab{font-size:9px;letter-spacing:3px;text-transform:uppercase;color:#666}' +
    '.grand .v{font-size:22px;font-weight:300}' +
    '.subline{margin-top:4px;text-align:right;font-size:10px;color:#666}';

  var header =
    '<div class="h"><h1>Számla</h1><span class="n">' + d.invNum + '</span></div>';

  var mod = d.isModification
    ? '<div class="mod">Módosítás · eredeti számla: ' + d.origInvoiceNumber +
      (d.modificationIndex ? ' (' + d.modificationIndex + '.)' : '') + '</div>'
    : '';

  function extra(lbl, v) { return v ? '<div class="e"><b>' + lbl + '</b>' + v + '</div>' : ''; }

  var parties = '<div class="parties">' +
    '<div class="col"><div class="lab">Eladó</div>' +
      '<div class="nm">' + (d.supName || '—') + '</div>' +
      '<div class="a">' + pdfAddrHtml(d.supAddr) + '</div>' +
      extra('Adószám',        d.supTaxNum) +
      extra('Közösségi a.',   d.supCommVat) +
      extra('Bankszámla',     d.supBankAcc) +
    '</div>' +
    '<div class="col"><div class="lab">Vevő</div>' +
      '<div class="nm">' + (d.cusName || '—') + '</div>' +
      '<div class="a">' + pdfAddrHtml(d.cusAddr) + '</div>' +
      extra('Adószám',        d.cusTaxNum) +
      extra('Közösségi a.',   d.cusCommVat) +
      extra('Bankszámla',     d.cusBankAcc) +
    '</div></div>';

  function dCol(lbl, v) {
    return '<div><span class="lab">' + lbl + '</span><span class="val">' + (v || '—') + '</span></div>';
  }
  var dates = '<div class="dates">' +
    dCol('Számla kelte', d.issueDate) +
    dCol('Teljesítés',   d.deliveryDate) +
    dCol('Fiz. határidő', d.paymentDate) +
    dCol('Fiz. mód',     d.paymentMethod) +
    (d.exchangeRate ? dCol('Árfolyam', d.exchangeRate + ' HUF/' + d.currency) : '') +
    '</div>';

  var itemRows = '';
  for (var i = 0; i < d.lines.length; i++) {
    var li = pdfLineInfo(d.lines[i], d.currency);
    itemRows += '<tr>' +
      '<td class="c">' + (i + 1) + '</td>' +
      '<td>' + li.desc + '</td>' +
      '<td class="r">' + pdfFmt(li.qty) + (li.uom ? ' ' + li.uom : '') + '</td>' +
      '<td class="r">' + (li.unitPrice !== '' ? pdfFmt(li.unitPrice) : '—') + '</td>' +
      '<td class="r">' + (li.net !== '' ? pdfFmt(li.net) : '—') + '</td>' +
      '<td class="r">' + li.vatText + '</td>' +
      '<td class="r">' + (li.gross !== '' ? pdfFmt(li.gross) : '—') + '</td>' +
    '</tr>';
  }
  var itemsTable = '<table class="it"><thead><tr>' +
    '<th></th><th>Megnevezés</th><th>Mennyiség</th><th>Egységár</th>' +
    '<th>Nettó</th><th>ÁFA</th><th>Bruttó</th></tr></thead><tbody>' + itemRows + '</tbody></table>';

  var sum = '<div class="grand"><span class="lab">Fizetendő</span>' +
    '<span class="v">' + pdfFmt(d.grossTotal) + ' ' + d.currency + '</span></div>' +
    '<div class="subline">Nettó ' + pdfFmt(d.netTotal) + ' + ÁFA ' + pdfFmt(d.vatTotal) + ' ' + d.currency + '</div>';

  return '<!DOCTYPE html><html><head><meta charset="UTF-8"><style>' + css + '</style></head><body>' +
    header + mod + parties + dates + itemsTable + sum + '</body></html>';
}

// ============================================================
// SABLON 5 — CORPORATE (arany kiemelés, ferde vízjel)
// ============================================================

function pdfBuildCorporate(d) {
  var GOLD = '#b8860b';
  var SLATE = '#2c3e50';
  var SLATE_L = '#5a6c7d';

  var css =
    'body{font-family:Georgia,"Times New Roman",serif;font-size:11px;color:' + SLATE + ';margin:28px;position:relative}' +
    '.watermark{position:fixed;top:35%;left:5%;font-size:80px;color:rgba(184,134,11,0.06);' +
      'transform:rotate(-28deg);letter-spacing:10px;font-weight:bold;text-transform:uppercase;z-index:-1;white-space:nowrap}' +
    '.head{display:flex;justify-content:space-between;align-items:center;padding-bottom:10px;border-bottom:3px double ' + GOLD + '}' +
    '.head .logo{font-family:Georgia,serif;font-size:22px;font-weight:bold;color:' + SLATE + ';letter-spacing:1px}' +
    '.head .logo small{display:block;font-size:9px;font-weight:normal;color:' + GOLD + ';letter-spacing:6px;margin-top:2px;text-transform:uppercase}' +
    '.head .right{text-align:right}' +
    '.head .right .t{font-size:9px;letter-spacing:3px;text-transform:uppercase;color:' + GOLD + '}' +
    '.head .right .n{font-size:16px;font-weight:bold;color:' + SLATE + '}' +
    '.head .right .dt{font-size:9px;color:' + SLATE_L + ';margin-top:2px}' +
    '.mod{margin-top:8px;background:' + GOLD + ';color:#fff;padding:5px 10px;font-size:10px;text-align:center;letter-spacing:1px}' +
    '.parties{display:flex;gap:16px;margin-top:18px}' +
    '.parties .col{flex:1;background:#fafaf6;border-left:3px solid ' + GOLD + ';padding:10px 12px}' +
    '.parties .lab{font-size:9px;color:' + GOLD + ';letter-spacing:4px;text-transform:uppercase;margin-bottom:4px}' +
    '.parties .nm{font-size:14px;font-weight:bold;color:' + SLATE + ';margin-bottom:4px}' +
    '.parties .a{font-size:10px;color:' + SLATE_L + ';line-height:1.5}' +
    '.parties .e{font-size:9px;color:' + SLATE_L + ';margin-top:3px}' +
    '.parties .e b{display:inline-block;min-width:85px;color:' + SLATE + ';font-weight:normal;font-style:italic}' +
    '.dates{margin-top:16px;background:' + SLATE + ';color:#fff;padding:8px 12px;display:flex;flex-wrap:wrap;gap:8px 22px;font-size:10px}' +
    '.dates .lab{display:block;color:' + GOLD + ';font-size:8px;letter-spacing:2px;text-transform:uppercase;margin-bottom:1px}' +
    '.dates .v{font-weight:bold;font-size:11px}' +
    'table.it{width:100%;border-collapse:collapse;margin-top:14px;font-size:10px}' +
    'table.it th{background:' + SLATE + ';color:#fff;padding:7px 5px;text-align:right;font-weight:normal;font-size:9px;letter-spacing:1px;text-transform:uppercase}' +
    'table.it th:nth-child(1),table.it th:nth-child(2){text-align:left}' +
    'table.it tbody tr:nth-child(even){background:#fafaf6}' +
    'table.it td{padding:6px 5px;border-bottom:1px solid #e8e3d3}' +
    'table.it td.r{text-align:right}.it td.c{text-align:center}' +
    '.total-card{margin-top:14px;background:' + SLATE + ';color:#fff;padding:14px 18px;display:flex;justify-content:space-between;align-items:center;border-bottom:4px solid ' + GOLD + '}' +
    '.total-card .lab{font-size:10px;letter-spacing:4px;text-transform:uppercase;color:' + GOLD + '}' +
    '.total-card .v{font-size:24px;font-weight:bold}' +
    '.summary{margin-top:8px;display:flex;justify-content:flex-end;gap:30px;font-size:10px;color:' + SLATE_L + '}' +
    '.summary b{color:' + SLATE + '}' +
    '.footer{margin-top:16px;text-align:center;font-size:9px;color:' + SLATE_L + ';border-top:1px solid ' + GOLD + ';padding-top:6px;font-style:italic}';

  function extra(lbl, v) { return v ? '<div class="e"><b>' + lbl + '</b>' + v + '</div>' : ''; }
  function dCol(lbl, v) {
    return '<div><span class="lab">' + lbl + '</span><span class="v">' + (v || '—') + '</span></div>';
  }

  var watermark = '<div class="watermark">Elektronikus Számla</div>';

  var supLogo = (d.supName || 'Számla').substring(0, 26);
  var header =
    '<div class="head">' +
      '<div class="logo">' + supLogo + '<small>Elektronikus Számla</small></div>' +
      '<div class="right">' +
        '<div class="t">Sorszám</div>' +
        '<div class="n">' + d.invNum + '</div>' +
        '<div class="dt">' + (d.issueDate || '') + '</div>' +
      '</div>' +
    '</div>';

  var mod = d.isModification
    ? '<div class="mod">Módosító számla · Eredeti: ' + d.origInvoiceNumber +
      (d.modificationIndex ? ' · ' + d.modificationIndex + '.' : '') + '</div>'
    : '';

  var parties = '<div class="parties">' +
    '<div class="col"><div class="lab">Eladó</div>' +
      '<div class="nm">' + (d.supName || '—') + '</div>' +
      '<div class="a">' + pdfAddrHtml(d.supAddr) + '</div>' +
      extra('Adószám', d.supTaxNum) + extra('Közösségi', d.supCommVat) + extra('Bankszámla', d.supBankAcc) +
    '</div>' +
    '<div class="col"><div class="lab">Vevő</div>' +
      '<div class="nm">' + (d.cusName || '—') + '</div>' +
      '<div class="a">' + pdfAddrHtml(d.cusAddr) + '</div>' +
      extra('Adószám', d.cusTaxNum) + extra('Közösségi', d.cusCommVat) + extra('Bankszámla', d.cusBankAcc) +
    '</div></div>';

  var dates = '<div class="dates">' +
    dCol('Kelte',       d.issueDate) +
    dCol('Teljesítés',  d.deliveryDate) +
    dCol('Fiz. határidő', d.paymentDate) +
    dCol('Fizetés',     d.paymentMethod) +
    dCol('Pénznem',     d.currency) +
    (d.exchangeRate ? dCol('Árfolyam', d.exchangeRate) : '') +
    '</div>';

  var itemRows = '';
  for (var i = 0; i < d.lines.length; i++) {
    var li = pdfLineInfo(d.lines[i], d.currency);
    itemRows += '<tr>' +
      '<td class="c">' + (i + 1) + '</td>' +
      '<td>' + li.desc + (li.modOp ? ' <i>(' + li.modOp + ')</i>' : '') + '</td>' +
      '<td class="r">' + pdfFmt(li.qty) + (li.uom ? ' ' + li.uom : '') + '</td>' +
      '<td class="r">' + (li.unitPrice !== '' ? pdfFmt(li.unitPrice) : '—') + '</td>' +
      '<td class="r">' + (li.net !== '' ? pdfFmt(li.net) : '—') + '</td>' +
      '<td class="c">' + li.vatText + '</td>' +
      '<td class="r">' + (li.gross !== '' ? pdfFmt(li.gross) + ' ' + li.currency : '—') + '</td>' +
    '</tr>';
  }
  var itemsTable = '<table class="it"><thead><tr>' +
    '<th>#</th><th>Megnevezés</th><th>Mennyiség</th><th>Egységár</th>' +
    '<th>Nettó</th><th>ÁFA</th><th>Bruttó</th></tr></thead><tbody>' + itemRows + '</tbody></table>';

  var totalCard =
    '<div class="total-card"><span class="lab">Fizetendő összeg</span>' +
    '<span class="v">' + pdfFmt(d.grossTotal) + ' ' + d.currency + '</span></div>' +
    '<div class="summary">' +
      '<div>Nettó <b>' + pdfFmt(d.netTotal) + ' ' + d.currency + '</b></div>' +
      '<div>ÁFA <b>' + pdfFmt(d.vatTotal) + ' ' + d.currency + '</b></div>' +
    '</div>';

  var fNotes = [];
  if (d.cashAccounting === 'true') fNotes.push('Pénzforgalmi elszámolás');
  if (d.appearance) fNotes.push('Megjelenés: ' + d.appearance);
  var footer = fNotes.length ? '<div class="footer">' + fNotes.join(' · ') + '</div>' : '';

  return '<!DOCTYPE html><html><head><meta charset="UTF-8"><style>' + css + '</style></head><body>' +
    watermark + header + mod + parties + dates + itemsTable + totalCard + footer +
    '</body></html>';
}

// ============================================================
// DIALÓGUS — preview + sablonváltó + PDF letöltés
// ============================================================

function pdfShowDialog(invoiceHtml, b64Pdf, invNum, fileName, currentTplKey) {
  var optsHtml = '';
  for (var k in PDF_TEMPLATES) {
    var sel = (k === currentTplKey) ? ' selected' : '';
    optsHtml += '<option value="' + k + '"' + sel + '>' + PDF_TEMPLATES[k].label + '</option>';
  }

  var wrapperCss =
    'html,body{margin:0;padding:0;background:#525659;font-family:Arial,sans-serif}' +
    '.toolbar{background:#323639;padding:8px 16px;display:flex;align-items:center;justify-content:space-between;position:sticky;top:0;z-index:999;gap:10px}' +
    '.toolbar .left,.toolbar .right{display:flex;align-items:center;gap:10px}' +
    '.toolbar span{color:#aaa;font-size:12px}' +
    '.toolbar select{background:#222;color:#fff;border:1px solid #555;border-radius:4px;padding:6px 8px;font-size:12px;cursor:pointer}' +
    '.toolbar label{color:#bbb;font-size:11px}' +
    '.btn{background:' + PDF_BLUE + ';color:#fff;padding:7px 16px;border:none;border-radius:4px;text-decoration:none;font-size:13px;cursor:pointer;display:inline-block}' +
    '.btn:hover{background:' + PDF_BLUE_DARK + '}' +
    '.btn.disabled{background:#666;cursor:wait}' +
    '#busy{display:none;color:#ffd86b;font-size:12px}' +
    '#busy.on{display:inline}' +
    '.page-wrap{padding:20px;max-width:860px;margin:0 auto}' +
    '.page{background:#fff;padding:20px;box-shadow:0 2px 10px rgba(0,0,0,.35)}';

  var clientJs =
    '<script>' +
      'var STATE = { invNum: ' + JSON.stringify(invNum) + ', fileName: ' + JSON.stringify(fileName) + ', tpl: ' + JSON.stringify(currentTplKey) + ' };' +
      'function onTplChange(sel){' +
        'var key = sel.value;' +
        'document.getElementById("busy").classList.add("on");' +
        'document.getElementById("dl").classList.add("disabled");' +
        'google.script.run' +
          '.withSuccessHandler(function(res){' +
            'document.getElementById("page").innerHTML = res.html;' +
            'var dl = document.getElementById("dl");' +
            'dl.href = "data:application/pdf;base64," + res.b64Pdf;' +
            'dl.setAttribute("download", res.fileName + ".pdf");' +
            'dl.classList.remove("disabled");' +
            'STATE.tpl = res.templateKey;' +
            'STATE.fileName = res.fileName;' +
            'document.getElementById("busy").classList.remove("on");' +
          '})' +
          '.withFailureHandler(function(err){' +
            'document.getElementById("busy").classList.remove("on");' +
            'document.getElementById("dl").classList.remove("disabled");' +
            'alert("Sablonváltási hiba: " + (err && err.message ? err.message : err));' +
          '})' +
          '.pdfRebuildForTemplate(STATE.invNum, key);' +
      '}' +
    '</script>';

  var dialogContent =
    '<!DOCTYPE html><html><head><meta charset="UTF-8"><style>' + wrapperCss + '</style>' + clientJs + '</head><body>' +
    '<div class="toolbar">' +
      '<div class="left"><span>' + invNum + '</span></div>' +
      '<div class="right">' +
        '<label for="tplSel">Sablon:</label>' +
        '<select id="tplSel" onchange="onTplChange(this)">' + optsHtml + '</select>' +
        '<span id="busy">⏳ Generálás…</span>' +
        '<a id="dl" class="btn" download="' + fileName + '.pdf" href="data:application/pdf;base64,' + b64Pdf + '">⬇ Letöltés PDF-ként</a>' +
      '</div>' +
    '</div>' +
    '<div class="page-wrap"><div id="page" class="page">' + invoiceHtml + '</div></div>' +
    '</body></html>';

  SpreadsheetApp.getUi().showModalDialog(
    HtmlService.createHtmlOutput(dialogContent).setWidth(960).setHeight(800),
    'Számla – ' + invNum
  );
}
