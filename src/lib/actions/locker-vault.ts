"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth";
import { err, ok, type Result } from "@/lib/result";
import { lockerAccess } from "@/lib/locker/access";
import { writeLockerAudit } from "@/lib/locker/audit";
import { backupPlan } from "@/lib/locker/graph";
import { blastFor } from "@/lib/locker/vault-service";
import * as core from "@/lib/locker/vault-core";
import * as ops from "@/lib/locker/ops-core";

/* ---------------------------------------------------------------------------
 * The vault's server actions. Each is a URL anybody signed in can post to, so
 * each signs the caller in and hands them to the core, which checks every
 * rule itself (lib/locker/vault-core.ts, ops-core.ts). No secret value is
 * ever returned except by `revealSecret`, once, to the caller.
 * ------------------------------------------------------------------------- */

function refresh(...paths: string[]) {
  try {
    for (const p of paths) revalidatePath(p);
  } catch {
    /* outside a request */
  }
}

export async function planReveal(credentialId: string, field: string, previousSecretId: string | null) {
  const user = await requireUser();
  return core.planReveal(user, credentialId, field, previousSecretId);
}

export async function requestReveal(credentialId: string, field: string, previousSecretId: string | null, reason: string) {
  const user = await requireUser();
  const r = await core.requestReveal(user, credentialId, field, previousSecretId, reason);
  refresh("/locker/approvals");
  return r;
}

export async function withdrawReveal(requestId: string) {
  const user = await requireUser();
  return core.withdrawRequest(user, requestId);
}

export async function decideReveal(requestId: string, approve: boolean, note: string) {
  const user = await requireUser();
  const r = await core.decideReveal(user, requestId, approve, note);
  refresh("/locker/approvals");
  return r;
}

export async function revealSecret(input: { credentialId: string; field: string; previousSecretId?: string | null; password?: string; reason?: string; requestId?: string | null }) {
  const user = await requireUser();
  const r = await core.performReveal(user, input);
  refresh(`/locker/vault/${input.credentialId}`);
  return r;
}

export async function noteCopied(credentialId: string, field: string) {
  const user = await requireUser();
  await core.recordCopy(user, credentialId, field);
}

export async function createCredential(input: core.CredentialInput) {
  const user = await requireUser();
  const r = await core.createCredential(user, input);
  refresh("/locker/vault");
  return r;
}

export async function updateCredential(id: string, input: core.CredentialInput) {
  const user = await requireUser();
  const r = await core.updateCredential(user, id, input);
  refresh("/locker/vault", `/locker/vault/${id}`);
  return r;
}

export async function recordChange(id: string, field: string, value: string, note: string) {
  const user = await requireUser();
  const r = await core.recordChange(user, id, field, value, note);
  refresh("/locker/vault", `/locker/vault/${id}`, "/locker/vault/change-due");
  return r;
}

export async function saveIdentity(id: string | null, input: ops.IdentityInput) {
  const user = await requireUser();
  const r = await ops.saveIdentity(user, id, input);
  refresh("/locker/vault/accounts", "/locker/vault/connections");
  return r;
}

export async function addLink(credentialId: string, identityId: string, kind: string, sole: boolean) {
  const user = await requireUser();
  const r = await ops.addLink(user, credentialId, identityId, kind, sole);
  refresh(`/locker/vault/${credentialId}`, "/locker/vault/connections");
  return r;
}

export async function removeLink(linkId: string, credentialId: string) {
  const user = await requireUser();
  const r = await ops.removeLink(user, linkId);
  refresh(`/locker/vault/${credentialId}`, "/locker/vault/connections");
  return r;
}

export async function startBreakglass(scope: string[], reason: string) {
  const user = await requireUser();
  const r = await core.startBreakglass(user, scope, reason);
  refresh("/locker", "/locker/emergency", "/locker/approvals");
  return r;
}

export async function decideBreakglass(id: string, approve: boolean) {
  const user = await requireUser();
  const r = await core.decideBreakglass(user, id, approve);
  refresh("/locker", "/locker/emergency", "/locker/approvals");
  return r;
}

export async function endBreakglass(id: string) {
  const user = await requireUser();
  const r = await core.endBreakglass(user, id);
  refresh("/locker", "/locker/emergency");
  return r;
}

export async function reviewBreakglass(id: string, note: string) {
  const user = await requireUser();
  const r = await core.reviewBreakglass(user, id, note);
  refresh("/locker/emergency");
  return r;
}

/** The continuity document for one sign-in account. No secrets in it; the export is recorded. */
export async function exportBackupPlan(identityId: string): Promise<Result<{ text: string; filename: string }>> {
  const user = await requireUser();
  const a = await lockerAccess(user.id);
  if (!a.has("locker.graph")) return err("You do not have Connections in the Locker.", "not_permitted");
  const { blast } = await blastFor(identityId);
  if (!blast) return err("That sign-in account no longer exists.", "not_found");
  const at = new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", dateStyle: "medium", timeStyle: "short" }).format(new Date());
  await writeLockerAudit({ actorId: user.id, actorName: user.name, action: "locker.assets.exported", entityType: "identity", entityId: identityId, entityTitle: blast.identity.email, summary: `Exported the backup plan for ${blast.identity.email}` });
  return ok({ text: backupPlan(blast, user.name, at), filename: `backup-plan-${blast.identity.email.replace(/[^a-z0-9]+/gi, "-")}.txt` });
}
