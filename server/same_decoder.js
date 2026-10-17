// NOAA SAME header parser and event-action mapper.
// SAME format: ZCZC-ORG-EVENT-PSSCCC+TTTT-JJJHHMM-LLLLLLLL/NWS-
// Multiple location codes separated by '-' are supported.

/**
 * Parse a NOAA SAME EAS header string.
 * @param {string} text
 * @returns {{ originator, event, locations, durationMinutes, issued, sender } | { error }}
 */
export function parseSameHeader(text) {
  if (typeof text !== "string" || !text.startsWith("ZCZC-")) {
    return { error: "missing ZCZC prefix" };
  }

  // Strip optional trailing newline / EOM trailers and the leading "ZCZC-"
  const body = text.replace(/\s+$/, "").slice("ZCZC-".length);

  // Split on '-'; we expect at minimum: ORG, EVENT, one or more locations, +TTTT, JJJHHMM, SENDER
  // The '+' duration field is attached to the last location code, e.g. "006037+0100"
  const parts = body.split("-");

  if (parts.length < 5) {
    return { error: "bad field count" };
  }

  const originator = parts[0];
  const event = parts[1];

  // Find the part containing '+' — that's the last location + duration
  const plusIdx = parts.findIndex((p) => p.includes("+"));
  if (plusIdx < 2) {
    return { error: "bad field count" };
  }

  // Everything between index 2 and plusIdx (inclusive) are location codes
  const locationParts = parts.slice(2, plusIdx + 1);
  const lastLoc = locationParts[locationParts.length - 1];
  const plusPos = lastLoc.indexOf("+");
  const lastLocCode = lastLoc.slice(0, plusPos);
  const durationStr = lastLoc.slice(plusPos + 1);

  const locations = [...locationParts.slice(0, -1), lastLocCode];

  // Validate all location codes are 6-digit numeric
  for (const loc of locations) {
    if (!/^\d{6}$/.test(loc)) return { error: "non-numeric location" };
  }

  // Validate duration is 4-digit numeric
  if (!/^\d{4}$/.test(durationStr)) return { error: "non-numeric time" };
  const durationHH = parseInt(durationStr.slice(0, 2), 10);
  const durationMM = parseInt(durationStr.slice(2, 4), 10);
  const durationMinutes = durationHH * 60 + durationMM;

  // Next field after the duration+location group: JJJHHMM
  const issuedStr = parts[plusIdx + 1];
  if (!issuedStr || !/^\d{7}$/.test(issuedStr)) return { error: "non-numeric time" };
  const dayOfYear = parseInt(issuedStr.slice(0, 3), 10);
  const hhmm = issuedStr.slice(3, 7);

  // Sender: everything after JJJHHMM joined back (in case it contained '-')
  const senderParts = parts.slice(plusIdx + 2);
  // Drop trailing empty part from trailing '-'
  while (senderParts.length && senderParts[senderParts.length - 1] === "") senderParts.pop();
  if (!senderParts.length) return { error: "bad field count" };
  const sender = senderParts.join("-");

  return { originator, event, locations, durationMinutes, issued: { dayOfYear, hhmm }, sender };
}

/**
 * Map a SAME event code to an action name.
 * @param {string} code
 * @returns {string}
 */
export function actionForEvent(code) {
  const map = {
    SPW: "shelter_in_place",
    EVI: "evacuate",
    CEM: "info_only",
    RWT: "info_only",
    FFW: "info_only",
    TOR: "info_only",
  };
  return map[code] ?? "info_only";
}
