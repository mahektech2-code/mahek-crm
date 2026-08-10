"use server";

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { appSecrets, auditLog } from "@/db/schema";
import { requireUser } from "@/lib/auth";
import { listUserApps } from "@/lib/access";
import { isSecretName, SECRET_NAMES, type SecretName } from "@/lib/secrets";
import { err as fail, okVoid, type Result } from "@/lib/result";

/* ---------------------------------------------------------------------------
 * Setting and clearing the credentials MahekOne calls outside services with.
 *
 * Platform admin only, checked HERE and not by hiding the form: a key is the
 * one setting whose misuse costs money on somebody else's bill, and a screen
 * that merely does not draw the control is not an access rule.
 *
 * THE AUDIT ROW NEVER CARRIES THE KEY. Every other setting writes its before
 * and after values to `audit_log`, which is right for a threshold and exactly
 * wrong here — the log is the one table nobody prunes and everybody can read.
 * What is recorded is that somebody set or cleared a named credential, when,
 * and which one by its last four characters. That is what an audit of a
 * credential is actually for: knowing who changed it and when, so a leak has
 * a timeline. Knowing the value is not part of it.
 * ------------------------------------------------------------------------- */

async function requirePlatformAdmin() {
  const user = await requireUser();
  const apps = await listUserApps(user.id);
  if (!apps.includes("admin")) {
    return { user: null, error: fail("Only a platform admin can change credentials.", "not_permitted") };
  }
  return { user, error: null };
}

/**
 * A key is trimmed and then checked for being obviously not a key. The point
 * is not validation — only the provider can say whether a key works — but to
 * catch the paste that took the surrounding quotes, a label, or a whole
 * `NAME=value` line with it, which otherwise fails much later as an
 * unauthorised call that reads like the feature is broken.
 */
function tidy(raw: string): string | null {
  let value = raw.trim();
  if (!value) return null;
  /* A pasted `.env` line — keep what is after the first `=`. */
  const envLine = value.match(/^[A-Z0-9_]+\s*=\s*(.+)$/);
  if (envLine) value = envLine[1].trim();
  /* Quotes that came along with the paste. */
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    value = value.slice(1, -1).trim();
  }
  if (value.length < 12 || /\s/.test(value)) return null;
  return value;
}

export async function setSecretAction(name: string, raw: string): Promise<Result> {
  const { user, error } = await requirePlatformAdmin();
  if (error) return error;

  if (!isSecretName(name)) return fail("That is not a credential MahekOne holds.");

  const value = tidy(raw);
  if (!value) {
    return fail(
      "That does not look like a key — it is too short, or it has a space in it. Paste the value on its own, without quotes.",
    );
  }

  const last4 = value.slice(-4);

  await db.transaction(async (tx) => {
    await tx
      .insert(appSecrets)
      .values({ name, value, last4, updatedById: user.id, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: appSecrets.name,
        set: { value, last4, updatedById: user.id, updatedAt: new Date() },
      });

    await tx.insert(auditLog).values({
      id: `aud_${randomUUID().slice(0, 12)}`,
      actorId: user.id,
      action: "secret.set",
      entityType: "app_secret",
      entityId: name,
      /* Never the key. Which one, and its tail — nothing that can be spent. */
      afterState: { name, last4 },
    });
  });

  revalidatePath("/admin");
  return okVoid(`${LABELS[name]} saved. Dictation uses it from the next recording.`);
}

export async function clearSecretAction(name: string): Promise<Result> {
  const { user, error } = await requirePlatformAdmin();
  if (error) return error;
  if (!isSecretName(name)) return fail("That is not a credential MahekOne holds.");

  await db.transaction(async (tx) => {
    await tx.delete(appSecrets).where(eq(appSecrets.name, name));
    await tx.insert(auditLog).values({
      id: `aud_${randomUUID().slice(0, 12)}`,
      actorId: user.id,
      action: "secret.clear",
      entityType: "app_secret",
      entityId: name,
      afterState: { name },
    });
  });

  revalidatePath("/admin");
  /*
   * Clearing removes what the console holds. Where the deploy also sets the
   * matching environment variable, that one takes over rather than the
   * feature switching off — say so, because a manager who clears a key and
   * watches dictation keep working is entitled to know why.
   */
  return okVoid(
    `${LABELS[name]} cleared. If ${SECRET_NAMES[name]} is set on this deployment, that value applies again.`,
  );
}

const LABELS: Record<SecretName, string> = {
  "sarvam.apiKey": "The Sarvam key",
  "openai.apiKey": "The OpenAI key",
};
