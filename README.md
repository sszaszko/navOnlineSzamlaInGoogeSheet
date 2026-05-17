# NAV Online Számla – Google Sheets Integráció

## Leírás

Google Apps Script (GAS) alapú megoldás, amely a NAV három különböző rendszerét köti össze egyetlen Google Táblázattal:

| Modul | NAV rendszer | Google Sheets lapok |
|---|---|---|
| **OSA** – Online Számla API | Bejövő és kimenő számlák | Fejléc adatok, Tétel adatok, Fejléc KIMENŐ, Tételek KIMENŐ |
| **eVatVam** – eÁFA vámhatározatok | Elektronikus vám- és ÁFA határozatok | Vámhatározatok |
| **OPG** – Online Pénztárgép | Kasszabizonylaток (nyugták) | OPG Nyugta fejléc, OPG Nyugta tétel |

A szkript elvégzi a duplikátumok szűrését, a dátumok szerinti rendezést, a költségtípusok automatikus kitöltését előre definiált szabályok alapján, és opcionálisan PDF-et generál egyes számlákhoz.

---

## Telepítés

1. Nyisd meg a Google Táblázatot, amelyhez hozzá szeretnéd adni.
2. Felső menü: **Extensions → Apps Script**.
3. Másold be az összes `.js` fájlt külön szkriptfájlként, és a `.html` fájlokat (`SyncDateDialog.html`, `NavConnectionDialog.html`) HTML-fájlként.
4. Mentés után az **appsscript.json** tartalmát másold a projekt **Project Settings → Edit appsscript.json** részébe (időzóna, szükséges scope-ok).

### Script Properties beállítása

**Project Settings → Script Properties** alatt add meg a következő kulcsokat:

| Kulcs | Leírás |
|---|---|
| `NAV_LOGIN` | NAV technikai felhasználónév |
| `NAV_PASSWORD_HASH` | Jelszó SHA-512 hash-e (nagybetűs hex) _(ajánlott)_ |
| `NAV_PASSWORD` | Jelszó plain-textben _(legacy, automatikusan hash-elve lesz)_ |
| `NAV_TAX_NUMBER` | 8 jegyű adószám törzsszám |
| `NAV_SIGNATURE_KEY` | Aláírókulcs |
| `NAV_EXCHANGE_KEY` | Cserekulcs |
| `NAV_ENV` | `test` vagy `production` (alapértelmezett: `production`) |

Opcionális felülírások (automatikus alapértékkel rendelkeznek):

| Kulcs | Leírás |
|---|---|
| `NAV_SOFTWARE_ID` | 18 karakterre normalizálva; ha rövidebb, nullákkal egészül ki |
| `NAV_SOFTWARE_NAME` | |
| `NAV_SOFTWARE_VERSION` | |
| `NAV_SOFTWARE_DEV_NAME` | |
| `NAV_SOFTWARE_DEV_CONTACT` | |
| `NAV_SOFTWARE_DEV_COUNTRY` | |
| `NAV_SOFTWARE_DEV_TAX_NUMBER` | |
| `START_DATE` / `END_DATE` | Fix lekérdezési időszak (YYYY-MM-DD); ha üres, automatikusan számolja |
| `BEFORE_AFTER_EXTRA_DAYS` | Extra napok a lekérdezési ablak bővítéséhez (alapértelmezett: 30) |

> **Tipp:** A hitelesítési adatok a `NavAuth.js` → `menuSetupNavConnection` menüpontból is bekonfigurálhatók grafikus párbeszédablakkal.

---

## Fájlstruktúra

```
Config.js              – Globális konstansok (sheet nevek, batch méretek, debug kapcsolók)
NavConfig.js           – NAV hitelesítési konfiguráció (getNavConfig)
NavAuth.js             – SHA-512 hash, token és requestId generálás
NavXmlUtils.js         – Közös NAV XML felépítő és elemző segédek

OsaApi.js              – OSA API hívások (queryInvoiceDigest, queryInvoiceData batch)
OsaFieldMaps.js        – OSA mező-leképező táblák
OsaFormatters.js       – OSA cellaformázók
OsaProcessor.js        – OSA adat feldolgozás (fejléc + tétel írás, kategorizálás)
OsaSync.js             – OSA szinkron orchestrátor + menü wrapperek

eVatVamApi.js          – eVatVam API hívások
eVatVamDataprocessor.js– eVatVam adat feldolgozás
eVatVamSync.js         – eVatVam szinkron orchestrátor + menü wrapperek

OpgApi.js              – OPG API hívások (multipart XML/MTOM)
OpgDataprocessor.js    – OPG adat feldolgozás, state-tracker
OpgMenu.js             – OPG menü handlerek + time-driven trigger végpont

Menu.js                – onOpen(), SyncDateDialog megnyitó
ConnectionMenu.js      – NAV kapcsolat beállítás dialógus
SheetUtils.js          – Közös sheet segédfüggvények (dpValidate, dpGetHeaderMap, getDateBoundaries)
InvoicePdf.js          – PDF generálás egyedi számla lekérdezéshez
ProcessNAV_xls.js      – XLS/XLSX adatok hozzáfűzése + utófeldolgozás
SHA3.js                – SHA-3/SHA-512 implementáció

SyncDateDialog.html    – Dátumválasztó párbeszédablak (minden szinkronhoz)
NavConnectionDialog.html – NAV kapcsolat beállítás párbeszédablak
```

---

## Menüpontok

### NAV számlák

| Menüpont | Leírás |
|---|---|
| Bejövő fejléc adatok letöltése (Digest API)… | Dátumablak-dialógussal lekéri a bejövő számla fejléceket |
| Bejövő tételek letöltése (teljes letöltés API)… | Letölti a még hiányzó bejövő tétel adatokat batch-csel |
| Kimenő fejléc adatok letöltése (Digest API)… | Ugyanaz, kimenő irányban |
| Kimenő tételek letöltése (teljes letöltés API)… | Ugyanaz, kimenő irányban |
| Egy számla kézi lekérdezése és pdf | Egyedi számlaszám alapján lekérdez + PDF-et generál |
| NAV adatkapcsolat létrehozás | Grafikus párbeszédablak a hitelesítési adatok beállításához |
| NAV kapcsolat teszt | Gyors tokencsere-teszt a NAV felé |
| xls adatok hozzáfűzése és feldolgozása | Manuálisan exportált XLS/XLSX tartalmát hozzáadja a sheetre |
| Költségtípusok frissítése | Újrafuttatja a kategória-kitöltő szabályokat |
| Minden adat és állapot törlése | Törli az összes sheetadatot (visszavonhatatlan) |

### eÁFA vámhatározatok

| Menüpont | Leírás |
|---|---|
| Határozat lista letöltése (Digest)… | Vámhatározat fejlécek letöltése dátumablak-dialógussal |
| Részletek letöltése (hiányzó XML adatok)… | Hiányzó határozat részletek batch-csel |

### NAV pénztárgép (OPG)

| Menüpont | Leírás |
|---|---|
| Nyugta lekérdezés (default 14 nap)… | Pénztárgép-bizonylatok letöltése dátumablak-dialógussal |
| OPG sheetek létrehozása | Létrehozza a szükséges lapokat fejlécekkel és formázással |
| Minden OPG adat törlése | Törli az OPG lapok tartalmát és az állapot-trackert |
| Teszt környezet ellenőrzés… | Ellenőrzi az OPG teszt API elérhetőségét |
| Tesztadat generálás (test env)… | NAV teszt fiókkal generál tesztbizonylatokat |

---

## Automatikus futtatás (Time-driven triggerek)

Az alábbi függvények regisztrálhatók **Time-driven trigger**-ként az Apps Script felületén (**Triggers → Add trigger**):

| Függvény | Leírás |
|---|---|
| `osaAutoSync` | Bejövő számlák szinkronizálása (alapértelmezett ablak: utolsó 5 nap) |
| `osaAutoSyncOutbound` | Kimenő számlák szinkronizálása |
| `eVatVamAutoSync` | Vámhatározatok szinkronizálása |
| `opgAutoSync` | OPG nyugták szinkronizálása (alapértelmezett ablak: utolsó 5 nap) |

> **Fontos – régi trigger nevek:** Ha korábban `autoSyncLast5Days`, `autoSyncLast5DaysOutbound` vagy `autoSyncEarLast5Days` vagy `autoSyncOpgLast5Days` volt beállítva, töröld azokat, és regisztráld újra a fenti nevekkel.

---

## Konfiguráció (Config.js)

A `Config.js` fájlban módosítható paraméterek:

```javascript
OSA_BATCH_SIZE           = 30    // Tétel batch méret
OSA_AUTOSYNC_DAYS        = 5     // Trigger fallback időablak (nap)
OSA_MAX_DIGEST_PAGES     = 10    // Max lapszám egy digest API hívásban

EVATVAM_BATCH_SIZE       = 30
EVATVAM_MAX_DIGEST_PAGES = 20

OPG_LOOKBACK_DAYS        = 14    // Menüből indított OPG lekérdezés ablaka
OPG_AUTOSYNC_DAYS        = 5     // OPG trigger fallback időablak
OPG_INCLUDE_PRACTICE     = false // Gyakorló bizonylatok (NYT/EST/SZT/VBT) átvétele
OPG_MAX_AP_PER_RUN       = 3     // Max AP/run (GAS 6 perces limit miatt)

NAV_DEBUG_LOG_XML        = false // XML kérések logolása (OSA/eVatVam)
OPG_DEBUG_LOG            = false // XML kérések logolása (OPG)
```
