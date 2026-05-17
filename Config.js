/**
 * Config.js — Központi konfiguráció minden testreszabható konstanshoz.
 *
 * Ide kerülnek a sheet nevek, debug kapcsolók, batch méretek, lookback napok
 * és a beégetett teszt-fiókok. Üzleti logika (mezőleképező táblák, default ÁFA
 * táblák) NEM ide kerülnek, azok a saját Processor / Api fájlokban élnek.
 */

// ============================================================
// OSA — Online Számla API (NAV) — Bejövő / Kimenő számlák
// ============================================================

var OSA_SHEET_FEJLEC         = 'Fejléc adatok';
var OSA_SHEET_TETEL          = 'Tétel adatok';
var OSA_SHEET_FEJLEC_KIMENO  = 'Fejléc KIMENŐ';
var OSA_SHEET_TETEL_KIMENO   = 'Tételek KIMENŐ';

// Hány tételt töltünk le párhuzamosan egy batch-ben
var OSA_BATCH_SIZE           = 30;

// Time-driven trigger fallback ablaka (osaAutoSync), ha sheet üres és nincs START_DATE
var OSA_AUTOSYNC_DAYS        = 5;

// Maximum lapszám a digest lekérdezésnél (egyetlen API hívásra)
var OSA_MAX_DIGEST_PAGES     = 10;

// ============================================================
// eVatVam — Elektronikus Vám + ÁFA határozatok (NAV EAR)
// ============================================================

var EVATVAM_SHEET            = 'Vámhatározatok';
var EVATVAM_BATCH_SIZE       = 30;
var EVATVAM_MAX_DIGEST_PAGES = 20;

// ============================================================
// OPG — Online Pénztárgép napló (NAV)
// ============================================================

var OPG_SHEET_FEJLEC         = 'OPG Nyugta fejléc';
var OPG_SHEET_TETEL          = 'OPG Nyugta tétel';

// Ha hiányzanak a lapok, létrehozzuk fejlécekkel és formázással. False esetén
// a futás hibával áll meg (dpValidate-szerűen).
var OPG_AUTO_CREATE_SHEETS   = true;

// Menüből indított lekérdezés default ablaka (nap)
var OPG_LOOKBACK_DAYS        = 14;

// Time-driven trigger (opgAutoSync) lookback ablaka (nap)
var OPG_AUTOSYNC_DAYS        = 5;

// Gyakorló bizonylatok (NYT/EST/SZT/VBT) átvétele. false → kihagyjuk.
var OPG_INCLUDE_PRACTICE     = false;

// Egy run-ban max ennyi AP-t dolgozunk fel. A GAS 6 perces limit miatt; ha
// több AP van, a state-tracker viszi tovább a következő trigger futásra.
var OPG_MAX_AP_PER_RUN       = 3;

// NAV által kiosztott teszt fiók hitelesítési adatai (csak teszt env)
var OPG_TEST_LOGIN           = 'a5mtm0xr0subgft';
var OPG_TEST_PASSWORD        = 'Ab123456';
var OPG_TEST_SIGN_KEY        = 'd4-a493-b83935e521bf5DVFYT0H9FDE';
var OPG_TEST_EXCHANGE_KEY    = 'eaaf5DVFYT0H8FI3';

// ============================================================
// DEBUG — XML kérések / válaszok logolása
// ============================================================

// OSA / eVatVam XML kérések és válaszok bekerülnek a Logger naplóba
var NAV_DEBUG_LOG_XML        = false;

// OPG XML kérések és válaszok (multipart attachmentekből csak méret + first 64 byte hex)
var OPG_DEBUG_LOG            = false;
