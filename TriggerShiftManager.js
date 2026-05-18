/**
 * A MŰSZAKVÁLTÓ (SHIFT MANAGER) KERETRENDSZER
 * 
 * =========================================================================
 * MŰKÖDÉSI ELV ÉS ARCHITEKTÚRA:
 * 1. Telepítés: Az INSTALL_FRAMEWORK() futtatásakor a rendszer beállítja a
 *    munkaidő határait (OO:PP formátumban) és regisztrálja a feladatokat.
 * 2. Főidőzítők: Létrehoz két állandó napi triggert a megadott munkaidő
 *    kezdetére (pl. 08:30 -> startDayShift) és végére (pl. 18:00 -> startNightShift).
 * 3. Műszakváltás (KÉTFÁZISÚ): Amikor egy műszak elindul (reggel vagy este):
 *    - A rendszer teljesen letörli a korábbi műszak ismétlődő feladat-triggereit.
 *    - 1. FÁZIS: az adott műszak MINDEN aktív feladatára létrehoz egy egyszeri
 *      háttértriggert TRIGGER_AFTER_BUFFER_MS (20 mp) késleltetéssel — ez a Google
 *      ütemező biztonsági puffere, hogy a trigger ne kerüljön azonnal „Letiltva"
 *      státuszba a túl közeli futási idő miatt.
 *    - 2. FÁZIS: EGYETLEN várakozás TRIGGER_RECURRING_DELAY_MS (puffer + 10 mp =
 *      30 mp) — amíg az egyszeri triggerek lefutnak. Független a taskok számától.
 *    - 3. FÁZIS: az adott műszak MINDEN aktív feladatára létrehoz egy rendszeres
 *      ismétlődő triggert (pl. 15 percenként).
 * 
 * =========================================================================
 * PROPERTIES SERVICE ADATTÁROLÁS (SHIFT_CONFIG_JSON):
 * A rendszer a beállításokat a PropertiesService.getScriptProperties() tárolóban
 * menti el JSON-osított Stringként a 'SHIFT_CONFIG_JSON' kulcs alatt.
 * 
 * A mentett JSON objektum pontos felépítése (Példa):
 * {
 *   "workHours": {
 *     "start": "08:30",  // Nappali műszak kezdete (String "OO:PP")
 *     "end": "18:00"     // Éjszakai műszak kezdete / Nappali vége (String "OO:PP")
 *   },
 *   "tasks": {
 *     "syncOrders": {
 *       "work_time": "every15minutes",  // Nappali ütemezés
 *       "off_work": "atHour(18)"        // Éjszakai ütemezés (Dinamikus napi trigger este 6-kor)
 *     },
 *     "cleanUpLogs": {
 *       "work_time": "every1hour",      // Nappali ütemezés
 *       "off_work": "none"              // Éjszaka teljesen ki van kapcsolva
 *     }
 *   }
 * }
 * =========================================================================
 */

// ============================================================
// AUTOMATIZÁLÁS — Shift manager keretrendszer + auto-trigger időzítések
// ============================================================

// Properties Service kulcs a műszak/trigger config JSON tárolásához.
var CONFIG_KEY                    = 'SHIFT_CONFIG_JSON';

// Biztonsági puffer az egyszeri (.after) háttértriggereknek. A Google ütemező a
// regisztráció pillanatában már elévültnek/letiltottnak nyilvánítja azokat a
// one-shot triggereket, amelyek futási ideje túl közel van a jelenhez
// (<10-15 mp). 20 mp pufferrel ez biztosan nem fordul elő.
var TRIGGER_AFTER_BUFFER_MS       = 20000;

// Az ismétlődő trigger regisztrálását megvárjuk, amíg az egyszeri háttértrigger
// le is futott (+10 mp ráhagyás), így nem kerülnek versenyhelyzetbe.
var TRIGGER_RECURRING_DELAY_MS    = TRIGGER_AFTER_BUFFER_MS + 10000;

// Hány nappal az END_DATE után álljon le minden auto-trigger.
var TRIGGER_CUTOFF_DAYS_AFTER_END = 30;

// Az automatikusan időzíthető trigger-végpontok regisztere (4 függvény) — a
// NavConnectionDialog automation-view innen építi fel a task-blokkokat.
var AUTOMATION_TASKS = [
  { fn: 'osaAutoSync',         label: 'Bejövő számlák szinkronja' },
  { fn: 'osaAutoSyncOutbound', label: 'Kimenő számlák szinkronja' },
  { fn: 'eVatVamAutoSync',     label: 'eÁFA vámhatározatok szinkronja' },
  { fn: 'opgAutoSync',         label: 'OPG nyugták szinkronja' }
];

// Fix, előre definiált natív Google Trigger gyakoriságok — a getTriggerDefinition()
// szótára. A NavConnectionDialog dropdown listái ennek egy szűkebb halmazát kínálják.
var NATIVE_INTERVALS = {
  'none':           { type: 'none' },
  'every1minute':   { type: 'minutes', val: 1 },
  'every5minutes':  { type: 'minutes', val: 5 },
  'every10minutes': { type: 'minutes', val: 10 },
  'every15minutes': { type: 'minutes', val: 15 },
  'every30minutes': { type: 'minutes', val: 30 },
  'every1hour':     { type: 'hours',   val: 1 },
  'every2hours':    { type: 'hours',   val: 2 },
  'every4hours':    { type: 'hours',   val: 4 },
  'every8hours':    { type: 'hours',   val: 8 },
  'every12hours':   { type: 'hours',   val: 12 },
  'daily':          { type: 'days',    val: 1 }
};

/**
 * Dinamikus időzítő-értelmező.
 * Támogatja a fix értékeket és a dinamikus 'atHour(18)' jellegű kifejezéseket is.
 */
function getTriggerDefinition(intervalString) {
  // 1. Megnézzük a fix listában
  if (NATIVE_INTERVALS[intervalString]) {
    return NATIVE_INTERVALS[intervalString];
  }
  
  // 2. Dinamikus 'atHour(X)' minta felismerése reguláris kifejezéssel
  const atHourMatch = intervalString.match(/^atHour\((\d+)\)$/);
  if (atHourMatch) {
    const hour = parseInt(atHourMatch[1], 10);
    if (hour >= 0 && hour <= 23) {
      return { type: 'days', val: 1, atHour: hour };
    }
  }
  
  throw new Error(`Érvénytelen időzítő kifejezés: ${intervalString}`);
}

/**
 * Segédfüggvény az "OO:PP" formátumú időpontok szétbontásához.
 */
function parseTimeStr(timeStr) {
  const parts = timeStr.split(':');
  const hour = parseInt(parts[0], 10);
  const minute = parts.length > 1 ? parseInt(parts[1], 10) : 0;
  return { hour, minute };
}

/**
 * Betölti a beállításokat a PropertiesService-ből.
 */
function getConfig() {
  const props = PropertiesService.getScriptProperties();
  const rawData = props.getProperty(CONFIG_KEY);
  if (rawData) return JSON.parse(rawData);
  
  const defaultConfig = {
    workHours: { start: "08:00", end: "18:00" }, // Alapértelmezett OO:PP formátum
    tasks: {}
  };
  saveConfig(defaultConfig);
  return defaultConfig;
}

function saveConfig(configObj) {
  PropertiesService.getScriptProperties().setProperty(CONFIG_KEY, JSON.stringify(configObj));
}

/**
 * Regisztrál egy feladatot és annak időzítését.
 */
function registerTask(functionName, intervalString, period) {
  // Ellenőrizzük, hogy érvényes-e az időzítő struktúra
  getTriggerDefinition(intervalString);
  
  const config = getConfig();
  if (!config.tasks[functionName]) {
    config.tasks[functionName] = { work_time: 'none', off_work: 'none' };
  }
  
  config.tasks[functionName][period] = intervalString;
  saveConfig(config);
  Logger.log(`✓ Feladat frissítve: ${functionName} [${period} -> ${intervalString}]`);
}

/**
 * Beállítja a munkaidő kezdetét és végét "OO:PP" formátumban (pl. "08:30", "18:00").
 */
function setWorkHours(startStr, endStr) {
  // Egyszerű formátum ellenőrzés
  const timeRegex = /^[0-2]?\d:[0-5]\d$/;
  if (!timeRegex.test(startStr) || !timeRegex.test(endStr)) {
    throw new Error("Hiba: A munkaidőt 'OO:PP' formátumban kell megadni! (pl. '08:30')");
  }
  
  const config = getConfig();
  config.workHours.start = startStr;
  config.workHours.end = endStr;
  saveConfig(config);
  Logger.log(`✓ Munkaidő beállítva: ${startStr} - ${endStr}`);
}

/**
 * ELTÁVOLÍTJA a feladatokhoz tartozó összes korábbi triggert.
 */
function clearTaskTriggers() {
  const config = getConfig();
  const taskNames = Object.keys(config.tasks);
  const triggers = ScriptApp.getProjectTriggers();
  let deletedCount = 0;
  
  for (let i = 0; i < triggers.length; i++) {
    const handlerName = triggers[i].getHandlerFunction();
    if (taskNames.includes(handlerName)) {
      ScriptApp.deleteTrigger(triggers[i]);
      deletedCount++;
    }
  }
  Logger.log(`Törölve ${deletedCount} db korábbi feladat-trigger.`);
}

// TRIGGER_AFTER_BUFFER_MS és TRIGGER_RECURRING_DELAY_MS konstansok a Config.js-ben.

/**
 * Létrehozza egy adott műszakhoz tartozó triggereket — KÉTFÁZISÚ FELÉPÍTÉSSEL:
 *   1. fázis: az adott műszakhoz tartozó MINDEN feladatra létrejön az egyszeri
 *             .after(TRIGGER_AFTER_BUFFER_MS) háttértrigger (~20 mp múlva indul).
 *   2. fázis: EGYETLEN sleep TRIGGER_RECURRING_DELAY_MS-ig (~30 mp), megvárjuk
 *             míg az egyszeri háttértriggerek lefutottak.
 *   3. fázis: az adott műszakhoz tartozó MINDEN feladatra létrejön az ismétlődő
 *             trigger.
 * Így a teljes idő ~30 mp (független a feladatok számától) szemben a régi
 * 30s * N módszerrel.
 */
function buildTriggersForPeriod(period) {
  clearTaskTriggers(); // Először nagytakarítás
  const config = getConfig();

  // Gyűjtsd össze az aktív feladatokat (type !== 'none')
  const activeTasks = [];
  for (const funcName in config.tasks) {
    const intervalStr = config.tasks[funcName][period];
    let triggerDef;
    try {
      triggerDef = getTriggerDefinition(intervalStr);
    } catch (e) {
      Logger.log(`  ❌ Hibás időzítő def. (${funcName}): ${e.message}`);
      continue;
    }
    if (triggerDef.type === 'none') continue;
    activeTasks.push({ funcName, intervalStr, triggerDef });
  }

  if (activeTasks.length === 0) {
    Logger.log(`Nincs aktív feladat a '${period}' műszakban.`);
    return;
  }

  // 1. fázis: minden taskra egyszeri háttértrigger
  let oneShotCount = 0;
  for (const t of activeTasks) {
    try {
      ScriptApp.newTrigger(t.funcName).timeBased().after(TRIGGER_AFTER_BUFFER_MS).create();
      oneShotCount++;
      Logger.log(`  + Egyszeri trigger (T+${TRIGGER_AFTER_BUFFER_MS / 1000}s): ${t.funcName}()`);
    } catch (e) {
      Logger.log(`  ❌ One-shot trigger hiba (${t.funcName}): ${e.message}`);
    }
  }

  // 2. fázis: egyetlen várakozás, amíg az egyszeri triggerek lefutnak
  Logger.log(`  ⏳ Várakozás ${TRIGGER_RECURRING_DELAY_MS / 1000}s — ${oneShotCount} db egyszeri trigger lefutását...`);
  Utilities.sleep(TRIGGER_RECURRING_DELAY_MS);

  // 3. fázis: minden taskra ismétlődő trigger
  let recurringCount = 0;
  for (const t of activeTasks) {
    try {
      const builder = ScriptApp.newTrigger(t.funcName).timeBased();
      if (t.triggerDef.type === 'minutes') {
        builder.everyMinutes(t.triggerDef.val);
      } else if (t.triggerDef.type === 'hours') {
        builder.everyHours(t.triggerDef.val);
      } else if (t.triggerDef.type === 'days') {
        builder.everyDays(t.triggerDef.val);
        if (t.triggerDef.atHour !== undefined) {
          builder.atHour(t.triggerDef.atHour);
        }
      }
      builder.create();
      recurringCount++;
      Logger.log(`  + Rendszeres trigger: ${t.funcName}() -> ${t.intervalStr}`);
    } catch (e) {
      Logger.log(`  ❌ Ismétlődő trigger hiba (${t.funcName}): ${e.message}`);
    }
  }

  Logger.log(`Összesen ${recurringCount}/${activeTasks.length} db feladat aktív a '${period}' műszakban.`);
}

/**
 * REGGELI MŰSZAK
 */
function startDayShift() {
  Logger.log('=== NAPPALI MŰSZAK INDÍTÁSA ===');
  buildTriggersForPeriod('work_time');
}

/**
 * ÉJSZAKAI MŰSZAK
 */
function startNightShift() {
  Logger.log('=== ÉJSZAKAI MŰSZAK INDÍTÁSA ===');
  buildTriggersForPeriod('off_work');
}

/**
 * A KERETRENDSZER TELEPÍTÉSE (a már elmentett config alapján).
 *
 * Feltételezi, hogy a workHours és a tasks korábban már be lettek állítva
 * a setWorkHours() és registerTask() hívásokkal. Csak a triggereket építi fel
 * (műszakváltók + azonnali aktuális műszak indítás).
 */
function installShiftFrameworkFromConfig() {
  // 1. Összes korábbi projekt trigger törlése (Full Reset)
  const allTriggers = ScriptApp.getProjectTriggers();
  allTriggers.forEach(t => ScriptApp.deleteTrigger(t));

  const config = getConfig();
  const start = parseTimeStr(config.workHours.start);
  const end = parseTimeStr(config.workHours.end);

  // 2. Létrehozzuk a két fő Műszakváltó triggert percre pontosan
  ScriptApp.newTrigger('startDayShift')
    .timeBased()
    .atHour(start.hour)
    .nearMinute(start.minute)
    .everyDays(1)
    .create();

  ScriptApp.newTrigger('startNightShift')
    .timeBased()
    .atHour(end.hour)
    .nearMinute(end.minute)
    .everyDays(1)
    .create();

  Logger.log('✓ Műszakváltó triggerek létrehozva (' +
             config.workHours.start + ' / ' + config.workHours.end + ').');

  // 3. Megnézzük, most épp milyen műszak van, és azonnal aktiváljuk azt
  const now = new Date();
  const currentMinutes = now.getHours() * 60 + now.getMinutes();
  const startMinutes = start.hour * 60 + start.minute;
  const endMinutes = end.hour * 60 + end.minute;

  if (currentMinutes >= startMinutes && currentMinutes < endMinutes) {
    startDayShift();
  } else {
    startNightShift();
  }
}

/**
 * Régi minta-telepítő (példa konfig + installShiftFrameworkFromConfig).
 * Csak demó/teszt céllal — éles használatra a dialog-os automatizálás-beállítót használjuk.
 */
function INSTALL_FRAMEWORK() {
  setWorkHours("08:30", "18:00");
  registerTask('syncOrders', 'every15minutes', 'work_time');
  registerTask('syncOrders', 'atHour(18)', 'off_work');
  registerTask('cleanUpLogs', 'every1hour', 'work_time');
  registerTask('cleanUpLogs', 'none', 'off_work');
  installShiftFrameworkFromConfig();
}

// ------ TESZT FÜGGVÉNYEK ------
function syncOrders() { Logger.log('syncOrders lefutott!'); }
function cleanUpLogs() { Logger.log('cleanUpLogs lefutott!'); }