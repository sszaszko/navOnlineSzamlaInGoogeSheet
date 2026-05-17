/**
 * OpgMenu.js — OPG (Online Pénztárgépnapló) menü handlerek + trigger végpont.
 *
 * Tartalom:
 *   - menuOpgEnsureSheets, menuOpgClearData, menuOpgQuerySync
 *   - menuOpgTestEnvironment, menuOpgGenerateTestData
 *   - opgAutoSync       : time-driven trigger végpont (volt: autoSyncOpgLast5Days)
 *   - dialogRunSyncOpg  : SyncDateDialog.html backend
 *
 * ⚠ Trigger figyelmeztetés: ha korábban autoSyncOpgLast5Days trigger volt beállítva,
 *    azt törölni kell és újraregisztrálni az opgAutoSync névre.
 *
 * Függőségei: OpgApi.js, OpgDataprocessor.js, Config.js, Menu.js (openSyncDialog)
 */

function menuOpgEnsureSheets() {
  var ui = SpreadsheetApp.getUi();
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  try {
    opgEnsureSheets();
    ss.toast('"' + OPG_SHEET_FEJLEC + '" és "' + OPG_SHEET_TETEL + '" sheetek rendben.', '✔ Kész', 5);
  } catch (e) {
    ui.alert('Hiba!\n\n' + e.message);
  }
}

function menuOpgClearData() {
  var ui = SpreadsheetApp.getUi();
  var confirm = ui.alert(
    'Figyelem!',
    'Biztosan törölni szeretnéd a "' + OPG_SHEET_FEJLEC + '" és "' + OPG_SHEET_TETEL +
    '" lapok tartalmát, valamint a feldolgozási állapotot (state)?\n\nA művelet nem vonható vissza.',
    ui.ButtonSet.YES_NO);
  if (confirm !== ui.Button.YES) return;
  try {
    opgClearAllData();
    ui.alert('OPG adatok és állapot törölve. ✔');
  } catch (e) {
    ui.alert('Hiba!\n\n' + e.message);
  }
}

function menuOpgQuerySync() {
  var ui = SpreadsheetApp.getUi();
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var cfg;
  try { cfg = getOpgConfig(); }
  catch (e) { ui.alert('Hiba!\n\n' + e.message); return; }

  var lookback = OPG_LOOKBACK_DAYS;
  var info =
    'Pénztárgép-nyugta lekérdezés indítása.\n\n' +
    'Környezet: ' + cfg.env + '\n' +
    'Base URL : ' + cfg.opgBaseUrl + '\n' +
    'Tájékoztató: a NAV csak az utolsó ' + lookback + ' nap fájljait őrzi meg; ' +
    'a dátumtartomány automatikusan a NAV által megadott ' +
    'min..maxAvailableFileNumber alapján zajlik.\n\n' +
    'Indulhat?';
  var ok = ui.alert('OPG nyugta lekérdezés', info, ui.ButtonSet.YES_NO);
  if (ok !== ui.Button.YES) return;

  try {
    var summary = opgRunSync({ lookbackDays: lookback, tag: 'menuOpgQuerySync' });
    var msg = 'Feldolgozott AP-k: ' + summary.apProcessed + '\n' +
              'Naplófájlok: '       + summary.files + '\n' +
              'Bizonylatok: '       + summary.bizonylatok + '\n' +
              'Tételek: '           + summary.tetelek;
    if (summary.nullXml > 0)
      msg += ' | ⚠ XML kibontás sikertelen: ' + summary.nullXml;
    if (summary.practiceSkipped > 0)
      msg += ' | ⚠ Gyakorló kihagyva: ' + summary.practiceSkipped;
    if (summary.errors.length > 0)
      msg += ' | Hibák: ' + summary.errors.slice(0, 3).join('; ');
    Logger.log('[menuOpgQuerySync] KÉSZ: ' + msg);
    ss.toast(msg, '✔ OPG Szinkron kész', 12);
  } catch (e) {
    ui.alert('Hiba!\n\n' + e.message);
  }
}

// ============================================================
// TIME-DRIVEN TRIGGER VÉGPONT
// ============================================================

function opgAutoSync(opts) {
  var tag = 'opgAutoSync';
  var ss  = SpreadsheetApp.getActiveSpreadsheet();
  Logger.log('[' + tag + '] INDULÁS');

  var lookback;
  if (opts && opts.dateFrom) {
    var ms   = new Date() - new Date(opts.dateFrom);
    lookback = Math.ceil(ms / (24 * 3600 * 1000)) + 1;
  } else {
    var bounds = getDateBoundaries({ sheetName: OPG_SHEET_FEJLEC, dateColumnHeader: 'Kiállítás ideje' });
    var ms2    = new Date() - new Date(bounds.filterFrom);
    lookback   = Math.max(OPG_AUTOSYNC_DAYS, Math.ceil(ms2 / (24 * 3600 * 1000)) + 1);
    Logger.log('[' + tag + '] Auto bounds: filterFrom=' + bounds.filterFrom + ', lookback=' + lookback);
  }

  try {
    var summary = opgRunSync({ lookbackDays: lookback, tag: tag });
    var msg = 'OPG: ' + summary.apProcessed + ' AP, ' + summary.bizonylatok + ' bizonylat, ' +
              summary.tetelek + ' tétel' +
              (summary.errors.length > 0 ? ' | ' + summary.errors.length + ' hiba (ld. Naplók)' : '') + '.';
    Logger.log('[' + tag + '] KÉSZ: ' + JSON.stringify(summary));
    ss.toast(msg, '✔ OPG Szinkron kész', 10);
  } catch (e) {
    Logger.log('[' + tag + '] VÉGZETES HIBA: ' + e.message);
    ss.toast('Végzetes hiba: ' + e.message, '✖ OPG hiba', 15);
  }
}

// ============================================================
// DIALOG BACKEND
// ============================================================

function dialogRunSyncOpg(opts) {
  opgAutoSync(opts);
}

// ============================================================
// TESZT FÜGGVÉNYEK
// ============================================================

function menuOpgTestEnvironment() {
  var ui = SpreadsheetApp.getUi();
  var cfg;
  try { cfg = getOpgConfig(); }
  catch (e) { ui.alert('Hiba!\n\n' + e.message); return; }

  if (cfg.env !== 'test') {
    var goAhead = ui.alert(
      'Figyelem',
      'A NAV_ENV jelenleg "' + cfg.env + '". A teszt függvény a teszt környezetet ' +
      'célozza meg.\n\nFolytatod a "' + cfg.env + '" környezeten?\n(Ha mégis tesztet ' +
      'szeretnél, állítsd át a NAV_ENV Script Property-t "test"-re és próbáld újra.)',
      ui.ButtonSet.YES_NO);
    if (goAhead !== ui.Button.YES) return;
  }

  var prevDebug = OPG_DEBUG_LOG;
  OPG_DEBUG_LOG = true;

  var report = [];
  report.push('=== OPG teszt környezet ellenőrzés ===');
  report.push('env: ' + cfg.env);
  report.push('Status URL: ' + cfg.opgStatusUrl);
  report.push('File URL  : ' + cfg.opgFileUrl);
  report.push('login: ' + cfg.login + ', taxNumber: ' + cfg.taxNumber);

  try {
    Logger.log(report.join('\n'));
    var t0       = Date.now();
    var statuses = opgQueryCashRegisterStatus({});
    report.push('');
    report.push('Status hívás: ' + (Date.now() - t0) + ' ms, ' + statuses.length + ' AP-szám visszakapva');
    for (var i = 0; i < statuses.length; i++) {
      var s = statuses[i];
      report.push('  - ' + s.apNumber + ': fileNum ' + s.minAvailableFileNumber + '..' + s.maxAvailableFileNumber +
                  ' (lastFile=' + s.lastFileDate + ')');
    }

    if (statuses.length > 0 && statuses[0].maxAvailableFileNumber > 0) {
      var ap = statuses[0];
      report.push('');
      report.push('Próbálkozás 1 fájl letöltéssel: AP=' + ap.apNumber + ', fileNum=' + ap.minAvailableFileNumber);
      var t1       = Date.now();
      var fileResp = opgQueryCashRegisterFile({
        apNumber:        ap.apNumber,
        fileNumberStart: ap.minAvailableFileNumber,
        fileNumberEnd:   ap.minAvailableFileNumber
      });
      report.push('File hívás: ' + (Date.now() - t1) + ' ms');
      report.push('  - allFilesSent: ' + fileResp.allFilesSent);
      report.push('  - files: ' + fileResp.files.length);

      if (fileResp.files.length > 0) {
        var f = fileResp.files[0];
        report.push('  - első fájl: ' + f.cashRegisterFileName + ', validation=' + f.fileValidationResultCode +
                    ', ZIP méret=' + f.contentBytes.length + ' byte');
        var xml = opgExtractXmlFromZippedP7b(f.contentBytes, f.cashRegisterFileName);
        report.push('  - XML kibontva: ' + (xml ? (xml.length + ' karakter') : 'sikertelen'));
        if (xml) {
          var doc, rowsEl;
          try { doc = XmlService.parse(xml); rowsEl = navFindFirst(doc.getRootElement(), 'ROWS'); }
          catch (e2) { report.push('  - XML parse hiba: ' + e2.message); }
          if (rowsEl) {
            var children = rowsEl.getChildren();
            var tagCount = {};
            for (var j = 0; j < children.length; j++) {
              var tg = children[j].getName();
              tagCount[tg] = (tagCount[tg] || 0) + 1;
            }
            report.push('  - rekord típusok: ' + JSON.stringify(tagCount));
          }
        }
      }
    } else {
      report.push('');
      report.push('Nincs lekérdezhető fájl. Generálj tesztadatot a "Tesztadat generálás (test env)…" menüvel,');
      report.push('majd próbáld újra.');
    }

    report.push('');
    report.push('=== Vége ✔ ===');
  } catch (e) {
    report.push('');
    report.push('HIBA: ' + e.message);
    Logger.log('[opgTestEnvironment] HIBA: ' + e.message + '\nStack: ' + (e.stack || ''));
  } finally {
    OPG_DEBUG_LOG = prevDebug;
  }

  var output = report.join('\n');
  Logger.log(output);
  ui.alert(output.length > 4000 ? output.substring(0, 4000) + '\n…(folytatás a Naplókban)' : output);
}

function menuOpgGenerateTestData() {
  var ui = SpreadsheetApp.getUi();
  var cfg;
  try { cfg = getOpgConfig(); }
  catch (e) { ui.alert('Hiba!\n\n' + e.message); return; }

  if (cfg.env !== 'test') {
    ui.alert('Csak a teszt környezetben hívható!\n\nÁllítsd át a NAV_ENV Script Property-t "test"-re.');
    return;
  }

  var r = ui.prompt('Tesztadat generálás',
    'Pénztárgép AP szám (formátum: 1 nagybetű + 8 számjegy, pl. A12345678):',
    ui.ButtonSet.OK_CANCEL);
  if (r.getSelectedButton() !== ui.Button.OK) return;
  var ap = r.getResponseText().trim().toUpperCase();
  if (!/^[A-Z][0-9]{8}$/.test(ap)) {
    ui.alert('Érvénytelen AP-szám: "' + ap + '"');
    return;
  }

  var prev = OPG_DEBUG_LOG;
  OPG_DEBUG_LOG = true;
  try {
    var result = opgGenerateTestData({ apNumber: ap });
    ui.alert('Generálás eredménye:\n\n' +
             'funcCode : ' + result.funcCode + '\n' +
             (result.errorCode ? 'errorCode: ' + result.errorCode + '\n' : '') +
             (result.message   ? 'message  : ' + result.message   + '\n' : '') +
             '\nMost futtasd le a "Teszt környezet ellenőrzés…" menüt, hogy lekérdezd ' +
             'a most generált 76 db tesztfájlt.');
  } catch (e) {
    ui.alert('Hiba!\n\n' + e.message);
  } finally {
    OPG_DEBUG_LOG = prev;
  }
}
