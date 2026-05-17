/**
 * OpgApi.gs — NAV Online Pénztárgépnapló-lekérdező (OPF) API kommunikáció
 *
 * Felelőssége:
 *   - getOpgConfig()                : OPG-specifikus config (NAV config + OPG URL-ek)
 *   - opgQueryCashRegisterStatus()  : pénztárgép állapot lekérdezés (AP-lista, sorszám-tartomány)
 *   - opgQueryCashRegisterFile()    : naplófájl letöltés MTOM-mal (ZIP-pelt P7B-k)
 *   - opgGenerateTestData()         : tesztkörnyezetben tesztadat generálása (76 file/AP)
 *   - opgPost()                     : OPG-specifikus HTTP POST (UrlFetchApp Blob)
 *   - Multipart/MTOM válasz parser
 *   - XML request builder és válasz parser
 *
 * NEM tartalmaz: sheet műveletek, UI, mezőleképezések, ZIP/P7B kicsomagolás.
 * Hívja: OpgDataprocessor.gs (közvetve a Menu.gs-en keresztül)
 * Újrahasználja: NavApi.gs — navNewRequestIdAndTimestamp, navComputeRequestSignature,
 *                            navXmlEscape, navFindFirst, navFindAll, navFindDirectChildren,
 *                            navTextOf, navSha512Hex, getNavConfig
 *
 * NAV hivatalos specifikáció: OPF_specifikacio_v1.2.1
 *   https://github.com/nav-gov-hu/Online-Cash-Register-Logfile
 */

// ============================================================
// CONFIG
// ============================================================

/**
 * OPG API konfiguráció.
 * Újrahasználja a NAV Online Számla hitelesítési adatait (login, passwordHash, signatureKey,
 * taxNumber, software*) — a v1.1-es OPF specifikáció óta azonos a NAV Common séma.
 *
 * Az API base URL-eket env-alapján választja, de override-olható az OPG_API_BASE_URL
 * Script Property-vel (pl. saját proxy mögött).
 * Konstansok (OPG_DEBUG_LOG, OPG_TEST_*): Config.js
 */
function getOpgConfig() {
  var navCfg = getNavConfig();
  var p = PropertiesService.getScriptProperties();
  var env = (p.getProperty('NAV_ENV') || 'production').toLowerCase();
  var baseUrl = p.getProperty('OPG_API_BASE_URL') || (
    env === 'test'
      ? 'https://api-test-onlinepenztargep.nav.gov.hu'
      : 'https://api-onlinepenztargep.nav.gov.hu'
  );
  var cfg = Object.assign({}, navCfg, {
    opgBaseUrl: baseUrl,
    opgStatusUrl:   baseUrl + '/queryCashRegisterFile/v1/queryCashRegisterStatus',
    opgFileUrl:     baseUrl + '/queryCashRegisterFile/v1/queryCashRegisterFile',
    opgTestDataUrl: baseUrl + '/generateCashRegisterTestData/v1/generateCashRegisterTestData'
  });
  if (env === 'test') {
    cfg.login        = OPG_TEST_LOGIN;
    cfg.passwordHash = navSha512Hex(OPG_TEST_PASSWORD).toUpperCase();
    cfg.signatureKey = OPG_TEST_SIGN_KEY;
    cfg.exchangeKey  = OPG_TEST_EXCHANGE_KEY;
  }
  return cfg;
}

// ============================================================
// PUBLIC API — queryCashRegisterStatus
// ============================================================

/**
 * Pénztárgép állapot lekérdezés. APNumberList nélkül → adózó összes pénztárgépe.
 *
 * @param {Object} [params]
 *   apNumbers  {Array<string>}  pl. ['A12345678', 'A98765432'] — opcionális
 *
 * @returns {Array<{
 *   apNumber: string,
 *   lastCommunicationDate: string,
 *   lastFileDate: string,
 *   minAvailableFileNumber: number,
 *   maxAvailableFileNumber: number
 * }>}
 */
function opgQueryCashRegisterStatus(params) {
  params = params || {};
  var cfg = getOpgConfig();
  var rt  = navNewRequestIdAndTimestamp();
  var sig = navComputeRequestSignature(rt.requestId, rt.timestamp, cfg.signatureKey);

  var apListXml = '';
  if (params.apNumbers && params.apNumbers.length > 0) {
    var items = params.apNumbers.map(function(ap) {
      return '      <APNumber>' + navXmlEscape(ap) + '</APNumber>';
    }).join('\n');
    apListXml =
      '    <APNumberList>\n' + items + '\n    </APNumberList>';
  }

  var body =
    '  <cashRegisterStatusQuery>\n' +
       (apListXml ? apListXml + '\n' : '') +
    '  </cashRegisterStatusQuery>';

  var xml = opgBuildRequestXml('QueryCashRegisterStatusRequest', rt, cfg.passwordHash, sig, cfg, body);
  var resp = opgPost(cfg.opgStatusUrl, xml);
  return opgParseStatusResponse(resp.xml);
}

// ============================================================
// PUBLIC API — queryCashRegisterFile
// ============================================================

/**
 * Naplófájl letöltés MTOM-mal.
 *
 * @param {Object} params
 *   apNumber         {string}  AP szám (kötelező)
 *   fileNumberStart  {number}  első sorszám (kötelező)
 *   fileNumberEnd    {number}  utolsó sorszám (opcionális — különben nyitott)
 *
 * @returns {{
 *   allFilesSent: boolean,
 *   filesNotSentReason: string|null,
 *   minAvailableFileNumber: number,
 *   maxAvailableFileNumber: number,
 *   files: Array<{
 *     cashRegisterFileName: string,
 *     contentBytes: number[],          // bináris ZIP tartalom
 *     fileValidationResultCode: string,
 *     fileValidationErrorCode: string|null
 *   }>
 * }}
 */
function opgQueryCashRegisterFile(params) {
  if (!params || !params.apNumber)        throw new Error('apNumber kötelező');
  if (params.fileNumberStart == null)     throw new Error('fileNumberStart kötelező');

  var cfg = getOpgConfig();
  var rt  = navNewRequestIdAndTimestamp();
  var sig = navComputeRequestSignature(rt.requestId, rt.timestamp, cfg.signatureKey);

  var queryXml =
    '  <cashRegisterFileDataQuery>\n' +
    '    <APNumber>' + navXmlEscape(params.apNumber) + '</APNumber>\n' +
    '    <fileNumberStart>' + parseInt(params.fileNumberStart, 10) + '</fileNumberStart>\n' +
    (params.fileNumberEnd != null
      ? '    <fileNumberEnd>' + parseInt(params.fileNumberEnd, 10) + '</fileNumberEnd>\n'
      : '') +
    '  </cashRegisterFileDataQuery>';

  var xml = opgBuildRequestXml('QueryCashRegisterFileDataRequest', rt, cfg.passwordHash, sig, cfg, queryXml);
  var resp = opgPost(cfg.opgFileUrl, xml);
  return opgParseFileResponse(resp);
}

// ============================================================
// PUBLIC API — generateCashRegisterTestData (CSAK teszt env)
// ============================================================

/**
 * Tesztkörnyezet adatkészlet generálása egy adott AP-számra. 76 db naplófájl
 * jön létre, amelyek azonnal lekérdezhetők a queryCashRegisterFile-lal.
 * Éles környezetben az endpoint nem létezik.
 *
 * @param {Object} params
 *   apNumber  {string}  AP szám (kötelező)
 *
 * @returns {{funcCode: string, errorCode: string|null, message: string|null}}
 */
function opgGenerateTestData(params) {
  if (!params || !params.apNumber) throw new Error('apNumber kötelező');

  var cfg = getOpgConfig();
  if (cfg.env !== 'test') {
    throw new Error('generateCashRegisterTestData csak teszt környezetben hívható (jelenlegi env=' + cfg.env + '). Állítsd át a NAV_ENV Script Property-t "test"-re.');
  }

  var rt  = navNewRequestIdAndTimestamp();
  var sig = navComputeRequestSignature(rt.requestId, rt.timestamp, cfg.signatureKey);

  var body =
    '  <generateCashRegisterTestDataParameter>\n' +
    '    <APNumber>' + navXmlEscape(params.apNumber) + '</APNumber>\n' +
    '  </generateCashRegisterTestDataParameter>';

  var xml = opgBuildRequestXml('GenerateCashRegisterTestDataRequest', rt, cfg.passwordHash, sig, cfg, body);
  var resp = opgPost(cfg.opgTestDataUrl, xml);

  // A response csak BasicCashRegisterResponseType — funcCode + esetleges errorCode/message.
  var doc  = XmlService.parse(resp.xml);
  var root = doc.getRootElement();
  return {
    funcCode:  navTextOf(navFindFirst(root, 'funcCode')),
    errorCode: navTextOf(navFindFirst(root, 'errorCode')) || null,
    message:   navTextOf(navFindFirst(root, 'message'))   || null
  };
}

// ============================================================
// REQUEST BUILDER
// ============================================================

/**
 * OPG-specifikus request XML SOAP 1.2 Envelope-ba csomagolva.
 *
 * Az OPF API a WSDL szerint SOAP 1.2 over HTTP (soap12: binding), tehát NEM
 * elég a nyers root elem (mint az Online Számlánál), hanem teljes
 * <soap:Envelope><soap:Body>...</soap:Body></soap:Envelope> struktúra kell.
 *
 * Namespace: http://schemas.nav.gov.hu/OPF/1.0/api
 * requestVersion: 1.0 (a NAV csak ezt fogadja el)
 */
function opgBuildRequestXml(rootTag, rt, pwHash, sig, cfg, bodyContent) {
  var inner =
    '    <' + rootTag +
    ' xmlns:common="http://schemas.nav.gov.hu/NTCA/1.0/common"' +
    ' xmlns="http://schemas.nav.gov.hu/OPF/1.0/api">\n' +
    '      <common:header>\n' +
    '        <common:requestId>'      + rt.requestId  + '</common:requestId>\n' +
    '        <common:timestamp>'      + rt.timestamp  + '</common:timestamp>\n' +
    '        <common:requestVersion>1.0</common:requestVersion>\n' +
    '        <common:headerVersion>1.0</common:headerVersion>\n' +
    '      </common:header>\n' +
    '      <common:user>\n' +
    '        <common:login>'          + navXmlEscape(cfg.login)      + '</common:login>\n' +
    '        <common:passwordHash cryptoType="SHA-512">'  + pwHash   + '</common:passwordHash>\n' +
    '        <common:taxNumber>'      + navXmlEscape(cfg.taxNumber)  + '</common:taxNumber>\n' +
    '        <common:requestSignature cryptoType="SHA3-512">' + sig  + '</common:requestSignature>\n' +
    '      </common:user>\n' +
    '      <software>\n        ' + opgBuildSoftwareXml(cfg) + '\n      </software>\n' +
         bodyContent.replace(/^/gm, '    ') + '\n' +
    '    </' + rootTag + '>';

  return (
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<soap:Envelope xmlns:soap="http://www.w3.org/2003/05/soap-envelope">\n' +
    '  <soap:Body>\n' +
       inner + '\n' +
    '  </soap:Body>\n' +
    '</soap:Envelope>'
  );
}

function opgBuildSoftwareXml(cfg) {
  var parts = [
    '<softwareId>'             + navXmlEscape(cfg.softwareId)             + '</softwareId>',
    '<softwareName>'           + navXmlEscape(cfg.softwareName)           + '</softwareName>',
    '<softwareOperation>LOCAL_SOFTWARE</softwareOperation>',
    '<softwareMainVersion>'    + navXmlEscape(cfg.softwareVersion)        + '</softwareMainVersion>',
    '<softwareDevName>'        + navXmlEscape(cfg.softwareDevName)        + '</softwareDevName>',
    '<softwareDevContact>'     + navXmlEscape(cfg.softwareDevContact)     + '</softwareDevContact>',
    '<softwareDevCountryCode>' + navXmlEscape(cfg.softwareDevCountryCode) + '</softwareDevCountryCode>'
  ];
  if (cfg.softwareDevTaxNumber)
    parts.push('<softwareDevTaxNumber>' + navXmlEscape(cfg.softwareDevTaxNumber) + '</softwareDevTaxNumber>');
  return parts.join('\n    ');
}

// ============================================================
// HTTP TRANSPORT
// ============================================================

/**
 * OPG-specifikus HTTP POST. Visszaadja a teljes választ: XML body + esetleges
 * MTOM attachmentek. A naplófájl letöltésnél a válasz multipart/related;
 * minden más operációnál single XML.
 *
 * @returns {{
 *   httpCode: number,
 *   contentType: string,
 *   xml: string,                              // a SOAP body XML része (UTF-8)
 *   attachments: Array<{
 *     contentId: string,
 *     contentType: string,
 *     bytes: number[]                          // bináris adat
 *   }>
 * }}
 */
function opgPost(url, xmlBody) {
  var endpoint = url.split('/').slice(-1)[0];
  if (OPG_DEBUG_LOG) {
    Logger.log('[OPG REQUEST] ' + endpoint + '\nURL: ' + url + '\nBody (' + xmlBody.length + ' byte):\n' + xmlBody);
  }

  // SOAP 1.2 Content-Type. A WSDL üres soapAction-t ír elő, így nem küldünk action paramétert.
  var resp = UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/soap+xml; charset=UTF-8',
    headers: { 'Accept': 'application/soap+xml, multipart/related, application/xml' },
    payload: xmlBody,
    muteHttpExceptions: true,
    timeoutSeconds: 60
  });

  var code        = resp.getResponseCode();
  var headers     = resp.getAllHeaders() || {};
  var contentType = headers['Content-Type'] || headers['content-type'] || '';
  var rawBytes    = resp.getContent();

  var parsed;
  if (/multipart\//i.test(contentType)) {
    parsed = opgParseMultipart(rawBytes, contentType);
  } else {
    var bodyText = resp.getContentText('UTF-8');
    parsed = { xml: bodyText, attachments: [] };
  }

  if (OPG_DEBUG_LOG) {
    Logger.log('[OPG RESPONSE ' + code + '] ' + endpoint + '\nContent-Type: ' + contentType +
               '\nXML (' + parsed.xml.length + ' byte):\n' + parsed.xml);
    for (var ai = 0; ai < parsed.attachments.length; ai++) {
      var att = parsed.attachments[ai];
      Logger.log('[OPG ATTACHMENT ' + ai + '] contentId=' + att.contentId +
                 ', type=' + att.contentType + ', size=' + att.bytes.length + ' byte, head(hex)=' +
                 opgBytesToHex(att.bytes.slice(0, 64)));
    }
  }

  if (code >= 400) {
    // 500 esetén gyakran SOAP Fault jön (Code/Value + Reason/Text), 4xx-nél a NAV
    // GeneralErrorResponse-ban hozza a funcCode/errorCode/message-et.
    Logger.log('[OPG HTTP ' + code + ' BODY] ' + endpoint + ' (' + parsed.xml.length + ' byte):\n' + parsed.xml);
    try {
      var doc = XmlService.parse(parsed.xml);
      opgCheckForFault(doc.getRootElement());
    } catch (e) {
      if (/^OPG hiba/.test(e.message)) throw e;
    }
    throw new Error('OPG HTTP ' + code + ': ' + (parsed.xml.substring(0, 1500) || '(üres válasz body)'));
  }

  // A NAV "üzleti hibákat" HTTP 200-ban hozza vissza: funcCode=ERROR vagy SOAP Fault
  try {
    var doc2 = XmlService.parse(parsed.xml);
    opgCheckForFault(doc2.getRootElement());
  } catch (e2) {
    if (/^OPG hiba/.test(e2.message)) throw e2;
  }

  return { httpCode: code, contentType: contentType, xml: parsed.xml, attachments: parsed.attachments };
}

/**
 * Multipart/related → { xml, attachments }
 * A NAV az XOP/MTOM-ot használja:
 *   - Az első part a SOAP XML (application/xop+xml vagy application/xml)
 *   - A többi part egy-egy binary fájl (Content-ID: <cid-...>)
 *
 * @param {number[]} rawBytes  a teljes HTTP body bájtjai
 * @param {string} contentType  pl. multipart/related; boundary="uuid:..."
 */
function opgParseMultipart(rawBytes, contentType) {
  var m = contentType.match(/boundary\s*=\s*"?([^";]+)"?/i);
  if (!m) throw new Error('Multipart válasz boundary nélkül: ' + contentType);
  var boundary = m[1];

  // Mindent UTF-8 mintaként kezelünk a boundary kereséshez, a partok belsejében
  // viszont megőrizzük a bináris bájtokat.
  var boundaryBytes = opgStringToUtf8Bytes('--' + boundary);
  var positions = opgFindAllByteOccurrences(rawBytes, boundaryBytes);
  if (positions.length < 2) throw new Error('Nem található elég boundary marker a válaszban (talált=' + positions.length + ')');

  var parts = [];
  for (var i = 0; i < positions.length - 1; i++) {
    var start = positions[i] + boundaryBytes.length;
    var end   = positions[i + 1];
    // \r\n vagy \n a boundary után — átléptetjük
    while (start < end && (rawBytes[start] === 0x0d || rawBytes[start] === 0x0a)) start++;
    if (start >= end) continue;
    // a part vége előtt visszafelé eltávolítjuk a \r\n elválasztót
    // (csak \r és \n, NEM '-' — egy ZIP payload utolsó bájtja jogosan lehet 0x2d)
    var partEnd = end;
    while (partEnd > start && (rawBytes[partEnd - 1] === 0x0d || rawBytes[partEnd - 1] === 0x0a)) partEnd--;

    parts.push({ from: start, to: partEnd });
  }

  // Az utolsó "--boundary--" zárókapcsoló után stop — ha végén további bájtok vannak, ignoráljuk

  var xml = '';
  var attachments = [];

  for (var p = 0; p < parts.length; p++) {
    var part = parts[p];
    // Header–body szétválasztás: első üres sor (\r\n\r\n vagy \n\n)
    var sep = opgFindHeaderBodySeparator(rawBytes, part.from, part.to);
    if (sep === -1) continue;
    var headerStr = opgBytesToUtf8Substring(rawBytes, part.from, sep.headerEnd);
    var bodyFrom  = sep.bodyStart;
    var bodyTo    = part.to;

    var headers = opgParseHeaders(headerStr);
    var ct = headers['content-type'] || '';
    var cid = (headers['content-id'] || '').replace(/^<|>$/g, '');

    if (/xop\+xml/i.test(ct) || /^application\/xml/i.test(ct) || (!xml && /xml/i.test(ct))) {
      // Az XML part-ot szöveggé alakítjuk UTF-8 alapján
      xml = opgBytesToUtf8Substring(rawBytes, bodyFrom, bodyTo);
    } else {
      // Binary attachment
      var bytes = [];
      for (var bi = bodyFrom; bi < bodyTo; bi++) bytes.push(rawBytes[bi] & 0xff);
      attachments.push({ contentId: cid, contentType: ct, bytes: bytes });
    }
  }

  if (!xml) throw new Error('Multipart válaszban nem találtam XML root part-ot');
  return { xml: xml, attachments: attachments };
}

function opgFindHeaderBodySeparator(bytes, from, to) {
  for (var i = from; i < to - 3; i++) {
    if (bytes[i] === 0x0d && bytes[i+1] === 0x0a && bytes[i+2] === 0x0d && bytes[i+3] === 0x0a) {
      return { headerEnd: i, bodyStart: i + 4 };
    }
  }
  for (var j = from; j < to - 1; j++) {
    if (bytes[j] === 0x0a && bytes[j+1] === 0x0a) {
      return { headerEnd: j, bodyStart: j + 2 };
    }
  }
  return -1;
}

function opgParseHeaders(headerStr) {
  var out = {};
  var lines = headerStr.split(/\r?\n/);
  for (var i = 0; i < lines.length; i++) {
    var ln = lines[i];
    var idx = ln.indexOf(':');
    if (idx < 1) continue;
    var k = ln.substring(0, idx).trim().toLowerCase();
    var v = ln.substring(idx + 1).trim();
    out[k] = v;
  }
  return out;
}

function opgFindAllByteOccurrences(haystack, needle) {
  var out = [];
  var nl = needle.length;
  var hl = haystack.length;
  outer: for (var i = 0; i <= hl - nl; i++) {
    for (var j = 0; j < nl; j++) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
    out.push(i);
    i += nl - 1;
  }
  return out;
}

function opgStringToUtf8Bytes(s) {
  var blob = Utilities.newBlob(s, 'text/plain', 'b.txt');
  return blob.getBytes();
}

function opgBytesToUtf8Substring(bytes, from, to) {
  var slice = [];
  for (var i = from; i < to; i++) slice.push(bytes[i]);
  return Utilities.newBlob(slice).getDataAsString('UTF-8');
}

function opgBytesToHex(bytes) {
  var s = '';
  for (var i = 0; i < bytes.length; i++) {
    var b = bytes[i] & 0xff;
    s += (b < 16 ? '0' : '') + b.toString(16);
  }
  return s;
}

// ============================================================
// RESPONSE PARSERS
// ============================================================

function opgParseStatusResponse(respXml) {
  var doc  = XmlService.parse(respXml);
  var root = doc.getRootElement();
  opgCheckForFault(root);

  var listEl = navFindFirst(root, 'cashRegisterStatusList');
  if (!listEl) return [];

  var items = navFindDirectChildren(listEl, 'cashRegisterStatus');
  return items.map(function(el) {
    return {
      apNumber:               navTextOf(navFindFirst(el, 'APNumber')),
      lastCommunicationDate:  navTextOf(navFindFirst(el, 'lastCommunicationDate')),
      lastFileDate:           navTextOf(navFindFirst(el, 'lastFileDate')),
      minAvailableFileNumber: parseInt(navTextOf(navFindFirst(el, 'minAvailableFileNumber')), 10) || 0,
      maxAvailableFileNumber: parseInt(navTextOf(navFindFirst(el, 'maxAvailableFileNumber')), 10) || 0
    };
  });
}

/**
 * queryCashRegisterFile válasz parse-olása. A bináris naplófájlok az MTOM
 * attachmentekből származnak, az XML pedig hivatkozást (xop:Include) tartalmaz.
 */
function opgParseFileResponse(resp) {
  var doc  = XmlService.parse(resp.xml);
  var root = doc.getRootElement();
  opgCheckForFault(root);

  var result = navFindFirst(root, 'cashRegisterFileDataResult');
  if (!result) {
    return { allFilesSent: true, filesNotSentReason: null,
             minAvailableFileNumber: 0, maxAvailableFileNumber: 0, files: [] };
  }

  var allFilesSent = (navTextOf(navFindFirst(result, 'allFilesSent')) === 'true');
  var notSent      = navTextOf(navFindFirst(result, 'filesNotSentReason')) || null;
  var minAv        = parseInt(navTextOf(navFindFirst(result, 'minAvailableFileNumber')), 10) || 0;
  var maxAv        = parseInt(navTextOf(navFindFirst(result, 'maxAvailableFileNumber')), 10) || 0;

  // contentId → attachment lookup
  var byCid = {};
  for (var i = 0; i < resp.attachments.length; i++) {
    var att = resp.attachments[i];
    byCid[att.contentId] = att;
  }

  var listEl = navFindFirst(result, 'cashRegisterFileDataList');
  var files = [];
  if (listEl) {
    var fileEls = navFindDirectChildren(listEl, 'cashRegisterFileData');
    for (var f = 0; f < fileEls.length; f++) {
      var fEl  = fileEls[f];
      var name = navTextOf(navFindFirst(fEl, 'cashRegisterFileName'));
      var validation = navTextOf(navFindFirst(fEl, 'fileValidationResultCode'));
      var errorCode  = navTextOf(navFindFirst(fEl, 'fileValidationErrorCode')) || null;

      // cashRegisterFile lehet:
      //   (a) xop:Include href="cid:..." → MTOM attachment-re mutat
      //   (b) base64 inline (kis fájloknál előfordulhat)
      var fileEl = navFindFirst(fEl, 'cashRegisterFile');
      var bytes  = null;
      if (fileEl) {
        var include = navFindFirst(fileEl, 'Include');
        if (include) {
          var href = include.getAttribute('href');
          var hrefVal = href ? href.getValue() : '';
          var cid = decodeURIComponent(hrefVal.replace(/^cid:/, ''));
          if (byCid[cid]) bytes = byCid[cid].bytes;
        } else {
          var inlineB64 = fileEl.getText().trim();
          if (inlineB64) {
            bytes = Utilities.base64Decode(inlineB64);
          }
        }
      }

      files.push({
        cashRegisterFileName:     name,
        contentBytes:             bytes || [],
        fileValidationResultCode: validation,
        fileValidationErrorCode:  errorCode
      });
    }
  }

  return {
    allFilesSent:           allFilesSent,
    filesNotSentReason:     notSent,
    minAvailableFileNumber: minAv,
    maxAvailableFileNumber: maxAv,
    files:                  files
  };
}

function opgCheckForFault(root) {
  if (!root) return;

  // SOAP 1.2 Fault: <soap:Fault><Code><Value>...</Value></Code><Reason><Text>...</Text></Reason><Detail>...</Detail></Fault>
  var faultEl = navFindFirst(root, 'Fault');
  if (faultEl) {
    var faultCode   = navTextOf(navFindFirst(faultEl, 'Value'));
    var faultReason = navTextOf(navFindFirst(faultEl, 'Text'));
    // Detail-ben sokszor a NAV-féle BasicResultType található (funcCode/errorCode/message)
    var detailEl    = navFindFirst(faultEl, 'Detail');
    var detailCode  = detailEl ? navTextOf(navFindFirst(detailEl, 'errorCode')) : '';
    var detailMsg   = detailEl ? navTextOf(navFindFirst(detailEl, 'message'))   : '';
    var label = detailCode || faultCode || 'SOAP_FAULT';
    var msg   = detailMsg  || faultReason || 'Ismeretlen SOAP Fault';
    throw new Error('OPG hiba (' + label + '): ' + msg);
  }

  // NAV BasicResultType: funcCode=ERROR + errorCode + message
  var funcCode = navTextOf(navFindFirst(root, 'funcCode'));
  if (funcCode === 'ERROR') {
    var resMsg  = navTextOf(navFindFirst(root, 'message'))   || 'Ismeretlen OPG hiba';
    var resCode = navTextOf(navFindFirst(root, 'errorCode')) || '';
    throw new Error('OPG hiba' + (resCode ? ' (' + resCode + ')' : '') + ': ' + resMsg);
  }

  // GeneralErrorResponse fallback (mint az Online Számlánál)
  var local = root.getName();
  if (local === 'GeneralErrorResponse' || local === 'GeneralExceptionResponse') {
    var gMsg  = navTextOf(navFindFirst(root, 'message'))   || 'Ismeretlen OPG hiba';
    var gCode = navTextOf(navFindFirst(root, 'errorCode')) || navTextOf(navFindFirst(root, 'funcCode'));
    throw new Error('OPG hiba' + (gCode ? ' (' + gCode + ')' : '') + ': ' + gMsg);
  }
}
