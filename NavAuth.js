/**
 * NavAuth.js — NAV közös hitelesítési helperek.
 *
 * Request ID generálás, request signature (SHA3-512) és SHA-512 jelszó hash.
 * Az OSA, eVatVam és OPG alrendszerek mind ezt használják.
 */

// Monoton számláló: garantálja az egyediséget egy végrehajtáson belül (batch kérések esetén)
var _navReqSeq = 0;

/**
 * Új requestId + timestamp generálása.
 *
 * @returns {{ requestId: string, timestamp: string }}
 *   requestId: 'GAS' + yyyyMMddHHmmss + 4 jegyű sorszám (összesen 21 karakter, max 30)
 *   timestamp: ISO 8601 UTC, ezredmásodpercig
 */
function navNewRequestIdAndTimestamp() {
  var ts  = new Date();
  var seq = _navReqSeq++;
  var rid = 'GAS' +
    Utilities.formatDate(ts, 'UTC', 'yyyyMMddHHmmss') +
    ('0000' + (seq % 10000)).slice(-4);
  var timestamp = Utilities.formatDate(ts, 'UTC', "yyyy-MM-dd'T'HH:mm:ss.SSS'Z'");
  return { requestId: rid, timestamp: timestamp };
}

/**
 * Request signature kiszámítása: SHA3-512(requestId + compactTimestamp + signKey).
 */
function navComputeRequestSignature(requestId, timestamp, signKey) {
  var m = timestamp.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/);
  if (!m) throw new Error('Érvénytelen timestamp: ' + timestamp);
  var compact = m[1] + m[2] + m[3] + m[4] + m[5] + m[6];
  return sha3_512Hex(requestId + compact + signKey).toUpperCase();
}

/**
 * Jelszó SHA-512 hex hash — NAV "passwordHash" mezőhöz.
 */
function navSha512Hex(str) {
  var bytes = Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_512, str, Utilities.Charset.UTF_8);
  var s = '';
  for (var i = 0; i < bytes.length; i++) {
    var h = (bytes[i] & 0xff).toString(16);
    s += h.length === 1 ? '0' + h : h;
  }
  return s;
}
