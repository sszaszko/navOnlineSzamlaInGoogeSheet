/**
 * NavXmlUtils.js — Megosztott XML helperek és HTTP transport.
 *
 * Mind az OSA, mind az eVatVam, mind az OPG alrendszer használja ezeket
 * (kivéve navPost-ot, amit az OPG saját opgPost-tal váltott le, mert MTOM-mal jön a válasz).
 *
 * Tartalmaz:
 *   - navFindFirst / navFindAll / navFindDirectChildren — XML elem keresés
 *   - navXmlFlatten / navXmlText — gyors O(1) elérés laposított struktúrával
 *   - navTextOf / navXmlEscape — apró segédfüggvények
 *   - navElementToObject — XML → plain JS objektum
 *   - navDecodeInvoiceData — base64+gzip kicsomagolás (OSA invoiceXml-hez)
 *   - navCheckForFault — GeneralError/ExceptionResponse → Error throw
 *   - navPost — egyszerű XML POST (OSA + eVatVam használja, OPG saját mtom-os)
 */

// ============================================================
// XML keresés
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
 * XmlElement fát plain JS objektummá lapítja: egyetlen DOM-bejárással kinyeri
 * az összes csomópont szövegét. Eredmény: { _text: '...', childTag: { _text: '...', ... } }
 * Ismétlődő tagneveknél csak az első példány kerül be.
 */
function navXmlFlatten(el) {
  if (!el || typeof el.getChildren !== 'function') return { _text: '' };
  var obj = { _text: el.getText ? el.getText().trim() : '' };
  var children = el.getChildren();
  for (var i = 0; i < children.length; i++) {
    var child = children[i];
    var name = child.getName();
    if (!obj.hasOwnProperty(name)) {
      obj[name] = navXmlFlatten(child);
    }
  }
  return obj;
}

/**
 * XML szöveg kinyerése szóközzel elválasztott tag-út mentén.
 * Elfogad XmlElement-et (DFS) és navXmlFlatten() által létrehozott plain objektumot (O(1)) is.
 * Pl. navXmlText(head, 'supplierTaxNumber taxpayerId')
 */
function navXmlText(root, path) {
  if (!root) return '';
  var parts = path.split(' ');
  var cur = root;
  if (typeof cur.getChildren === 'function') {
    for (var i = 0; i < parts.length; i++) {
      cur = navFindFirst(cur, parts[i]);
      if (!cur) return '';
    }
    return cur.getText ? cur.getText().trim() : '';
  } else {
    for (var i = 0; i < parts.length; i++) {
      cur = cur[parts[i]];
      if (!cur) return '';
    }
    return cur._text || '';
  }
}

function navTextOf(el) { return el ? el.getText().trim() : ''; }

function navXmlEscape(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

/**
 * XmlElement → plain JS objektum (rekurzív).
 * Ismétlődő tagnévhez tömböt hoz létre. Levél elemnél a szöveget adja vissza.
 */
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

// ============================================================
// OSA invoiceData kicsomagolás (base64 + opcionálisan gzip)
// ============================================================

function navDecodeInvoiceData(b64, compressed) {
  var bytes = Utilities.base64Decode(b64);
  var rawBytes;
  if (compressed) {
    var gzBlob = Utilities.newBlob(bytes, 'application/x-gzip', 'invoice.xml.gz');
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

// ============================================================
// Hibakezelés — GeneralErrorResponse / GeneralExceptionResponse
// ============================================================

function navCheckForFault(root) {
  var local = root.getName();
  if (local === 'GeneralErrorResponse' || local === 'GeneralExceptionResponse') {
    var msg  = navTextOf(navFindFirst(root, 'message'))    || 'Ismeretlen NAV hiba';
    var code = navTextOf(navFindFirst(root, 'errorCode'))  || navTextOf(navFindFirst(root, 'funcCode'));
    throw new Error('NAV hiba' + (code ? ' (' + code + ')' : '') + ': ' + msg);
  }
}

// ============================================================
// HTTP POST — egyszerű XML kérés (OSA + eVatVam)
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
    muteHttpExceptions: true,
    timeoutSeconds: 30
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
