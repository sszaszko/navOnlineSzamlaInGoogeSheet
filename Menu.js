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
    .addItem('Bejövő fejléc adatok letöltése (Digest API)…', 'menuOsaQueryInvoiceDigest')
    .addItem('Bejövő tételek letöltése (teljes letöltés API)…', 'menuOsaDownloadMissingDetails')
    .addSeparator()
    .addItem('Kimenő fejléc adatok letöltése (Digest API)…', 'menuOsaQueryInvoiceDigestOutbound')
    .addItem('Kimenő tételek letöltése (teljes letöltés API)…', 'menuOsaDownloadMissingDetailsOutbound')
    .addSeparator()
    .addItem('Egy számla kézi lekérdezése és pdf', 'menuQuerySingleInvoice')
    .addItem('NAV adatkapcsolat létrehozás', 'menuSetupNavConnection')
    .addItem('NAV kapcsolat teszt', 'menuTestConnection')
    .addSeparator()
    .addItem('xls adatok hozzáfűzése és feldolgozása', 'appendXLSXDataToGoogleSheet')
    .addItem('Költségtípusok frissítése', 'runCategoryUpdateFromMenu')
    .addSeparator()
    .addItem('Minden adat és állapot törlése', 'clearAllData')
    .addToUi();

  ui.createMenu('eÁFA vámhatározatok')
    .addItem('Határozat lista letöltése (Digest)…', 'menuEVatVamQueryDigest')
    .addItem('Részletek letöltése (hiányzó XML adatok)…', 'menuEVatVamDownloadMissing')
    .addToUi();

  ui.createMenu('NAV pénztárgép (OPG)')
    .addItem('Nyugta lekérdezés (default 14 nap)…', 'menuOpgQuerySync')
    .addSeparator()
    .addItem('OPG sheetek létrehozása', 'menuOpgEnsureSheets')
    .addItem('Minden OPG adat törlése', 'menuOpgClearData')
    .addSeparator()
    .addItem('Teszt környezet ellenőrzés…', 'menuOpgTestEnvironment')
    .addItem('Tesztadat generálás (test env)…', 'menuOpgGenerateTestData')
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

  var p         = PropertiesService.getScriptProperties();
  var extraDays = p.getProperty('BEFORE_AFTER_EXTRA_DAYS') || '30';
  var propStart = p.getProperty('START_DATE')              || '';
  var propEnd   = p.getProperty('END_DATE')                || '';

  var tpl = HtmlService.createTemplateFromFile('SyncDateDialog');
  tpl.syncType   = syncType;
  tpl.queryFrom  = ctx.queryFrom;
  tpl.queryTo    = ctx.queryTo;
  tpl.filterFrom = ctx.filterFrom;
  tpl.filterTo   = ctx.filterTo;
  tpl.extraDays  = extraDays;
  tpl.propStart  = propStart;
  tpl.propEnd    = propEnd;

  var html = tpl.evaluate().setWidth(520).setHeight(360);
  SpreadsheetApp.getUi().showModalDialog(html, 'NAV szinkronizálás — időszak beállítása');
}
