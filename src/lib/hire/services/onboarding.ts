import "server-only";
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { db } from "@/db";
import { hireDocuments, hireFiles, hireOnboardingItems, hireStageExecutions, hireVault, users, type HireDocument } from "@/db/schema";
import { err, ok, type Result } from "@/lib/result";
import { fileStorage } from "@/lib/storage";
import type { BlueprintDefinition, DocumentRequirement } from "../blueprint-types";
import { stageByKey } from "../blueprint-types";
import { maskNumber } from "../engines/identity";
import type { HireContext } from "../access";
import { extractDocument } from "../ai/extract-document";
import { hireTrail, ensureExecution, getApplication, hid, stageOutcome, type AppBundle } from "./core";
import { boardRows, type BoardRow } from "./pipeline";
import { cleanNumber, reveal, storeNumber, vaultAvailable, vaultEntry, type VaultKind } from "./vault";
import { courierArrived, currentOffer } from "./offers";

/* ---------------------------------------------------------------------------
 * ONBOARDING: who is at which onboarding point, their documents, the work kit
 * and training topics, and field setup. Every list is the pipeline's own
 * scoped rows (`boardRows`), so a candidate missing from an interviewer's
 * board is missing here too.
 * ------------------------------------------------------------------------- */

export type OnboardScreen = "offers" | "documents" | "induction" | "provision";

const STAGES: Record<OnboardScreen, string[]> = {
  offers: ["document_collection", "checklist", "system_setup"],
  documents: ["document_collection", "checklist", "system_setup"],
  induction: ["checklist", "system_setup"],
  provision: ["system_setup", "terminal"],
};

/** The candidates an onboarding screen lists, newest stage entry first. */
export async function onboardList(ctx: HireContext, screen: OnboardScreen): Promise<BoardRow[]> {
  const rows = await boardRows(ctx);
  const recentHire = (r: BoardRow) => r.status === "hired" && r.totalHours < 24 * 120;
  return rows
    .filter((r) => STAGES[screen].includes(r.stageType) && (r.status === "in_progress" || r.status === "on_hold" || (screen === "provision" && recentHire(r))))
    .sort((a, b) => (a.status === "hired" ? 1 : 0) - (b.status === "hired" ? 1 : 0) || a.hoursInStage - b.hoursInStage);
}

export const VAULTED: ReadonlySet<string> = new Set(["aadhaar", "pan", "bank"]);
const vaultKindOf = (r: DocumentRequirement): VaultKind | null => (VAULTED.has(r.kind) ? (r.kind as VaultKind) : null);

export type DocRow = {
  req: DocumentRequirement;
  doc: HireDocument | null;
  file: { id: string; filename: string; contentType: string; sizeBytes: number } | null;
  masked: string | null;
  vaultId: string | null;
  verifiedBy: string | null;
};

export async function documentRows(b: AppBundle): Promise<DocRow[]> {
  const docs = await db
    .select()
    .from(hireDocuments)
    .where(and(eq(hireDocuments.applicationId, b.app.id), isNull(hireDocuments.supersededById)))
    .orderBy(desc(hireDocuments.createdAt));
  const fileIds = docs.map((d) => d.fileId).filter((x): x is string => Boolean(x));
  const vaultIds = docs.map((d) => d.vaultId).filter((x): x is string => Boolean(x));
  const verIds = docs.map((d) => d.verifiedById).filter((x): x is string => Boolean(x));
  const [files, vault, people] = await Promise.all([
    fileIds.length ? db.select({ id: hireFiles.id, filename: hireFiles.filename, contentType: hireFiles.contentType, sizeBytes: hireFiles.sizeBytes }).from(hireFiles).where(inArray(hireFiles.id, fileIds)) : [],
    vaultIds.length ? db.select({ id: hireVault.id, kind: hireVault.kind, last4: hireVault.last4 }).from(hireVault).where(and(inArray(hireVault.id, vaultIds), isNull(hireVault.purgedAt))) : [],
    verIds.length ? db.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, verIds)) : [],
  ]);
  return b.def.documents.map((req) => {
    const doc = docs.find((d) => d.requirementKey === req.key) ?? null;
    const v = doc?.vaultId ? vault.find((x) => x.id === doc.vaultId) : null;
    return {
      req,
      doc,
      file: doc?.fileId ? (files.find((f) => f.id === doc.fileId) ?? null) : null,
      masked: v ? maskNumber(v.last4, v.kind) : null,
      vaultId: v?.id ?? null,
      verifiedBy: doc?.verifiedById ? (people.find((p) => p.id === doc.verifiedById)?.name ?? null) : null,
    };
  });
}

/** What still keeps the Documents & offer stage open, in words. */
export async function documentsReadiness(b: AppBundle, rows: DocRow[]): Promise<string[]> {
  const out: string[] = [];
  const missing = rows.filter((r) => r.req.mandatory && r.doc?.verificationStatus !== "verified" && r.doc?.verificationStatus !== "waived");
  for (const r of missing) out.push(`${r.req.label} is mandatory and ${r.doc ? (r.doc.verificationStatus === "failed" ? "failed verification — ask for a new one" : "not verified yet") : "not collected"}.`);
  const offer = await currentOffer(b.app.id);
  if (!offer) out.push("No offer has been drafted yet.");
  else if (offer.status !== "accepted") out.push(`The offer is ${offer.status === "issued" ? "issued and waiting for an answer" : offer.status}.`);
  else if (!courierArrived(offer)) out.push("The signed offer has not come back by courier yet — this stage stays open until it is received.");
  return out;
}

/* --------------------------------------------------------------- uploads */

const MAX_BYTES = 10 * 1024 * 1024;

/** The bytes decide the type, never the name (AGENTS.md). */
export function sniff(bytes: Uint8Array): string | null {
  const b = bytes;
  if (b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46) return "application/pdf";
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png";
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return "image/webp";
  return null;
}

async function supersede(applicationId: string, requirementKey: string, newId: string) {
  await db
    .update(hireDocuments)
    .set({ supersededById: newId, updatedAt: new Date() })
    .where(and(eq(hireDocuments.applicationId, applicationId), eq(hireDocuments.requirementKey, requirementKey), isNull(hireDocuments.supersededById)));
}

export async function uploadDocument(ctx: HireContext, applicationId: string, requirementKey: string, file: File): Promise<Result<{ extracted: boolean; note: string }>> {
  const b = await getApplication(ctx, applicationId);
  if (!b) return err("That candidate is not on your list.", "not_found");
  const req = b.def.documents.find((d) => d.key === requirementKey);
  if (!req) return err("That document is not one this role collects.", "validation");
  if (!file || file.size === 0) return err("Choose a file.", "validation");
  if (file.size > MAX_BYTES) return err("Files up to 10 MB.", "validation");
  const bytes = new Uint8Array(await file.arrayBuffer());
  const type = sniff(bytes);
  if (!type) return err("That is not a PDF, JPEG, PNG or WebP — whatever its name says.", "validation");

  const fileId = hid("hfi");
  const stored = await fileStorage.upload({ key: `hire/${b.candidate.id}/${fileId}`, body: bytes, contentType: type });
  await db.insert(hireFiles).values({ id: fileId, candidateId: b.candidate.id, applicationId, purpose: "document", filename: file.name.slice(0, 200) || "document", contentType: type, sizeBytes: stored.sizeBytes, storedRef: stored.ref, uploadedById: ctx.user.id });
  const docId = hid("hdo");
  await supersede(applicationId, req.key, docId);
  await db.insert(hireDocuments).values({ id: docId, applicationId, requirementKey: req.key, fileId, verificationStatus: "pending", createdById: ctx.user.id });
  await hireTrail(ctx, { applicationId, candidateId: b.candidate.id, entityType: "document", entityId: docId, event: "document_uploaded", summary: `Uploaded ${req.label} (${type.replace("application/", "").replace("image/", "").toUpperCase()}, ${Math.round(stored.sizeBytes / 1024)} KB)` });

  const ex = await extractDocument({ requirement: req, bytes, contentType: type, actorId: ctx.user.id, applicationId, documentId: docId });
  if (!ex.ok) return ok({ extracted: false, note: ex.reason }, "Uploaded. " + ex.reason);

  const e = ex.extraction;
  let vaultId: string | null = null;
  let vaultNote = "";
  const kind = vaultKindOf(req);
  if (kind && e.idNumber) {
    const clean = cleanNumber(kind, e.idNumber);
    if (clean && vaultAvailable()) {
      vaultId = (await storeNumber(b.candidate.id, kind, clean, ctx.user.id)).id;
      vaultNote = " The number went to the vault.";
    } else vaultNote = clean ? " No vault key is set, so the number was not kept." : " The number did not read cleanly — enter it by hand.";
  }
  e.idNumber = null;
  const low = e.confidence < 0.6 || e.quality !== "good" || !e.matches || (kind != null && (!vaultId || e.idConfidence < 0.7));
  await db
    .update(hireDocuments)
    .set({
      vaultId,
      extraction: { fields: e.fields, signals: e.signals, quality: e.quality, aiTaskId: e.aiTaskId },
      extractionConfidence: e.confidence,
      verificationStatus: low ? "manual_review" : "pending",
      updatedAt: new Date(),
    })
    .where(eq(hireDocuments.id, docId));
  await hireTrail(ctx, {
    applicationId,
    candidateId: b.candidate.id,
    entityType: "document",
    entityId: docId,
    event: "document_extracted",
    summary: `AI read ${req.label} · ${e.fields.length} fields · ${low ? "routed to manual review" : "waiting for a person to confirm"}${vaultId ? " · number vaulted" : ""}`,
    aiTaskId: e.aiTaskId,
  });
  return ok({ extracted: true, note: vaultNote.trim() }, `Read by AI — check the fields and verify.${vaultNote}`);
}

/** Fields entered or corrected by a person; a number goes to the vault, never to the fields. */
export async function confirmFields(ctx: HireContext, documentId: string, input: { fields: { label: string; value: string }[]; idNumber?: string; verify: boolean }): Promise<Result> {
  const [d] = await db.select().from(hireDocuments).where(eq(hireDocuments.id, documentId)).limit(1);
  if (!d || d.supersededById) return err("That document has been replaced.", "not_found");
  const b = await getApplication(ctx, d.applicationId);
  if (!b) return err("Not found.", "not_found");
  const req = b.def.documents.find((r) => r.key === d.requirementKey);
  if (!req) return err("Not found.", "not_found");
  const kind = vaultKindOf(req);
  let vaultId = d.vaultId;
  if (kind && input.idNumber?.trim()) {
    const clean = cleanNumber(kind, input.idNumber);
    if (!clean) return { ok: false, error: `That does not look like a ${req.label} number.`, code: "validation", fieldErrors: [{ field: "idNumber", message: "Check the number" }] };
    if (!vaultAvailable()) return err("This deployment has no app signing secret, so the number cannot be stored.", "rule_violation");
    vaultId = (await storeNumber(b.candidate.id, kind, clean, ctx.user.id)).id;
  }
  if (input.verify && kind && !vaultId) return { ok: false, error: `Enter the ${req.label} number before verifying.`, code: "validation", fieldErrors: [{ field: "idNumber", message: "Required" }] };
  const before = d.extraction?.fields ?? [];
  const fields = input.fields
    .filter((f) => f.label.trim() && f.value.trim())
    .filter((f) => !/\d{4}\s?\d{4}\s?\d{4}|[A-Z]{5}\d{4}[A-Z]|\d{9,18}/.test(f.value))
    .map((f) => {
      const was = before.find((x) => x.label === f.label);
      return { label: f.label.trim(), value: f.value.trim(), confidence: was && was.value === f.value.trim() ? was.confidence : 1 };
    });
  const now = new Date();
  await db
    .update(hireDocuments)
    .set({
      vaultId,
      extraction: { fields, signals: d.extraction?.signals ?? [], quality: d.extraction?.quality ?? "entered by hand", aiTaskId: d.extraction?.aiTaskId },
      ...(input.verify ? { verificationStatus: "verified", verifiedById: ctx.user.id, verifiedAt: now } : {}),
      updatedAt: now,
      updatedById: ctx.user.id,
    })
    .where(eq(hireDocuments.id, documentId));
  const corrected = fields.filter((f) => before.find((x) => x.label === f.label)?.value !== f.value).map((f) => f.label);
  await hireTrail(ctx, {
    applicationId: d.applicationId,
    candidateId: b.candidate.id,
    entityType: "document",
    entityId: documentId,
    event: input.verify ? "document_verified" : "document_fields",
    summary: `${input.verify ? "Verified" : "Saved"} ${req.label}${corrected.length ? ` · corrected ${corrected.join(", ")}` : ""}${vaultId !== d.vaultId ? " · number stored in the vault" : ""}`,
  });
  return ok(undefined, input.verify ? `${req.label} verified.` : "Saved.");
}

/** Fail (ask for a new one) or waive a requirement. Both need a reason. */
export async function setDocumentStatus(ctx: HireContext, applicationId: string, requirementKey: string, status: "failed" | "waived" | "manual_review", notes: string): Promise<Result> {
  const b = await getApplication(ctx, applicationId);
  if (!b) return err("That candidate is not on your list.", "not_found");
  const req = b.def.documents.find((r) => r.key === requirementKey);
  if (!req) return err("Not found.", "not_found");
  if (notes.trim().length < 10) return { ok: false, error: "Give a reason — it is kept on the record.", code: "validation", fieldErrors: [{ field: "notes", message: "At least 10 characters" }] };
  const [d] = await db.select().from(hireDocuments).where(and(eq(hireDocuments.applicationId, applicationId), eq(hireDocuments.requirementKey, requirementKey), isNull(hireDocuments.supersededById))).limit(1);
  const now = new Date();
  if (d) {
    await db.update(hireDocuments).set({ verificationStatus: status, verificationNotes: notes.trim(), verifiedById: ctx.user.id, verifiedAt: now, updatedAt: now, updatedById: ctx.user.id }).where(eq(hireDocuments.id, d.id));
  } else {
    if (status !== "waived") return err("Nothing has been uploaded to fail.", "rule_violation");
    await db.insert(hireDocuments).values({ id: hid("hdo"), applicationId, requirementKey, verificationStatus: "waived", verificationNotes: notes.trim(), verifiedById: ctx.user.id, verifiedAt: now, createdById: ctx.user.id });
  }
  await hireTrail(ctx, { applicationId, candidateId: b.candidate.id, entityType: "document", entityId: d?.id ?? null, event: `document_${status}`, summary: `${req.label}: ${status === "failed" ? "failed verification — a new one requested" : status === "waived" ? "waived" : "sent to manual review"} · “${notes.trim()}”` });
  return ok(undefined, status === "failed" ? "Marked failed. Ask the candidate for a new one." : status === "waived" ? "Waived, with the reason on the record." : "Sent to manual review.");
}

/** UNMASK — the caller holds `unmask`; this decrypts and writes the PII audit line. */
export async function unmask(ctx: HireContext, vaultId: string): Promise<Result<{ value: string }>> {
  const v = await vaultEntry(vaultId);
  if (!v) return err("Not found.", "not_found");
  const [d] = await db.select({ applicationId: hireDocuments.applicationId, requirementKey: hireDocuments.requirementKey }).from(hireDocuments).where(eq(hireDocuments.vaultId, vaultId)).limit(1);
  if (!d) return err("Not found.", "not_found");
  const b = await getApplication(ctx, d.applicationId);
  if (!b) return err("Not found.", "not_found");
  const value = await reveal(vaultId);
  if (!value) return err("The vault could not open this entry with the current key.", "rule_violation");
  await hireTrail(ctx, {
    applicationId: d.applicationId,
    candidateId: b.candidate.id,
    entityType: "vault",
    entityId: vaultId,
    event: "pii_unmasked",
    summary: `Unmasked ${b.def.documents.find((r) => r.key === d.requirementKey)?.label ?? v.kind} number (ending ${v.last4})`,
    pii: [v.kind],
  });
  const pretty = v.kind === "aadhaar" ? value.replace(/(\d{4})(\d{4})(\d{4})/, "$1 $2 $3") : value;
  return ok({ value: pretty });
}

/* ------------------------------------------------------------- checklists */

export type ItemKey = { kind: "asset" | "topic" | "setup"; group: string; item: string };

export async function onboardItems(applicationId: string) {
  const rows = await db.select().from(hireOnboardingItems).where(eq(hireOnboardingItems.applicationId, applicationId));
  const names = rows.map((r) => r.doneById).filter((x): x is string => Boolean(x));
  const people = names.length ? await db.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, names)) : [];
  const map = new Map(rows.map((r) => [`${r.kind}:${r.groupKey}:${r.itemKey}`, { ...r, doneByName: people.find((p) => p.id === r.doneById)?.name ?? null }]));
  return (k: ItemKey) => map.get(`${k.kind}:${k.group}:${k.item}`) ?? null;
}

function itemExists(def: BlueprintDefinition, k: ItemKey): string | null {
  if (k.kind === "asset") return k.group === "assets" ? (def.onboarding.assets.find((a) => a.key === k.item)?.label ?? null) : null;
  if (k.kind === "topic") {
    const m = def.onboarding.modules.find((x) => x.key === k.group);
    const t = m?.topics.find((x) => x.key === k.item);
    return m && t ? `${m.name} · ${t.title}` : null;
  }
  const g = def.onboarding.setup.find((x) => x.key === k.group);
  const s = g?.steps.find((x) => x.key === k.item);
  return g && s ? `${g.system} · ${s.label}` : null;
}

export async function setItem(ctx: HireContext, applicationId: string, k: ItemKey, done: boolean, serial?: string | null): Promise<Result> {
  const b = await getApplication(ctx, applicationId);
  if (!b) return err("That candidate is not on your list.", "not_found");
  if (b.app.status !== "in_progress") return err(`The application is ${b.app.status.replace("_", " ")}.`, "rule_violation");
  const label = itemExists(b.def, k);
  if (!label) return err("That item is not in this role’s onboarding plan.", "validation");
  const at = b.def.stages.findIndex((s) => s.key === b.app.stageKey);
  const need = b.def.stages.findIndex((s) => s.type === (k.kind === "setup" ? "system_setup" : "checklist"));
  if (need >= 0 && at < need) return err(k.kind === "setup" ? "Field setup starts once the work kit and induction are done." : "Induction starts after documents and the offer.", "rule_violation");
  const asset = k.kind === "asset" ? b.def.onboarding.assets.find((a) => a.key === k.item) : null;
  const ser = serial?.trim() || null;
  if (done && asset?.serial && !ser) return { ok: false, error: `${asset.label} needs its serial number before it is marked received.`, code: "validation", fieldErrors: [{ field: "serial", message: "Required" }] };
  const now = new Date();
  await db
    .insert(hireOnboardingItems)
    .values({ id: hid("hon"), applicationId, kind: k.kind, groupKey: k.group, itemKey: k.item, done, serial: ser, doneById: done ? ctx.user.id : null, doneAt: done ? now : null })
    .onConflictDoUpdate({
      target: [hireOnboardingItems.applicationId, hireOnboardingItems.kind, hireOnboardingItems.groupKey, hireOnboardingItems.itemKey],
      set: { done, serial: ser, doneById: done ? ctx.user.id : null, doneAt: done ? now : null },
    });
  await hireTrail(ctx, {
    applicationId,
    candidateId: b.candidate.id,
    entityType: "onboarding",
    entityId: `${k.kind}:${k.group}:${k.item}`,
    event: done ? "onboarding_done" : "onboarding_undone",
    summary: `${k.kind === "asset" ? (done ? "Received" : "Marked pending") : k.kind === "topic" ? (done ? "Taught" : "Un-ticked") : done ? "Completed" : "Re-opened"}: ${label}${ser ? ` · serial ${ser}` : ""}`,
  });
  await refreshStage(ctx, b);
  return ok(undefined, done ? "Saved." : "Re-opened.");
}

/** Keep the current non-scored stage's execution row in step with what its rows now say. */
async function refreshStage(ctx: HireContext, b: AppBundle) {
  const fresh = await getApplication(ctx, b.app.id);
  if (!fresh) return;
  const stage = stageByKey(fresh.def, fresh.app.stageKey);
  if (!stage || (stage.type !== "checklist" && stage.type !== "system_setup" && stage.type !== "document_collection")) return;
  const oc = await stageOutcome(fresh.app, fresh.def);
  const ex = await ensureExecution(fresh.app.id, stage, ctx.user.id);
  const status = oc.outcome === "pass" ? "completed" : "in_progress";
  if (ex.outcome !== oc.outcome || ex.status !== status)
    await db
      .update(hireStageExecutions)
      .set({ outcome: oc.outcome === "fail" ? "pending" : oc.outcome, status, completedAt: oc.outcome === "pass" ? new Date() : null, conductedById: ctx.user.id, updatedAt: new Date() })
      .where(eq(hireStageExecutions.id, ex.id));
}

export { refreshStage };
