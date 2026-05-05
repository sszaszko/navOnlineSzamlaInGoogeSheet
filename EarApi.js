/**
 * EarApi.gs — NAV Elektronikus ÁFA rendszer (eÁFA / EAR) API kommunikáció
 *
 * Felelőssége:
 *   - queryCustomsDeclarationDigest()  : kivonatos vámhatározat lekérdezés, lapozással
 *   - queryCustomsDeclarationTaxCode() : részletes vámhatározat XML lekérdezés
 *   - EAR-specifikus XML request builder (különböző namespace)
 *
 * NEM tartalmaz: sheet műveletek, UI, mezőleképezések.
 * Hívja: EarDataprocessor.gs (közvetve a Menu.gs-en keresztül)
 * Újrahasználja: NavApi.gs — navPost, navComputeRequestSignature, navSha512Hex,
 *                             navXmlEscape, navFindFirst, navFindDirectChildren,
 *                             navTextOf, navNewRequestIdAndTimestamp, getNavConfig
 */

// ============================================================
// CONFIG
// ============================================================

/**
 * eÁFA API konfiguráció.
 * Újrahasználja a NAV Online Számla hitelesítési adatait (login, password, stb.),
 * az API URL-t az EAR_API_URL script property-ből olvassa.
 */
function getEarConfig() {
  var navCfg = getNavConfig();
  var p = PropertiesService.getScriptProperties();
  var env = (p.getProperty('NAV_ENV') || 'production').toLowerCase();
  var earApiUrl = p.getProperty('EAR_API_URL') || (
    env === 'test'
      ? 'https://api-test.eafa.nav.gov.hu/analyticsService/v1'
      : 'https://api.eafa.nav.gov.hu/analyticsService/v1'
  );
  return Object.assign({}, navCfg, { earApiUrl: earApiUrl });
}

// ============================================================
// PUBLIC API — queryCustomsDeclarationDigest
// ============================================================

/**
 * Kivonatos vámhatározat lekérdezés, automatikus lapozással.
 *
 * @param {Object} params
 *   declarationDateFrom    yyyy-MM-dd  (kötelező)
 *   declarationDateTo      yyyy-MM-dd  (kötelező)
 *   declarationDirection   IMPORTER|INDIRECT_REPRESENTATIVE  (alapért. IMPORTER)
 *   declarationOperation   CREATE|MODIFY  (opcionális)
 *   returnDualAgentOnly    boolean  (opcionális)
 *   maxPages               max lapszám (alapért. 20)
 *
 * @returns {Array<Object>}  declarationDigest plain objektumok tömbje
 */
function queryCustomsDeclarationDigest(params) {
  params = params || {};
  var direction = (params.declarationDirection || 'IMPORTER').toUpperCase();
  var maxPages = params.maxPages || 20;

  if (!params.declarationDateFrom || !params.declarationDateTo) {
    throw new Error('declarationDateFrom és declarationDateTo megadása kötelező');
  }

  var mandatory =
    '    <mandatoryDeclarationQueryParams>\n' +
    '      <declarationDateFrom>' + params.declarationDateFrom + '</declarationDateFrom>\n' +
    '      <declarationDateTo>'   + params.declarationDateTo   + '</declarationDateTo>\n' +
    '    </mandatoryDeclarationQueryParams>';

  var additional = earBuildAdditionalDeclarationQueryParams(params);
  var declarationQueryParams =
    '  <declarationQueryParams>\n' + mandatory + '\n' + additional + '\n  </declarationQueryParams>';

  var cfg = getEarConfig();
  var allRows = [];
  var page = 1;

  while (page <= maxPages) {
    var rt = navNewRequestIdAndTimestamp();
    var sig = navComputeRequestSignature(rt.requestId, rt.timestamp, cfg.signatureKey);
    var pwHash = navSha512Hex(cfg.password).toUpperCase();

    var body =
      '  <page>' + page + '</page>\n' +
      '  <declarationDirection>' + direction + '</declarationDirection>\n' +
      declarationQueryParams;

    var xml = earBuildRequestXml('QueryCustomsDeclarationDigestRequest', rt, pwHash, sig, cfg, body);
    var respXml = navPost(cfg.earApiUrl + '/queryCustomsDeclarationDigest', xml);
    var parsed = earParseDeclarationDigestResponse(respXml);

    parsed.rows.forEach(function(r) { allRows.push(r); });
    if (parsed.currentPage >= parsed.availablePages || parsed.rows.length === 0) break;
    page++;
  }
  return allRows;
}

// ============================================================
// PUBLIC API — queryCustomsDeclarationTaxCode
// ============================================================

/**
 * Részletes vámhatározat adatok lekérdezése (adókód információ).
 *
 * @param {Object} params
 *   cdpsId                 string  (kötelező) — a digest-ből
 *   resolutionId           string  (kötelező) — a digest-ből
 *   declarationDirection   IMPORTER|INDIRECT_REPRESENTATIVE  (alapért. IMPORTER)
 *
 * @returns {{ cdpsId, resolutionId, rawXml }}
 */
function queryCustomsDeclarationTaxCode(params) {
  if (!params || !params.cdpsId || !params.resolutionId) {
    throw new Error('cdpsId és resolutionId megadása kötelező');
  }
  var direction = (params.declarationDirection || 'IMPORTER').toUpperCase();

  var cfg = getEarConfig();
  var rt = navNewRequestIdAndTimestamp();
  var sig = navComputeRequestSignature(rt.requestId, rt.timestamp, cfg.signatureKey);
  var pwHash = navSha512Hex(cfg.password).toUpperCase();

  var body =
    '  <cdpsId>'               + navXmlEscape(params.cdpsId)       + '</cdpsId>\n' +
    '  <resolutionId>'         + navXmlEscape(params.resolutionId) + '</resolutionId>\n' +
    '  <declarationDirection>' + direction                          + '</declarationDirection>';

  var xml = earBuildRequestXml('QueryCustomsDeclarationTaxCodeRequest', rt, pwHash, sig, cfg, body);
  var respXml = navPost(cfg.earApiUrl + '/queryCustomsDeclarationTaxCode', xml);

  return {
    cdpsId:       params.cdpsId,
    resolutionId: params.resolutionId,
    rawXml:       respXml
  };
}

// ============================================================
// REQUEST BUILDERS
// ============================================================

function earBuildAdditionalDeclarationQueryParams(params) {
  var parts = [];
  if (params.declarationOperation) {
    parts.push('      <declarationOperation>' + params.declarationOperation + '</declarationOperation>');
  }
  if (params.returnDualAgentOnly !== undefined && params.returnDualAgentOnly !== null) {
    parts.push('      <returnDualAgentDeclarationsOnly>' + (params.returnDualAgentOnly ? 'true' : 'false') + '</returnDualAgentDeclarationsOnly>');
  }
  if (parts.length === 0) return '';
  return '    <additionalDeclarationQueryParams>\n' + parts.join('\n') + '\n    </additionalDeclarationQueryParams>';
}

/**
 * EAR-specifikus request XML builder.
 * A NAV Online Számla-tól eltérő namespace-t használ:
 *   xmlns="http://schemas.nav.gov.hu/EAR/1.0/api"
 * Az autentikáció (common:header, common:user) azonos struktúrájú.
 */
function earBuildRequestXml(rootTag, rt, pwHash, sig, cfg, bodyContent) {
  return (
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<' + rootTag +
    ' xmlns:common="http://schemas.nav.gov.hu/NTCA/1.0/common"' +
    ' xmlns="http://schemas.nav.gov.hu/EAR/1.0/api">\n' +
    '  <common:header>\n' +
    '    <common:requestId>'      + rt.requestId  + '</common:requestId>\n' +
    '    <common:timestamp>'      + rt.timestamp  + '</common:timestamp>\n' +
    '    <common:requestVersion>1.0</common:requestVersion>\n' +
    '    <common:headerVersion>1.0</common:headerVersion>\n' +
    '  </common:header>\n' +
    '  <common:user>\n' +
    '    <common:login>'          + navXmlEscape(cfg.login)      + '</common:login>\n' +
    '    <common:passwordHash cryptoType="SHA-512">'  + pwHash   + '</common:passwordHash>\n' +
    '    <common:taxNumber>'      + navXmlEscape(cfg.taxNumber)  + '</common:taxNumber>\n' +
    '    <common:requestSignature cryptoType="SHA3-512">' + sig  + '</common:requestSignature>\n' +
    '  </common:user>\n' +
    '  <software>\n    ' + earBuildSoftwareXml(cfg) + '\n  </software>\n' +
    bodyContent + '\n' +
    '</' + rootTag + '>'
  );
}

function earBuildSoftwareXml(cfg) {
  var parts = [
    '<softwareId>'           + navXmlEscape(cfg.softwareId)               + '</softwareId>',
    '<softwareName>'         + navXmlEscape(cfg.softwareName)             + '</softwareName>',
    '<softwareOperation>LOCAL_SOFTWARE</softwareOperation>',
    '<softwareMainVersion>'  + navXmlEscape(cfg.softwareVersion)          + '</softwareMainVersion>',
    '<softwareDevName>'      + navXmlEscape(cfg.softwareDevName)          + '</softwareDevName>',
    '<softwareDevContact>'   + navXmlEscape(cfg.softwareDevContact)       + '</softwareDevContact>',
    '<softwareDevCountryCode>' + navXmlEscape(cfg.softwareDevCountryCode) + '</softwareDevCountryCode>'
  ];
  var devTaxNum = cfg.softwareDevTaxNumber || cfg.taxNumber || '00000000';
  parts.push('<softwareDevTaxNumber>' + navXmlEscape(devTaxNum) + '</softwareDevTaxNumber>');
  return parts.join('\n    ');
}

// ============================================================
// RESPONSE PARSERS
// ============================================================

/**
 * QueryCustomsDeclarationDigestResponse → { rows, currentPage, availablePages }
 */
function earParseDeclarationDigestResponse(respXml) {
  var doc = XmlService.parse(respXml);
  var root = doc.getRootElement();
  earCheckForFault(root);

  var availablePages = 0, currentPage = 0;
  var avEl = navFindFirst(root, 'availablePage');
  var cuEl = navFindFirst(root, 'currentPage');
  if (avEl) availablePages = parseInt(avEl.getText(), 10) || 0;
  if (cuEl) currentPage    = parseInt(cuEl.getText(), 10) || 0;

  var digests = navFindDirectChildren(root, 'declarationDigest');
  var rows = digests.map(earDeclarationDigestToObject);

  if (rows.length > 0) {
    Logger.log('[EAR DIGEST sample] ' + JSON.stringify(rows[0]));
  }
  return { rows: rows, currentPage: currentPage, availablePages: availablePages };
}

/**
 * declarationDigest XML elem → lapos plain object.
 * Mezők (a DeclarationDigestType alapján):
 *   cdpsId, resolutionId, declarationOperation,
 *   importerTaxNumber, indirectRepresentativeTaxNumber,
 *   importerSelfTaxationIndicator, indirectRepresentativeSelfTaxationIndicator,
 *   taxpointDate, deliveryDate, totalNetAmount, totalVatAmount
 */
function earDeclarationDigestToObject(el) {
  var obj = {};
  var children = el.getChildren();
  for (var i = 0; i < children.length; i++) {
    var c = children[i];
    obj[c.getName()] = c.getText().trim();
  }
  return obj;
}

function earCheckForFault(root) {
  var local = root.getName();
  if (local === 'GeneralErrorResponse' || local === 'GeneralExceptionResponse') {
    var msg  = navTextOf(navFindFirst(root, 'message'))   || 'Ismeretlen eÁFA hiba';
    var code = navTextOf(navFindFirst(root, 'errorCode')) || navTextOf(navFindFirst(root, 'funcCode'));
    throw new Error('eÁFA hiba' + (code ? ' (' + code + ')' : '') + ': ' + msg);
  }
}
