/**
 * eVatVamApi.js — NAV eÁFA / eVatVam API kommunikáció
 *
 * Felelőssége:
 *   - eVatVamQueryDigest()  : kivonatos vámhatározat lekérdezés, lapozással
 *   - eVatVamQueryTaxCode() : részletes vámhatározat XML lekérdezés
 *   - eVatVam-specifikus XML request builder (eltérő namespace)
 *
 * NEM tartalmaz: sheet műveletek, UI, mezőleképezések.
 * Hívja: eVatVamDataprocessor.js, eVatVamSync.js
 * Újrahasználja: NavAuth.js, NavXmlUtils.js, NavConfig.js
 */

// ============================================================
// CONFIG
// ============================================================

function getEVatVamConfig() {
  var navCfg = getNavConfig();
  var p   = PropertiesService.getScriptProperties();
  var env = (p.getProperty('NAV_ENV') || 'production').toLowerCase();
  var apiUrl = p.getProperty('EAR_API_URL') || (
    env === 'test'
      ? 'https://api-test.eafa.nav.gov.hu/analyticsService/v1'
      : 'https://api.eafa.nav.gov.hu/analyticsService/v1'
  );
  return Object.assign({}, navCfg, { eVatVamApiUrl: apiUrl });
}

// ============================================================
// PUBLIC API — eVatVamQueryDigest
// ============================================================

/**
 * Kivonatos vámhatározat lekérdezés, automatikus lapozással (33-napos chunking).
 *
 * @param {Object} params
 *   declarationDateFrom    yyyy-MM-dd  (kötelező)
 *   declarationDateTo      yyyy-MM-dd  (kötelező)
 *   declarationDirection   IMPORTER|INDIRECT_REPRESENTATIVE  (alapért. IMPORTER)
 *   declarationOperation   CREATE|MODIFY  (opcionális)
 *   returnDualAgentOnly    boolean  (opcionális)
 *   maxPages               max lapszám (alapért. EVATVAM_MAX_DIGEST_PAGES)
 * @returns {Array<Object>}  declarationDigest plain objektumok tömbje
 */
function eVatVamQueryDigest(params) {
  params = params || {};
  var direction = (params.declarationDirection || 'IMPORTER').toUpperCase();
  var maxPages  = params.maxPages || EVATVAM_MAX_DIGEST_PAGES;

  if (!params.declarationDateFrom || !params.declarationDateTo) {
    throw new Error('declarationDateFrom és declarationDateTo megadása kötelező');
  }

  var msPerDay = 24 * 60 * 60 * 1000;
  var fDate    = new Date(params.declarationDateFrom + 'T00:00:00Z');
  var tDate    = new Date(params.declarationDateTo   + 'T00:00:00Z');
  var diffDays = (tDate.getTime() - fDate.getTime()) / msPerDay;

  if (diffDays > 33) {
    var allRowsChunked = [];
    var currentFrom    = new Date(fDate.getTime());
    while (currentFrom <= tDate) {
      var currentTo = new Date(currentFrom.getTime() + 33 * msPerDay);
      if (currentTo > tDate) currentTo = new Date(tDate.getTime());
      var chunkParams = JSON.parse(JSON.stringify(params));
      chunkParams.declarationDateFrom = Utilities.formatDate(currentFrom, 'UTC', 'yyyy-MM-dd');
      chunkParams.declarationDateTo   = Utilities.formatDate(currentTo,   'UTC', 'yyyy-MM-dd');
      allRowsChunked = allRowsChunked.concat(eVatVamQueryDigest(chunkParams));
      currentFrom = new Date(currentTo.getTime() + msPerDay);
    }
    return allRowsChunked;
  }

  var mandatory =
    '    <mandatoryDeclarationQueryParams>\n' +
    '      <declarationDateFrom>' + params.declarationDateFrom + '</declarationDateFrom>\n' +
    '      <declarationDateTo>'   + params.declarationDateTo   + '</declarationDateTo>\n' +
    '    </mandatoryDeclarationQueryParams>';

  var additional = eVatVamBuildAdditionalQueryParams(params);
  var declarationQueryParams =
    '  <declarationQueryParams>\n' + mandatory + '\n' + additional + '\n  </declarationQueryParams>';

  var cfg     = getEVatVamConfig();
  var allRows = [];
  var page    = 1;

  while (page <= maxPages) {
    var rt     = navNewRequestIdAndTimestamp();
    var sig    = navComputeRequestSignature(rt.requestId, rt.timestamp, cfg.signatureKey);
    var pwHash = cfg.passwordHash;

    var body =
      '  <page>' + page + '</page>\n' +
      '  <declarationDirection>' + direction + '</declarationDirection>\n' +
      declarationQueryParams;

    var xml     = eVatVamBuildRequestXml('QueryCustomsDeclarationDigestRequest', rt, pwHash, sig, cfg, body);
    var respXml = navPost(cfg.eVatVamApiUrl + '/queryCustomsDeclarationDigest', xml);
    var parsed  = eVatVamParseDigestResponse(respXml);

    parsed.rows.forEach(function(r) { allRows.push(r); });
    if (parsed.currentPage >= parsed.availablePages || parsed.rows.length === 0) break;
    page++;
  }
  return allRows;
}

// ============================================================
// PUBLIC API — eVatVamQueryTaxCode
// ============================================================

/**
 * Részletes vámhatározat adatok lekérdezése (adókód információ).
 *
 * @param {Object} params  { cdpsId, resolutionId, declarationDirection }
 * @returns {{ cdpsId, resolutionId, rawXml }}
 */
function eVatVamQueryTaxCode(params) {
  if (!params || !params.cdpsId || !params.resolutionId) {
    throw new Error('cdpsId és resolutionId megadása kötelező');
  }
  var direction = (params.declarationDirection || 'IMPORTER').toUpperCase();

  var cfg    = getEVatVamConfig();
  var rt     = navNewRequestIdAndTimestamp();
  var sig    = navComputeRequestSignature(rt.requestId, rt.timestamp, cfg.signatureKey);
  var pwHash = cfg.passwordHash;

  var body =
    '  <cdpsId>'               + navXmlEscape(params.cdpsId)       + '</cdpsId>\n' +
    '  <resolutionId>'         + navXmlEscape(params.resolutionId) + '</resolutionId>\n' +
    '  <declarationDirection>' + direction                          + '</declarationDirection>';

  var xml     = eVatVamBuildRequestXml('QueryCustomsDeclarationTaxCodeRequest', rt, pwHash, sig, cfg, body);
  var respXml = navPost(cfg.eVatVamApiUrl + '/queryCustomsDeclarationTaxCode', xml);

  return { cdpsId: params.cdpsId, resolutionId: params.resolutionId, rawXml: respXml };
}

// ============================================================
// REQUEST BUILDERS
// ============================================================

function eVatVamBuildAdditionalQueryParams(params) {
  var parts = [];
  if (params.declarationOperation) {
    parts.push('      <declarationOperation>' + params.declarationOperation + '</declarationOperation>');
  }
  if (params.returnDualAgentOnly !== undefined && params.returnDualAgentOnly !== null) {
    parts.push('      <returnDualAgentDeclarationsOnly>' +
               (params.returnDualAgentOnly ? 'true' : 'false') +
               '</returnDualAgentDeclarationsOnly>');
  }
  if (parts.length === 0) return '';
  return '    <additionalDeclarationQueryParams>\n' + parts.join('\n') + '\n    </additionalDeclarationQueryParams>';
}

/**
 * eVatVam-specifikus request XML builder.
 * Namespace: xmlns="http://schemas.nav.gov.hu/EAR/1.0/api"
 */
function eVatVamBuildRequestXml(rootTag, rt, pwHash, sig, cfg, bodyContent) {
  return (
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<' + rootTag +
    ' xmlns:common="http://schemas.nav.gov.hu/NTCA/1.0/common"' +
    ' xmlns="http://schemas.nav.gov.hu/EAR/1.0/api">\n' +
    '  <common:header>\n' +
    '    <common:requestId>'      + rt.requestId + '</common:requestId>\n' +
    '    <common:timestamp>'      + rt.timestamp + '</common:timestamp>\n' +
    '    <common:requestVersion>1.0</common:requestVersion>\n' +
    '    <common:headerVersion>1.0</common:headerVersion>\n' +
    '  </common:header>\n' +
    '  <common:user>\n' +
    '    <common:login>'          + navXmlEscape(cfg.login)     + '</common:login>\n' +
    '    <common:passwordHash cryptoType="SHA-512">'  + pwHash  + '</common:passwordHash>\n' +
    '    <common:taxNumber>'      + navXmlEscape(cfg.taxNumber) + '</common:taxNumber>\n' +
    '    <common:requestSignature cryptoType="SHA3-512">' + sig + '</common:requestSignature>\n' +
    '  </common:user>\n' +
    '  <software>\n    ' + eVatVamBuildSoftwareXml(cfg) + '\n  </software>\n' +
    bodyContent + '\n' +
    '</' + rootTag + '>'
  );
}

function eVatVamBuildSoftwareXml(cfg) {
  var devTaxNum = cfg.softwareDevTaxNumber || cfg.taxNumber || '00000000';
  return [
    '<softwareId>'             + navXmlEscape(cfg.softwareId)             + '</softwareId>',
    '<softwareName>'           + navXmlEscape(cfg.softwareName)           + '</softwareName>',
    '<softwareOperation>LOCAL_SOFTWARE</softwareOperation>',
    '<softwareMainVersion>'    + navXmlEscape(cfg.softwareVersion)        + '</softwareMainVersion>',
    '<softwareDevName>'        + navXmlEscape(cfg.softwareDevName)        + '</softwareDevName>',
    '<softwareDevContact>'     + navXmlEscape(cfg.softwareDevContact)     + '</softwareDevContact>',
    '<softwareDevCountryCode>' + navXmlEscape(cfg.softwareDevCountryCode) + '</softwareDevCountryCode>',
    '<softwareDevTaxNumber>'   + navXmlEscape(devTaxNum)                  + '</softwareDevTaxNumber>'
  ].join('\n    ');
}

// ============================================================
// RESPONSE PARSERS
// ============================================================

function eVatVamParseDigestResponse(respXml) {
  var doc  = XmlService.parse(respXml);
  var root = doc.getRootElement();
  eVatVamCheckForFault(root);

  var availablePages = 0, currentPage = 0;
  var avEl = navFindFirst(root, 'availablePage');
  var cuEl = navFindFirst(root, 'currentPage');
  if (avEl) availablePages = parseInt(avEl.getText(), 10) || 0;
  if (cuEl) currentPage    = parseInt(cuEl.getText(), 10) || 0;

  var digests = navFindDirectChildren(root, 'declarationDigest');
  var rows    = digests.map(eVatVamDigestToObject);

  if (rows.length > 0) Logger.log('[eVatVam DIGEST sample] ' + JSON.stringify(rows[0]));
  return { rows: rows, currentPage: currentPage, availablePages: availablePages };
}

function eVatVamDigestToObject(el) {
  var obj      = {};
  var children = el.getChildren();
  for (var i = 0; i < children.length; i++) {
    obj[children[i].getName()] = children[i].getText().trim();
  }
  return obj;
}

function eVatVamCheckForFault(root) {
  var local = root.getName();
  if (local === 'GeneralErrorResponse' || local === 'GeneralExceptionResponse') {
    var msg  = navTextOf(navFindFirst(root, 'message'))   || 'Ismeretlen eVatVam hiba';
    var code = navTextOf(navFindFirst(root, 'errorCode')) || navTextOf(navFindFirst(root, 'funcCode'));
    throw new Error('eVatVam hiba' + (code ? ' (' + code + ')' : '') + ': ' + msg);
  }
}
