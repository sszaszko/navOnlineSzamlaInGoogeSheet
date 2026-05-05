/**
 * InvoicePdf.gs — Számla PDF generátor (NAV OSA 3.0)
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
// BELÉPÉSI PONT
// ============================================================

function generateInvoicePdf(invoiceDataResult) {
  if (!invoiceDataResult || !invoiceDataResult.invoiceXml) {
    SpreadsheetApp.getUi().alert('A számla nem tartalmaz XML adatokat. Nem készíthető PDF.');
    return;
  }
  
  var doc = XmlService.parse(invoiceDataResult.invoiceXml);
  
  // XML logolása egészében, takarékos tabos behúzással
  try {
    var formatter = XmlService.getPrettyFormat().setIndent('\t');
    Logger.log("Számla XML (" + invoiceDataResult.invoiceNumber + "):\n" + formatter.format(doc));
  } catch(e) {
    Logger.log("Nem sikerült formázni az XML-t a loghoz.");
  }
  
  var root       = doc.getRootElement();
  var data       = pdfExtract(root, invoiceDataResult.invoiceNumber);
  var invHtml    = pdfBuildInvoiceHtml(data);
  var b64Pdf     = Utilities.base64Encode(
    Utilities.newBlob(invHtml, MimeType.HTML, 'sz.html').getAs(MimeType.PDF).getBytes()
  );
  
  // Szállító nevének rövidítése a fájlnévhez (csak alfanumerikus karakterek)
  var shortSupName = (data.supName || 'Ismeretlen_Elado')
    .replace(/[^a-zA-Z0-9áéíóöőúüűÁÉÍÓÖŐÚÜŰ]/g, '')
    .substring(0, 15);
  var fileName = 'szamla_' + shortSupName + '_' + data.invNum;
  
  pdfShowDialog(invHtml, b64Pdf, data.invNum, fileName);
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

  // Összegek — summaryNormal, vagy summarySimplified fallback, majd tétel-szintű összeg
  var netTotal   = pdfSumFrom(sumNormEl, 'invoiceNetAmount', 'invoiceNetAmountHUF');
  var vatTotal   = pdfSumFrom(sumNormEl, 'invoiceVatAmount', 'invoiceVatAmountHUF');
  var grossTotal = pdfSumFrom(sumGrossEl, 'invoiceGrossAmount', 'invoiceGrossAmountHUF');

  if (isNaN(netTotal) && sumSimpEl) {
    // Egyszerűsített számlánál nincsen summaryNormal
    netTotal   = pdfSumFrom(sumSimpEl, 'invoiceNetAmount',   'invoiceNetAmountHUF');
    vatTotal   = pdfSumFrom(sumSimpEl, 'invoiceVatAmount',   'invoiceVatAmountHUF');
  }
  if (isNaN(grossTotal)) {
    grossTotal = parseFloat(navXmlText(root, 'invoiceGrossAmount')) || 0;
  }
  netTotal   = isNaN(netTotal)   ? 0 : netTotal;
  vatTotal   = isNaN(vatTotal)   ? 0 : vatTotal;
  grossTotal = isNaN(grossTotal) ? 0 : grossTotal;

  // Ha bruttó van de nettó/áfa nulla, számítsuk vissza a tételekből
  if (grossTotal > 0 && netTotal === 0) {
    var lines = navFindAll(root, 'line');
    for (var i = 0; i < lines.length; i++) {
      var a = dpResolveAmounts(lines[i]);
      if (typeof a.net   === 'number') netTotal   += a.net;
      if (typeof a.vat   === 'number') vatTotal   += a.vat;
    }
    netTotal   = Math.round(netTotal   * 100) / 100;
    vatTotal   = Math.round(vatTotal   * 100) / 100;
  }

  return {
    invNum:        navXmlText(root, 'invoiceNumber')                           || fallbackNum,
    issueDate:     navXmlText(root, 'invoiceIssueDate'),
    category:      detailEl ? navXmlText(detailEl, 'invoiceCategory')          : '',
    deliveryDate:  detailEl ? navXmlText(detailEl, 'invoiceDeliveryDate')      : '',
    deliveryPeriodStart: detailEl ? navXmlText(detailEl, 'invoiceDeliveryPeriodStart') : '',
    deliveryPeriodEnd:   detailEl ? navXmlText(detailEl, 'invoiceDeliveryPeriodEnd')   : '',
    paymentMethod: dpPaymentMethodHu(detailEl ? navXmlText(detailEl, 'paymentMethod') : ''),
    paymentDate:   detailEl ? navXmlText(detailEl, 'paymentDate')              : '',
    currency:      currency,
    exchangeRate:  detailEl ? navXmlText(detailEl, 'exchangeRate')             : '',
    cashAccounting:detailEl ? navXmlText(detailEl, 'cashAccountingIndicator')  : '',
    appearance:    detailEl ? navXmlText(detailEl, 'invoiceAppearance')        : '',

    // Módosítás
    isModification:        !!modRefEl,
    origInvoiceNumber:     modRefEl ? navXmlText(modRefEl, 'originalInvoiceNumber') : '',
    modificationIndex:     modRefEl ? navXmlText(modRefEl, 'modificationIndex')     : '',
    modifyWithoutMaster:   modRefEl ? navXmlText(modRefEl, 'modifyWithoutMaster')   : '',

    // Eladó
    supName:       supInfoEl ? navXmlText(supInfoEl, 'supplierName')           : '',
    supTaxNum:     pdfTaxNum(supInfoEl, 'supplierTaxNumber'),
    supGroupTax:   pdfTaxNum(supInfoEl, 'groupMemberTaxNumber'),
    supCommVat:    supInfoEl ? navXmlText(supInfoEl, 'communityVatNumber')     : '',
    supBankAcc:    supInfoEl ? navXmlText(supInfoEl, 'supplierBankAccountNumber') : '',
    supAddr:       pdfParseAddr(supInfoEl ? navFindFirst(supInfoEl, 'supplierAddress') : null),

    // Vevő
    cusName:       cusInfoEl ? navXmlText(cusInfoEl, 'customerName')           : '',
    cusTaxNum:     pdfTaxNum(cusInfoEl, 'customerTaxNumber'),
    cusCommVat:    cusInfoEl ? navXmlText(cusInfoEl, 'communityVatNumber')     : '',
    cusThirdTax:   cusInfoEl ? navXmlText(cusInfoEl, 'thirdStateTaxId')        : '',
    cusBankAcc:    cusInfoEl ? navXmlText(cusInfoEl, 'customerBankAccountNumber') : '',
    cusAddr:       pdfParseAddr(cusInfoEl ? navFindFirst(cusInfoEl, 'customerAddress') : null),

    // Összegek
    netTotal:      netTotal,
    vatTotal:      vatTotal,
    grossTotal:    grossTotal,

    // Tételek
    lines:         navFindAll(root, 'line')
  };
}

// ============================================================
// SEGÉDEK — adatkinyerés
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
  var id  = navXmlText(el, 'taxpayerId');
  var vc  = navXmlText(el, 'vatCode');
  var cc  = navXmlText(el, 'countyCode');
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

// ============================================================
// HTML ÉPÍTÉS
// ============================================================

function pdfAddrHtml(addr) {
  var parts = [];
  var cityLine = [addr.postalCode, addr.city].filter(Boolean).join(' ');
  if (cityLine)     parts.push(cityLine);
  if (addr.street)  parts.push(addr.street);
  if (addr.country) parts.push(addr.country);
  return parts.join('<br>');
}

function pdfDetailRow(label, value) {
  if (!value) return '';
  return '<div class="dr"><span class="dl">' + label + ':</span><span class="dv">' + value + '</span></div>';
}

function pdfPartyHtml(title, name, addr, rows) {
  return '<td class="party">' +
    '<div class="lbl">' + title + '</div>' +
    '<div class="pname">' + (name || '—') + '</div>' +
    '<div class="addr">' + pdfAddrHtml(addr) + '</div>' +
    (rows || '') +
  '</td>';
}

function pdfLineRow(i, line, currency) {
  var a   = dpResolveAmounts(line);
  var qty = dpNumParse(navXmlText(line, 'quantity'));
  var uom = navXmlText(line, 'unitOfMeasureOwn') || dpUnitOfMeasureHu(navXmlText(line, 'unitOfMeasure'));
  var desc = navXmlText(line, 'lineDescription');
  var unitPrice = dpNumParse(navXmlText(line, 'unitPrice'));
  var lineNature = navXmlText(line, 'lineNatureIndicator');

  // Módosítás jelzés
  var modOp = navXmlText(line, 'lineModificationReference lineOperation');
  var modBadge = modOp ? ' <span class="badge">' + modOp + '</span>' : '';

  return '<tr>' +
    '<td class="center blue">' + i + '</td>' +
    '<td>' + desc + modBadge + (lineNature ? '<div class="nat">' + (lineNature === 'SERVICE' ? 'Szolgáltatás' : 'Termék') + '</div>' : '') + '</td>' +
    '<td class="right">' + pdfFmt(qty) + (uom ? ' ' + uom : '') + '</td>' +
    '<td class="right">' + (unitPrice !== '' ? pdfFmt(unitPrice) + ' ' + currency : '—') + '</td>' +
    '<td class="right">' + (a.net !== '' ? pdfFmt(a.net) + ' ' + currency : '—') + '</td>' +
    '<td class="right">' + pdfVatText(line) + '</td>' +
    '<td class="right">' + (a.gross !== '' ? pdfFmt(a.gross) + ' ' + currency : '—') + '</td>' +
  '</tr>';
}

function pdfBuildInvoiceHtml(d) {
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

  // Fejléc
  var header =
    '<div class="header">' +
      '<div class="h-left"><h1>Elektronikus számla</h1></div>' +
      '<div class="h-right">' +
        '<div class="inv-label">Számla sorszáma</div>' +
        '<div class="inv-num">' + d.invNum + '</div>' +
      '</div>' +
    '</div>';

  // Módosítás jelzés
  var modBar = '';
  if (d.isModification) {
    modBar = '<div class="mod-bar">⚠ Ez a számla módosítás — Eredeti számla: <strong>' +
      d.origInvoiceNumber + '</strong>' +
      (d.modificationIndex ? ' · Módosítás sorsz.: ' + d.modificationIndex : '') +
      '</div>';
  }

  // Eladó / Vevő
  var parties =
    '<table class="info-table"><tr>' +
      pdfPartyHtml('Eladó', d.supName, d.supAddr,
        pdfDetailRow('Adószám',             d.supTaxNum) +
        pdfDetailRow('Csoporttag adószám',  d.supGroupTax) +
        pdfDetailRow('Közösségi adószám',   d.supCommVat) +
        pdfDetailRow('Bankszámlaszám',      d.supBankAcc)
      ) +
      pdfPartyHtml('Vevő', d.cusName, d.cusAddr,
        pdfDetailRow('Adószám',             d.cusTaxNum) +
        pdfDetailRow('Közösségi adószám',   d.cusCommVat) +
        pdfDetailRow('Harmadik o. adószám', d.cusThirdTax) +
        pdfDetailRow('Bankszámlaszám',      d.cusBankAcc)
      ) +
    '</tr></table>';

  // Dátumok
  function dtRow(l1, v1, l2, v2) {
    return '<tr>' +
      '<td><span class="dates-label">' + l1 + '</span><span class="dates-value">' + (v1 || '—') + '</span></td>' +
      '<td><span class="dates-label">' + l2 + '</span><span class="dates-value">' + (v2 || '—') + '</span></td>' +
    '</tr>';
  }
  var periodText = (d.deliveryPeriodStart && d.deliveryPeriodEnd)
    ? d.deliveryPeriodStart + ' – ' + d.deliveryPeriodEnd : '';

  var dates =
    '<table class="dates-table">' +
      dtRow('Számla kelte:',   d.issueDate,   'Fizetési határidő:', d.paymentDate) +
      dtRow('Teljesítés:',     d.deliveryDate,'Fizetési mód:',      d.paymentMethod) +
      (periodText ? dtRow('Teljesítési időszak:', periodText, 'Árfolyam:', d.exchangeRate ? d.exchangeRate + ' (HUF/' + d.currency + ')' : '') : '') +
    '</table>';

  // Bruttó kiemelés
  var totalBox =
    '<div class="total-box">' +
      '<span class="total-label">Fizetendő bruttó végösszeg:</span>' +
      '<span class="total-amount">' + pdfFmt(d.grossTotal) + ' ' + d.currency + '</span>' +
    '</div>';

  // Tételek
  var itemRows = '';
  for (var i = 0; i < d.lines.length; i++) {
    itemRows += pdfLineRow(i + 1, d.lines[i], d.currency);
  }
  var itemsTable =
    '<table class="items-table"><thead><tr>' +
      '<th></th><th>Megnevezés</th><th>Mennyiség</th>' +
      '<th>Egységár</th><th>Nettó ár</th><th>ÁFA</th><th>Bruttó ár</th>' +
    '</tr></thead><tbody>' + itemRows + '</tbody></table>';

  // Összegzés
  var summary =
    '<table class="summary-table">' +
      '<tr><td>Nettó összeg:</td><td>' + pdfFmt(d.netTotal) + ' ' + d.currency + '</td></tr>' +
      '<tr><td>ÁFA:</td><td>' + pdfFmt(d.vatTotal) + ' ' + d.currency + '</td></tr>' +
      '<tr><td><strong>Fizetendő bruttó végösszeg:</strong></td><td><strong>' + pdfFmt(d.grossTotal) + ' ' + d.currency + '</strong></td></tr>' +
    '</table>';

  // Lábléc megjegyzések
  var footer = '';
  if (d.cashAccounting) footer += pdfDetailRow('Pénzforgalmi elszámolás', d.cashAccounting === 'true' ? 'Igen' : '');
  if (d.appearance)     footer += pdfDetailRow('Számla megjelenési formája', d.appearance);

  return '<!DOCTYPE html><html><head><meta charset="UTF-8">' +
    '<style>' + css + '</style></head><body>' +
    header +
    (modBar ? modBar : '') +
    '<hr class="divider">' +
    parties +
    '<hr class="divider">' +
    dates +
    '<hr class="divider">' +
    totalBox +
    itemsTable +
    '<hr class="divider">' +
    summary +
    (footer ? '<hr class="divider"><div class="footer-note">' + footer + '</div>' : '') +
  '</body></html>';
}

// ============================================================
// DIALÓGUS — HTML preview + PDF letöltés
// ============================================================

function pdfShowDialog(invoiceHtml, b64Pdf, invNum, fileName) {
  // Chrome blokkolt data: URI-t iframe-ben, ezért a számlát közvetlenül rendereljük a modalban
  var wrapperCss =
    'html,body{margin:0;padding:0;background:#525659;font-family:Arial,sans-serif}' +
    '.toolbar{background:#323639;padding:8px 16px;display:flex;align-items:center;justify-content:space-between;position:sticky;top:0;z-index:999}' +
    '.toolbar span{color:#aaa;font-size:12px}' +
    '.btn{background:' + PDF_BLUE + ';color:#fff;padding:7px 16px;border:none;border-radius:4px;' +
          'text-decoration:none;font-size:13px;cursor:pointer}' +
    '.btn:hover{background:' + PDF_BLUE_DARK + '}' +
    '.page-wrap{padding:20px;max-width:860px;margin:0 auto}' +
    '.page{background:#fff;padding:20px;box-shadow:0 2px 10px rgba(0,0,0,.35)}';

  var dialogContent =
    '<!DOCTYPE html><html><head><meta charset="UTF-8"><style>' + wrapperCss + '</style></head><body>' +
    '<div class="toolbar">' +
      '<span>' + invNum + '</span>' +
      '<a class="btn" download="' + fileName + '.pdf" href="data:application/pdf;base64,' + b64Pdf + '">' +
        '⬇ Letöltés PDF-ként</a>' +
    '</div>' +
    '<div class="page-wrap"><div class="page">' + invoiceHtml + '</div></div>' +
    '</body></html>';

  SpreadsheetApp.getUi().showModalDialog(
    HtmlService.createHtmlOutput(dialogContent).setWidth(900).setHeight(780),
    'Számla – ' + invNum
  );
}
