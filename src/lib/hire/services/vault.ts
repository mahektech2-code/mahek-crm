import "server-only";
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "@/db";
import { hireVault } from "@/db/schema";
import { hid } from "./core";

/* ---------------------------------------------------------------------------
 * THE PII VAULT — the fix for D2 (spec §2.8, §9.1).
 *
 * Aadhaar, PAN and bank account numbers are stored here, encrypted with
 * AES-256-GCM, and nowhere else: not on the candidate, not in a document's
 * extraction, not in a log, never in another model context. A list reads
 * `last4` and nothing more; the plaintext is decrypted only by `reveal`, which
 * its caller must audit as a PII access.
 *
 * WHICH KEY. One, derived from the deployment's app signing secret — the
 * secret MBOS sign-in already depends on (`MBOS_JWT_SECRET`, or `JWT_SECRET`
 * where that is the name it was given), so the vault works on every
 * deployment with nothing to set up. There is deliberately no second,
 * Hire-only variable: a key that can be added later is a key that, once
 * added, silently makes every number stored before it unreadable. Rotating
 * the app secret therefore needs the vault re-encrypted in the same breath.
 *
 * A database dump alone does not open the vault: the key lives in the
 * environment, not in a table.
 * ------------------------------------------------------------------------- */

export type VaultKind = "aadhaar" | "pan" | "bank";

function keySource(): Buffer | null {
  const app = (process.env.MBOS_JWT_SECRET ?? process.env.JWT_SECRET)?.trim();
  return app ? scryptSync(app, "mahekone.hire.vault.derived", 32) : null;
}

/** For the Documents screen: how the vault is protected, in words. */
export function vaultKeyLine(): string {
  return keySource()
    ? "Identity and bank numbers are encrypted (AES-256-GCM) with this deployment’s own key."
    : "This deployment has no app signing secret, so identity numbers cannot be stored — only the documents themselves.";
}

export const vaultAvailable = () => keySource() !== null;

/** Digits and letters only, upper-cased — what is compared and kept. */
export function cleanNumber(kind: VaultKind, raw: string): string | null {
  const v = raw.replace(/[\s-]/g, "").toUpperCase();
  if (kind === "aadhaar") return /^\d{12}$/.test(v) ? v : null;
  if (kind === "pan") return /^[A-Z]{5}\d{4}[A-Z]$/.test(v) ? v : null;
  return /^\d{9,18}$/.test(v) ? v : null;
}

export const NUMBER_HINT: Record<VaultKind, string> = {
  aadhaar: "12 digits",
  pan: "5 letters, 4 digits, 1 letter",
  bank: "9 to 18 digits",
};

function encrypt(plain: string): string {
  const k = keySource();
  if (!k) throw new Error("This deployment has no app signing secret.");
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", k, iv);
  const data = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return `v1:app:${iv.toString("base64")}:${c.getAuthTag().toString("base64")}:${data.toString("base64")}`;
}

function decrypt(ciphertext: string): string {
  const [ver, , iv, tag, data] = ciphertext.split(":");
  if (ver !== "v1") throw new Error("Unknown vault format.");
  const k = keySource();
  if (!k) throw new Error("This deployment has no app signing secret.");
  const d = createDecipheriv("aes-256-gcm", k, Buffer.from(iv, "base64"));
  d.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([d.update(Buffer.from(data, "base64")), d.final()]).toString("utf8");
}

/** Store a number; returns the vault id. The caller has already validated it with `cleanNumber`. */
export async function storeNumber(candidateId: string, kind: VaultKind, value: string, actorId: string | null): Promise<{ id: string; last4: string }> {
  const id = hid("hvt");
  const last4 = value.slice(-4);
  await db.insert(hireVault).values({ id, candidateId, kind, ciphertext: encrypt(value), last4, createdById: actorId });
  return { id, last4 };
}

export async function vaultEntry(id: string) {
  const [v] = await db
    .select({ id: hireVault.id, candidateId: hireVault.candidateId, kind: hireVault.kind, last4: hireVault.last4 })
    .from(hireVault)
    .where(and(eq(hireVault.id, id), isNull(hireVault.purgedAt)))
    .limit(1);
  return v ?? null;
}

/** The plaintext. ONLY for an unmask the caller has checked and is about to audit. */
export async function reveal(id: string): Promise<string | null> {
  const [v] = await db.select({ c: hireVault.ciphertext }).from(hireVault).where(and(eq(hireVault.id, id), isNull(hireVault.purgedAt))).limit(1);
  if (!v) return null;
  try {
    return decrypt(v.c);
  } catch {
    return null;
  }
}
