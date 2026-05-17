/**
 * NavConfig.js — NAV közös hitelesítési konfiguráció.
 *
 * Az itt definiált getNavConfig() szolgáltatja a hitelesítési adatokat (login,
 * passwordHash, taxNumber, signatureKey, exchangeKey + software metaadatok)
 * az OSA, eVatVam és OPG API-knak egyaránt. Mindhárom subsystem ugyanazokat a
 * NAV_* Script Property-ket használja, csak a végpont URL-je tér el.
 *
 * Külső script tárolja: NAV_LOGIN, NAV_PASSWORD_HASH (vagy legacy NAV_PASSWORD),
 *                       NAV_TAX_NUMBER, NAV_SIGNATURE_KEY, NAV_EXCHANGE_KEY,
 *                       NAV_SOFTWARE_* (opcionális override-ok).
 */

function getNavConfig() {
  var p   = PropertiesService.getScriptProperties();
  var env = (p.getProperty('NAV_ENV') || 'production').toLowerCase();

  // Jelszó: a NAV protokoll csak SHA-512 hash-t küld (passwordHash mező),
  // ezért előnyben részesítjük a már hash-ben tárolt NAV_PASSWORD_HASH-t.
  // Legacy fallback: ha még csak a plaintext NAV_PASSWORD van beállítva,
  // futási időben hash-eljük (régi setupok kompatibilitásához).
  var pwHashStored  = p.getProperty('NAV_PASSWORD_HASH');
  var pwPlainLegacy = p.getProperty('NAV_PASSWORD');
  var passwordHash  = pwHashStored
    || (pwPlainLegacy ? navSha512Hex(pwPlainLegacy).toUpperCase() : null);

  var cfg = {
    env:      env,
    apiUrl:   env === 'test'
                ? 'https://api-test.onlineszamla.nav.gov.hu/invoiceService/v3'
                : 'https://api.onlineszamla.nav.gov.hu/invoiceService/v3',
    login:                 p.getProperty('NAV_LOGIN'),
    passwordHash:          passwordHash,
    taxNumber:             p.getProperty('NAV_TAX_NUMBER'),
    signatureKey:          p.getProperty('NAV_SIGNATURE_KEY'),
    exchangeKey:           p.getProperty('NAV_EXCHANGE_KEY')           || '',
    softwareId:            p.getProperty('NAV_SOFTWARE_ID')            || 'GAS' + (p.getProperty('NAV_TAX_NUMBER') || '00000000') + '00001',
    softwareName:          p.getProperty('NAV_SOFTWARE_NAME')          || 'GAS-NAV-Client',
    softwareVersion:       p.getProperty('NAV_SOFTWARE_VERSION')       || '2.0.0',
    softwareDevName:       p.getProperty('NAV_SOFTWARE_DEV_NAME')      || 'GAS User',
    softwareDevContact:    p.getProperty('NAV_SOFTWARE_DEV_CONTACT')   || 'noreply@example.com',
    softwareDevCountryCode:p.getProperty('NAV_SOFTWARE_DEV_COUNTRY')   || 'HU',
    softwareDevTaxNumber:  p.getProperty('NAV_SOFTWARE_DEV_TAX_NUMBER')|| ''
  };
  var missing = ['login', 'passwordHash', 'taxNumber', 'signatureKey']
    .filter(function(k) { return !cfg[k]; });
  if (missing.length) {
    throw new Error('Hiányzó Script Property-k: ' +
      missing.map(function(k) {
        return k === 'passwordHash' ? 'NAV_PASSWORD_HASH (vagy NAV_PASSWORD)' : 'NAV_' + k.toUpperCase();
      }).join(', '));
  }
  cfg.softwareId = navNormalizeSoftwareId(cfg.softwareId);
  return cfg;
}

function navNormalizeSoftwareId(id) {
  var s = String(id).toUpperCase().replace(/[^0-9A-Z\-]/g, '');
  if (s.length > 18) s = s.substring(0, 18);
  while (s.length < 18) s += '0';
  return s;
}
