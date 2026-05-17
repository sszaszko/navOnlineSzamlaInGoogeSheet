/**
 * OpgDataprocessor.gs — OPG (Online Pénztárgépnapló) adatfeldolgozás és sheet műveletek
 *
 * Felelőssége:
 *   - "OPG Nyugta fejléc" és "OPG Nyugta tétel" sheetek upsert-je
 *   - ZIP kicsomagolás (Utilities.unzip), P7B → naplófájl XML kihámozás
 *   - Naplófájl XML parsolása (V2_AEEnaplo séma — NYN/ESN/SZN/VBN/NFN/PJN bizonylatok)
 *   - Fizetési módok normalizálása (DRC blokk)
 *   - Dinamikus ÁFA-kulcs lookup a PJN (pénztárjelentés) rekordokból
 *   - Idempotencia: SHA1 alapú Bizonylat ID
 *   - State tracker: PropertiesService alapú "lastProcessedFileNumber" per AP
 *
 * NEM tartalmaz: NAV API hívások, auth, UI.
 * Függőségei: OpgApi.gs, NavApi.gs (navFindFirst/All, navTextOf), Dataprocessor.gs (dpGetHeaderMap)
 */

// ============================================================
// KONSTANSOK ÉS KONFIGURÁCIÓ
// ============================================================

// Konstansok (OPG_SHEET_FEJLEC/TETEL, OPG_AUTO_CREATE_SHEETS, OPG_LOOKBACK_DAYS,
// OPG_AUTOSYNC_DAYS, OPG_INCLUDE_PRACTICE, OPG_MAX_AP_PER_RUN): Config.js

// PropertiesService kulcs az állapot perzisztálásához (1 property, JSON map).
var OPG_STATE_PROP_KEY = 'OPG_STATE';

// ÁFA gyűjtő prefix → áfakulcs (default, ha a PJN-ből nem oldódik fel)
var OPG_DEFAULT_VAT_BY_PREFIX = {
  'A': 0.05,
  'B': 0.18,
  'C': 0.27,
  'D': 0,        // adómentes
  'E': null      // különbözeti / egyéb — ismeretlen, n/a
};

// ============================================================
// MEZŐLEKÉPEZŐ TÁBLÁK
// ============================================================

/**
 * OPG Nyugta fejléc sheet — oszlopok sorrendje és értékfüggvényei.
 * Signature: function(rec) → cellaérték
 *
 * rec: opgParseLogFile() egy bizonylat rekord objektum, ld. a parsernél.
 */
var OPG_FEJLEC_MEZO_ERTEKEK = {
  'Bizonylat ID':            function(rec) { return rec.bizonylatId; },
  'AP-szám':                 function(rec) { return rec.apNumber; },
  'Naplófájl sorszám':       function(rec) { return rec.fileNumber; },
  'Rekord sorszám':          function(rec) { return rec.recordIndex; },
  'Bizonylat típus':         function(rec) { return opgBizonylatTipusHu(rec.tag); },
  'Sorszám':                 function(rec) { return rec.sorszam; },
  'Kiállítás ideje':         function(rec) { return rec.cts; },
  'Végösszeg':               function(rec) { return opgNum(rec.sum); },
  'Elsődleges fiz. mód':     function(rec) { return rec.payments.primary; },
  'Fizetési mód részletező': function(rec) { return rec.payments.detail; },
  'NAV ellenőrző kód':       function(rec) { return rec.navCode; },
  'Naplófájl név':           function(rec) { return rec.fileName; },
  'Letöltve':                function(rec) { return Utilities.formatDate(new Date(), 'Europe/Budapest', 'yyyy-MM-dd HH:mm:ss'); }
};

/**
 * OPG Nyugta tétel sheet — oszlopok sorrendje és értékfüggvényei.
 * Signature: function(bizonylatId, tetel) → cellaérték
 */
var OPG_TETEL_MEZO_ERTEKEK = {
  'Tétel ID':       function(bid, t) { return t.tetelId; },
  'Bizonylat ID':   function(bid, t) { return bid; },
  'Sor index':      function(bid, t) { return t.sorIndex; },
  'Megnevezés':     function(bid, t) { return t.megnevezes; },
  'Mennyiség':      function(bid, t) { return opgNum(t.mennyiseg); },
  'Mértékegység':   function(bid, t) { return t.mertekegyseg; },
  'Egységár':       function(bid, t) { return opgNum(t.egysegar); },
  'Bruttó érték':   function(bid, t) { return opgNum(t.brutto); },
  'ÁFA kód':        function(bid, t) { return t.afaKod; },
  'ÁFA mérték':     function(bid, t) { return t.afaMertek != null ? t.afaMertek : 'n/a'; }
};

// ============================================================
// PUBLIKUS API — magas szintű orchestráció
// ============================================================

/**
 * Egy futási ciklus: státusz lekérdezés → sorszám-tartomány alapján fájl letöltés
 * → ZIP/P7B/XML parse → bizonylat upsert + state mentés.
 *
 * @param {Object} options
 *   lookbackDays  {number}  csak diagnosztikai célra a logban (a NAV maga
 *                           tartja a 14 napos ablakot, nem szűrhetünk dátumra)
 *   maxApPerRun   {number}  override OPG_MAX_AP_PER_RUN
 *   tag           {string}  log prefix
 *
 * @returns {{apProcessed:number, files:number, bizonylatok:number, tetelek:number, errors:Array<string>}}
 */
function opgRunSync(options) {
  options = options || {};
  var tag = options.tag || 'opgRunSync';
  var maxAp = options.maxApPerRun || OPG_MAX_AP_PER_RUN;

  opgEnsureSheets();

  Logger.log('[' + tag + '] Pénztárgép státuszok lekérdezése...');
  var statusList = opgQueryCashRegisterStatus({});
  Logger.log('[' + tag + '] AP-k száma: ' + statusList.length);

  var state = opgLoadState();
  var summary = { apProcessed: 0, files: 0, bizonylatok: 0, tetelek: 0, nullXml: 0, practiceSkipped: 0, errors: [] };

  for (var i = 0; i < statusList.length && summary.apProcessed < maxAp; i++) {
    var ap = statusList[i];
    if (!ap.maxAvailableFileNumber || ap.maxAvailableFileNumber === 0) {
      Logger.log('[' + tag + '] ' + ap.apNumber + ': nincs elérhető naplófájl. Skip.');
      continue;
    }

    var apState = state[ap.apNumber] || { lastProcessedFileNumber: 0 };
    var startNum = Math.max(ap.minAvailableFileNumber, (apState.lastProcessedFileNumber || 0) + 1);
    var endNum   = ap.maxAvailableFileNumber;
    if (startNum > endNum) {
      Logger.log('[' + tag + '] ' + ap.apNumber + ': nincs új naplófájl (state=' + apState.lastProcessedFileNumber + ', max=' + endNum + ')');
      continue;
    }

    Logger.log('[' + tag + '] ' + ap.apNumber + ': feldolgozás ' + startNum + '..' + endNum);
    try {
      var apSum = opgProcessApRange(ap.apNumber, startNum, endNum, tag);
      summary.apProcessed++;
      summary.files           += apSum.files;
      summary.bizonylatok     += apSum.bizonylatok;
      summary.tetelek         += apSum.tetelek;
      summary.nullXml         += apSum.nullXml || 0;
      summary.practiceSkipped += apSum.practiceSkipped || 0;

      state[ap.apNumber] = {
        lastProcessedFileNumber: apSum.lastProcessedFileNumber,
        lastRunUtc:              new Date().toISOString()
      };
      opgSaveState(state);
    } catch (e) {
      var msg = ap.apNumber + ': ' + e.message;
      summary.errors.push(msg);
      Logger.log('[' + tag + '] HIBA ' + msg);
    }
  }

  Logger.log('[' + tag + '] ÖSSZEGZÉS: ' + JSON.stringify(summary));
  return summary;
}

/**
 * Egy AP-szám sorszám-tartományának feldolgozása, allFilesSent=true-ig iterálva.
 */
function opgProcessApRange(apNumber, fileStart, fileEnd, tag) {
  tag = tag || 'opgProcessApRange';
  var totalFiles = 0, totalBizonylatok = 0, totalTetelek = 0;
  var nullXmlCount = 0, parseErrorCount = 0, noRowsCount = 0, practiceSkipped = 0;
  var cursor = fileStart;
  var lastProcessed = fileStart - 1;
  var pjnCache = {}; // AP-szintű ÁFA-cache; PJN rekordok közben épül fel

  // Először építsünk fel egy ÁFA lookup-ot a PJN/NFN rekordokból — első körben
  // letöltünk minden fájlt, parse-oljuk a PJN rekordokat, cache-eljük az áfakulcsokat,
  // majd a tétel feldolgozásnál ebből oldjuk fel a VC → áfa% leképezést.

  while (cursor <= fileEnd) {
    var resp = opgQueryCashRegisterFile({
      apNumber:        apNumber,
      fileNumberStart: cursor,
      fileNumberEnd:   fileEnd
    });

    Logger.log('[' + tag + '] ' + apNumber + ': letöltve ' + resp.files.length + ' fájl (allFilesSent=' + resp.allFilesSent + ', notSent=' + resp.filesNotSentReason + ')');
    if (resp.files.length === 0) break;

    // 1. menet: PJN-ekből áfa-lookup feltöltése a teljes batchen
    for (var i = 0; i < resp.files.length; i++) {
      var xml1 = opgExtractXmlFromZippedP7b(resp.files[i].contentBytes, resp.files[i].cashRegisterFileName);
      if (!xml1) continue;
      opgBuildVatLookupFromXml(xml1, pjnCache);
    }

    // 2. menet: bizonylat-rekordok feldolgozása
    for (var j = 0; j < resp.files.length; j++) {
      var f = resp.files[j];
      totalFiles++;

      if (f.fileValidationResultCode === 'ERROR') {
        Logger.log('[' + tag + '] ' + apNumber + '/' + f.cashRegisterFileName +
                   ': ERROR (' + f.fileValidationErrorCode + ') — naplófájl kihagyva');
        continue;
      }
      if (!f.contentBytes || f.contentBytes.length === 0) {
        nullXmlCount++;
        Logger.log('[' + tag + '] ' + apNumber + '/' + f.cashRegisterFileName +
                   ': contentBytes üres (MTOM attachment nem érkezett meg?)');
        continue;
      }
      var xml2 = opgExtractXmlFromZippedP7b(f.contentBytes, f.cashRegisterFileName);
      if (!xml2) {
        nullXmlCount++;
        Logger.log('[' + tag + '] ' + apNumber + '/' + f.cashRegisterFileName +
                   ': ZIP/P7B kibontás sikertelen (contentBytes=' + f.contentBytes.length + ' byte)');
        continue;
      }
      var fileNumber = opgExtractFileNumberFromName(f.cashRegisterFileName);
      var stats = opgIngestLogXml(xml2, apNumber, fileNumber, f.cashRegisterFileName, pjnCache);
      totalBizonylatok += stats.bizonylatok;
      totalTetelek     += stats.tetelek;
      parseErrorCount  += stats.parseErrors  || 0;
      noRowsCount      += stats.noRows       ? 1 : 0;
      practiceSkipped  += stats.practiceSkipped || 0;
      if (fileNumber > lastProcessed) lastProcessed = fileNumber;
    }

    // Cursor előreléptetés
    var lastReceived = 0;
    for (var k = 0; k < resp.files.length; k++) {
      var fn = opgExtractFileNumberFromName(resp.files[k].cashRegisterFileName);
      if (fn > lastReceived) lastReceived = fn;
    }
    if (resp.allFilesSent || lastReceived === 0) break;
    if (lastReceived + 1 <= cursor) break; // safety: ne ragadjunk be loopba
    cursor = lastReceived + 1;
  }

  Logger.log('[' + tag + '] ' + apNumber + ' DIAGNOSZTIKA: fájlok=' + totalFiles +
             ', nullXml=' + nullXmlCount + ', parseHiba=' + parseErrorCount +
             ', nincsROWS=' + noRowsCount + ', gyakorlóKihagyva=' + practiceSkipped +
             ', bizonylatok=' + totalBizonylatok + ', tételek=' + totalTetelek);

  return {
    files:                   totalFiles,
    bizonylatok:             totalBizonylatok,
    tetelek:                 totalTetelek,
    nullXml:                 nullXmlCount,
    practiceSkipped:         practiceSkipped,
    lastProcessedFileNumber: lastProcessed
  };
}

// ============================================================
// ZIP + P7B + XML kibontás
// ============================================================

/**
 * Egy darab cashRegisterFile (ZIP-pelt P7B) bájttömbjéből kinyeri a naplófájl XML-t.
 * Lépések:
 *   1. ZIP kicsomagolása Utilities.unzip-pel → P7B blob
 *   2. P7B-ből byte-search-csel kihámozzuk a `<?xml ... ?>...</...>` payload-ot
 *
 * @param {number[]|Blob} contentBytes
 * @param {string} fileName  (csak diagnosztikához)
 * @returns {string|null}  UTF-8 XML string
 */
function opgExtractXmlFromZippedP7b(contentBytes, fileName) {
  if (!contentBytes || contentBytes.length === 0) return null;

  var zipBlob = Utilities.newBlob(contentBytes, 'application/zip', (fileName || 'log') + '.zip');
  var entries;
  try {
    entries = Utilities.unzip(zipBlob);
  } catch (e) {
    Logger.log('[opgExtractXmlFromZippedP7b] ZIP kicsomagolás sikertelen (' + fileName + '): ' + e.message);
    return null;
  }
  if (!entries || entries.length === 0) return null;

  // Általában 1 .p7b van per ZIP; ha több, az elsőt vesszük amely XML-szerű payloaddal kihámozható
  for (var i = 0; i < entries.length; i++) {
    var entry = entries[i];
    var xml = opgExtractXmlFromP7bBlob(entry);
    if (xml) return xml;
  }
  return null;
}

/**
 * P7B (PKCS#7 SignedData) → naplófájl XML byte-search módszerrel.
 *
 * Mivel a GAS-ban nincs natív PKCS#7 parser, a SignedData DER ASN.1 struktúrából
 * a payload-ot úgy keressük, hogy a `<?xml` (0x3c 0x3f 0x78 0x6d 0x6c) markerre
 * scan-elünk, majd az XML-t a záró záró root tagig olvassuk. Ez működik addig,
 * amíg az aláírt tartalom közvetlenül a naplófájl XML, mert a PKCS#7 DER bájtok
 * nem tartalmaznak '<?xml' byte sorozatot a payload-on kívül.
 *
 * @param {Blob} p7bBlob
 * @returns {string|null}
 */
function opgExtractXmlFromP7bBlob(p7bBlob) {
  var bytes = p7bBlob.getBytes();
  // Keressük a `<?xml` markert
  var startIdx = -1;
  for (var i = 0; i < bytes.length - 5; i++) {
    if (bytes[i]   === 0x3c &&  // <
        bytes[i+1] === 0x3f &&  // ?
        bytes[i+2] === 0x78 &&  // x
        bytes[i+3] === 0x6d &&  // m
        bytes[i+4] === 0x6c) {  // l
      startIdx = i; break;
    }
  }
  if (startIdx === -1) {
    // Fallback: keressünk `<AEE` vagy `<` után naplófájl root tagre
    for (var j = 0; j < bytes.length - 4; j++) {
      if (bytes[j] === 0x3c && bytes[j+1] === 0x41 && bytes[j+2] === 0x45 && bytes[j+3] === 0x45) {
        startIdx = j; break;
      }
    }
    if (startIdx === -1) return null;
  }

  // A PKCS#7 wrapper a végén ASN.1 metainformációkat (certificate, signerInfos) tartalmaz,
  // amelyek bináris adatként 0x3e ('>') bájtot is tartalmazhatnak. Ezért a régi "visszafele
  // scan az utolsó '>'-ig" megbízhatatlan. Ehelyett:
  //   1. Kihagyjuk az XML-deklarációt (?xml...?>).
  //   2. A következő '<' után kiolvasunk egy tag-nevet (ez lesz a gyökerelemo neve, pl. "ROWS").
  //   3. A </tagNév> utolsó előfordulásánál vágjuk le a bájtokat.

  var endIdx = bytes.length; // alapértelmezett: teljes tömb (fallback a korábbi scan-hez)

  var scanPos = startIdx;
  // 1. XML deklaráció kihagyása (<?xml...?>)
  if (bytes[startIdx + 1] === 0x3f) { // '?' → <?xml
    for (var d = startIdx; d < bytes.length - 1; d++) {
      if (bytes[d] === 0x3f && bytes[d + 1] === 0x3e) { scanPos = d + 2; break; }
    }
  }
  // 2. Whitespace kihagyása
  while (scanPos < bytes.length &&
         (bytes[scanPos] === 0x20 || bytes[scanPos] === 0x09 ||
          bytes[scanPos] === 0x0a || bytes[scanPos] === 0x0d)) scanPos++;
  // 3. Gyökerelemo nevének kiolvasása
  if (scanPos < bytes.length && bytes[scanPos] === 0x3c) { // '<'
    scanPos++;
    var tagNameBytes = [];
    while (scanPos < bytes.length) {
      var tb = bytes[scanPos] & 0xff;
      if (tb === 0x20 || tb === 0x09 || tb === 0x0a || tb === 0x0d ||
          tb === 0x3e || tb === 0x2f) break;
      tagNameBytes.push(tb);
      scanPos++;
    }
    if (tagNameBytes.length > 0) {
      var rootTagName = String.fromCharCode.apply(null, tagNameBytes);
      var closingTagBytes = opgStringToUtf8Bytes('</' + rootTagName + '>');
      var positions = opgFindAllByteOccurrences(bytes, closingTagBytes);
      if (positions.length > 0) {
        endIdx = positions[positions.length - 1] + closingTagBytes.length;
      }
    }
  }
  // Fallback: ha a gyökerelemo-keresés nem adott jobb pozíciót
  if (endIdx === bytes.length) {
    for (var e = bytes.length - 1; e > startIdx; e--) {
      if (bytes[e] === 0x3e) { endIdx = e + 1; break; }
    }
  }

  var slice = [];
  for (var s = startIdx; s < endIdx; s++) slice.push(bytes[s] & 0xff);
  // A naplófájl deklarálhat encoding-ot — UTF-8-ban olvasunk, az XmlService úgyis
  // az XML declaration alapján igazítja a karakterkódolást, de jobb biztosra menni.
  var text = Utilities.newBlob(slice).getDataAsString('UTF-8');
  // XML deklaráció eltávolítása (az XmlService.parse helyenként akadozik a windows-1250-en)
  text = text.replace(/^<\?xml[\s\S]*?\?>\s*/i, '');
  return text;
}

function opgExtractFileNumberFromName(name) {
  // A naplófájl neve általában: AP-szám + sorszám pattern; jellemzően
  // `<APNumber>_<fileNumber>_<dátum>.xml` vagy `<AP><LFN>.p7b` formátum.
  // Próbáljuk meg az utolsó számcsoportot kinyerni.
  if (!name) return 0;
  var m = String(name).match(/(\d{3,})(?!.*\d)/);
  if (m) return parseInt(m[1], 10) || 0;
  return 0;
}

// ============================================================
// NAPLÓFÁJL XML → BIZONYLAT REKORDOK
// ============================================================

/**
 * A naplófájl XML feldolgozása és a fejléc + tétel sheetekbe írása.
 *
 * @returns {{bizonylatok:number, tetelek:number}}
 */
function opgIngestLogXml(xml, apNumber, fileNumber, fileName, pjnCache) {
  var doc, root;
  try {
    doc  = XmlService.parse(xml);
    root = doc.getRootElement();
  } catch (e) {
    Logger.log('[opgIngestLogXml] XML parse hiba (' + fileName + '): ' + e.message);
    return { bizonylatok: 0, tetelek: 0, parseErrors: 1, noRows: false, practiceSkipped: 0 };
  }

  var apnFromFile = navTextOf(navFindFirst(root, 'APN')) || apNumber;

  // A gyökerelemo lehet maga a ROWS (közvetlen root), vagy ROWS egy belsőbb elemen belül
  var rows = (root.getName() === 'ROWS') ? root : navFindFirst(root, 'ROWS');
  if (!rows) {
    Logger.log('[opgIngestLogXml] Nincs ROWS elem (' + fileName + '), root=' + root.getName());
    return { bizonylatok: 0, tetelek: 0, parseErrors: 0, noRows: true, practiceSkipped: 0 };
  }

  var children = rows.getChildren();
  var bizonylatRows = [];
  var tetelRows     = [];
  var sumBiz = 0, sumTetel = 0, sumPractice = 0;

  for (var i = 0; i < children.length; i++) {
    var rec = children[i];
    var tag = rec.getName();
    if (!opgIsBizonylatTag(tag)) continue;
    if (!OPG_INCLUDE_PRACTICE && opgIsPracticeTag(tag)) { sumPractice++; continue; }

    var recordIndex = i + 1;
    var sorszam = navTextOf(navFindFirst(rec, 'NSZ'));
    var cts     = navTextOf(navFindFirst(rec, 'CTS'));
    var sum     = navTextOf(navFindFirst(rec, 'SUM'));
    var navCode = navTextOf(navFindFirst(rec, 'NAV'));

    var bizonylatId = opgBizonylatId(apnFromFile, fileNumber, recordIndex);
    var payments    = opgNormalizePayments(navFindFirst(rec, 'DRC'));

    var bizonylatRec = {
      bizonylatId: bizonylatId,
      apNumber:    apnFromFile,
      fileNumber:  fileNumber,
      recordIndex: recordIndex,
      tag:         tag,
      sorszam:     sorszam,
      cts:         cts,
      sum:         sum,
      navCode:     navCode,
      payments:    payments,
      fileName:    fileName
    };
    bizonylatRows.push(bizonylatRec);
    sumBiz++;

    // Tételek: ITL/Tetel vagy közvetlenül ITL gyermekei
    var itl = navFindFirst(rec, 'ITL');
    if (itl) {
      var tetelEls = navFindAll(itl, 'Tetel');
      if (tetelEls.length === 0) {
        // Egyes pénztárgépek nem 'Tetel'-nek hívják — vesszünk minden gyereket
        tetelEls = itl.getChildren();
      }
      for (var t = 0; t < tetelEls.length; t++) {
        var te  = tetelEls[t];
        var vc  = navTextOf(navFindFirst(te, 'VC'));
        var afaMertek = opgLookupVatRate(apnFromFile, vc, pjnCache);
        var tetel = {
          tetelId:      opgTetelId(bizonylatId, t + 1),
          sorIndex:     t + 1,
          megnevezes:   navTextOf(navFindFirst(te, 'NA')),
          mennyiseg:    navTextOf(navFindFirst(te, 'QY')),
          mertekegyseg: navTextOf(navFindFirst(te, 'IU')),
          egysegar:     navTextOf(navFindFirst(te, 'UN')),
          brutto:       navTextOf(navFindFirst(te, 'SU')),
          afaKod:       vc,
          afaMertek:    afaMertek
        };
        tetelRows.push({ bizonylatId: bizonylatId, tetel: tetel });
        sumTetel++;
      }
    }
  }

  opgUpsertFejlec(bizonylatRows);
  opgUpsertTetelek(tetelRows);

  return { bizonylatok: sumBiz, tetelek: sumTetel, parseErrors: 0, noRows: false, practiceSkipped: sumPractice };
}

/**
 * A naplófájl XML-ből PJN (pénztárjelentés) rekordok alapján feltölti a
 * `pjnCache[ap][vc] = rate` lookup táblát. A PJN/NFN rekordok az aktuális
 * forgalmi gyűjtő → áfa% leképezést tartalmazzák a `VRA` blokkban.
 *
 * A séma kissé pénztárgép-függő. A leggyakoribb minta:
 *   <PJN><VRA><VR><VC>A01</VC><VP>0.05</VP></VR>...</VRA></PJN>
 * vagy `VPC` (vat percentage) néven. Mindkettőt megpróbáljuk olvasni.
 */
function opgBuildVatLookupFromXml(xml, pjnCache) {
  var doc, root;
  try {
    doc  = XmlService.parse(xml);
    root = doc.getRootElement();
  } catch (e) {
    return;
  }
  var apn = navTextOf(navFindFirst(root, 'APN'));
  if (!apn) return;
  pjnCache[apn] = pjnCache[apn] || {};

  var rows = navFindFirst(root, 'ROWS');
  if (!rows) return;
  var pjns = [].concat(navFindAll(rows, 'PJN'), navFindAll(rows, 'NFN'));
  for (var i = 0; i < pjns.length; i++) {
    var vra = navFindFirst(pjns[i], 'VRA');
    if (!vra) continue;
    var rates = vra.getChildren(); // VR/VR1/... — pénztárgép-függő
    for (var j = 0; j < rates.length; j++) {
      var rEl = rates[j];
      var vc  = navTextOf(navFindFirst(rEl, 'VC'));
      var vp  = navTextOf(navFindFirst(rEl, 'VP')) ||
                navTextOf(navFindFirst(rEl, 'VPC'));
      if (!vc || !vp) continue;
      var rate = parseFloat(String(vp).replace(',', '.'));
      if (isNaN(rate)) continue;
      // Ha %-os értékként jön (pl. 27 → 27%), normalizáljuk 0..1 közé
      if (rate > 1) rate = rate / 100;
      pjnCache[apn][vc] = rate;
    }
  }
}

function opgLookupVatRate(ap, vc, pjnCache) {
  if (!vc) return null;
  if (pjnCache && pjnCache[ap] && pjnCache[ap][vc] != null) return pjnCache[ap][vc];
  var prefix = String(vc).charAt(0).toUpperCase();
  if (OPG_DEFAULT_VAT_BY_PREFIX.hasOwnProperty(prefix)) return OPG_DEFAULT_VAT_BY_PREFIX[prefix];
  return null;
}

function opgIsBizonylatTag(tag) {
  // Bizonylatok, amiket a fejléc táblába veszünk
  // NYN: nyugta, NYT: gyak. nyugta
  // ESN: egysz. számla, EST: gyak. egysz. számla
  // SZN: sztornó nyugta, SZT: gyak. sztornó
  // VBN: visszáru nyugta, VBT: gyak. visszáru
  // NFN: napi forgalmi jelentés, PJN: pénztárjelentés
  return /^(NYN|NYT|ESN|EST|SZN|SZT|VBN|VBT|NFN|PJN)$/.test(tag);
}

function opgIsPracticeTag(tag) {
  return /^(NYT|EST|SZT|VBT)$/.test(tag);
}

function opgBizonylatTipusHu(tag) {
  var map = {
    'NYN': 'Nyugta',
    'NYT': 'Nyugta (gyakorló)',
    'ESN': 'Egyszerűsített számla',
    'EST': 'Egysz. számla (gyak.)',
    'SZN': 'Sztornó nyugta',
    'SZT': 'Sztornó (gyak.)',
    'VBN': 'Visszáru nyugta',
    'VBT': 'Visszáru (gyak.)',
    'NFN': 'Napi forgalmi jelentés',
    'PJN': 'Pénztárjelentés'
  };
  return map[tag] || tag;
}

/**
 * Fizetési mód normalizálás a DRC blokkból.
 *   FE1 = forint készpénz, FE2 = bankkártya, FEE = egészségpénztári,
 *   FEV = valutában (ismétlődő), FE3/FEN = egyéb (SZÉCHK, AJÁND, ERZSU, …)
 *
 * @param {XmlElement|null} drcEl
 * @returns {{primary: string, detail: string}}
 */
function opgNormalizePayments(drcEl) {
  if (!drcEl) return { primary: '', detail: '' };
  var parts = {};

  var fe1 = parseFloat(navTextOf(navFindFirst(drcEl, 'FE1')));
  if (!isNaN(fe1) && fe1 !== 0) parts['CASH'] = fe1;

  var fe2 = parseFloat(navTextOf(navFindFirst(drcEl, 'FE2')));
  if (!isNaN(fe2) && fe2 !== 0) parts['CARD'] = fe2;

  var fee = parseFloat(navTextOf(navFindFirst(drcEl, 'FEE')));
  if (!isNaN(fee) && fee !== 0) parts['HEALTH_FUND'] = fee;

  // FEV (valuta) — ismétlődő
  var fevList = navFindAll(drcEl, 'FEV');
  for (var i = 0; i < fevList.length; i++) {
    var cty = navTextOf(navFindFirst(fevList[i], 'CTY'));
    var cft = parseFloat(navTextOf(navFindFirst(fevList[i], 'CFT')));
    if (cty && !isNaN(cft) && cft !== 0) parts['FX_' + cty] = cft;
  }

  // FE3 (egyéb) — ismétlődő, FEN névvel és FES összeggel
  var fe3List = navFindAll(drcEl, 'FE3');
  for (var j = 0; j < fe3List.length; j++) {
    var fen = navTextOf(navFindFirst(fe3List[j], 'FEN'));
    var fes = parseFloat(navTextOf(navFindFirst(fe3List[j], 'FES')));
    if (fen && !isNaN(fes) && fes !== 0) parts[fen] = fes;
  }

  var keys = Object.keys(parts);
  if (keys.length === 0) return { primary: '', detail: '' };
  if (keys.length === 1) return { primary: opgPaymentLabelHu(keys[0]), detail: '' };

  // Több fizetési mód: a legmagasabb összegű lesz a "primary", a többi JSON-ban
  var maxKey = keys[0];
  for (var k = 1; k < keys.length; k++) if (parts[keys[k]] > parts[maxKey]) maxKey = keys[k];
  return { primary: opgPaymentLabelHu(maxKey), detail: JSON.stringify(parts) };
}

function opgPaymentLabelHu(key) {
  var map = {
    'CASH':        'Készpénz',
    'CARD':        'Bankkártya',
    'HEALTH_FUND': 'Egészségpénztár'
  };
  if (map[key]) return map[key];
  if (/^FX_/.test(key)) return 'Valuta (' + key.replace(/^FX_/, '') + ')';
  return key; // pl. SZÉCHK, AJÁND, ERZSU, KUPON
}

// ============================================================
// IDEMPOTENCIA — Bizonylat / Tétel ID
// ============================================================

function opgBizonylatId(ap, lfn, rsr) {
  return opgSha1Hex(ap + '|' + lfn + '|' + rsr).substring(0, 12);
}

function opgTetelId(bizonylatId, sorIndex) {
  return opgSha1Hex(bizonylatId + '|' + sorIndex).substring(0, 12);
}

function opgSha1Hex(str) {
  var bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_1, str, Utilities.Charset.UTF_8);
  var s = '';
  for (var i = 0; i < bytes.length; i++) {
    var h = (bytes[i] & 0xff).toString(16);
    s += h.length === 1 ? '0' + h : h;
  }
  return s;
}

// ============================================================
// STATE TRACKER — PropertiesService alapú
// ============================================================

function opgLoadState() {
  var p = PropertiesService.getDocumentProperties();
  var raw = p.getProperty(OPG_STATE_PROP_KEY);
  if (!raw) return {};
  try {
    return JSON.parse(raw) || {};
  } catch (e) {
    Logger.log('[opgLoadState] sérült state property, üres state-tel indulunk: ' + e.message);
    return {};
  }
}

function opgSaveState(state) {
  var p = PropertiesService.getDocumentProperties();
  p.setProperty(OPG_STATE_PROP_KEY, JSON.stringify(state));
}

function opgClearState() {
  var p = PropertiesService.getDocumentProperties();
  p.deleteProperty(OPG_STATE_PROP_KEY);
}

// ============================================================
// SHEET ÍRÓK
// ============================================================

function opgEnsureSheets() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var pairs = [
    { name: OPG_SHEET_FEJLEC, headers: Object.keys(OPG_FEJLEC_MEZO_ERTEKEK) },
    { name: OPG_SHEET_TETEL,  headers: Object.keys(OPG_TETEL_MEZO_ERTEKEK)  }
  ];
  for (var i = 0; i < pairs.length; i++) {
    var sh = ss.getSheetByName(pairs[i].name);
    if (sh) continue;
    if (!OPG_AUTO_CREATE_SHEETS) {
      throw new Error('A "' + pairs[i].name + '" munkalap nem létezik, és az automatikus létrehozás ki van kapcsolva (OPG_AUTO_CREATE_SHEETS=false).');
    }
    sh = ss.insertSheet(pairs[i].name);
    sh.getRange(1, 1, 1, pairs[i].headers.length).setValues([pairs[i].headers]);
    sh.getRange(1, 1, 1, pairs[i].headers.length)
      .setFontWeight('bold')
      .setBackground('#cfe2f3');
    sh.setFrozenRows(1);
    Logger.log('[opgEnsureSheets] Létrehozva: ' + pairs[i].name);
  }
}

function opgUpsertFejlec(records) {
  if (!records || records.length === 0) return 0;
  var sh    = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(OPG_SHEET_FEJLEC);
  var hMap  = dpGetHeaderMap(sh);
  var idCol = hMap['Bizonylat ID'];
  if (!idCol) throw new Error('"Bizonylat ID" oszlop hiányzik a "' + OPG_SHEET_FEJLEC + '" lapról');

  var totalCols = sh.getLastColumn() || Object.keys(OPG_FEJLEC_MEZO_ERTEKEK).length;
  var existing  = dpGetExistingKeys(sh, idCol);

  var newRows = [];
  for (var i = 0; i < records.length; i++) {
    var rec = records[i];
    if (existing[rec.bizonylatId]) continue;
    var row = dpBuildRow(hMap, totalCols, OPG_FEJLEC_MEZO_ERTEKEK, [rec]);
    newRows.push(row);
    existing[rec.bizonylatId] = true;
  }
  if (newRows.length > 0) {
    sh.getRange(sh.getLastRow() + 1, 1, newRows.length, totalCols).setValues(newRows);
  }
  return newRows.length;
}

function opgUpsertTetelek(rows) {
  if (!rows || rows.length === 0) return 0;
  var sh    = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(OPG_SHEET_TETEL);
  var hMap  = dpGetHeaderMap(sh);
  var idCol = hMap['Tétel ID'];
  if (!idCol) throw new Error('"Tétel ID" oszlop hiányzik a "' + OPG_SHEET_TETEL + '" lapról');

  var totalCols = sh.getLastColumn() || Object.keys(OPG_TETEL_MEZO_ERTEKEK).length;
  var existing  = dpGetExistingKeys(sh, idCol);

  var newRows = [];
  for (var i = 0; i < rows.length; i++) {
    var bid = rows[i].bizonylatId;
    var t   = rows[i].tetel;
    if (existing[t.tetelId]) continue;
    var row = dpBuildRow(hMap, totalCols, OPG_TETEL_MEZO_ERTEKEK, [bid, t]);
    newRows.push(row);
    existing[t.tetelId] = true;
  }
  if (newRows.length > 0) {
    sh.getRange(sh.getLastRow() + 1, 1, newRows.length, totalCols).setValues(newRows);
  }
  return newRows.length;
}

// ============================================================
// ÉRTÉK-KONVERZIÓK
// ============================================================

function opgNum(x) {
  if (x == null || x === '') return '';
  var n = parseFloat(String(x).replace(',', '.'));
  return isNaN(n) ? '' : n;
}

// ============================================================
// ADATTÖRLÉS
// ============================================================

/**
 * OPG sheetek tartalmának törlése a fejlécek megtartásával + state törlés.
 */
function opgClearAllData() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  [OPG_SHEET_FEJLEC, OPG_SHEET_TETEL].forEach(function(name) {
    var sh = ss.getSheetByName(name);
    if (sh && sh.getLastRow() > 1) {
      sh.getRange(2, 1, sh.getLastRow() - 1, sh.getMaxColumns()).clearContent();
    }
  });
  opgClearState();
}
