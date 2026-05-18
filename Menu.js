/**
 * Menu.js — menü regisztráció + SyncDateDialog megnyitó.
 *
 * Felelőssége:
 *   - onOpen() : UI menüpontok regisztrálása
 *   - openSyncDialog() : SyncDateDialog.html megnyitása bármely szinkron folyamathoz
 *
 * A korábbi orchestráció logika kiszervezett fájlokba kerültek:
 *   OsaSync.js, eVatVamSync.js, OpgMenu.js, ConnectionMenu.js
 */

// ============================================================
// MENU REGISZTRÁCIÓ
// ============================================================

function onOpen() {
  var ui = SpreadsheetApp.getUi();

  ui.createMenu('NAV számlák')
    .addItem('Bejövő számlák szinkronizálása…', 'menuOsaQueryInvoiceDigest')
    .addItem('Kimenő számlák szinkronizálása…', 'menuOsaQueryInvoiceDigestOutbound')
    .addItem('Egy számla kézi lekérdezése és PDF', 'menuQuerySingleInvoice')
    .addSeparator()
    .addItem('XLS adatok importálása és feldolgozása', 'appendXLSXDataToGoogleSheet')
    .addItem('Költségtípusok frissítése', 'runCategoryUpdateFromMenu')
    .addSeparator()
    .addItem('NAV kapcsolat beállítása (+ teszt + automatizálás)', 'menuSetupNavConnection')
    .addItem('NAV kapcsolat teszt', 'menuTestConnection')
    .addItem('Automatikus szinkron időzítése…', 'menuSetupTriggers')
    .addSeparator()
    .addItem('Minden adat és állapot törlése', 'clearAllData')
    .addToUi();

  ui.createMenu('Vám és OPG')
    .addItem('eÁFA vámhatározatok szinkronizálása…', 'menuEVatVamQueryDigest')
    .addSeparator()
    .addItem('NAV pénztárgép (OPG) szinkronizálása (default 14 nap)…', 'menuOpgQuerySync')
    .addItem('OPG sheetek létrehozása', 'menuOpgEnsureSheets')
    .addSeparator()
    .addItem('Teszt környezet ellenőrzés…', 'menuOpgTestEnvironment')
    .addItem('Tesztadat generálás (test env)…', 'menuOpgGenerateTestData')
    .addSeparator()
    .addItem('Minden OPG adat törlése', 'menuOpgClearData')
    .addToUi();
}

// ============================================================
// SYNC DIALOG MEGNYITÓ
// ============================================================

/**
 * Kiszámítja a dátum határokat és megnyitja a SyncDateDialog.html-t.
 *
 * @param {string}      syncType   'invoice_in'|'invoice_out'|'eVatVam'|'opg'
 * @param {string|null} direction  'INBOUND'|'OUTBOUND' (számláknál), null egyébeknél
 */
function openSyncDialog(syncType, direction) {
  var ctx;
  if (syncType === 'invoice_in' || syncType === 'invoice_out') {
    var cfg = osaDirCfg(direction);
    ctx = getDateBoundaries({ sheetName: cfg.sheetFejlec, dateColumnHeader: 'Számla kelte' });
  } else if (syncType === 'eVatVam') {
    ctx = getDateBoundaries({ sheetName: EVATVAM_SHEET, dateColumnHeader: 'Kézbesítés dátuma' });
  } else {
    ctx = getDateBoundaries({ sheetName: OPG_SHEET_FEJLEC, dateColumnHeader: 'Kiállítás ideje' });
  }

  var p = PropertiesService.getScriptProperties();
  var extraDays = p.getProperty('BEFORE_AFTER_EXTRA_DAYS') || '30';
  var propStart = p.getProperty('START_DATE') || '';
  var propEnd = p.getProperty('END_DATE') || '';

  var tpl = HtmlService.createTemplateFromFile('SyncDateDialog');
  tpl.syncType = syncType;
  tpl.queryFrom = ctx.queryFrom;
  tpl.queryTo = ctx.queryTo;
  tpl.filterFrom = ctx.filterFrom;
  tpl.filterTo = ctx.filterTo;
  tpl.extraDays = extraDays;
  tpl.propStart = propStart;
  tpl.propEnd = propEnd;

  var html = tpl.evaluate().setWidth(520).setHeight(360);
  SpreadsheetApp.getUi().showModalDialog(html, 'NAV szinkronizálás — időszak beállítása');
}
