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
  var html = template.evaluate().setWidth(560).setHeight(820);
  SpreadsheetApp.getUi().showModalDialog(html, 'NAV adatkapcsolat beállítása');
}

function menuTestConnection() {
  var template = HtmlService.createTemplateFromFile('NavConnectionDialog');
  template.mode = 'testOnly';
  var html = template.evaluate().setWidth(520).setHeight(640);
  SpreadsheetApp.getUi().showModalDialog(html, 'NAV kapcsolat teszt');
}

function menuSetupTriggers() {
  var template = HtmlService.createTemplateFromFile('NavConnectionDialog');
  template.mode = 'triggersOnly';
  var html = template.evaluate().setWidth(560).setHeight(720);
  SpreadsheetApp.getUi().showModalDialog(html, 'Automatikus szinkron időzítése');
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

// ============================================================
// AUTOMATIZÁLÁS BEÁLLÍTÁSA — NavConnectionDialog.html 3. lépés
// ============================================================
//
// A 4 időzíthető trigger-végpont: osaAutoSync, osaAutoSyncOutbound,
// eVatVamAutoSync, opgAutoSync. A munkaidő határait, az ütemezést és
// a START_DATE / END_DATE Script Property-t innen lehet beállítani.

// AUTOMATION_TASKS és TRIGGER_CUTOFF_DAYS_AFTER_END konstansok a Config.js-ben.

/**
 * Kiszámítja az END_DATE alapú cutoff állapotot. Ha az END_DATE Script Property
 * be van állítva és a mai nap > END_DATE + TRIGGER_CUTOFF_DAYS_AFTER_END, akkor
 * az auto-triggerek nem futnak.
 *
 * @return {{ active: boolean, pastEndDate: boolean, endDate: ?string, cutoffDate: ?string }}
 *   active      → már túl a cutoff-on (END_DATE + N nap) → triggerek nem futnak
 *   pastEndDate → már túl az END_DATE-en (de még a cutoff előtt → triggerek futnak,
 *                 de hamarosan leállnak)
 */
function getTriggerCutoffState() {
  var endStr = PropertiesService.getScriptProperties().getProperty('END_DATE');
  if (!endStr) return { active: false, pastEndDate: false, endDate: null, cutoffDate: null };

  var end = new Date(endStr);
  if (isNaN(end.getTime())) return { active: false, pastEndDate: false, endDate: endStr, cutoffDate: null };

  var cutoff = new Date(end);
  cutoff.setDate(cutoff.getDate() + TRIGGER_CUTOFF_DAYS_AFTER_END);
  var cutoffStr = Utilities.formatDate(cutoff, Session.getScriptTimeZone(), 'yyyy-MM-dd');
  var now = new Date();

  return {
    active:      now > cutoff,
    pastEndDate: now > end,
    endDate:     endStr,
    cutoffDate:  cutoffStr
  };
}

/**
 * Belépési ellenőrzés az auto-trigger végpontoknak — ha az END_DATE óta
 * 30+ nap eltelt, a hívó függvény álljon le. Logba is ír.
 *
 * @param  {string} tag  hívó tag (loghoz)
 * @return {boolean}     true → kihagyandó
 */
function shouldSkipTriggerByEndDate(tag) {
  var st = getTriggerCutoffState();
  if (st.active) {
    Logger.log('[' + (tag || 'autoSync') + '] KIHAGYVA — END_DATE (' + st.endDate +
               ') + ' + TRIGGER_CUTOFF_DAYS_AFTER_END + ' nap eltelt (cutoff: ' +
               st.cutoffDate + ').');
    return true;
  }
  return false;
}

/**
 * Visszaadja a dialog kezdeti állapotát az automatizálás lépéshez.
 */
function getAutomationConfig() {
  var p = PropertiesService.getScriptProperties();
  var year = new Date().getFullYear();
  var defStart = year + '-01-01';
  var defEnd   = year + '-12-31';

  var cfg = getConfig(); // TriggerShiftManager.getConfig()
  var tasksOut = AUTOMATION_TASKS.map(function (t) {
    var saved = (cfg.tasks && cfg.tasks[t.fn]) || {};
    return {
      fn:        t.fn,
      label:     t.label,
      work_time: saved.work_time || 'none',
      off_work:  saved.off_work  || 'none'
    };
  });

  return {
    startDate:  p.getProperty('START_DATE') || defStart,
    endDate:    p.getProperty('END_DATE')   || defEnd,
    workStart:  (cfg.workHours && cfg.workHours.start) || '08:00',
    workEnd:    (cfg.workHours && cfg.workHours.end)   || '17:00',
    tasks:      tasksOut,
    cutoff:     getTriggerCutoffState(),
    cutoffDaysAfterEnd: TRIGGER_CUTOFF_DAYS_AFTER_END
  };
}

/**
 * Elmenti az automatizálás beállításait (Properties-be JSON-ként), majd
 * REGISZTRÁL EGY EGYSZERI HÁTTÉRTRIGGERT, amely az aktuális dialog-szál
 * lezárása után a háttérben felépíti a triggereket. A dialog így azonnal
 * bezárható — nem várakozik 30+ másodpercet a felhasználó.
 *
 * @param {Object} data {
 *   startDate, endDate, workStart, workEnd,
 *   tasks: [{ fn, work_time, off_work }, ...]
 * }
 */
function saveAutomationConfig(data) {
  var p = PropertiesService.getScriptProperties();

  // 1. START_DATE / END_DATE
  if (data && data.startDate) p.setProperty('START_DATE', data.startDate);
  else                        p.deleteProperty('START_DATE');
  if (data && data.endDate)   p.setProperty('END_DATE', data.endDate);
  else                        p.deleteProperty('END_DATE');

  // 2. Munkaidő határok
  setWorkHours(data.workStart, data.workEnd);

  // 3. Feladatok regisztrálása — friss lista (régi, idegen tasks törölve)
  var cfg = getConfig();
  cfg.tasks = {};
  saveConfig(cfg);

  var validFns = AUTOMATION_TASKS.map(function (t) { return t.fn; });
  (data.tasks || []).forEach(function (t) {
    if (validFns.indexOf(t.fn) < 0) return;
    registerTask(t.fn, t.work_time || 'none', 'work_time');
    registerTask(t.fn, t.off_work  || 'none', 'off_work');
  });

  // 4. Aszinkron triggerépítés — egy egyszeri háttértrigger meghívja
  //    a _installTriggersJob()-ot, ami felépíti a teljes keretrendszert.
  //    Előbb töröljük az esetleges korábbi job-triggert, hogy ne legyen duplikálás.
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === '_installTriggersJob') {
      ScriptApp.deleteTrigger(t);
    }
  });
  ScriptApp.newTrigger('_installTriggersJob').timeBased().after(TRIGGER_AFTER_BUFFER_MS).create();

  return {
    success: true,
    message: 'Beállítások elmentve ✓ — a triggerek felépítése a háttérben folyik (' +
             (TRIGGER_AFTER_BUFFER_MS / 1000) + ' mp múlva indul, kb. ' +
             (TRIGGER_RECURRING_DELAY_MS / 1000 + 5) + ' mp alatt készül el).'
  };
}

/**
 * HÁTTÉR FELADAT — egyszeri triggerről indul a saveAutomationConfig után.
 * Felépíti a teljes shift framework triggereket a Properties-ben tárolt
 * konfigurációból.
 */
function _installTriggersJob() {
  Logger.log('[_installTriggersJob] HÁTTÉR TRIGGER ÉPÍTÉS INDUL');
  try {
    installShiftFrameworkFromConfig();
    Logger.log('[_installTriggersJob] KÉSZ ✓');
  } catch (e) {
    Logger.log('[_installTriggersJob] HIBA: ' + e.message);
  }
}

/**
 * TOTÁLIS TRIGGER TÖRLŐ — a projekt MINDEN triggerét eltávolítja
 * a jelenlegi felhasználóhoz tartozóan (ScriptApp.getProjectTriggers()).
 * Ezután semmilyen időzített futás nincs a scriptben.
 *
 * @return {{ success: boolean, deleted: number, message: string }}
 */
function deleteAllProjectTriggers() {
  var triggers = ScriptApp.getProjectTriggers();
  var count = triggers.length;
  triggers.forEach(function (t) {
    try { ScriptApp.deleteTrigger(t); } catch (_e) { /* ignore */ }
  });
  Logger.log('[deleteAllProjectTriggers] ' + count + ' db trigger törölve.');
  return {
    success: true,
    deleted: count,
    message: count + ' db trigger törölve. Most már nincs aktív időzítés.'
  };
}
