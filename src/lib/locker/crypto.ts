import "server-only";
import { createCipheriv, createDecipheriv, createHmac, randomBytes, scryptSync } from "node:crypto";

/* ---------------------------------------------------------------------------
 * THE VAULT'S CRYPTOGRAPHY — envelope encryption, spec Part A §1.
 *
 *   value ── AES-256-GCM under a fresh 256-bit data key (DEK) ── ciphertext
 *   DEK   ── AES-256-GCM under the key-encryption key (KEK)  ── wrapped_dek
 *
 * E1 a unique DEK per stored value. E2 GCM everywhere, so a tampered byte
 * fails to decrypt rather than returning garbage. E10 the KEK version is
 * stored on every row, so rotating the KEK re-wraps DEKs (`rewrap`) without
 * touching a ciphertext.
 *
 * WHERE THE KEK LIVES. The spec asks for a KMS; this deployment is one
 * droplet with no KMS to call. The KEK is derived from a secret in the
 * ENVIRONMENT — `LOCKER_KEK` where set (a separate, rotatable key, which is
 * what a KMS would hold), else the app signing secret Hire's vault already
 * derives from — and never from anything in the database. So the property
 * that matters most holds: a database dump yields nothing. What a KMS adds
 * beyond that (a key that never leaves hardware) is recorded in AGENTS.md as
 * the open item it is, not pretended.
 *
 * Rotation: set the new key as LOCKER_KEK (with LOCKER_KEK_VERSION counting
 * up), the old as LOCKER_KEK_PREVIOUS (+ _VERSION), run the re-wrap job, then
 * remove the old.
 *
 * Nothing here logs, throws or returns a plaintext except `openValue`, which
 * is called by exactly one function — the audited reveal.
 * ------------------------------------------------------------------------- */

type Kek = { version: number; key: Buffer };

const derive = (material: string, salt: string) => scryptSync(material, salt, 32);

function keks(): { current: Kek | null; all: Kek[] } {
  const explicit = process.env.LOCKER_KEK?.trim();
  const previous = process.env.LOCKER_KEK_PREVIOUS?.trim();
  const app = (process.env.MBOS_JWT_SECRET ?? process.env.JWT_SECRET)?.trim();
  const all: Kek[] = [];
  if (app) all.push({ version: 1, key: derive(app, "mahekone.locker.kek.v1") });
  if (previous) all.push({ version: Number(process.env.LOCKER_KEK_PREVIOUS_VERSION ?? 2), key: derive(previous, "mahekone.locker.kek") });
  if (explicit) all.push({ version: Number(process.env.LOCKER_KEK_VERSION ?? 2), key: derive(explicit, "mahekone.locker.kek") });
  const current = explicit ? all[all.length - 1] : (all.find((k) => k.version === 1) ?? null);
  return { current, all };
}

export const vaultReady = () => keks().current !== null;
export const currentKekVersion = () => keks().current?.version ?? 0;

function seal(key: Buffer, plain: Buffer): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, iv);
  const data = Buffer.concat([c.update(plain), c.final()]);
  return `${iv.toString("base64")}:${c.getAuthTag().toString("base64")}:${data.toString("base64")}`;
}

function unseal(key: Buffer, sealed: string): Buffer {
  const [iv, tag, data] = sealed.split(":");
  if (!iv || !tag || data === undefined) throw new Error("A stored vault value is malformed.");
  const d = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64"));
  d.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([d.update(Buffer.from(data, "base64")), d.final()]);
}

export type Sealed = { ciphertext: string; wrappedDek: string; kekVersion: number };

/** Encrypt one value under its own data key. */
export function sealValue(plain: string): Sealed {
  const kek = keks().current;
  if (!kek) throw new Error("This deployment has no vault key (LOCKER_KEK or the app signing secret), so the vault cannot store anything.");
  const dek = randomBytes(32);
  try {
    return { ciphertext: seal(dek, Buffer.from(plain, "utf8")), wrappedDek: seal(kek.key, dek), kekVersion: kek.version };
  } finally {
    dek.fill(0);
  }
}

/** Decrypt one value. Only the audited reveal calls this. Throws on any tampering (E2). */
export function openValue(s: Sealed): string {
  const kek = keks().all.find((k) => k.version === s.kekVersion);
  if (!kek) throw new Error(`The key that encrypted this value (version ${s.kekVersion}) is not configured on this deployment.`);
  const dek = unseal(kek.key, s.wrappedDek);
  try {
    const plain = unseal(dek, s.ciphertext);
    const out = plain.toString("utf8");
    plain.fill(0);
    return out;
  } finally {
    dek.fill(0);
  }
}

/** Re-wrap a data key under the current KEK — rotation without touching the ciphertext. */
export function rewrap(s: Sealed): Sealed {
  const { current, all } = keks();
  const old = all.find((k) => k.version === s.kekVersion);
  if (!current || !old) throw new Error("Cannot re-wrap: a key is missing.");
  if (old.version === current.version) return s;
  const dek = unseal(old.key, s.wrappedDek);
  try {
    return { ciphertext: s.ciphertext, wrappedDek: seal(current.key, dek), kekVersion: current.version };
  } finally {
    dek.fill(0);
  }
}

/** A keyed fingerprint (spec §6.3): equal values match; without the key nothing can be brute-forced offline. */
export function fingerprint(plain: string): string {
  const k = (process.env.LOCKER_KEK ?? process.env.MBOS_JWT_SECRET ?? process.env.JWT_SECRET)?.trim();
  if (!k) return "";
  return createHmac("sha256", derive(k, "mahekone.locker.pepper")).update(plain, "utf8").digest("hex").slice(0, 32);
}

/** The last two characters — all any list ever shows. Short values show nothing. */
export function hintOf(plain: string): string {
  const t = plain.trim();
  return t.length <= 6 ? "··" : t.slice(-2);
}
