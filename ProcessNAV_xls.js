/**
 * Beolvassa a megadott ("Fejléc adatok", "Tétel adatok") munkalapokat egy forrás Google Drive mappában
 * található összes .xlsx fájlból, és a második sortól kezdve minden sort átmásol.
 * A feldolgozás előtt ellenőrzi, hogy a fájl neve szerepel-e a "feldolgozott" munkalapon. Ha igen, kihagyja.
 * A sikeres feldolgozás után a fájl nevét rögzíti a "feldolgozott" munkalapon.
 * Az adatokat a szkriptet tartalmazó táblázat megfelelő nevű munkalapjainak végéhez fűzi.
 * A beillesztés a cél munkalapon található "Számla sorszáma" oszloptól kezdődik.
 * A "Tétel adatok" munkalapra történő beillesztés után az 'A' oszlopba beszúr egy VLOOKUP formulát.
 * Az adatok betöltése után utófeldolgozást végez: duplikátumokat töröl, rendezi a sorokat, 
 * számításokat hajt végre és kategóriákat tölt ki.
 *
 * A szkript ideiglenesen minden .xlsx fájlt Google Táblázattá konvertál a feldolgozáshoz,
 * majd törli az ideiglenes másolatot.
 *
 * Szerző: AI Asszisztens
 * Dátum: 2025. június 28.
 * Módosítva: 2025. szeptember 5. (Duplikátumtörlő funkció hozzáadva)
*/


/**
 * Törli az összes adatot a "Fejléc adatok" és "Tétel adatok" munkalapokról (a fejléc kivételével),
 * valamint a "feldolgozott" munkalap teljes tartalmát.
 */
function clearAllData() {
    const ui = SpreadsheetApp.getUi();
    const response = ui.alert(
        'Figyelem!',
        'Biztosan törölni szeretné a "Fejléc adatok" és "Tétel adatok" munkalapok tartalmát, valamint a feldolgozott fájlok listáját? Ez a művelet nem vonható vissza.',
        ui.ButtonSet.YES_NO
    );

    if (response == ui.Button.YES) {
        try {
            const ss = SpreadsheetApp.getActiveSpreadsheet();
            const sheetNamesToClearHeaders = ["Fejléc adatok", "Tétel adatok"];
            const processedSheetName = "feldolgozott";

            // Adatlapok törlése a fejléc megtartásával
            for (const sheetName of sheetNamesToClearHeaders) {
                const sheet = ss.getSheetByName(sheetName);
                if (sheet && sheet.getLastRow() > 1) {
                    sheet.getRange(2, 1, sheet.getLastRow() - 1, sheet.getMaxColumns()).clearContent();
                }
            }

            // Feldolgozott lista teljes törlése
            const processedSheet = ss.getSheetByName(processedSheetName);
            if (processedSheet) {
                processedSheet.clearContents();
            }

            ui.alert('Az adatok és a feldolgozási állapot törlése sikeresen befejeződött.');
        } catch (e) {
            Logger.log(`Hiba az adatok törlése közben: ${e.message}`);
            ui.alert(`Hiba történt az adatok törlése közben: ${e.message}`);
        }
    }
}

/**
 * Wrapper function to run category update from the menu and show a final alert.
 */
function runCategoryUpdateFromMenu() {
    const ui = SpreadsheetApp.getUi();
    try {
        ui.alert('Költségtípusok frissítése elindult. A művelet a sorok számától függően időbe telhet.');
        const count = updateCostCategories();
        ui.alert(`A kategóriák frissítése befejeződött. Összesen ${count} sor került frissítésre vagy kitöltésre.`);
    } catch (e) {
        Logger.log(`Hiba a kategóriák frissítése közben (menüből futtatva): ${e.message}`);
        ui.alert(`Hiba történt a kategóriák frissítése közben: ${e.message}`);
    }
}

/**
 * Updates the cost category fields in the "Tétel adatok" sheet based on rules in the "kategóriák" sheet.
 * @returns {number} The number of rows where categories were filled.
*/
function updateCostCategories() {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    let categoriesFilledCount = 0;

    // Kategóriák beolvasása a memóriába
    const kategoriakSheet = ss.getSheetByName("kategóriák");
    let kategoriakMap = [];
    if (kategoriakSheet && kategoriakSheet.getLastRow() > 1) {
        kategoriakMap = kategoriakSheet.getRange(2, 1, kategoriakSheet.getLastRow() - 1, 4).getValues();
    } else {
        Logger.log("Figyelmeztetés: 'kategóriák' munkalap nem található vagy üres. A költségtípusok kitöltése kimarad.");
        return 0; // Kilépés, ha nincsenek szabályok
    }

    const tetelSheet = ss.getSheetByName("Tétel adatok");
    if (!tetelSheet || tetelSheet.getLastRow() < 2) {
        Logger.log("A 'Tétel adatok' munkalap nem található vagy üres. Nincs mit frissíteni.");
        return 0;
    }

    const tetelHeaders = tetelSheet.getRange(1, 1, 1, tetelSheet.getLastColumn()).getValues()[0];
    const eladoNeveCol = tetelHeaders.indexOf("Eladó neve") + 1;
    const koltsegTipCol = tetelHeaders.indexOf("Költség típ.") + 1;
    const koltsegAlTipCol = tetelHeaders.indexOf("Költség al. típ.") + 1;
    const megnevezesCol = tetelHeaders.indexOf("Megnevezés") + 1;

    if (koltsegTipCol === 0 || koltsegAlTipCol === 0 || eladoNeveCol === 0 || megnevezesCol === 0) {
        throw new Error("A 'Tétel adatok' munkalapon hiányzik a szükséges oszlopok (Eladó neve, Megnevezés, Költség típ., Költség al. típ.) egyike.");
    }

    const dataRange = tetelSheet.getRange(2, 1, tetelSheet.getLastRow() - 1, tetelSheet.getMaxColumns());
    const values = dataRange.getValues();

    for (let i = 0; i < values.length; i++) {
        const currentKoltsegTip = values[i][koltsegTipCol - 1];
        if ((!currentKoltsegTip || currentKoltsegTip.toString().trim() === '') && kategoriakMap.length > 0) {
            const eladoNeve = (values[i][eladoNeveCol - 1] || '').toString().toLowerCase();
            const megnevezes = (values[i][megnevezesCol - 1] || '').toString().toLowerCase();
            let categoryAssigned = false;

            // 1. Első kör: Próbálkozás "Eladó neve" alapján
            for (const categoryRow of kategoriakMap) {
                const kategoriaSzallito = (categoryRow[0] || '').toString().toLowerCase().trim();
                const ujKoltsegTip = categoryRow[2];
                const ujKoltsegAlTip = categoryRow[3];

                if (kategoriaSzallito && eladoNeve.includes(kategoriaSzallito)) {
                    values[i][koltsegTipCol - 1] = ujKoltsegTip;
                    values[i][koltsegAlTipCol - 1] = ujKoltsegAlTip;
                    categoriesFilledCount++;
                    categoryAssigned = true;
                    break;
                }
            }

            // 2. Második kör: Ha nem volt találat, próbálkozás "Megnevezés" alapján
            if (!categoryAssigned) {
                for (const categoryRow of kategoriakMap) {
                    const kategoriaMegnevezes = (categoryRow[1] || '').toString().toLowerCase().trim();
                    const ujKoltsegTip = categoryRow[2];
                    const ujKoltsegAlTip = categoryRow[3];

                    if (kategoriaMegnevezes && megnevezes.includes(kategoriaMegnevezes)) {
                        values[i][koltsegTipCol - 1] = ujKoltsegTip;
                        values[i][koltsegAlTipCol - 1] = ujKoltsegAlTip;
                        categoriesFilledCount++;
                        break;
                    }
                }
            }
        }
    }

    if (categoriesFilledCount > 0) {
        dataRange.setValues(values);
        Logger.log(`${categoriesFilledCount} kategória kitöltve a "Tétel adatok" munkalapon.`);
    } else {
        Logger.log('Nem történt kategória frissítés, minden ki volt töltve.');
    }

    return categoriesFilledCount;
}

/**
 * Az adatok betöltése után lefutó funkció, amely elvégzi a duplikátumtörlést, rendezéseket, számításokat és kategorizálást.
 * @returns {object} Egy objektum, amely tartalmazza a kicserélt "n/a", a kitöltött kategóriák és a törölt duplikátumok számát.
*/
function postProcessSheets() {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    let naReplacedCount = 0;
    let categoriesFilledCount = 0;
    let fejlecDuplicatesFound = 0; // <-- ÚJ
    let tetelDuplicatesFound = 0; // <-- ÚJ

    try {
        Logger.log("--- Utófeldolgozás megkezdése ---");

        // --- "Fejléc adatok" feldolgozása ---
        const fejlecSheet = ss.getSheetByName("Fejléc adatok");
        if (fejlecSheet && fejlecSheet.getLastRow() > 1) {
            const fejlecHeaders = fejlecSheet.getRange(1, 1, 1, fejlecSheet.getLastColumn()).getValues()[0];
            const szamlaSorszamaCol = fejlecHeaders.indexOf("Számla sorszáma") + 1; // <-- DUPLIKÁTUMHOZ
            const szamlaKelteCol = fejlecHeaders.indexOf("Számla kelte") + 1;
            const nettoCol = fejlecHeaders.indexOf("Számla nettó (forintban)") + 1; // AD
            const bruttoCol = fejlecHeaders.indexOf("Számla bruttó (forintban)") + 1; // AH
            const afaCol = fejlecHeaders.indexOf("Számla ÁFA összege (forintban)") + 1;

            if (szamlaSorszamaCol > 0 && szamlaKelteCol > 0 && nettoCol > 0 && bruttoCol > 0 && afaCol > 0) {
                const dataRange = fejlecSheet.getRange(2, 1, fejlecSheet.getLastRow() - 1, fejlecSheet.getMaxColumns());
                let values = dataRange.getValues();
                Logger.log(`"Fejléc adatok" eredeti sorszám: ${values.length}`);

                // === DUPLIKÁTUM SZŰRÉS (FEJLÉC) ===
                const uniqueKeysFejlec = new Set();
                const uniqueValuesFejlec = [];
                for (const row of values) {
                    const key = row[szamlaSorszamaCol - 1];
                    if (key && key.toString().trim() !== '' && !uniqueKeysFejlec.has(key)) {
                        uniqueKeysFejlec.add(key);
                        uniqueValuesFejlec.push(row);
                    } else {
                        fejlecDuplicatesFound++;
                    }
                }
                values = uniqueValuesFejlec; // 'values' felülírása a szűrt listával
                Logger.log(`"Fejléc adatok" duplikátumok törlése utáni sorszám: ${values.length}. Talált duplikátum: ${fejlecDuplicatesFound}`);
                // === DUPLIKÁTUM SZŰRÉS VÉGE ===

                // Tiszta lap a szűrt adatoknak
                fejlecSheet.getRange(2, 1, fejlecSheet.getLastRow(), fejlecSheet.getMaxColumns()).clearContent();

                if (values.length > 0) {
                    for (let i = 0; i < values.length; i++) {
                        // --- 1. Netto/Brutto 'n/a' csere ---
                        const nettoValueRaw = values[i][nettoCol - 1];
                        const bruttoValueRaw = values[i][bruttoCol - 1];

                        if (nettoValueRaw === 'n/a') {
                            const bruttoValue = parseFloat(bruttoValueRaw);
                            if (!isNaN(bruttoValue)) {
                                values[i][nettoCol - 1] = bruttoValue / 1.27; // Frissítés
                                naReplacedCount++;
                            }
                        } else if (bruttoValueRaw === 'n/a') {
                            const nettoValue = parseFloat(nettoValueRaw);
                            if (!isNaN(nettoValue)) {
                                values[i][bruttoCol - 1] = nettoValue * 1.27; // Frissítés
                                naReplacedCount++;
                            }
                        }

                        // --- 2. KIEGÉSZÍTÉS: ÁFA 'n/a' csere ---
                        const afaValueRaw = values[i][afaCol - 1];
                        if (afaValueRaw === 'n/a') {
                            const finalNetto = parseFloat(values[i][nettoCol - 1]);
                            const finalBrutto = parseFloat(values[i][bruttoCol - 1]);

                            if (!isNaN(finalNetto) && !isNaN(finalBrutto)) {
                                values[i][afaCol - 1] = finalBrutto - finalNetto; // Különbség beállítása
                                naReplacedCount++;
                            }
                        }
                    }

                    // Szűrt és 'n/a' mentesített adatok visszaírása
                    const newFejlecRange = fejlecSheet.getRange(2, 1, values.length, values[0].length);
                    newFejlecRange.setValues(values);
                    Logger.log(`"Fejléc adatok" munkalapon 'n/a' értékek cserélve (Nettó, Bruttó, ÁFA).`);

                    newFejlecRange.sort({
                        column: szamlaKelteCol,
                        ascending: true
                    });
                    Logger.log(`"Fejléc adatok" munkalap rendezve a "Számla kelte" oszlop szerint.`);
                } else {
                    Logger.log('"Fejléc adatok" munkalap üres a duplikátum szűrés után.');
                }
            } else {
                Logger.log(`Figyelmeztetés: A "Fejléc adatok" munkalapon nem található minden szükséges oszlop (Számla sorszáma, Számla kelte, Nettó, Bruttó, ÁFA) az utófeldolgozáshoz.`);
            }
        }

        // --- "Tétel adatok" feldolgozása ---
        const tetelSheet = ss.getSheetByName("Tétel adatok");
        if (tetelSheet && tetelSheet.getLastRow() > 1) {
            const tetelHeaders = tetelSheet.getRange(1, 1, 1, tetelSheet.getLastColumn()).getValues()[0];
            const tetelSzamlaSorszamaCol = tetelHeaders.indexOf("Számla sorszáma") + 1; // <-- DUPLIKÁTUMHOZ
            const sorszamCol = tetelHeaders.indexOf("Tétel sorszáma") + 1; // <-- DUPLIKÁTUMHOZ
            const kiallitasCol = tetelHeaders.indexOf("Kiállítás") + 1;
            const eladoNeveCol = tetelHeaders.indexOf("Eladó neve") + 1;
            const nettoCol = tetelHeaders.indexOf("Nettó összeg (forintban)") + 1;
            const bruttoCol = tetelHeaders.indexOf("Bruttó összeg (forintban)") + 1;

            if (tetelSzamlaSorszamaCol > 0 && sorszamCol > 0 && kiallitasCol > 0 && eladoNeveCol > 0 && nettoCol > 0 && bruttoCol > 0) {
                const dataRange = tetelSheet.getRange(2, 1, tetelSheet.getLastRow() - 1, tetelSheet.getMaxColumns());
                let values = dataRange.getValues();
                Logger.log(`"Tétel adatok" eredeti sorszám: ${values.length}`);

                // === DUPLIKÁTUM SZŰRÉS (TÉTEL) ===
                const uniqueKeysTetel = new Set();
                const uniqueValuesTetel = [];
                for (const row of values) {
                    const keySzamla = row[tetelSzamlaSorszamaCol - 1];
                    const keyTetel = row[sorszamCol - 1];
                    const combinedKey = `${keySzamla}___${keyTetel}`;
                    if (keySzamla && keyTetel && keySzamla.toString().trim() !== '' && keyTetel.toString().trim() !== '' && !uniqueKeysTetel.has(combinedKey)) {
                        uniqueKeysTetel.add(combinedKey);
                        uniqueValuesTetel.push(row);
                    } else {
                        tetelDuplicatesFound++;
                    }
                }
                values = uniqueValuesTetel; // 'values' felülírása a szűrt listával
                Logger.log(`"Tétel adatok" duplikátumok törlése utáni sorszám: ${values.length}. Talált duplikátum: ${tetelDuplicatesFound}`);
                // === DUPLIKÁTUM SZŰRÉS VÉGE ===

                // Tiszta lap a szűrt adatoknak
                tetelSheet.getRange(2, 1, tetelSheet.getLastRow(), tetelSheet.getMaxColumns()).clearContent();

                if (values.length > 0) {
                    for (let i = 0; i < values.length; i++) {
                        // "n/a" értékek cseréje
                        const nettoValueRaw = values[i][nettoCol - 1];
                        const bruttoValueRaw = values[i][bruttoCol - 1];
                        if (nettoValueRaw === 'n/a') {
                            const bruttoValue = parseFloat(bruttoValueRaw);
                            if (!isNaN(bruttoValue)) {
                                values[i][nettoCol - 1] = bruttoValue / 1.27;
                                naReplacedCount++;
                            }
                        } else if (bruttoValueRaw === 'n/a') {
                            const nettoValue = parseFloat(nettoValueRaw);
                            if (!isNaN(nettoValue)) {
                                values[i][bruttoCol - 1] = nettoValue * 1.27;
                                naReplacedCount++;
                            }
                        }
                    }

                    // Szűrt és 'n/a' mentesített adatok visszaírása
                    const newTetelRange = tetelSheet.getRange(2, 1, values.length, values[0].length);
                    newTetelRange.setValues(values);
                    Logger.log(`"Tétel adatok" munkalapon 'n/a' értékek cserélve.`);

                    // Költségtípusok frissítése a már visszaírt adatokon
                    categoriesFilledCount = updateCostCategories();

                    // Rendezés (az updateCostCategories *után*, de az új tartományon)
                    // Fontos: Ha a updateCostCategories több sort ad hozzá (ami most nem),
                    // akkor a 'newTetelRange' helyett újra kellene kérni a data range-t. 
                    // Jelenleg az updateCostCategories csak meglévő sorokat módosít, így ez biztonságos.
                    newTetelRange.sort([{
                        column: kiallitasCol,
                        ascending: true
                    }, {
                        column: eladoNeveCol,
                        ascending: true
                    }, {
                        column: sorszamCol,
                        ascending: true
                    }]);
                    Logger.log(`"Tétel adatok" munkalap rendezve "Kiállítás", "Eladó neve", "Tétel sorszáma" szerint.`);
                } else {
                    Logger.log('"Tétel adatok" munkalap üres a duplikátum szűrés után.');
                }
            } else {
                Logger.log(`Figyelmeztetés: A "Tétel adatok" munkalapon nem található minden szükséges oszlop (Számla sorszáma, Tétel sorszáma, stb.) az utófeldolgozáshoz.`);
            }
        }
        Logger.log("--- Utófeldolgozás befejezve ---");
        return {
            naCount: naReplacedCount,
            catCount: categoriesFilledCount,
            fejlecDupCount: fejlecDuplicatesFound,
            tetelDupCount: tetelDuplicatesFound
        };

    } catch (e) {
        Logger.log(`Hiba az utófeldolgozás során: ${e.message}`);
        SpreadsheetApp.getUi().alert(`Hiba történt az utófeldolgozás során: ${e.message}`);
        return {
            naCount: naReplacedCount,
            catCount: categoriesFilledCount,
            fejlecDupCount: fejlecDuplicatesFound,
            tetelDupCount: tetelDuplicatesFound
        };
    }
}


/**
 * Fő funkció, amely beolvassa az .xlsx fájlokat, hozzáfűzi az adatokat, majd elindítja az utófeldolgozást.
*/
function appendXLSXDataToGoogleSheet() {
    // --- KONFIGURÁCIÓ ---
    const sourceDriveFolderId = "1mRrXXxWiZ5Ev10oX0usrQkGTkLUO3615";
    const sheetsToReadFromXLSX = ["Fejléc adatok", "Tétel adatok"];
    const startRowToCopy = 2;
    const processedSheetName = "feldolgozott";

    // --- SZKRIPT LOGIKA ---
    let filesProcessedCount = 0;
    let totalRowsAppended = 0;
    const ui = SpreadsheetApp.getUi();

    try {
        const targetSpreadsheet = SpreadsheetApp.getActiveSpreadsheet();
        if (!targetSpreadsheet) {
            Logger.log('Hiba: A szkript nincs Google Táblázathoz csatolva.');
            return;
        }

        let processedSheet = targetSpreadsheet.getSheetByName(processedSheetName);
        if (!processedSheet) {
            processedSheet = targetSpreadsheet.insertSheet(processedSheetName);
            Logger.log(`A(z) "${processedSheetName}" munkalap létrehozva.`);
        }
        const processedFileNames = processedSheet.getDataRange().getValues().flat();

        const sourceFolder = DriveApp.getFolderById(sourceDriveFolderId);
        if (!sourceFolder) {
            Logger.log(`Hiba: A forrás Drive mappa "${sourceDriveFolderId}" azonosítóval nem található.`);
            return;
        }

        Logger.log(`Cél táblázat: "${targetSpreadsheet.getName()}"`);
        const xlsxFilesIterator = sourceFolder.getFilesByType(MimeType.MICROSOFT_EXCEL);

        // Iterátor konvertálása tömbbé a rendezéshez
        const xlsxFiles = [];
        while (xlsxFilesIterator.hasNext()) {
            xlsxFiles.push(xlsxFilesIterator.next());
        }

        // Fájlok rendezése név szerint növekvő (ABC) sorrendbe
        xlsxFiles.sort((a, b) => a.getName().localeCompare(b.getName()));

        if (xlsxFiles.length === 0) {
            Logger.log('Nincsenek .xlsx fájlok a forrás mappában.');
            ui.alert('Nem található .xlsx fájl a megadott mappában.');
            return;
        }
        Logger.log('Feldolgozás megkezdődik...');

        for (const xlsxFile of xlsxFiles) {
            const xlsxFileName = xlsxFile.getName();
            let tempGoogleSheetFile = null;

            if (processedFileNames.includes(xlsxFileName)) {
                Logger.log(`--- Kihagyva (már feldolgozva): "${xlsxFileName}" ---`);
                continue;
            }

            Logger.log(`--- Feldolgozás alatt: "${xlsxFileName}" ---`);

            try {
                tempGoogleSheetFile = Drive.Files.insert({
                    title: xlsxFileName + '_TEMP_CONVERTED',
                    mimeType: MimeType.GOOGLE_SHEETS
                },
                    xlsxFile.getBlob(), {
                    convert: true
                });
                Logger.log(`  - Ideiglenes fájl létrehozva: "${tempGoogleSheetFile.title}"`);

                const sourceSpreadsheet = SpreadsheetApp.openById(tempGoogleSheetFile.id);

                for (const sheetName of sheetsToReadFromXLSX) {
                    const sourceSheet = sourceSpreadsheet.getSheetByName(sheetName);
                    const destinationSheet = targetSpreadsheet.getSheetByName(sheetName);

                    if (!destinationSheet) {
                        Logger.log(`  - Hiba: A(z) "${sheetName}" cél munkalap nem található.`);
                        continue;
                    }

                    if (sourceSheet) {
                        const lastRow = sourceSheet.getLastRow();
                        if (lastRow >= startRowToCopy) {
                            const valuesToCopy = sourceSheet.getRange(startRowToCopy, 1, lastRow - startRowToCopy + 1, sourceSheet.getLastColumn()).getValues();

                            if (valuesToCopy.length > 0) {
                                const targetRow = destinationSheet.getLastRow() + 1;

                                // A cél munkalap fejlécéből megkeressük a "Számla sorszáma" oszlopot, hogy onnan kezdjük a beillesztést.
                                const destHeaders = destinationSheet.getRange(1, 1, 1, destinationSheet.getLastColumn()).getValues()[0];
                                let startCol = destHeaders.indexOf("Számla sorszáma") + 1;

                                if (startCol === 0) { // Tartalék eset, ha nem található a fejléc
                                    startCol = 1;
                                    Logger.log(`  - Figyelmeztetés: A(z) "${sheetName}" cél munkalapon nem található "Számla sorszáma" fejléc. Beillesztés az 'A' oszloptól.`);
                                }

                                // Adatok beillesztése a megtalált oszloptól kezdve.
                                destinationSheet.getRange(targetRow, startCol, valuesToCopy.length, valuesToCopy[0].length).setValues(valuesToCopy);
                                Logger.log(`    ${valuesToCopy.length} sor hozzáfűzve a(z) "${sheetName}" munkalaphoz, a(z) ${startCol}. oszloptól.`);

                                // === KIEGÉSZÍTÉS KEZDETE ===
                                if (sheetName === "Tétel adatok") {
                                    // 1. A keresési érték oszlopának meghatározása a "Tétel adatok" lapon
                                    const szamlaOszlopBetujele = destinationSheet.getRange(1, startCol).getA1Notation().replace(/\d+/, '');

                                    // 2. A keresési tartomány első oszlopának meghatározása a "Fejléc adatok" lapon
                                    const fejlecSheet = targetSpreadsheet.getSheetByName("Fejléc adatok");
                                    if (!fejlecSheet) {
                                        Logger.log("Hiba: 'Fejléc adatok' munkalap nem található a VLOOKUP tartomány beállításához.");
                                        continue;
                                    }
                                    const fejlecHeaders = fejlecSheet.getRange(1, 1, 1, fejlecSheet.getLastColumn()).getValues()[0];
                                    const fejlecSzamlaColIndex = fejlecHeaders.indexOf("Számla sorszáma") + 1;

                                    if (fejlecSzamlaColIndex === 0) {
                                        Logger.log("Hiba: 'Számla sorszáma' oszlop nem található a 'Fejléc adatok' munkalapon a VLOOKUP számára.");
                                        continue;
                                    }

                                    const fejlecSzamlaColLetter = fejlecSheet.getRange(1, fejlecSzamlaColIndex).getA1Notation().replace(/\d+/, '');
                                    const lookupRange = `'Fejléc adatok'!${fejlecSzamlaColLetter}:AM`;

                                    // 3. Formula összeállítása és beillesztése
                                    const formulaRange = destinationSheet.getRange(targetRow, 1, valuesToCopy.length, 1);
                                    const formula = `=VLOOKUP(INDEX(${szamlaOszlopBetujele}:${szamlaOszlopBetujele};ROW());${lookupRange};2;FALSE)`;
                                    formulaRange.setFormula(formula);
                                    Logger.log(`      Formula beillesztve a(z) "${sheetName}" ${valuesToCopy.length} sorába. Keresési tartomány: ${lookupRange}.`);
                                }
                                // === KIEGÉSZÍTÉS VÉGE ===

                                totalRowsAppended += valuesToCopy.length;
                            }
                        }
                    } else {
                        Logger.log(`  - Figyelmeztetés: A(z) "${sheetName}" munkalap nem található a(z) "${xlsxFileName}" fájlban.`);
                    }
                }
                processedSheet.appendRow([xlsxFileName]);
                Logger.log(`  - "${xlsxFileName}" rögzítve a feldolgozottak közé.`);
                filesProcessedCount++;

            } catch (innerError) {
                Logger.log(`Hiba a(z) "${xlsxFileName}" fájl feldolgozása közben: ${innerError.message}.`);
            } finally {
                if (tempGoogleSheetFile) {
                    try {
                        DriveApp.getFileById(tempGoogleSheetFile.id).setTrashed(true);
                        Logger.log(`  - Ideiglenes fájl törölve.`);
                    } catch (deleteError) {
                        Logger.log(`  - Hiba az ideiglenes fájl törlésekor: ${deleteError.message}`);
                    }
                }
            }
        }

        Logger.log(`--- Adatbetöltés befejeződött ---`);
        Logger.log(`Feldolgozott új .xlsx fájlok: ${filesProcessedCount}.`);
        Logger.log(`Összesen hozzáfűzött sor: ${totalRowsAppended}.`);

        if (filesProcessedCount > 0) {
            // Az utófeldolgozás most már a duplikátum számokat is visszaadja
            const counts = postProcessSheets();

            const summaryMessage = `A feldolgozás befejeződött.\n\n` +
                `Betöltött új fájlok: ${filesProcessedCount} db\n` +
                `Betöltött új sorok: ${totalRowsAppended} db\n` +
                `Kicserélt "n/a" értékek: ${counts.naCount} db\n` +
                `Kitöltött költségtípusok: ${counts.catCount} db\n` +
                `Törölt duplikátumok (Fejléc): ${counts.fejlecDupCount} db\n` + // <-- ÚJ
                `Törölt duplikátumok (Tétel): ${counts.tetelDupCount} db`; // <-- ÚJ
            ui.alert('Feldolgozás kész', summaryMessage, ui.ButtonSet.OK);

        } else {
            ui.alert('Nem történt adatbetöltés, mert nem találtam új, feldolgozásra váró fájlt.');
        }

    } catch (e) {
        Logger.log(`Általános szkripthiba: ${e.message}`);
        ui.alert(`Általános hiba történt a szkript futása közben: ${e.message}`);
    }
}

