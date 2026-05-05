/**
 * Menu.gs — UI és orchestráció
 *
 * Felelőssége:
 *   - onOpen() menu regisztráció
 *   - Menu handlerек: felhasználói inputok begyűjtése, folyamatok koordinálása
 *   - Hívja: NavApi.gs (queryInvoiceDigest, queryInvoiceData)
 *             DataProcessor.gs (dpWriteFejlecRows, dpWriteTetelRows,
 *                                dpUpdateFejlecFromInvoiceXml)
 *
 * NEM tartalmaz: sheet műveletek, NAV API hívások, mezőleképezések.
 */

// ============================================================
// BEÁLLÍTÁSOK
// ============================================================

var NAV_DEBUG_LOG_XML = false; // Ha true, az XML kérések és válaszok bekerülnek a logba

// ============================================================
// MENU REGISZTRÁCIÓ
// ============================================================

function onOpen() {
  var ui = SpreadsheetApp.getUi();
  
  ui.createMenu('NAV')
    .addItem('1 · Fejléc adatok letöltése (Digest)…',       'menuQueryInvoiceDigest')
    .addItem('2 · Tételek letöltése (hiányzókhoz)…',         'menuDownloadMissingDetails')
    .addSeparator()
    .addItem('Egy számla kézi lekérdezése…',                 'menuQuerySingleInvoice')
    .addItem('Kapcsolat teszt',                              'menuTestConnection')
    .addToUi();

  ui.createMenu('Adatfeldolgozó')
    .addItem('Adatok hozzáfűzése és feldolgozása', 'appendXLSXDataToGoogleSheet')
    .addItem('Költségtípusok frissítése', 'runCategoryUpdateFromMenu')
    .addSeparator()
    .addItem('Minden adat és állapot törlése', 'clearAllData')
    .addToUi();
}

// ============================================================
// 1. FEJLÉC ADATOK — queryInvoiceDigest
// ============================================================

function menuQueryInvoiceDigest() {
  var ui    = SpreadsheetApp.getUi();
  var today = new Date();
  var from  = new Date(today.getTime() - 30 * 24 * 3600 * 1000);
  var fmt   = function(d) { return Utilities.formatDate(d, 'UTC', 'yyyy-MM-dd'); };

  var r1 = ui.prompt('Fejléc letöltés — Dátum TÓL', 'Kiállítás dátuma (yyyy-MM-dd)\nAlapért.: ' + fmt(from), ui.ButtonSet.OK_CANCEL);
  if (r1.getSelectedButton() !== ui.Button.OK) return;

  var r2 = ui.prompt('Fejléc letöltés — Dátum IG', 'Kiállítás dátuma (yyyy-MM-dd)\nAlapért.: ' + fmt(today), ui.ButtonSet.OK_CANCEL);
  if (r2.getSelectedButton() !== ui.Button.OK) return;

  var dateFrom = r1.getResponseText().trim() || fmt(from);
  var dateTo   = r2.getResponseText().trim() || fmt(today);

  try {
    var rows    = queryInvoiceDigest({ dateFrom: dateFrom, dateTo: dateTo, invoiceDirection: 'INBOUND' });
    var written = dpWriteFejlecRows(rows);
    ui.alert('Kész ✓\n\n' + written + ' új sor beírva\n(' + rows.length + ' találat összesen)');
  } catch(e) {
    ui.alert('Hiba!\n\n' + e.message);
  }
}

// ============================================================
// 2. TÉTEL ADATOK — queryInvoiceData a hiányzó tételeknél
// ============================================================

function menuDownloadMissingDetails() {
  var ui    = SpreadsheetApp.getUi();
  var ss    = SpreadsheetApp.getActiveSpreadsheet();
  var fejSh = ss.getSheetByName(SHEET_FEJLEC);

  if (!fejSh) {
    ui.alert('A "' + SHEET_FEJLEC + '" sheet nem található. Előbb futtasd a Fejléc letöltést!');
    return;
  }

  // Fejléc map — fejléc alapján, nem pozíció szerint
  var hMap   = dpGetHeaderMap(fejSh);
  var keyCol = hMap['Számla sorszáma'];
  var dlCol  = hMap['Tételek LETÖLTVE'];

  if (!keyCol || !dlCol) {
    ui.alert('Hiba: "Számla sorszáma" vagy "Tételek LETÖLTVE" fejléc nem található a "' + SHEET_FEJLEC + '" sheetben.');
    return;
  }

  var lastRow = fejSh.getLastRow();
  if (lastRow < 2) { ui.alert('Nincs adat a "' + SHEET_FEJLEC + '" sheetben.'); return; }

  // Összegyűjti a "Tételek LETÖLTVE" üres / n/a sorait
  var data    = fejSh.getRange(2, 1, lastRow - 1, fejSh.getLastColumn()).getValues();
  var pending = [];
  for (var i = 0; i < data.length; i++) {
    var dl  = String(data[i][dlCol - 1]).trim();
    var num = String(data[i][keyCol - 1]).trim();
    if (num && (dl === '' || dl === 'n/a')) {
      pending.push({ invoiceNumber: num, row: i + 2 });
    }
  }

  if (pending.length === 0) {
    ui.alert('Minden sor tételei már le vannak töltve. ✓');
    return;
  }

  var confirm = ui.alert(
    pending.length + ' számlához hiányzik a részletes adat.\n\nElindítod a letöltést?',
    ui.ButtonSet.YES_NO
  );
  if (confirm !== ui.Button.YES) return;

  var ok = 0, fail = 0, errors = [];

  for (var j = 0; j < pending.length; j++) {
    var invoiceNumber = pending[j].invoiceNumber;
    try {
      var result = queryInvoiceData({ invoiceNumber: invoiceNumber, invoiceDirection: 'INBOUND' });

      // Tételek beírása a Tétel adatok sheetbe
      dpWriteTetelRows(result);

      // Fejléc adatok visszatöltése + "Tételek LETÖLTVE" kitöltése
      dpUpdateFejlecFromInvoiceXml(result);

      ok++;
    } catch(e) {
      fail++;
      errors.push(invoiceNumber + ': ' + e.message);
      Logger.log('Hiba [' + invoiceNumber + ']: ' + e.message);
    }
  }

  if (ok > 0) {
    // Utófeldolgozás: duplikátum szűrés, n/a csere, kategória kitöltés, rendezés
    postProcessSheets();
  }

  var msg = 'Kész ✓\n\n' + ok + ' számla letöltve.';
  if (fail > 0) msg += '\n' + fail + ' hiba:\n' + errors.slice(0, 5).join('\n');
  if (errors.length > 5) msg += '\n…és ' + (errors.length - 5) + ' további (ld. Naplók)';
  ui.alert(msg);
}

// ============================================================
// 3. AUTOMATIKUS SZINKRONIZÁLÁS (NINCS UI)
// ============================================================

function autoSyncLast5Days() {
  Logger.log('autoSyncLast5Days: INDULÁS - Utolsó 5 nap (mát is beleértve) digest letöltése és hiányzók pótlása...');
  
  var today = new Date();
  var from = new Date(today.getTime() - 4 * 24 * 3600 * 1000); // 4 nap kivonása = mai nap + 4 korábbi = 5 nap
  
  var fmt = function(d) { return Utilities.formatDate(d, 'UTC', 'yyyy-MM-dd'); };
  
  var dateFrom = fmt(from);
  var dateTo = fmt(today);
  
  Logger.log('Dátum sáv: ' + dateFrom + ' - ' + dateTo);
  
  try {
    // 1. Digest lekérdezés
    var rows = queryInvoiceDigest({ dateFrom: dateFrom, dateTo: dateTo, invoiceDirection: 'INBOUND' });
    var writtenFejlec = dpWriteFejlecRows(rows);
    Logger.log('Digest letöltés KÉSZ. Új fejlécek száma: ' + writtenFejlec + ' (Összes találat: ' + rows.length + ')');
    
    // 2. Hiányzó tételek letöltése
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var fejSh = ss.getSheetByName(SHEET_FEJLEC);
    
    if (!fejSh) {
      Logger.log('Hiba: "' + SHEET_FEJLEC + '" sheet nem található.');
      return;
    }
    
    var hMap = dpGetHeaderMap(fejSh);
    var keyCol = hMap['Számla sorszáma'];
    var dlCol  = hMap['Tételek LETÖLTVE'];
    
    if (!keyCol || !dlCol) {
      Logger.log('Hiba: "Számla sorszáma" vagy "Tételek LETÖLTVE" fejléc hiányzik.');
      return;
    }
    
    var lastRow = fejSh.getLastRow();
    if (lastRow < 2) {
      Logger.log('Nincs adat a fejléc táblában.');
      return;
    }
    
    var data = fejSh.getRange(2, 1, lastRow - 1, fejSh.getLastColumn()).getValues();
    var pending = [];
    for (var i = 0; i < data.length; i++) {
      var dl  = String(data[i][dlCol - 1]).trim();
      var num = String(data[i][keyCol - 1]).trim();
      if (num && (dl === '' || dl === 'n/a')) {
        pending.push({ invoiceNumber: num, row: i + 2 });
      }
    }
    
    if (pending.length === 0) {
      Logger.log('autoSyncLast5Days: ÖSSZEGZÉS - Minden sor tételei már le vannak töltve. Nincs hiányzó adat. VÉGE.');
      return;
    }
    
    Logger.log(pending.length + ' számlához hiányzik a részletes adat. Letöltés indítása...');
    
    var ok = 0, fail = 0;
    
    for (var j = 0; j < pending.length; j++) {
      var invoiceNumber = pending[j].invoiceNumber;
      try {
        var result = queryInvoiceData({ invoiceNumber: invoiceNumber, invoiceDirection: 'INBOUND' });
        dpWriteTetelRows(result);
        dpUpdateFejlecFromInvoiceXml(result);
        ok++;
      } catch(e) {
        fail++;
        Logger.log('Hiba [' + invoiceNumber + ']: ' + e.message);
      }
    }
    
    if (ok > 0 || writtenFejlec > 0) {
      Logger.log('autoSyncLast5Days: Utófeldolgozás (kategorizálás, rendezés) indítása...');
      postProcessSheets();
    }
    
    Logger.log('autoSyncLast5Days: ÖSSZEGZÉS - KÉSZ. Sikeres: ' + ok + ', Hibás: ' + fail + '. VÉGE.');
    
  } catch (e) {
    Logger.log('autoSyncLast5Days: VÉGZETES HIBA - ' + e.message);
  }
}

// ============================================================
// KÉZI — egyetlen számla lekérdezése
// ============================================================

function menuQuerySingleInvoice() {
  var ui = SpreadsheetApp.getUi();

  var r1 = ui.prompt('Kézi számla lekérdezés', 'Számla sorszáma:', ui.ButtonSet.OK_CANCEL);
  if (r1.getSelectedButton() !== ui.Button.OK) return;
  var invoiceNumber = r1.getResponseText().trim();
  if (!invoiceNumber) return;

  var r2 = ui.prompt('Irány', 'INBOUND vagy OUTBOUND (alapért. INBOUND)', ui.ButtonSet.OK_CANCEL);
  if (r2.getSelectedButton() !== ui.Button.OK) return;
  var direction = (r2.getResponseText().trim() || 'INBOUND').toUpperCase();

  try {
    var result  = queryInvoiceData({ invoiceNumber: invoiceNumber, invoiceDirection: direction });
    var written = dpWriteTetelRows(result);
    dpUpdateFejlecFromInvoiceXml(result);
    ui.alert('Kész ✓\n\n' + written + ' tétel beírva (' + invoiceNumber + ').');
  } catch(e) {
    ui.alert('Hiba!\n\n' + e.message);
  }
}

// ============================================================
// KAPCSOLAT TESZT
// ============================================================

function menuTestConnection() {
  var ui    = SpreadsheetApp.getUi();
  var cfg   = getNavConfig();
  var today = Utilities.formatDate(new Date(), 'UTC', 'yyyy-MM-dd');
  try {
    queryInvoiceDigest({ dateFrom: today, dateTo: today, invoiceDirection: 'INBOUND', maxPages: 1 });
    ui.alert('Kapcsolat OK ✓\n\nKörnyezet: ' + cfg.env + '\nFelhasználó: ' + cfg.login);
  } catch(e) {
    ui.alert('Kapcsolat HIBA\n\n' + e.message);
  }
}