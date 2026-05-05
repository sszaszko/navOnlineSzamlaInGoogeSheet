# NAV Online Számla - Google Sheets Integráció

## Leírás
Ez a projekt egy Google Apps Script (GAS) alapú megoldás, amely közvetlenül összeköti a NAV Online Számla rendszerét a Google Táblázatokkal (Google Sheets). Lehetővé teszi a bejövő számlák adatainak (fejléc és tétel szintű információk) automatikus vagy manuális letöltését, átlátható formába rendezését és utófeldolgozását. Célja, hogy minimalizálja az adminisztrációs terheket a számlák manuális rögzítésének és kategorizálásának automatizálásával. A szkript elvégzi a duplikátumok szűrését, a dátumok szerinti rendezést, valamint az előre definiált szabályok alapján a költségtípusok automatikus kitöltését is.

## Telepítés (Installation)
1. Nyisd meg a használni kívánt Google Táblázatot (Google Sheets).
2. A felső menüben válaszd az **Extensions → Apps Script** (Bővítmények → Apps Script) lehetőséget.
3. Másold be a projekt fájljait külön szkriptfájlokként (pl. `Menu.gs`, `ProcessNAV_xls.gs`, `Dataprocessor.gs`, `Navapi.gs`, `SHA3.gs`).
4. Menj a **Project Settings → Script Properties** (Projektbeállítások → Szkript tulajdonságok) menüpontba, és add hozzá az alábbi kulcsokat a NAV-os hitelesítő adataiddal:

   * `NAV_LOGIN`
   * `NAV_PASSWORD`
   * `NAV_TAX_NUMBER` (8 számjegyből álló adószám törzsszám)
   * `NAV_SIGNATURE_KEY`
   * `NAV_EXCHANGE_KEY`
   * `NAV_ENV` = `test` vagy `production` (teszt vagy éles környezet)

   *(Opcionális)* `NAV_SOFTWARE_*` felülírások (a `softwareId` automatikusan 18 karakteresre lesz kiegészítve, ha rövidebb).

## Használat (Usage)
A telepítés és beállítás után a dokumentum megnyitásakor (vagy frissítésekor) meg fognak jelenni a felső sávban az egyedi menüpontok (**NAV** és **Adatfeldolgozó** néven).

**1. Fejléc adatok letöltése:**
* Navigálj a `NAV -> 1 · Fejléc adatok letöltése (Digest)…` menüpontra.
* Add meg a lekérdezni kívánt időszak kezdő és végdátumát, majd a szkript letölti a megadott időszak számláinak alapadatait (fejléceit).

**2. Tételek letöltése:**
* Válaszd a `NAV -> 2 · Tételek letöltése (hiányzókhoz)…` menüpontot.
* A szkript automatikusan kikeresi a "Fejléc adatok" munkalapról azokat a számlákat, amelyeknek még hiányoznak a részletes tételei, és letölti azokat a NAV rendszeréből.
* A letöltés befejeztével a rendszer automatikusan rendezi a sorokat és kitölti a kategóriákat.

**3. Egyedi számla lekérdezése:**
* Ha csak egy bizonyos számlára van szükséged, válaszd a `NAV -> Egy számla kézi lekérdezése…` lehetőséget, és add meg a számlaszámot.

**4. Automatikus futtatás (opcionális):**
* Az `autoSyncLast5Days` nevű függvény beállítható **Time-driven trigger**-ként (pl. napi egyszeri futásra) a Google Apps Script felületén. Így a rendszer a háttérben teljesen automatikusan le fogja tölteni az utolsó 5 nap számláit, és elvégzi a kategóriák kitöltését, illetve az adatok rendezését.
