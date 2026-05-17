/**
 * OsaApi.js — NAV Online Számla (OSA) v3.0 API kommunikáció.
 *
 * Felelőssége:
 *   - osaQueryInvoiceDigest()   : kivonatos számla lekérdezés, lapozással
 *   - osaQueryInvoiceData()     : teljes számla XML lekérdezés számlaszám alapján
 *   - osaQueryInvoiceDataBatch(): párhuzamos batch (UrlFetchApp.fetchAll)
 *   - OSA-specifikus XML request builder + válasz parser
 *
 * Megosztott helperek: NavConfig.js (getNavConfig), NavAuth.js (signing),
 *                       NavXmlUtils.js (xml helpers + navPost), Config.js (OSA_MAX_DIGEST_PAGES).
 *
 * NEM tartalmaz: sheet műveletek, UI, mezőleképezések.
 */

// ============================================================
// PUBLIC API — osaQueryInvoiceDigest
// ============================================================

/**
 * Kivonatos számla lekérdezés, automatikus lapozással és dátum-chunkolással.
 *
 * @param {Object} params
 *   dateFrom / dateTo       yyyy-MM-dd  — kiállítás dátum szűrő
 *   dateTimeFrom/dateTimeTo ISO         — beküldési idő szűrő (alternatív)
 *   originalInvoiceNumber   string      — alternatív kötelező param
 *   invoiceDirection        INBOUND|OUTBOUND  (alapért. INBOUND)
 *   taxNumber               partner adószám szűrő
 *   partnerName             partner név szűrő
 *   invoiceCategory         NORMAL|SIMPLIFIED|AGGREGATE
 *   paymentMethod           TRANSFER|CASH|CARD|VOUCHER|OTHER
 *   invoiceAppearance       PAPER|ELECTRONIC|EDI|UNKNOWN
 *   source                  WEB|XML|MGM|OPG
 *   currency                pl. "HUF"
 *   maxPages                max lapszám (alapért. OSA_MAX_DIGEST_PAGES)
 *
 * @returns {Array<Object>}  digestRow objektumok tömbje
 */
function osaQueryInvoiceDigest(params) {
  params = params || {};

  // A NAV egy lekérdezésben max 35 napos ablakot enged — 33 napos chunkolás biztos pad.
  if (params.dateFrom && params.dateTo) {
    var msPerDay = 24 * 60 * 60 * 1000;
    var fDate = new Date(params.dateFrom + 'T00:00:00Z');
    var tDate = new Date(params.dateTo + 'T00:00:00Z');
    var diffDays = (tDate.getTime() - fDate.getTime()) / msPerDay;

    if (diffDays > 33) {
      var allRows = [];
      var currentFrom = new Date(fDate.getTime());

      while (currentFrom <= tDate) {
        var currentTo = new Date(currentFrom.getTime() + 33 * msPerDay);
        if (currentTo > tDate) {
          currentTo = new Date(tDate.getTime());
        }

        var chunkParams = JSON.parse(JSON.stringify(params));
        chunkParams.dateFrom = Utilities.formatDate(currentFrom, 'UTC', 'yyyy-MM-dd');
        chunkParams.dateTo   = Utilities.formatDate(currentTo, 'UTC', 'yyyy-MM-dd');

        var chunkRows = osaQueryInvoiceDigest(chunkParams);
        allRows = allRows.concat(chunkRows);

        currentFrom = new Date(currentTo.getTime() + 1 * msPerDay);
      }
      return allRows;
    }
  }

  var direction = (params.invoiceDirection || 'INBOUND').toUpperCase();
  var maxPages  = params.maxPages || OSA_MAX_DIGEST_PAGES;

  var mandatory = osaBuildMandatoryQueryParams(params);
  var additional = osaBuildAdditionalQueryParams(params);

  var cfg     = getNavConfig();
  var allRows = [];
  var page    = 1;

  while (page <= maxPages) {
    var rt  = navNewRequestIdAndTimestamp();
    var sig = navComputeRequestSignature(rt.requestId, rt.timestamp, cfg.signatureKey);
    var pwHash = cfg.passwordHash;

    var body =
      '  <page>' + page + '</page>\n' +
      '  <invoiceDirection>' + direction + '</invoiceDirection>\n' +
      '  <invoiceQueryParams>\n' + mandatory + '\n' + additional + '\n  </invoiceQueryParams>';

    var xml = osaBuildRequestXml('QueryInvoiceDigestRequest', rt, pwHash, sig, cfg, body);
    var respXml = navPost(cfg.apiUrl + '/queryInvoiceDigest', xml);
    var parsed  = osaParseDigestResponse(respXml);

    parsed.rows.forEach(function(r) { allRows.push(r); });
    if (parsed.currentPage >= parsed.availablePages || parsed.rows.length === 0) break;
    page++;
  }
  return allRows;
}

// ============================================================
// PUBLIC API — osaQueryInvoiceData
// ============================================================

/**
 * Teljes számla adatok lekérdezése számlaszám alapján.
 *
 * @param {Object} params
 *   invoiceNumber     string  (kötelező)
 *   invoiceDirection  INBOUND|OUTBOUND  (alapért. INBOUND)
 *   batchIndex        number  (opcionális)
 *   supplierTaxNumber string  (opcionális, INBOUND esetén hasznos)
 *
 * @returns {{
 *   invoiceNumber: string,
 *   compressed: boolean,
 *   invoiceXml: string|null,
 *   auditData: Object,
 *   raw: string
 * }}
 */
function osaQueryInvoiceData(params) {
  if (!params || !params.invoiceNumber) throw new Error('invoiceNumber kötelező');
  var direction = (params.invoiceDirection || 'INBOUND').toUpperCase();

  var cfg = getNavConfig();
  var rt  = navNewRequestIdAndTimestamp();
  var sig = navComputeRequestSignature(rt.requestId, rt.timestamp, cfg.signatureKey);
  var pwHash = cfg.passwordHash;

  var inner =
    '    <invoiceNumber>' + navXmlEscape(params.invoiceNumber) + '</invoiceNumber>\n' +
    '    <invoiceDirection>' + direction + '</invoiceDirection>\n';
  if (params.batchIndex != null)
    inner += '    <batchIndex>' + params.batchIndex + '</batchIndex>\n';
  if (params.supplierTaxNumber)
    inner += '    <supplierTaxNumber>' + navXmlEscape(params.supplierTaxNumber) + '</supplierTaxNumber>\n';

  var xml = osaBuildRequestXml('QueryInvoiceDataRequest', rt, pwHash, sig, cfg,
    '  <invoiceNumberQuery>\n' + inner + '  </invoiceNumberQuery>');

  var respXml = navPost(cfg.apiUrl + '/queryInvoiceData', xml);
  return osaParseInvoiceDataResponse(respXml, params.invoiceNumber);
}

// ============================================================
// PUBLIC API — osaQueryInvoiceDataBatch (párhuzamos batch)
// ============================================================

/**
 * Több számla adatainak lekérdezése egyszerre, aszinkron párhuzamosítással
 * (UrlFetchApp.fetchAll). Drasztikusan felgyorsítja a hálózati kommunikációt.
 */
function osaQueryInvoiceDataBatch(paramsArray) {
  if (!paramsArray || paramsArray.length === 0) return [];

  var cfg = getNavConfig();
  var pwHash = cfg.passwordHash;

  var requests = [];
  var resultTemplate = [];
  var url = cfg.apiUrl + '/queryInvoiceData';

  for (var i = 0; i < paramsArray.length; i++) {
    var params = paramsArray[i];
    var direction = (params.invoiceDirection || 'INBOUND').toUpperCase();
    var rt  = navNewRequestIdAndTimestamp();
    var sig = navComputeRequestSignature(rt.requestId, rt.timestamp, cfg.signatureKey);

    var inner =
      '    <invoiceNumber>' + navXmlEscape(params.invoiceNumber) + '</invoiceNumber>\n' +
      '    <invoiceDirection>' + direction + '</invoiceDirection>\n';
    if (params.batchIndex != null)
      inner += '    <batchIndex>' + params.batchIndex + '</batchIndex>\n';
    if (params.supplierTaxNumber)
      inner += '    <supplierTaxNumber>' + navXmlEscape(params.supplierTaxNumber) + '</supplierTaxNumber>\n';

    var xml = osaBuildRequestXml('QueryInvoiceDataRequest', rt, pwHash, sig, cfg,
      '  <invoiceNumberQuery>\n' + inner + '  </invoiceNumberQuery>');

    requests.push({
      url: url,
      method: 'post',
      contentType: 'application/xml',
      headers: { 'Accept': 'application/xml' },
      payload: xml,
      muteHttpExceptions: true
    });

    resultTemplate.push({
      invoiceNumber: params.invoiceNumber,
      xmlPayload: xml
    });
  }

  var tFetch = Date.now();
  Logger.log('[OSA BATCH REQUEST] ' + requests.length + ' db queryInvoiceData indul...');

  var responses = UrlFetchApp.fetchAll(requests);
  Logger.log('[OSA BATCH REQUEST] fetchAll kész: ' + requests.length + ' válasz (' + (Date.now() - tFetch) + 'ms)');

  var parsedResults = [];
  var httpOk = 0, httpErr = 0, parseErr = 0;

  for (var j = 0; j < responses.length; j++) {
    var resp = responses[j];
    var code = resp.getResponseCode();
    var body = resp.getContentText('UTF-8');
    var invNum = resultTemplate[j].invoiceNumber;

    if (code >= 400) {
      var navErrCode = '';
      var errMatch = body.match(/<errorCode>([^<]+)<\/errorCode>/);
      var funcMatch = body.match(/<funcCode>([^<]+)<\/funcCode>/);
      if (errMatch) navErrCode = errMatch[1];
      else if (funcMatch) navErrCode = funcMatch[1];
      Logger.log('[OSA BATCH ERROR] HTTP ' + code + ' [' + navErrCode + '] számla: ' + invNum);
      httpErr++;
      parsedResults.push({
        invoiceNumber: invNum,
        compressed: false,
        invoiceXml: null,
        auditData: {},
        raw: body
      });
      continue;
    }

    httpOk++;
    try {
      var parsed = osaParseInvoiceDataResponse(body, invNum);
      parsedResults.push(parsed);
    } catch (e) {
      Logger.log('[OSA BATCH PARSE ERROR] számla: ' + invNum + ' -> ' + e.message);
      parseErr++;
      parsedResults.push({
        invoiceNumber: invNum,
        compressed: false,
        invoiceXml: null,
        auditData: {},
        raw: body
      });
    }
  }

  Logger.log('[OSA BATCH REQUEST] Eredmény: ' + httpOk + ' OK, ' + httpErr + ' HTTP hiba, ' + parseErr + ' parsz hiba');
  return parsedResults;
}

// ============================================================
// REQUEST BUILDERS
// ============================================================

function osaBuildMandatoryQueryParams(params) {
  if (params.dateFrom || params.dateTo) {
    var f = params.dateFrom || params.dateTo;
    var t = params.dateTo   || params.dateFrom;
    return (
      '    <mandatoryQueryParams>\n' +
      '      <invoiceIssueDate>\n' +
      '        <dateFrom>' + f + '</dateFrom>\n' +
      '        <dateTo>'   + t + '</dateTo>\n' +
      '      </invoiceIssueDate>\n' +
      '    </mandatoryQueryParams>'
    );
  }
  if (params.dateTimeFrom || params.dateTimeTo) {
    var df = params.dateTimeFrom || params.dateTimeTo;
    var dt = params.dateTimeTo   || params.dateTimeFrom;
    return (
      '    <mandatoryQueryParams>\n' +
      '      <insDate>\n' +
      '        <dateTimeFrom>' + df + '</dateTimeFrom>\n' +
      '        <dateTimeTo>'   + dt + '</dateTimeTo>\n' +
      '      </insDate>\n' +
      '    </mandatoryQueryParams>'
    );
  }
  if (params.originalInvoiceNumber) {
    return (
      '    <mandatoryQueryParams>\n' +
      '      <originalInvoiceNumber>' + navXmlEscape(params.originalInvoiceNumber) + '</originalInvoiceNumber>\n' +
      '    </mandatoryQueryParams>'
    );
  }
  // Alapértelmezett: mai nap
  var today = Utilities.formatDate(new Date(), 'UTC', 'yyyy-MM-dd');
  return (
    '    <mandatoryQueryParams>\n' +
    '      <invoiceIssueDate>\n' +
    '        <dateFrom>' + today + '</dateFrom>\n' +
    '        <dateTo>'   + today + '</dateTo>\n' +
    '      </invoiceIssueDate>\n' +
    '    </mandatoryQueryParams>'
  );
}

function osaBuildAdditionalQueryParams(params) {
  var addl = [];
  if (params.taxNumber)         addl.push('      <taxNumber>'         + navXmlEscape(params.taxNumber)         + '</taxNumber>');
  if (params.partnerName)       addl.push('      <name>'              + navXmlEscape(params.partnerName)       + '</name>');
  if (params.invoiceCategory)   addl.push('      <invoiceCategory>'   + params.invoiceCategory                 + '</invoiceCategory>');
  if (params.paymentMethod)     addl.push('      <paymentMethod>'     + params.paymentMethod                   + '</paymentMethod>');
  if (params.invoiceAppearance) addl.push('      <invoiceAppearance>' + params.invoiceAppearance               + '</invoiceAppearance>');
  if (params.source)            addl.push('      <source>'            + params.source                          + '</source>');
  if (params.currency)          addl.push('      <currency>'          + navXmlEscape(params.currency)          + '</currency>');
  return addl.length
    ? '    <additionalQueryParams>\n' + addl.join('\n') + '\n    </additionalQueryParams>'
    : '';
}

function osaBuildRequestXml(rootTag, rt, pwHash, sig, cfg, bodyContent) {
  return (
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<' + rootTag + ' xmlns:common="http://schemas.nav.gov.hu/NTCA/1.0/common"' +
                   ' xmlns="http://schemas.nav.gov.hu/OSA/3.0/api">\n' +
    '  <common:header>\n' +
    '    <common:requestId>'      + rt.requestId  + '</common:requestId>\n' +
    '    <common:timestamp>'      + rt.timestamp  + '</common:timestamp>\n' +
    '    <common:requestVersion>3.0</common:requestVersion>\n' +
    '    <common:headerVersion>1.0</common:headerVersion>\n' +
    '  </common:header>\n' +
    '  <common:user>\n' +
    '    <common:login>'          + navXmlEscape(cfg.login)      + '</common:login>\n' +
    '    <common:passwordHash cryptoType="SHA-512">'  + pwHash   + '</common:passwordHash>\n' +
    '    <common:taxNumber>'      + navXmlEscape(cfg.taxNumber)  + '</common:taxNumber>\n' +
    '    <common:requestSignature cryptoType="SHA3-512">' + sig  + '</common:requestSignature>\n' +
    '  </common:user>\n' +
    '  <software>\n    ' + osaBuildSoftwareXml(cfg) + '\n  </software>\n' +
    bodyContent + '\n' +
    '</' + rootTag + '>'
  );
}

function osaBuildSoftwareXml(cfg) {
  var parts = [
    '<softwareId>'           + navXmlEscape(cfg.softwareId)              + '</softwareId>',
    '<softwareName>'         + navXmlEscape(cfg.softwareName)            + '</softwareName>',
    '<softwareOperation>LOCAL_SOFTWARE</softwareOperation>',
    '<softwareMainVersion>'  + navXmlEscape(cfg.softwareVersion)         + '</softwareMainVersion>',
    '<softwareDevName>'      + navXmlEscape(cfg.softwareDevName)         + '</softwareDevName>',
    '<softwareDevContact>'   + navXmlEscape(cfg.softwareDevContact)      + '</softwareDevContact>',
    '<softwareDevCountryCode>' + navXmlEscape(cfg.softwareDevCountryCode)+ '</softwareDevCountryCode>'
  ];
  if (cfg.softwareDevTaxNumber)
    parts.push('<softwareDevTaxNumber>' + navXmlEscape(cfg.softwareDevTaxNumber) + '</softwareDevTaxNumber>');
  return parts.join('\n    ');
}

// ============================================================
// RESPONSE PARSERS
// ============================================================

/**
 * QueryInvoiceDigestResponse → { rows, currentPage, availablePages }
 * rows: digestRow plain objektumok tömbje (lapos, aliasokkal)
 */
function osaParseDigestResponse(respXml) {
  var doc  = XmlService.parse(respXml);
  var root = doc.getRootElement();
  navCheckForFault(root);

  var result = navFindFirst(root, 'invoiceDigestResult');
  var availablePages = 0, currentPage = 0;
  if (result) {
    var a = navFindFirst(result, 'availablePage');
    var c = navFindFirst(result, 'currentPage');
    if (a) availablePages = parseInt(a.getText(), 10) || 0;
    if (c) currentPage    = parseInt(c.getText(), 10) || 0;
  }

  var digests = result ? navFindDirectChildren(result, 'invoiceDigest') : [];
  var rows = digests.map(osaDigestElementToObject);
  if (rows.length > 0) {
    Logger.log('[OSA DIGEST ROW sample] ' + JSON.stringify(rows[0]));
  }
  return { rows: rows, currentPage: currentPage, availablePages: availablePages };
}

/**
 * QueryInvoiceDataResponse → { invoiceNumber, compressed, invoiceXml, auditData, raw }
 */
function osaParseInvoiceDataResponse(respXml, invoiceNumber) {
  var doc  = XmlService.parse(respXml);
  var root = doc.getRootElement();
  navCheckForFault(root);

  var result  = navFindFirst(root, 'invoiceDataResult');
  if (!result) {
    return { invoiceNumber: invoiceNumber, compressed: false,
             invoiceXml: null, auditData: {}, raw: respXml };
  }

  var compEl  = navFindFirst(result, 'compressedContentIndicator');
  var dataEl  = navFindFirst(result, 'invoiceData');
  var auditEl = navFindFirst(result, 'auditData');

  var compressed = compEl && compEl.getText().trim() === 'true';
  var invoiceXml = dataEl ? navDecodeInvoiceData(dataEl.getText().trim(), compressed) : null;

  return {
    invoiceNumber: invoiceNumber,
    compressed:    !!compressed,
    invoiceXml:    invoiceXml,
    auditData:     auditEl ? navElementToObject(auditEl) : {},
    raw:           respXml
  };
}

/**
 * invoiceDigest XML elem → lapos plain object.
 * Adószám-összetevőket (taxpayerId, vatCode, countyCode) aliasokkal is elérhetővé teszi.
 */
function osaDigestElementToObject(el) {
  var obj = {};
  var children = el.getChildren();
  for (var i = 0; i < children.length; i++) {
    var c    = children[i];
    var k    = c.getName();
    var sub  = c.getChildren();
    obj[k]   = c.getText().trim();
    // Sub-elemek lapos feltérképezése: supplierTaxNumber/taxpayerId → supplierTaxNumber_taxpayerId
    for (var j = 0; j < sub.length; j++) {
      obj[k + '_' + sub[j].getName()] = sub[j].getText().trim();
    }
  }
  // Praktikus aliasok
  obj.supplierTaxNumber  = obj.supplierTaxNumber  || obj['supplierTaxNumber_taxpayerId']  || '';
  obj.supplierVatCode    = obj['supplierTaxNumber_vatCode']    || '';
  obj.supplierCountyCode = obj['supplierTaxNumber_countyCode'] || '';
  obj.customerTaxNumber  = obj.customerTaxNumber  || obj['customerTaxNumber_taxpayerId']  || '';
  obj.customerVatCode    = obj['customerTaxNumber_vatCode']    || '';
  obj.customerCountyCode = obj['customerTaxNumber_countyCode'] || '';
  obj.customerVatStatus  = obj.customerVatStatus  || '';
  return obj;
}
