# Architektúra — navOnlineSzamlaInGoogeSheet

Google Apps Script (GAS) projekt, amely három NAV API-t integrál Google Spreadsheet-be:
- **OSA** — Online Számla API v3.0 (bejövő / kimenő számla)
- **eVatVam** — eÁFA API v1.0 (vámhatározat)
- **OPG** — Online Pénztárgép napló API v1.2 (nyugta)

---

## GAS-specifikus korlátok

| Korlát | Hatás |
|--------|-------|
| Nincs modul rendszer | Minden `.js` egyetlen globális scope-ban él |
| Betöltési sorrend: ábécé | Fájlnév prefix meghatározza a betöltési sorrendet |
| Függvénydeklarációk: hoisted | Bármely fájl hívhat bármely másik fájl függvényt |
| 6 perces futási limit | Batch méret + state tracker + trigger láncolás szükséges |
| `UrlFetchApp.fetchAll()` | Párhuzamos HTTP kérések: batch-es tételletöltésnél kihasználva |
| Script Properties | Hitelesítési adatok és állapot tárolása (nem kód) |

---

## Fájlstruktúra

```
navOnlineSzamlaInGoogeSheet/
│
├── Config.js                  ← Minden testreszabható konstans (sheet nevek, batch méretek, debug)
│
├── Nav* — Közös NAV réteg (minden alrendszer újrahasználja)
│   ├── NavConfig.js            ← getNavConfig(): Script Properties → config object
│   ├── NavAuth.js              ← SHA-512, requestId generálás, request signature (SHA3-512)
│   └── NavXmlUtils.js          ← XML parse segédfüggvények (navFindFirst, navPost, stb.)
│
├── SheetUtils.js               ← Közös sheet műveletek (dpGetHeaderMap, dpValidate, getDateBoundaries, stb.)
│
├── Menu.js                     ← onOpen() menü regisztráció + openSyncDialog()
├── SyncDateDialog.html         ← Dátumválasztó modal (queryFrom/To + filterFrom/To)
├── NavConnectionDialog.html    ← NAV hitelesítési adatok beállítása modal
├── ConnectionMenu.js           ← NAV kapcsolat setup + diagnosztika
│
├── Osa* — Online Számla API (bejövő + kimenő számlák)
│   ├── OsaFieldMaps.js         ← Mezőleképező táblák + osaDirCfg() (INBOUND/OUTBOUND konfigok)
│   ├── OsaFormatters.js        ← Értékkonverziók (osaNum, osaBoolHu, osaPaymentMethodHu, stb.)
│   ├── OsaApi.js               ← NAV API hívások (digest lapozás, detail batch, XML builder)
│   ├── OsaProcessor.js         ← Sheet upsert logika (fejléc + tétel sorok írása/frissítése)
│   └── OsaSync.js              ← Orchestráció, menü wrapperek, trigger végpontok
│
├── eVatVam* — Vámhatározat API (eÁFA)
│   ├── eVatVamApi.js           ← eÁFA API hívások (digest + taxCode lekérdezés, XML builder)
│   ├── eVatVamDataprocessor.js ← Vámhatározatok sheet upsert + batch feldolgozó
│   └── eVatVamSync.js          ← Orchestráció, menü wrapperek, trigger végpont
│
├── Opg* — Online Pénztárgép napló
│   ├── OpgApi.js               ← OPG API hívások (status + file MTOM letöltés, multipart parser)
│   ├── OpgDataprocessor.js     ← ZIP/P7B kibontás, XML parse, sheet upsert, state tracker
│   └── OpgMenu.js              ← Menü wrapperek, trigger végpont
│
├── InvoicePdf.js               ← PDF generálás (kézi számlalekérdezéshez)
├── ProcessNAV_xls.js           ← XLS import + postProcessSheets() (kategória kiegészítés)
└── SHA3.js                     ← SHA3-512 implementáció (GAS natív nincs)
```

---

## Alrendszerek részletes leírása

### 1. OSA — Online Számla API

**Adatfolyam:**

```
SyncDateDialog.html
    │ google.script.run.dialogRunSyncInvoiceIn/Out(opts)
    ▼
OsaSync.osaSync(direction, opts)
    │
    ├─► OsaApi.osaQueryInvoiceDigest(params)        ← paginated, 33-napos chunk
    │       │ navPost() × N lap
    │       └─► osaParseDigestResponse()
    │
    ├─► OsaProcessor.osaWriteFejlecRows(rows, direction, filter)
    │       └─► dpGetHeaderMap / dpGetExistingKeys / batch setValues
    │
    └─► OsaSync.osaDownloadMissingDetails(direction)
            │
            ├─► OsaApi.osaQueryInvoiceDataBatch(paramsArray)   ← UrlFetchApp.fetchAll()
            │       └─► osaParseInvoiceDataResponse() × batch
            │
            └─► OsaProcessor.osaProcessInvoiceDataBatch(results, direction)
                    └─► batch setValues (fejléc + tétel sheet egyszerre)
```

**Digest lapozás (33-napos chunking + while-loop):**

```
queryFrom ──────────────────────────────────────── queryTo
    │         │         │         │
  [chunk1] [chunk2] [chunk3] ... [chunkN]   ← max 33 nap/chunk
  page 1..P  page 1..P                      ← max OSA_MAX_DIGEST_PAGES lap/chunk
```

**Két sheet:**

| Sheet | Kulcs | Forrás |
|-------|-------|--------|
| `Fejléc adatok` / `Fejléc KIMENŐ` | Számla sorszáma | Digest API |
| `Tétel adatok` / `Tételek KIMENŐ` | Számla sorszáma + Tétel sorszáma | InvoiceData API |

**Upsert logika:**
- Meglévő sor (azonos kulcs): mezők frissülnek, kivéve `Tételek LETÖLTVE` — az megmarad
- Új sor: dátumszűrő (`filterFrom`/`filterTo`) alapján döntjük el, beírjuk-e
- A `Tételek LETÖLTVE` mező vezérli a hiányzó tétel letöltést: üres vagy `n/a` → letöltendő

---

### 2. eVatVam — Elektronikus Vám + ÁFA határozatok

**Adatfolyam:**

```
SyncDateDialog.html
    │ google.script.run.dialogRunSyncEVatVam(opts)
    ▼
eVatVamSync.eVatVamAutoSync(opts)
    │
    ├─► eVatVamApi.eVatVamQueryDigest(params)       ← paginated, 33-napos chunk
    │
    ├─► eVatVamDataprocessor.eVatVamWriteDeclarationRows(rows, filter)
    │
    └─► eVatVamSync.eVatVamDownloadMissing()
            │
            └─► eVatVamApi.eVatVamQueryTaxCode({ cdpsId, resolutionId }) × N
                    │
                    └─► eVatVamDataprocessor.eVatVamProcessDeclarationDataBatch(results)
```

**Egy sheet:**

| Sheet | Kulcs | Forrás |
|-------|-------|--------|
| `Vámhatározatok` | Határozat azonosítója (cdpsId) | Digest API |
| (ugyanabban a sorban) | — | TaxCode API → `Teljes XML` oszlop |

**Eltérés az OSA-tól:**
- Nincs `fetchAll()` — a NAV eÁFA API szekvenciális hívást vár
- A részletes adat (rawXml) ugyanabba a sorba kerül mint a digest, nem külön sheetbe
- Namespace különbség: `xmlns="http://schemas.nav.gov.hu/EAR/1.0/api"` (OSA vs EAR)

---

### 3. OPG — Online Pénztárgép napló

**Adatfolyam:**

```
OpgMenu.opgAutoSync(opts)
    │
    └─► OpgDataprocessor.opgRunSync({ lookbackDays })
            │
            ├─► OpgApi.opgQueryCashRegisterStatus()       ← AP-lista
            │
            └─► per AP:
                    ├─► state tracker olvasása (PropertiesService)
                    │
                    ├─► OpgApi.opgQueryCashRegisterFile(apNumber, fileNum..)
                    │       └─► MTOM/multipart válasz → ZIP binary blob-ok
                    │
                    ├─► OpgDataprocessor.opgExtractXmlFromZippedP7b(bytes)
                    │       └─► Utilities.unzip() → P7B fejléc strip → XML
                    │
                    ├─► Naplófájl XML parse (NYN/ESN/SZN/VBN/NFN/PJN rekordok)
                    │
                    ├─► Fejléc + tétel sheet upsert (SHA1 alapú bizonylat ID)
                    │
                    └─► state tracker írása (lastProcessedFileNumber per AP)
```

**Alapvető különbségek az OSA/eVatVam-tól:**
- Nem XML REST, hanem MTOM/multipart binary (ZIP-be csomagolt, P7B-vel aláírt naplófájlok)
- Az iteráció nem dátum alapú, hanem fájlszám (`fileNumberStart..End`) alapú
- State tracker (PropertiesService `OPG_STATE`) teszi lehetővé a 6 perces limit melletti folytatást
- ÁFA-kulcs lookup: dinamikusan a PJN (pénztárjelentés) rekordból oldódik fel

---

## Közös infrastruktúra

### Hitelesítés (NAV Common séma)

Minden három alrendszer azonos hitelesítési sémát használ:

```
Script Properties
    NAV_LOGIN, NAV_PASSWORD_HASH (SHA-512), NAV_TAX_NUMBER,
    NAV_SIGNATURE_KEY, NAV_EXCHANGE_KEY, NAV_ENV (test|production)
        │
        ▼
NavConfig.getNavConfig() → { login, passwordHash, signatureKey, taxNumber, apiUrl, ... }
        │
        ▼
NavAuth.navNewRequestIdAndTimestamp()     → { requestId, timestamp }
NavAuth.navComputeRequestSignature(...)   → SHA3-512(requestId + timestamp + signatureKey)
```

A jelszót SHA-512 hash-ként tároljuk — a NAV API ezt várja, visszafejthető jelszó nem kerül Script Properties-be.

### Sheet upsert minta (SheetUtils.js)

```
dpGetHeaderMap(sheet)         → { "Fejléc neve": oszlopIndex }
dpGetExistingKeys(sheet, col) → { "kulcsérték": sorIndex }
dpBuildRow(obj, headers, map) → [cellaérték, ...]
sheet.getRange(...).setValues([...])   ← batch write (nem appendRow)
```

### Dátumhatárok (SheetUtils.getDateBoundaries)

Az automatikus trigger az utolsó ismert dátumtól számítja a lekérdezési ablakot, `START_DATE` / `END_DATE` Script Property-k alapján szűri a beírást:

```
queryFrom = max(utolsó ismert dátum − extraDays, START_DATE − extraDays)
queryTo   = min(mai nap + extraDays,             END_DATE   + extraDays)
filterFrom = START_DATE (könyvelési szűrő)
filterTo   = END_DATE
```

---

## Time-driven triggerek

| Trigger függvény | Alrendszer | Régi név |
|-----------------|-----------|---------|
| `osaAutoSync` | OSA bejövő | `autoSyncLast5Days` |
| `osaAutoSyncOutbound` | OSA kimenő | `autoSyncLast5DaysOutbound` |
| `eVatVamAutoSync` | eVatVam | `autoSyncEarLast5Days` |
| `opgAutoSync` | OPG | `autoSyncOpgLast5Days` |

> ⚠ A triggereket a GAS szerkesztőben (Triggerek panel) kézzel kell újraregisztrálni, ha a régi nevek voltak beállítva.

---

## Dialógusok (HTML modalok)

### SyncDateDialog.html

Minden szinkron folyamathoz közös dátumválasztó. A `syncType` paraméter vezérli:

| syncType | Callback függvény | Alrendszer |
|----------|-------------------|-----------|
| `invoice_in` | `dialogRunSyncInvoiceIn` | OSA bejövő |
| `invoice_out` | `dialogRunSyncInvoiceOut` | OSA kimenő |
| `eVatVam` | `dialogRunSyncEVatVam` | eVatVam |
| `opg` | `dialogRunSyncOpg` | OPG |

A dialog bezárul azonnal a gomb megnyomása után; a szerver oldali feldolgozás a háttérben fut tovább (GAS toast értesítésekkel).

### NavConnectionDialog.html

Kétféle módban nyílik meg (`mode='setup'` / `mode='testOnly'`):
- **setup**: 5 Script Property bevitele + mentés + automatikus diagnosztika
- **testOnly**: csak diagnosztika futtatása (mai napra szóló minimal digest lekérdezés)

---

## Függőségi gráf

```
Config.js
    ↑ (konstansok)
    │
NavConfig.js ◄── NavAuth.js ◄── NavXmlUtils.js
    ↑               ↑               ↑
    └───────────────┴───────────────┘
                    ↑ (mind a három alrendszer újrahasználja)
          ┌─────────┴──────────┬──────────────────┐
          │                    │                  │
    OsaApi.js           eVatVamApi.js        OpgApi.js
          │                    │                  │
   OsaProcessor.js   eVatVamDataprocessor.js  OpgDataprocessor.js
          │                    │                  │
    OsaSync.js          eVatVamSync.js        OpgMenu.js
          │                    │                  │
          └─────────┬──────────┴──────────────────┘
                    ↓
                 Menu.js (onOpen + openSyncDialog)
                    │
          SyncDateDialog.html / NavConnectionDialog.html

SheetUtils.js ← minden Processor/Sync fájl újrahasználja
OsaFieldMaps.js ← OsaProcessor, OsaSync, Menu (osaDirCfg)
OsaFormatters.js ← OsaProcessor
SHA3.js ← NavAuth.js
InvoicePdf.js ← OsaSync (kézi lekérdezésnél)
ProcessNAV_xls.js ← OsaSync (postProcessSheets)
```
