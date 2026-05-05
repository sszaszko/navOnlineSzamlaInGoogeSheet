/**
 * NavApi.gs — NAV Online Számla v3.0 API kommunikáció
 *
 * Felelőssége:
 *   - queryInvoiceDigest()   : kivonatos számla lekérdezés, lapozással
 *   - queryInvoiceData()     : teljes számla XML lekérdezés számlaszám alapján
 *   - HTTP transport (postNav)
 *   - Auth & request signing (SHA-512 / SHA3-512)
 *   - XML request builder
 *   - NAV válasz parse (digest list, invoiceData result)
 *
 * NEM tartalmaz: sheet műveletek, UI, mezőleképezések.
 * Hívja: DataProcessor.gs (közvetve a Menu.gs-en keresztül)
 */

// ============================================================
// CONFIG
// ============================================================

function getNavConfig() {
  var p   = PropertiesService.getScriptProperties();
  var env = (p.getProperty('NAV_ENV') || 'production').toLowerCase();
  var cfg = {
    env:      env,
    apiUrl:   env === 'test'
                ? 'https://api-test.onlineszamla.nav.gov.hu/invoiceService/v3'
                : 'https://api.onlineszamla.nav.gov.hu/invoiceService/v3',
    login:                 p.getProperty('NAV_LOGIN'),
    password:              p.getProperty('NAV_PASSWORD'),
    taxNumber:             p.getProperty('NAV_TAX_NUMBER'),
    signatureKey:          p.getProperty('NAV_SIGNATURE_KEY'),
    exchangeKey:           p.getProperty('NAV_EXCHANGE_KEY')           || '',
    softwareId:            p.getProperty('NAV_SOFTWARE_ID')            || 'GAS' + (p.getProperty('NAV_TAX_NUMBER') || '00000000') + '00001',
    softwareName:          p.getProperty('NAV_SOFTWARE_NAME')          || 'GAS-NAV-Client',
    softwareVersion:       p.getProperty('NAV_SOFTWARE_VERSION')       || '2.0.0',
    softwareDevName:       p.getProperty('NAV_SOFTWARE_DEV_NAME')      || 'GAS User',
    softwareDevContact:    p.getProperty('NAV_SOFTWARE_DEV_CONTACT')   || 'noreply@example.com',
    softwareDevCountryCode:p.getProperty('NAV_SOFTWARE_DEV_COUNTRY')   || 'HU',
    softwareDevTaxNumber:  p.getProperty('NAV_SOFTWARE_DEV_TAX_NUMBER')|| ''
  };
  var missing = ['login', 'password', 'taxNumber', 'signatureKey']
    .filter(function(k) { return !cfg[k]; });
  if (missing.length) {
    throw new Error('Hiányzó Script Property-k: ' +
      missing.map(function(k) { return 'NAV_' + k.toUpperCase(); }).join(', '));
  }
  cfg.softwareId = navNormalizeSoftwareId(cfg.softwareId);
  return cfg;
}

function navNormalizeSoftwareId(id) {
  var s = String(id).toUpperCase().replace(/[^0-9A-Z\-]/g, '');
  if (s.length > 18) s = s.substring(0, 18);
  while (s.length < 18) s += '0';
  return s;
}

// ============================================================
// PUBLIC API — queryInvoiceDigest
// ============================================================

/**
 * Kivonatos számla lekérdezés, automatikus lapozással.
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
 *   maxPages                max lapszám (alapért. 10)
 *
 * @returns {Array<Object>}  digestRow objektumok tömbje
 */
function queryInvoiceDigest(params) {
  params = params || {};
  
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
        
        var chunkRows = queryInvoiceDigest(chunkParams);
        allRows = allRows.concat(chunkRows);
        
        currentFrom = new Date(currentTo.getTime() + 1 * msPerDay);
      }
      return allRows;
    }
  }

  var direction = (params.invoiceDirection || 'INBOUND').toUpperCase();
  var maxPages  = params.maxPages || 10;

  var mandatory = navBuildMandatoryQueryParams(params);
  var additional = navBuildAdditionalQueryParams(params);

  var cfg     = getNavConfig();
  var allRows = [];
  var page    = 1;

  while (page <= maxPages) {
    var rt  = navNewRequestIdAndTimestamp();
    var sig = navComputeRequestSignature(rt.requestId, rt.timestamp, cfg.signatureKey);
    var pwHash = navSha512Hex(cfg.password).toUpperCase();

    var body =
      '  <page>' + page + '</page>\n' +
      '  <invoiceDirection>' + direction + '</invoiceDirection>\n' +
      '  <invoiceQueryParams>\n' + mandatory + '\n' + additional + '\n  </invoiceQueryParams>';

    var xml = navBuildRequestXml('QueryInvoiceDigestRequest', rt, pwHash, sig, cfg, body);
    var respXml = navPost(cfg.apiUrl + '/queryInvoiceDigest', xml);
    var parsed  = navParseDigestResponse(respXml);

    parsed.rows.forEach(function(r) { allRows.push(r); });
    if (parsed.currentPage >= parsed.availablePages || parsed.rows.length === 0) break;
    page++;
  }
  return allRows;
}

// ============================================================
// PUBLIC API — queryInvoiceData
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
function queryInvoiceData(params) {
  if (!params || !params.invoiceNumber) throw new Error('invoiceNumber kötelező');
  var direction = (params.invoiceDirection || 'INBOUND').toUpperCase();

  var cfg = getNavConfig();
  var rt  = navNewRequestIdAndTimestamp();
  var sig = navComputeRequestSignature(rt.requestId, rt.timestamp, cfg.signatureKey);
  var pwHash = navSha512Hex(cfg.password).toUpperCase();

  var inner =
    '    <invoiceNumber>' + navXmlEscape(params.invoiceNumber) + '</invoiceNumber>\n' +
    '    <invoiceDirection>' + direction + '</invoiceDirection>\n';
  if (params.batchIndex != null)
    inner += '    <batchIndex>' + params.batchIndex + '</batchIndex>\n';
  if (params.supplierTaxNumber)
    inner += '    <supplierTaxNumber>' + navXmlEscape(params.supplierTaxNumber) + '</supplierTaxNumber>\n';

  var xml = navBuildRequestXml('QueryInvoiceDataRequest', rt, pwHash, sig, cfg,
    '  <invoiceNumberQuery>\n' + inner + '  </invoiceNumberQuery>');

  var respXml = navPost(cfg.apiUrl + '/queryInvoiceData', xml);
  return navParseInvoiceDataResponse(respXml, params.invoiceNumber);
}

// ============================================================
// REQUEST BUILDERS
// ============================================================

function navBuildMandatoryQueryParams(params) {
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

function navBuildAdditionalQueryParams(params) {
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

function navBuildRequestXml(rootTag, rt, pwHash, sig, cfg, bodyContent) {
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
    '  <software>\n    ' + navBuildSoftwareXml(cfg) + '\n  </software>\n' +
    bodyContent + '\n' +
    '</' + rootTag + '>'
  );
}

function navBuildSoftwareXml(cfg) {
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
function navParseDigestResponse(respXml) {
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
  var rows = digests.map(navDigestElementToObject);
  if (rows.length > 0) {
    Logger.log('[NAV DIGEST ROW sample] ' + JSON.stringify(rows[0]));
  }
  return { rows: rows, currentPage: currentPage, availablePages: availablePages };
}

/**
 * QueryInvoiceDataResponse → { invoiceNumber, compressed, invoiceXml, auditData, raw }
 */
function navParseInvoiceDataResponse(respXml, invoiceNumber) {
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
function navDigestElementToObject(el) {
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

function navElementToObject(el) {
  var out = {};
  var children = el.getChildren();
  if (children.length === 0) return el.getText();
  for (var i = 0; i < children.length; i++) {
    var c  = children[i];
    var k  = c.getName();
    var vv = navElementToObject(c);
    if (out.hasOwnProperty(k)) {
      if (!Array.isArray(out[k])) out[k] = [out[k]];
      out[k].push(vv);
    } else {
      out[k] = vv;
    }
  }
  return out;
}

function navDecodeInvoiceData(b64, compressed) {
  var bytes = Utilities.base64Decode(b64);
  var rawBytes;
  if (compressed) {
    var gzBlob   = Utilities.newBlob(bytes, 'application/x-gzip', 'invoice.xml.gz');
    rawBytes = Utilities.ungzip(gzBlob).getBytes();
  } else {
    rawBytes = bytes;
  }

  // XML deklaráció (első ~200 byte) kiolvasása a kódolás detektálásához
  var headLen = Math.min(200, rawBytes.length);
  var headBytes = [];
  for (var i = 0; i < headLen; i++) {
    headBytes.push(rawBytes[i]);
  }
  var headerStr = Utilities.newBlob(headBytes).getDataAsString('US-ASCII');
  
  var encoding = 'UTF-8';
  var match = headerStr.match(/encoding\s*=\s*"([^"]+)"/i) || headerStr.match(/encoding\s*=\s*'([^']+)'/i);
  if (match) {
    var e = match[1].toLowerCase();
    if (e === 'windows-1250' || e === 'cp1250') {
      encoding = 'windows-1250';
    } else if (e === 'iso-8859-2') {
      encoding = 'iso-8859-2';
    } else if (e === 'utf-16') {
      encoding = 'UTF-16';
    }
  }

  var xmlStr = Utilities.newBlob(rawBytes).getDataAsString(encoding);

  // Az XmlService.parse(string) eltérő encoding esetén hibásan parse-olja a karaktereket.
  // Megoldás: töröljük az egész declaration-t — XmlService declaration nélkül is parse-ol.
  xmlStr = xmlStr.replace(/^<\?xml[\s\S]*?\?>\s*/i, '');
  var isXmlLogEnabled = (typeof NAV_DEBUG_LOG_XML !== 'undefined') ? NAV_DEBUG_LOG_XML : false;
  if (isXmlLogEnabled) {
    Logger.log('[NAV DECODE] compressed=' + compressed + ', b64 length=' + b64.length + ', detected encoding=' + encoding);
    Logger.log('[NAV INVOICE XML]\n' + xmlStr);
  }
  return xmlStr;
}

function navCheckForFault(root) {
  var local = root.getName();
  if (local === 'GeneralErrorResponse' || local === 'GeneralExceptionResponse') {
    var msg  = navTextOf(navFindFirst(root, 'message'))    || 'Ismeretlen NAV hiba';
    var code = navTextOf(navFindFirst(root, 'errorCode'))  || navTextOf(navFindFirst(root, 'funcCode'));
    throw new Error('NAV hiba' + (code ? ' (' + code + ')' : '') + ': ' + msg);
  }
}

// ============================================================
// XML HELPERS
// ============================================================

/** Rekurzív mélységi keresés local name alapján */
function navFindFirst(parent, name) {
  if (!parent || !parent.getChildren) return null;
  var children = parent.getChildren();
  for (var i = 0; i < children.length; i++) {
    if (children[i].getName() === name) return children[i];
    var found = navFindFirst(children[i], name);
    if (found) return found;
  }
  return null;
}

/** Csak közvetlen gyerekek (nem rekurzív) — lista elemek iterálásához */
function navFindDirectChildren(parent, name) {
  var result = [];
  if (!parent || !parent.getChildren) return result;
  var children = parent.getChildren();
  for (var i = 0; i < children.length; i++) {
    if (children[i].getName() === name) result.push(children[i]);
  }
  return result;
}

/** Névtér-független rekurzív "összes" keresés */
function navFindAll(parent, name) {
  var result = [];
  if (!parent || !parent.getChildren) return result;
  var children = parent.getChildren();
  for (var i = 0; i < children.length; i++) {
    if (children[i].getName() === name) result.push(children[i]);
    var sub = navFindAll(children[i], name);
    for (var j = 0; j < sub.length; j++) result.push(sub[j]);
  }
  return result;
}

/**
 * XML szöveg kinyerése szóközzel elválasztott tag-út mentén.
 * Pl. navXmlText(head, 'supplierTaxNumber taxpayerId')
 */
function navXmlText(root, path) {
  if (!root) return '';
  var parts = path.split(' ');
  var cur = root;
  for (var i = 0; i < parts.length; i++) {
    cur = navFindFirst(cur, parts[i]);
    if (!cur) return '';
  }
  return cur.getText ? cur.getText().trim() : '';
}

function navTextOf(el) { return el ? el.getText().trim() : ''; }

function navXmlEscape(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

// ============================================================
// HTTP
// ============================================================

function navPost(url, xmlBody) {
  var isXmlLogEnabled = (typeof NAV_DEBUG_LOG_XML !== 'undefined') ? NAV_DEBUG_LOG_XML : false;
  var _endpoint = url.split('/').pop();
  if (isXmlLogEnabled) {
    Logger.log('[NAV REQUEST] ' + _endpoint + '\n' + xmlBody);
  }

  var resp = UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/xml',
    headers: { 'Accept': 'application/xml' },
    payload: xmlBody,
    muteHttpExceptions: true
  });
  var code = resp.getResponseCode();
  var body = resp.getContentText('UTF-8');

  if (isXmlLogEnabled) {
    Logger.log('[NAV RESPONSE ' + code + '] ' + _endpoint + '\n' + body);
  }

  if (code >= 400) {
    try {
      var doc = XmlService.parse(body);
      navCheckForFault(doc.getRootElement());
    } catch(e2) {
      throw new Error('NAV HTTP ' + code + ': ' + body.substring(0, 800));
    }
    throw new Error('NAV HTTP ' + code + ': ' + body.substring(0, 800));
  }
  return body;
}

// ============================================================
// AUTH HELPERS
// ============================================================

function navNewRequestIdAndTimestamp() {
  var ts  = new Date();
  var rid = 'GAS' +
    Utilities.formatDate(ts, 'UTC', 'yyyyMMddHHmmss') +
    ('000' + Math.floor(Math.random() * 1000)).slice(-3);
  var timestamp = Utilities.formatDate(ts, 'UTC', "yyyy-MM-dd'T'HH:mm:ss.SSS'Z'");
  return { requestId: rid, timestamp: timestamp };
}

function navComputeRequestSignature(requestId, timestamp, signKey) {
  var m = timestamp.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/);
  if (!m) throw new Error('Érvénytelen timestamp: ' + timestamp);
  var compact = m[1] + m[2] + m[3] + m[4] + m[5] + m[6];
  return sha3_512Hex(requestId + compact + signKey).toUpperCase();
}

function navSha512Hex(str) {
  var bytes = Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_512, str, Utilities.Charset.UTF_8);
  var s = '';
  for (var i = 0; i < bytes.length; i++) {
    var h = (bytes[i] & 0xff).toString(16);
    s += h.length === 1 ? '0' + h : h;
  }
  return s;
}