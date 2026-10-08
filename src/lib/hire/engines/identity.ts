/* ---------------------------------------------------------------------------
 * WHO IS THIS PERSON — the fix for D1 and D14 (spec §2.3, §6.3). Pure.
 *
 * Identity is the phone number plus a system id, never the typed name. The
 * AppSheet app linked stages by name, so one spelling difference broke the
 * chain and two people called Rahul Patil became one. Here a phone number is
 * normalised to E.164 and is unique; a NAME match only ever proposes a
 * duplicate for a person to confirm. Nothing auto-merges.
 * ------------------------------------------------------------------------- */

/** +91XXXXXXXXXX, or null when it cannot be a phone number. Indian default. */
export function normalisePhone(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let d = String(raw).replace(/[^\d+]/g, "");
  if (d.startsWith("+")) {
    d = "+" + d.slice(1).replace(/\+/g, "");
    return /^\+\d{10,15}$/.test(d) ? d : null;
  }
  d = d.replace(/^0+/, "");
  if (d.length === 12 && d.startsWith("91")) return "+" + d;
  if (d.length === 10 && /^[6-9]/.test(d)) return "+91" + d;
  return null;
}

/** "+91 98220 41736" for the screen. */
export function displayPhone(e164: string | null | undefined): string {
  if (!e164) return "—";
  const m = /^\+91(\d{5})(\d{5})$/.exec(e164);
  return m ? `+91 ${m[1]} ${m[2]}` : e164;
}

export function normaliseName(n: string): string {
  return n
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Jaro–Winkler similarity, 0..1. Good at one-letter spelling differences. */
export function nameSimilarity(a: string, b: string): number {
  const s1 = normaliseName(a);
  const s2 = normaliseName(b);
  if (!s1 || !s2) return 0;
  if (s1 === s2) return 1;
  const range = Math.max(0, Math.floor(Math.max(s1.length, s2.length) / 2) - 1);
  const m1 = new Array(s1.length).fill(false);
  const m2 = new Array(s2.length).fill(false);
  let matches = 0;
  for (let i = 0; i < s1.length; i++) {
    for (let j = Math.max(0, i - range); j < Math.min(s2.length, i + range + 1); j++) {
      if (m2[j] || s1[i] !== s2[j]) continue;
      m1[i] = m2[j] = true;
      matches++;
      break;
    }
  }
  if (!matches) return 0;
  let t = 0;
  let k = 0;
  for (let i = 0; i < s1.length; i++) {
    if (!m1[i]) continue;
    while (!m2[k]) k++;
    if (s1[i] !== s2[k]) t++;
    k++;
  }
  const jaro = (matches / s1.length + matches / s2.length + (matches - t / 2) / matches) / 3;
  let prefix = 0;
  while (prefix < 4 && s1[prefix] === s2[prefix]) prefix++;
  return jaro + prefix * 0.1 * (1 - jaro);
}

export type DupCandidate = { id: string; name: string; phones: string[]; email: string | null; location: string | null };
export type DupMatch = { id: string; confidence: "High" | "Moderate"; why: string };

/**
 * Possible duplicates of an incoming person. Phone equality is near-certain;
 * a very close name in the same place is worth asking about. Every result is a
 * QUESTION for a human — the caller never merges on it.
 */
export function findDuplicates(incoming: { name: string; phones: string[]; email: string | null; location: string | null }, pool: DupCandidate[]): DupMatch[] {
  const phones = new Set(incoming.phones.filter(Boolean));
  const out: DupMatch[] = [];
  for (const p of pool) {
    const samePhone = p.phones.some((x) => phones.has(x));
    const sim = nameSimilarity(incoming.name, p.name);
    const sameEmail = Boolean(incoming.email && p.email && incoming.email.toLowerCase() === p.email.toLowerCase());
    const samePlace = Boolean(incoming.location && p.location && incoming.location === p.location);
    if (samePhone) {
      out.push({
        id: p.id,
        confidence: "High",
        why: sim >= 0.999 ? "Same phone number and the same name." : `Same phone number; the name differs (“${p.name}”).`,
      });
    } else if (sameEmail) {
      out.push({ id: p.id, confidence: "High", why: `Same email address; ${sim >= 0.999 ? "same name" : `the name differs (“${p.name}”)`}.` });
    } else if (sim >= 0.94 && samePlace) {
      out.push({ id: p.id, confidence: "Moderate", why: `A very similar name (“${p.name}”) in the same location, with a different phone number.` });
    }
  }
  return out.sort((a, b) => (a.confidence === b.confidence ? 0 : a.confidence === "High" ? -1 : 1));
}

/** "XXXX XXXX 4417" — what an Aadhaar or account number looks like on screen. */
export function maskNumber(last4: string | null | undefined, kind: "aadhaar" | "pan" | "bank" | string): string {
  const l = last4 ?? "····";
  if (kind === "aadhaar") return `XXXX XXXX ${l}`;
  if (kind === "pan") return `XXXXXX${l}`;
  return `XXXXXXXX${l}`;
}
