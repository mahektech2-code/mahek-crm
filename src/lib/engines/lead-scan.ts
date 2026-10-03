/* ---------------------------------------------------------------------------
 * WHAT A PHOTOGRAPH SAID, made safe to put in a form.
 *
 * The salesman photographs a visiting card, a shop board or a bill head and
 * the model reads it (`lead-scan-service.ts`). What comes back is a reading —
 * a model's opinion of some pixels — and this is where it is turned into
 * values the New lead form can hold. PURE, like every engine: no I/O, so the
 * rules that decide what reaches a salesman's form are testable without a
 * model, a phone or a key.
 *
 * Three things are decided here rather than trusted to the prompt:
 *
 *   1. THE MOBILE. A card carries a mobile, a landline and a WhatsApp number,
 *      and an STD landline with its leading zero stripped is ten digits that
 *      look exactly like a mobile. So the model says which KIND each number
 *      is, and only a ten-digit number beginning 6–9 that it called a mobile
 *      becomes the primary one. Every other number is still offered, because
 *      the salesman standing in the shop can ask which is which and we cannot.
 *
 *   2. THE GSTIN. Fifteen characters with a checksum, printed in small type,
 *      photographed at an angle — O for 0 and I for 1 is the ordinary
 *      misreading. The checksum is what tells a real number from a plausible
 *      one, so a reading that fails it is repaired only where the repair is
 *      forced by the FORMAT (a letter where only a digit can stand) AND then
 *      passes the checksum. A number that still fails is passed through
 *      marked `invalid`, never dropped: the salesman can read the card, and
 *      silently removing what was printed on it would be worse than asking.
 *
 *   3. NOTHING IS INVENTED. An empty string, "N/A" and "not visible" are all
 *      null. A form filled with a model's apology reads as data.
 * ------------------------------------------------------------------------- */

export type PhoneKind = "mobile" | "landline" | "unknown";

/** What the model is asked for — see `lead-scan-schema.ts`. */
export type LeadScanReading = {
  businessName: string | null;
  contactPerson: string | null;
  phones: { number: string; kind: PhoneKind }[];
  city: string | null;
  state: string | null;
  address: string | null;
  pincode: string | null;
  gstin: string | null;
  note: string | null;
};

export type GstinCheck = "valid" | "corrected" | "invalid";

/** What the handset is sent. Every field may be null; none is a guess. */
export type LeadScanResult = {
  businessName: string | null;
  contactPerson: string | null;
  /** Ten digits, beginning 6–9, that the model called a mobile. */
  mobile: string | null;
  /** Every other number it saw, normalised where it could be, for him to pick. */
  otherNumbers: string[];
  city: string | null;
  state: string | null;
  address: string | null;
  gstin: string | null;
  gstinCheck: GstinCheck | null;
  /** Anything the model thought he should know — two shops on one card. */
  note: string | null;
};

const EMPTY = /^(n\/?a|na|nil|none|null|unknown|not (visible|available|found|legible|readable|clear)|-+|\.+|\?+)$/i;

/** A model's "nothing here" in any of its spellings, as null. */
export function tidy(value: string | null | undefined, max = 300): string | null {
  if (value == null) return null;
  const s = value.replace(/\s+/g, " ").trim();
  if (!s || EMPTY.test(s)) return null;
  return s.slice(0, max);
}

/* ----------------------------------------------------------------- phones */

/**
 * An Indian number reduced to its national digits: +91, a leading 0 and the
 * spaces and dashes a card is printed with all removed. Returns the digits
 * whatever their length — whether it is a MOBILE is `isMobile`'s question.
 */
function nationalDigits(raw: string): string {
  let d = raw.replace(/\D/g, "");
  if (d.length === 12 && d.startsWith("91")) d = d.slice(2);
  else if (d.length === 13 && d.startsWith("091")) d = d.slice(3);
  else if (d.length === 11 && d.startsWith("0")) d = d.slice(1);
  return d;
}

function isMobile(digits: string): boolean {
  return /^[6-9]\d{9}$/.test(digits);
}

function pickNumbers(phones: LeadScanReading["phones"]): {
  mobile: string | null;
  otherNumbers: string[];
} {
  const seen = new Set<string>();
  const all: { digits: string; shown: string; kind: PhoneKind }[] = [];
  /* One printed line often carries two numbers — "98220 11001 / 98220 11002"
     — and read as one string that is twenty digits, which is no number at
     all. Split on the separators a card uses; a run too long to be one
     number with nothing separating it is dropped rather than guessed at. */
  const pieces = phones.flatMap((p) =>
    (p.number ?? "")
      .split(/\s*(?:[\/,;|]|\bor\b|&)\s*/i)
      .map((number) => ({ number, kind: p.kind })),
  );
  for (const p of pieces) {
    const shown = tidy(p.number, 40);
    if (!shown) continue;
    const digits = nationalDigits(shown);
    if (digits.length < 6 || digits.length > 13 || seen.has(digits)) continue;
    seen.add(digits);
    all.push({ digits, shown, kind: p.kind });
  }

  /* A mobile is ten digits from 6–9 that the model did NOT call a landline.
     "unknown" is allowed through as a second choice: most cards print a bare
     number with no label, and that number is usually the proprietor's mobile. */
  const primary =
    all.find((p) => p.kind === "mobile" && isMobile(p.digits)) ??
    all.find((p) => p.kind === "unknown" && isMobile(p.digits)) ??
    null;

  return {
    mobile: primary?.digits ?? null,
    otherNumbers: all
      .filter((p) => p !== primary)
      .map((p) => (p.kind !== "landline" && isMobile(p.digits) ? p.digits : p.shown)),
  };
}

/* ------------------------------------------------------------------ GSTIN */

const GSTIN_CHARS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const GSTIN_SHAPE = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;

/** The fifteenth character the first fourteen require. */
function gstinCheckChar(first14: string): string | null {
  if (first14.length !== 14) return null;
  let sum = 0;
  for (let i = 0; i < 14; i++) {
    const v = GSTIN_CHARS.indexOf(first14[i]);
    if (v < 0) return null;
    const product = v * (i % 2 === 0 ? 1 : 2);
    sum += Math.floor(product / 36) + (product % 36);
  }
  return GSTIN_CHARS[(36 - (sum % 36)) % 36];
}

function isValidGstin(g: string): boolean {
  return GSTIN_SHAPE.test(g) && gstinCheckChar(g.slice(0, 14)) === g[14];
}

/* Which character each position may hold — the FORMAT, not a guess. */
const DIGIT_AT = new Set([0, 1, 7, 8, 9, 10]);
const LETTER_AT = new Set([2, 3, 4, 5, 6, 11]);
const TO_DIGIT: Record<string, string> = { O: "0", D: "0", Q: "0", I: "1", L: "1", Z: "2", S: "5", B: "8", G: "6" };
const TO_LETTER: Record<string, string> = { "0": "O", "1": "I", "2": "Z", "5": "S", "8": "B", "6": "G" };

/**
 * A GSTIN as read, repaired only where the format forces it, then judged by
 * its checksum. Null when there is nothing fifteen characters long to judge.
 */
function checkGstin(raw: string | null | undefined): { gstin: string; check: GstinCheck } | null {
  const s = tidy(raw, 40)?.toUpperCase().replace(/[^0-9A-Z]/g, "") ?? "";
  if (s.length !== 15) return s ? { gstin: s, check: "invalid" } : null;
  if (isValidGstin(s)) return { gstin: s, check: "valid" };

  const fixed = s
    .split("")
    .map((c, i) => (DIGIT_AT.has(i) ? (TO_DIGIT[c] ?? c) : LETTER_AT.has(i) ? (TO_LETTER[c] ?? c) : i === 13 && c === "2" ? "Z" : c))
    .join("");
  if (fixed !== s && isValidGstin(fixed)) return { gstin: fixed, check: "corrected" };

  /* The thirteenth character may be a digit OR a letter, so the format cannot
     force it. Where it is a letter a digit is commonly misread as, the digit
     is tried too — and kept only if the checksum then agrees, which a wrong
     guess does one time in thirty-six. */
  const entity = TO_DIGIT[fixed[12]];
  if (entity && entity !== "0") {
    const second = fixed.slice(0, 12) + entity + fixed.slice(13);
    if (isValidGstin(second)) return { gstin: second, check: "corrected" };
  }
  return { gstin: s, check: "invalid" };
}

/** The GST state codes — the first two digits of every GSTIN. */
const GST_STATE_CODES: Record<string, string> = {
  "01": "Jammu and Kashmir",
  "02": "Himachal Pradesh",
  "03": "Punjab",
  "04": "Chandigarh",
  "05": "Uttarakhand",
  "06": "Haryana",
  "07": "Delhi",
  "08": "Rajasthan",
  "09": "Uttar Pradesh",
  "10": "Bihar",
  "11": "Sikkim",
  "12": "Arunachal Pradesh",
  "13": "Nagaland",
  "14": "Manipur",
  "15": "Mizoram",
  "16": "Tripura",
  "17": "Meghalaya",
  "18": "Assam",
  "19": "West Bengal",
  "20": "Jharkhand",
  "21": "Odisha",
  "22": "Chhattisgarh",
  "23": "Madhya Pradesh",
  "24": "Gujarat",
  "26": "Dadra and Nagar Haveli and Daman and Diu",
  "27": "Maharashtra",
  "29": "Karnataka",
  "30": "Goa",
  "31": "Lakshadweep",
  "32": "Kerala",
  "33": "Tamil Nadu",
  "34": "Puducherry",
  "35": "Andaman and Nicobar Islands",
  "36": "Telangana",
  "37": "Andhra Pradesh",
  "38": "Ladakh",
};

/* ------------------------------------------------------------------ whole */

export function cleanScan(reading: LeadScanReading): LeadScanResult {
  const { mobile, otherNumbers } = pickNumbers(reading.phones ?? []);
  const gst = checkGstin(reading.gstin);

  /* The state a VALID GSTIN names is a fact about the registration; the one
     the model read off a board is a reading. Where the board says nothing the
     registration fills it — never the other way round, since a shop may well
     be trading outside the state it registered in, and the board is where it
     is standing. */
  const gstState = gst && gst.check !== "invalid" ? GST_STATE_CODES[gst.gstin.slice(0, 2)] ?? null : null;

  const address = tidy(reading.address, 500);
  const pincode = tidy(reading.pincode, 10)?.replace(/\D/g, "") ?? "";
  const withPin =
    address && /^\d{6}$/.test(pincode) && !address.includes(pincode) ? `${address} ${pincode}` : address;

  /* A card for "Patil Paints" with "Patil Paints" in the person's place is the
     model filling a box, not a person — the form would get the shop twice. */
  const businessName = tidy(reading.businessName, 200);
  const person = tidy(reading.contactPerson, 200);
  const contactPerson = person && businessName && person.toLowerCase() === businessName.toLowerCase() ? null : person;

  return {
    businessName,
    contactPerson,
    mobile,
    otherNumbers: otherNumbers.slice(0, 6),
    /* The lead schema's own ceilings: city 120, state 80. */
    city: tidy(reading.city, 120),
    state: tidy(reading.state, 80) ?? gstState,
    address: withPin,
    gstin: gst?.gstin ?? null,
    gstinCheck: gst?.check ?? null,
    note: tidy(reading.note, 300),
  };
}

/** Whether a reading found anything a form could use. */
export function foundAnything(r: LeadScanResult): boolean {
  return Boolean(r.businessName || r.contactPerson || r.mobile || r.otherNumbers.length || r.city || r.address || r.gstin);
}
