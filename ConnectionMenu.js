/**
 * ConnectionMenu.js — NAV adatkapcsolat beállítása + diagnosztika.
 *
 * Felelőssége:
 *   - menuSetupNavConnection : HTML modal megnyitása (mode='setup')
 *   - menuTestConnection     : HTML modal megnyitása (mode='testOnly')
 *   - getNavConnectionState / saveNavConnection : NavConnectionDialog.html GAS backend
 *   - runNavConnectionDiagnostic : strukturált diagnosztika (mai napra szóló minimal digest)
 *
 * A funkcionális Script Property-ket: NAV_LOGIN, NAV_PASSWORD_HASH,
 * NAV_TAX_NUMBER, NAV_SIGNATURE_KEY, NAV_EXCHANGE_KEY használjuk.
 * A jelszót SHA-512 hash-ként tároljuk — a NAV API úgyis ezt fogadja.
 */

// ============================================================
// MENÜ HANDLEREK
// ============================================================

function menuSetupNavConnection() {
  var template = HtmlService.createTemplateFromFile('NavConnectionDialog');
  template.mode = 'setup';
  var html = template.evaluate().setWidth(520).setHeight(820);
  SpreadsheetApp.getUi().showModalDialog(html, 'NAV adatkapcsolat beállítása');
}

function menuTestConnection() {
  var template = HtmlService.createTemplateFromFile('NavConnectionDialog');
  template.mode = 'testOnly';
  var html = template.evaluate().setWidth(520).setHeight(640);
  SpreadsheetApp.getUi().showModalDialog(html, 'NAV kapcsolat teszt');
}

// ============================================================
// DIALOG BACKEND — google.script.run hívásai
// ============================================================

function getNavConnectionState() {
  var p = PropertiesService.getScriptProperties();
  var login   = p.getProperty('NAV_LOGIN');
  var taxNum  = p.getProperty('NAV_TAX_NUMBER');
  var pwHash  = p.getProperty('NAV_PASSWORD_HASH');
  var pwPlain = p.getProperty('NAV_PASSWORD'); // legacy
  var sigKey  = p.getProperty('NAV_SIGNATURE_KEY');
  var exKey   = p.getProperty('NAV_EXCHANGE_KEY');
  return {
    NAV_LOGIN:         { hasValue: !!login,                 displayValue: login  || null },
    NAV_PASSWORD:      { hasValue: !!(pwHash || pwPlain),   displayValue: null            },
    NAV_TAX_NUMBER:    { hasValue: !!taxNum,                displayValue: taxNum || null },
    NAV_SIGNATURE_KEY: { hasValue: !!sigKey,                displayValue: null            },
    NAV_EXCHANGE_KEY:  { hasValue: !!exKey,                 displayValue: null            }
  };
}

function saveNavConnection(data) {
  var p = PropertiesService.getScriptProperties();
  var saved = [];

  var l = ((data && data.NAV_LOGIN) || '').trim();
  if (l) { p.setProperty('NAV_LOGIN', l); saved.push('felhasználónév'); }

  var pw = (data && data.NAV_PASSWORD) || '';
  if (pw) {
    var hash = navSha512Hex(pw).toUpperCase();
    p.setProperty('NAV_PASSWORD_HASH', hash);
    if (p.getProperty('NAV_PASSWORD')) p.deleteProperty('NAV_PASSWORD');
    saved.push('jelszó (hash)');
  }

  var t = ((data && data.NAV_TAX_NUMBER) || '').trim();
  if (t) { p.setProperty('NAV_TAX_NUMBER', t); saved.push('adószám'); }

  var s = ((data && data.NAV_SIGNATURE_KEY) || '').trim();
  if (s) { p.setProperty('NAV_SIGNATURE_KEY', s); saved.push('aláíró kulcs'); }

  var ex = ((data && data.NAV_EXCHANGE_KEY) || '').trim();
  if (ex) { p.setProperty('NAV_EXCHANGE_KEY', ex); saved.push('csere kulcs'); }

  // Legacy cleanup: ha valahogy maradt plaintext NAV_PASSWORD a hash mellett, töröljük.
  if (p.getProperty('NAV_PASSWORD_HASH') && p.getProperty('NAV_PASSWORD')) {
    p.deleteProperty('NAV_PASSWORD');
  }

  var message = saved.length === 0
    ? 'Nem történt módosítás (minden mező üres volt).'
    : 'Mentés kész ✓ — módosítva: ' + saved.join(', ') + '.';

  var test = runNavConnectionDiagnostic();
  return { success: true, message: message, test: test };
}

// ============================================================
// NAV KAPCSOLAT DIAGNOSZTIKA
// ============================================================
//
// Egyetlen, mai napra szóló minimal digest lekérdezést indít, és minden
// request/response részletet Logger-be ír, illetve strukturáltan visszaad
// a dialógusnak (httpCode, elapsedMs, body részlet, hint). A NAV gyakran
// hibakód+message kombóval válaszol XML-ben — ezt is kiparzoljuk.
//
// Per-request timeout: 30 mp (timeoutSeconds param, GAS default 360 mp helyett).

function runNavConnectionDiagnostic() {
  var diag = {
    ok: false,
    env: null, login: null, apiUrl: null,
    requestId: null, requestTimestamp: null, requestLength: null,
    elapsedMs: null,
    httpCode: null, headers: null,
    bodyBytes: null, bodySnippet: null,
    parsedErrorCode: null, parsedErrorMessage: null,
    fetchError: null, error: null, hint: null
  };

  var cfg;
  try {
    cfg = getNavConfig();
    diag.env    = cfg.env;
    diag.login  = cfg.login;
    diag.apiUrl = cfg.apiUrl;
  } catch (e) {
    diag.error = e.message;
    diag.hint  = 'Hiányzó vagy érvénytelen Script Property — lásd a hibaüzenetet.';
    Logger.log('[NAV teszt] getNavConfig hiba: ' + e.message);
    return diag;
  }

  var today = Utilities.formatDate(new Date(), 'UTC', 'yyyy-MM-dd');
  var rt    = navNewRequestIdAndTimestamp();
  var sig   = navComputeRequestSignature(rt.requestId, rt.timestamp, cfg.signatureKey);
  var pwHash = cfg.passwordHash;

  diag.requestId        = rt.requestId;
  diag.requestTimestamp = rt.timestamp;

  var mandatory =
    '    <mandatoryQueryParams>\n' +
    '      <invoiceIssueDate>\n' +
    '        <dateFrom>' + today + '</dateFrom>\n' +
    '        <dateTo>'   + today + '</dateTo>\n' +
    '      </invoiceIssueDate>\n' +
    '    </mandatoryQueryParams>';
  var bodyInner =
    '  <page>1</page>\n' +
    '  <invoiceDirection>INBOUND</invoiceDirection>\n' +
    '  <invoiceQueryParams>\n' + mandatory + '\n  </invoiceQueryParams>';
  var xml = osaBuildRequestXml('QueryInvoiceDigestRequest', rt, pwHash, sig, cfg, bodyInner);
  var url = cfg.apiUrl + '/queryInvoiceDigest';
  diag.requestLength = xml.length;

  Logger.log('=== NAV kapcsolat teszt ===');
  Logger.log('URL: ' + url);
  Logger.log('env: ' + cfg.env + ', login: ' + cfg.login + ', taxNumber: ' + cfg.taxNumber);
  Logger.log('requestId: ' + rt.requestId + ', timestamp: ' + rt.timestamp);
  Logger.log('Request XML (' + xml.length + ' byte):\n' + xml);

  var t0 = Date.now();
  try {
    var resp = UrlFetchApp.fetch(url, {
      method: 'post',
      contentType: 'application/xml',
      headers: { 'Accept': 'application/xml' },
      payload: xml,
      muteHttpExceptions: true,
      timeoutSeconds: 30
    });
    diag.elapsedMs = Date.now() - t0;
    diag.httpCode  = resp.getResponseCode();
    diag.headers   = resp.getAllHeaders();
    var bodyText   = resp.getContentText('UTF-8');
    diag.bodyBytes = bodyText.length;
    diag.bodySnippet = bodyText.length > 2000
      ? bodyText.substring(0, 2000) + '\n…(' + (bodyText.length - 2000) + ' további byte, ld. Apps Script log)'
      : bodyText;

    Logger.log('Elapsed: ' + diag.elapsedMs + ' ms');
    Logger.log('HTTP ' + diag.httpCode);
    Logger.log('Response headers: ' + JSON.stringify(diag.headers));
    Logger.log('Response body (' + diag.bodyBytes + ' byte):\n' + bodyText);

    if (diag.httpCode >= 200 && diag.httpCode < 300) {
      diag.ok = true;
    } else {
      var mErr  = bodyText.match(/<\s*([a-zA-Z]+:)?message[^>]*>([\s\S]*?)<\/\s*([a-zA-Z]+:)?message\s*>/i);
      var mCode = bodyText.match(/<\s*([a-zA-Z]+:)?errorCode[^>]*>([\s\S]*?)<\/\s*([a-zA-Z]+:)?errorCode\s*>/i);
      if (mCode) diag.parsedErrorCode    = mCode[2].trim();
      if (mErr)  diag.parsedErrorMessage = mErr[2].trim();
      diag.error = 'HTTP ' + diag.httpCode +
                   (diag.parsedErrorCode    ? ' — ' + diag.parsedErrorCode    : '') +
                   (diag.parsedErrorMessage ? ': '  + diag.parsedErrorMessage : '');
      if (diag.httpCode === 401 || /INVALID_USER|UNAUTHORIZED|hash|signature/i.test(bodyText)) {
        diag.hint = 'Hitelesítési hiba — ellenőrizd a felhasználónevet, jelszót, aláíró kulcsot, és a környezet (' + cfg.env + ') választást.';
      } else if (diag.httpCode === 403) {
        diag.hint = 'A fióknak nincs jogosultsága a kérésre.';
      } else if (diag.httpCode >= 500) {
        diag.hint = 'NAV szerver oldali hiba.';
      }
    }
  } catch (e) {
    diag.elapsedMs  = Date.now() - t0;
    diag.fetchError = e.message;
    diag.error      = 'UrlFetchApp: ' + e.message;
    Logger.log('Elapsed: ' + diag.elapsedMs + ' ms');
    Logger.log('Fetch exception: ' + e.message);
    if (/timed? ?out|timeout|időtúllépés|deadline/i.test(e.message)) {
      diag.hint = 'Időtúllépés ' + Math.round(diag.elapsedMs / 1000) + ' mp után (30 s timeout). ' +
                  'Ellenőrizd a környezet választást és a NAV elérhetőségét.';
    } else if (/Nem található a cím|Address unavailable|DNS/i.test(e.message)) {
      diag.hint = 'A NAV szerver nem volt elérhető. Ellenőrizd a környezet választást (' + cfg.env + ').';
    }
  }

  Logger.log('=== NAV kapcsolat teszt vége ===');
  return diag;
}
