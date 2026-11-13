"use server";

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import { auditLog, studioBatches, studioDesignVersions, studioDesigns, studioPeopleDates, studioPosters, studioPosterShares, studioReminderState } from "@/db/schema";
import { canOpenModule } from "@/lib/access";
import { resolveScope } from "@/lib/access-control";
import { requireUser } from "@/lib/auth";
import { getConfig } from "@/lib/config/store";
import { notifyUsers } from "@/lib/notify";
import { err, ok, type Result } from "@/lib/result";
import { fileStorage } from "@/lib/storage";
import { languageSchema } from "@/lib/studio/domain/language";
import { parsePersonalization, type Personalization } from "@/lib/studio/domain/personalization";
import { dismiss, markRead, pruneState } from "@/lib/studio/domain/reminder";
import { parseReminderInput } from "@/lib/studio/domain/shared-reminder";
import { buildManifest, copyFromDraft, declaredLanguages, nameProblem, nextVersion, normalizeDraft, parsePlacement } from "@/lib/studio/domain/template-upload";
import { istDateKey } from "@/lib/studio/date";
import { isUniqueViolation } from "@/lib/studio/db-errors";
import { newDesignId, previewDraft, stageDraftBackground } from "@/lib/studio/designs-service";
import { audienceOf, getRecipient, recipientsByIds, type RecipientList, isRecipientList } from "@/lib/studio/recipients";
import { prepareRecipe, renderRecipe, type PosterRecipe } from "@/lib/studio/render-service";
import { getStudioRegistry, validateCandidate } from "@/lib/studio/registry-service";
import { getDesignRow, reminderState } from "@/lib/studio/service";
import { BULK_MAX } from "@/lib/studio/limits";

/* ---------------------------------------------------------------------------
 * The Studio's writes. Every one is checked here — a server action is a URL,
 * and a hidden button is not a permission.
 * ------------------------------------------------------------------------- */

const newId = (p: string) => `${p}_${randomUUID().replace(/-/g, "").slice(0, 20)}`;

async function audit(actorId: string, action: string, entityType: string, entityId: string, detail: Record<string, unknown>) {
  await db.insert(auditLog).values({ id: newId("aud"), actorId, action, entityType, entityId, afterState: detail as never });
}

async function needModule(userId: string, key: string): Promise<boolean> {
  return canOpenModule(userId, key);
}

/** Invalidate a screen's cache. Outside a request (tests, scripts) there is nothing cached to invalidate. */
function refresh(path: string) {
  try {
    revalidatePath(path);
  } catch {
    /* no request context */
  }
}

const NO_ACCESS = "You do not have this part of the Studio. Ask whoever manages access to give it to you.";

/* ------------------------------------------------------------------ one poster */

export type MakePosterInput = {
  customerId: string;
  templateId: string;
  language: string;
  variantId?: string | null;
  showProduct: boolean;
  /** A product id from the recipient's own purchases; "" means none. Absent means the most bought. */
  productId?: string | null;
  personal?: Personalization;
};

/**
 * MAKES ONE POSTER: checks the recipient is in the asker's book, draws the
 * poster once — which is how a name too long for the design is refused here
 * rather than on the poster page — and stores its recipe.
 */
export async function makePoster(input: MakePosterInput): Promise<Result<{ id: string }>> {
  const user = await requireUser();
  if (!(await needModule(user.id, "studio.make"))) return err(NO_ACCESS, "not_permitted");
  const lang = languageSchema.safeParse(input.language);
  if (!lang.success) return err("Choose a language this design offers.");
  const { scope } = await resolveScope();
  const target = await getRecipient(scope.userIds, input.customerId);
  if (!target) return err("That lead or customer is not in your book.", "not_found");

  let product = target.recipient.product;
  if (input.productId === "") product = null;
  else if (input.productId) product = target.products.find((p) => p.id === input.productId) ?? null;

  const recipe: PosterRecipe = {
    audience: target.audience,
    recipient: { ...target.recipient, product },
    senderName: user.name,
    templateId: input.templateId,
    language: lang.data,
    variantId: input.variantId || null,
    showProduct: input.showProduct,
    personal: input.personal ?? {},
  };
  const drawn = await renderRecipe(recipe);
  if (!drawn.ok) return err(drawn.error, "rule_violation", drawn.field ? [{ field: drawn.field, message: drawn.error }] : undefined);

  const checked = parsePersonalization(recipe.personal);
  const id = newId("pst");
  await db.insert(studioPosters).values({
    id,
    createdById: user.id,
    customerId: target.id,
    audience: target.audience,
    recipient: recipe.recipient,
    senderName: recipe.senderName,
    templateId: drawn.data.template.id,
    templateVersion: drawn.data.template.version,
    templateName: drawn.data.template.name,
    occasion: drawn.data.template.occasion,
    language: recipe.language,
    variantId: drawn.data.wording?.id === "custom" ? null : (drawn.data.wording?.id ?? null),
    wordingLabel: drawn.data.wording?.label ?? null,
    showProduct: recipe.showProduct,
    personal: checked.ok ? checked.data : {},
  });
  refresh("/studio");
  return ok({ id }, "Poster made.");
}

/** Takes a poster off the lists. Its row stays, because a share already recorded against it is a fact. */
export async function removePoster(id: string): Promise<Result> {
  const user = await requireUser();
  const [row] = await db.select({ createdById: studioPosters.createdById }).from(studioPosters).where(eq(studioPosters.id, id)).limit(1);
  if (!row || row.createdById !== user.id) return err("Only the person who made a poster can remove it.", "not_permitted");
  await db.update(studioPosters).set({ removedAt: new Date() }).where(eq(studioPosters.id, id));
  refresh("/studio/posters");
  return ok(undefined, "Removed from your posters.");
}

/** Records that a poster left the building — downloaded, or opened in WhatsApp — so the page can say when and by whom. */
export async function recordShare(posterId: string, channel: "download" | "whatsapp" | "device", format?: "png" | "jpeg"): Promise<Result> {
  const user = await requireUser();
  const { scope } = await resolveScope();
  const [row] = await db
    .select({ id: studioPosters.id })
    .from(studioPosters)
    .where(and(eq(studioPosters.id, posterId), scope.userIds ? inArray(studioPosters.createdById, scope.userIds) : undefined))
    .limit(1);
  if (!row) return err("That poster was not found.", "not_found");
  if (!["download", "whatsapp", "device"].includes(channel)) return err("Not a way to share.");
  await db.transaction(async (tx) => {
    await tx.insert(studioPosterShares).values({ id: newId("shr"), posterId, userId: user.id, channel, format: format ?? null });
    await tx.update(studioPosters).set({ shareCount: sql`${studioPosters.shareCount} + 1`, lastSharedAt: new Date() }).where(eq(studioPosters.id, posterId));
  });
  return ok(undefined);
}

/* ------------------------------------------------------------------ bulk */

export type MakeBatchInput = {
  list: RecipientList;
  templateId: string;
  language: string;
  variantId?: string | null;
  showProduct: boolean;
  customerIds: string[];
};

/**
 * MAKES UP TO FIFTY POSTERS OF ONE DESIGN. Each recipient is checked against
 * the design — a shop with no product for a product design is SKIPPED with
 * the reason said, never dropped — and the posters are stored as recipes. They
 * are drawn when somebody opens or downloads them, one at a time, so the run
 * itself costs a few rows rather than fifty renders on a shared machine.
 */
export async function makeBatch(input: MakeBatchInput): Promise<Result<{ id: string; made: number; skipped: number }>> {
  const user = await requireUser();
  if (!(await needModule(user.id, "studio.bulk"))) return err(NO_ACCESS, "not_permitted");
  if (!isRecipientList(input.list)) return err("Choose leads, customers or lost leads.");
  const ids = [...new Set(input.customerIds)];
  if (!ids.length) return err("Tick at least one recipient.");
  if (ids.length > BULK_MAX) return err(`At most ${BULK_MAX} posters at a time. Untick ${ids.length - BULK_MAX}.`);
  const lang = languageSchema.safeParse(input.language);
  if (!lang.success) return err("Choose a language this design offers.");
  const audience = audienceOf(input.list);
  const registry = await getStudioRegistry();
  const template = registry.get(input.templateId);
  if (!template) return err("This design is not available.", "not_found");

  const { scope } = await resolveScope();
  const rows = await recipientsByIds(scope.userIds, ids);
  const found = new Map(rows.map((r) => [r.id, r]));
  const skipped: { customerId: string; name: string; reason: string }[] = [];
  const posters: (typeof studioPosters.$inferInsert)[] = [];
  const batchId = newId("bat");

  for (const cid of ids) {
    const r = found.get(cid);
    if (!r) {
      skipped.push({ customerId: cid, name: "—", reason: "Not in your book any more." });
      continue;
    }
    if (audienceOf(r.list) !== audience) {
      skipped.push({ customerId: cid, name: r.company, reason: "Not the kind of record this batch is for." });
      continue;
    }
    const recipe: PosterRecipe = {
      audience,
      recipient: { contact: r.contact, company: r.company, city: r.city, state: r.state, product: null },
      senderName: user.name,
      templateId: template.manifest.id,
      templateVersion: template.manifest.version,
      language: lang.data,
      variantId: input.variantId || null,
      showProduct: input.showProduct,
      personal: {},
    };
    const p = await prepareRecipe(recipe);
    if (!p.ok) {
      skipped.push({ customerId: cid, name: r.company, reason: p.error });
      continue;
    }
    posters.push({
      id: newId("pst"),
      createdById: user.id,
      customerId: r.id,
      audience,
      recipient: recipe.recipient,
      senderName: recipe.senderName,
      templateId: template.manifest.id,
      templateVersion: template.manifest.version,
      templateName: template.manifest.name,
      occasion: template.manifest.occasion,
      language: lang.data,
      variantId: p.data.wording?.id ?? null,
      wordingLabel: p.data.wording?.label ?? null,
      showProduct: input.showProduct,
      personal: {},
      batchId,
    });
  }
  if (!posters.length) return err(`None of the ${ids.length} could be made into this poster. ${skipped[0]?.reason ?? ""}`.trim(), "rule_violation");

  await db.transaction(async (tx) => {
    await tx.insert(studioBatches).values({
      id: batchId,
      createdById: user.id,
      audience,
      templateId: template.manifest.id,
      templateVersion: template.manifest.version,
      templateName: template.manifest.name,
      language: lang.data,
      variantId: input.variantId || null,
      showProduct: input.showProduct,
      requested: ids.length,
      skipped,
    });
    await tx.insert(studioPosters).values(posters);
  });
  refresh("/studio/bulk");
  return ok({ id: batchId, made: posters.length, skipped: skipped.length });
}

/* ------------------------------------------------------------------ uploaded designs */

/** Who may touch a draft: whoever made it, and whoever approves designs. */
async function draftAccess(userId: string, id: string) {
  const row = await getDesignRow(id);
  if (!row) return { row: null, owner: false, approver: false };
  const approver = await needModule(userId, "studio.approve");
  return { row, owner: row.createdById === userId, approver };
}

export async function saveDraftPlacement(id: string, raw: unknown): Promise<Result> {
  const user = await requireUser();
  /* The Designs screen is checked HERE, not only on the page: a server action is a URL. Ownership is checked as well. */
  if (!(await needModule(user.id, "studio.designs"))) return err(NO_ACCESS, "not_permitted");
  const { row, owner } = await draftAccess(user.id, id);
  if (!row || !owner) return err("That draft was not found.", "not_found");
  if (row.status !== "draft") return err("This design is already published and cannot be changed. Create a new version of it instead.", "rule_violation");
  const parsed = parsePlacement(raw);
  if (!parsed.ok) return err(parsed.message);
  if (parsed.draft.canvas !== row.canvas) return err("The canvas size comes from the uploaded image and cannot be changed.");
  const registry = await getStudioRegistry();
  if (!registry.occasion(parsed.draft.occasion)) return err("That occasion is not available.");
  const np = nameProblem(parsed.draft.name);
  if (np) return err(`The design name ${np}.`, "validation", [{ field: "name", message: np }]);
  /* Stored tidy: languages in their fixed order, and wording only for a language that is declared and a field that is placed. */
  const placement = normalizeDraft({ ...parsed.draft, name: parsed.draft.name.trim().replace(/\s+/g, " ") });
  await db.update(studioDesigns).set({ placement, name: placement.name, updatedAt: new Date() }).where(eq(studioDesigns.id, id));
  refresh("/studio/designs");
  return ok(undefined, "Saved.");
}

export async function deleteDraft(id: string): Promise<Result> {
  const user = await requireUser();
  if (!(await needModule(user.id, "studio.designs"))) return err(NO_ACCESS, "not_permitted");
  const { row, owner } = await draftAccess(user.id, id);
  if (!row || !owner) return err("That draft was not found.", "not_found");
  if (row.status !== "draft") return err("A published design cannot be deleted: posters already made from it still draw from it. Archive it instead.", "rule_violation");
  await db.delete(studioDesigns).where(and(eq(studioDesigns.id, id), eq(studioDesigns.status, "draft")));
  /* A draft's own files only. A new version's draft owns its own copy of the artwork, never the live design's. */
  await fileStorage.remove(row.backgroundRef).catch(() => undefined);
  if (row.sourceRef) await fileStorage.remove(row.sourceRef).catch(() => undefined);
  refresh("/studio/designs");
  return ok(undefined, "Draft deleted.");
}

type DesignRowT = NonNullable<Awaited<ReturnType<typeof getDesignRow>>>;

class PublishConflict extends Error {}

/**
 * THE ONE PUBLISHING PATH, whoever presses the button — a new design, or a new
 * version of a published one.
 *
 * NOTHING BECOMES PUBLISHED THAT THE REGISTRY WOULD REJECT. The checks run in
 * order: the placement (every declared language, English included); the real
 * renderer, drawing every declared language with sample text and with long
 * names; and then the candidate is written as the folder it would be and run
 * through the SAME loader the registry uses (`validateCandidate`). Only a
 * design that loads is written to the database as published.
 *
 * A NEW VERSION keeps the design's id and moves it to the next version in ONE
 * transaction: the version being replaced is saved whole in
 * studio_design_versions first, so every poster made from it keeps drawing, and
 * the update is guarded on the design still being at the version that was
 * read. Nothing is audited or announced unless it all landed.
 */
async function publishRow(user: { id: string; name: string }, row: DesignRowT, via: "approved" | "published"): Promise<Result> {
  const approver = await needModule(user.id, "studio.approve");
  let target: DesignRowT | null = null;
  if (row.revisesId) {
    target = await getDesignRow(row.revisesId);
    if (!target || target.status !== "approved" || !target.manifest || !target.previewRef) return err("The design this is a new version of is no longer published. Restore it first, or delete this draft.", "rule_violation");
    if (target.createdById !== user.id && !approver) return err("Only the person who uploaded a design, or somebody who approves designs, can publish a new version of it.", "not_permitted");
    /* A NEW VERSION IS PUBLISHED ONLY ON THE VERSION IT WAS MADE FROM. If the design has moved on since — another new version was
       published first — this draft would silently replace that version's changes, so it is refused with what to do instead. */
    if (row.revisesVersion !== target.version) {
      return err(
        `Another version of this design (${target.version}) was published after you started this one${row.revisesVersion ? ` from ${row.revisesVersion}` : ""}. Publishing it now would replace those changes. Delete this draft, create a new version from the current one, and make your changes again.`,
        "conflict",
      );
    }
  }
  const designId = target?.id ?? row.id;
  const version = target ? nextVersion(target.version) : row.version;

  const parsed = parsePlacement(row.placement);
  if (!parsed.ok) return err(parsed.message);
  const draft = normalizeDraft(parsed.draft);
  const background = Buffer.from(await fileStorage.read(row.backgroundRef));
  const backgroundPath = stageDraftBackground(row.id, background);
  const pv = await previewDraft({ id: row.id, placement: draft, backgroundPath });
  const problems = [...pv.check.errors.map((e) => e.message), ...pv.render.errors];
  if (problems.length) return err(`It cannot be ${via} yet: ${problems[0]}${problems.length > 1 ? ` (and ${problems.length - 1} more)` : ""}`, "rule_violation");
  const built = buildManifest(draft, { id: designId, version, status: "approved", approvedBy: user.name, approvedAt: istDateKey(new Date()) });
  if (!built.ok) return err(`The design cannot be built: ${built.problems[0]}`, "rule_violation");
  const copy = copyFromDraft(draft);
  const loaderProblems = validateCandidate({ manifest: built.manifest, copy, background, preview: pv.png });
  if (loaderProblems.length) return err(`It cannot be ${via} yet: ${loaderProblems[0]}${loaderProblems.length > 1 ? ` (and ${loaderProblems.length - 1} more)` : ""}`, "rule_violation");

  /* A new version's preview has a key of its own: the version it replaces keeps the preview it was published with. */
  const preview = await fileStorage.upload({ key: target ? `studio/designs/${designId}/preview-${version}.png` : `studio/designs/${designId}/preview.png`, body: pv.png, contentType: "image/png" });
  const now = new Date();

  if (!target) {
    const landed = await db
      .update(studioDesigns)
      .set({ placement: draft, status: "approved", manifest: built.manifest, copy, previewRef: preview.ref, approvedById: user.id, approvedAt: now, updatedAt: now })
      .where(and(eq(studioDesigns.id, row.id), eq(studioDesigns.status, "draft")))
      .returning({ id: studioDesigns.id });
    if (!landed.length) return err("This design is already published.", "rule_violation");
  } else {
    const t: DesignRowT = target;
    try {
      await db.transaction(async (tx) => {
        await tx.insert(studioDesignVersions).values({
          designId: t.id,
          version: t.version,
          manifest: t.manifest,
          copy: t.copy,
          placement: t.placement,
          backgroundRef: t.backgroundRef,
          previewRef: t.previewRef!,
          sourceRef: t.sourceRef,
          sourceFormat: t.sourceFormat,
          publishedById: t.approvedById,
          publishedAt: t.approvedAt,
          supersededById: user.id,
          supersededAt: now,
        });
        const moved = await tx
          .update(studioDesigns)
          .set({
            name: draft.name,
            placement: draft,
            manifest: built.manifest,
            copy,
            version,
            backgroundRef: row.backgroundRef,
            previewRef: preview.ref,
            sourceSha256: row.sourceSha256,
            sourceRef: row.sourceRef ?? t.sourceRef,
            sourceFormat: row.sourceFormat ?? t.sourceFormat,
            approvedById: user.id,
            approvedAt: now,
            updatedAt: now,
          })
          .where(and(eq(studioDesigns.id, t.id), eq(studioDesigns.status, "approved"), eq(studioDesigns.version, t.version)))
          .returning({ id: studioDesigns.id });
        if (!moved.length) throw new PublishConflict();
        const gone = await tx.delete(studioDesigns).where(and(eq(studioDesigns.id, row.id), eq(studioDesigns.status, "draft"))).returning({ id: studioDesigns.id });
        if (!gone.length) throw new PublishConflict();
      });
    } catch (e) {
      /* Two people publishing a version of one design at the same moment: the second finds the version already saved (a unique
         violation) or the design already moved. Either way it is a conflict said in words — never the database's own message. */
      if (e instanceof PublishConflict || isUniqueViolation(e)) return err("Somebody published a version of this design while you were preparing yours. Open it again to see their change.", "conflict");
      console.error("[studio] publishing a new version failed:", e instanceof Error ? e.message : e);
      return err("The new version could not be published. Nothing was changed. Try again.");
    }
  }

  await audit(user.id, via === "approved" ? "studio.design.approved" : "studio.design.published", "studio_design", designId, {
    name: draft.name,
    version,
    languages: declaredLanguages(draft),
    ...(target ? { previousVersion: target.version, revisionDraft: row.id } : {}),
  });
  const owner = target?.createdById ?? row.createdById;
  if (owner !== user.id) {
    await notifyUsers([{ userId: owner, title: target ? "A new version of your design is published" : "Your design is approved", body: `${draft.name}${target ? ` is now at version ${version}. Posters made from earlier versions are unchanged.` : " is now offered to everybody making posters in the Studio."}`, href: "/studio/designs", kind: "info" }]);
  }
  refresh("/studio");
  return ok(undefined, via === "approved" ? "Approved. It is now offered to everybody in the Studio." : target ? `Published as version ${version}. Posters made from earlier versions are unchanged.` : "Published. It is now offered to everybody in the Studio.");
}

/** Publishes a draft on an approver's say-so — the approval workflow, unchanged. */
export async function approveDesign(id: string): Promise<Result> {
  const user = await requireUser();
  const { row, approver } = await draftAccess(user.id, id);
  if (!approver) return err("Approving designs is not part of your access.", "not_permitted");
  if (!row) return err("That draft was not found.", "not_found");
  if (row.status !== "draft") return err("This design is already approved.", "rule_violation");
  return publishRow(user, row, "approved");
}

/**
 * PUBLISHES YOUR OWN DRAFT, with no approver, when the setting allows it. The
 * same checks run as for an approval — nothing here skips the drawing or the
 * loader — and only the person who uploaded it may press it, so immediate
 * publishing never lets anybody touch somebody else's draft.
 */
export async function publishDesign(id: string): Promise<Result> {
  const user = await requireUser();
  if (!(await needModule(user.id, "studio.designs"))) return err(NO_ACCESS, "not_permitted");
  const { row, owner } = await draftAccess(user.id, id);
  if (!row || !owner) return err("That draft was not found.", "not_found");
  if (row.status !== "draft") return err("This design is already published.", "rule_violation");
  if (!(await getConfig())["studio.publishImmediately"]) return err("Templates are published by somebody who approves designs. Your draft is saved and waiting for them.", "not_permitted");
  return publishRow(user, row, "published");
}

/**
 * STARTS A NEW VERSION of a published design: a private draft, with its own copy
 * of the artwork and the placement as it stands, to edit and publish like any
 * other. The design keeps its id; publishing moves it to its next version and
 * keeps the one it replaces for every poster already made. The uploader may
 * start one, and so may whoever approves designs.
 */
export async function reviseDesign(id: string): Promise<Result<{ id: string }>> {
  const user = await requireUser();
  if (!(await needModule(user.id, "studio.designs"))) return err(NO_ACCESS, "not_permitted");
  const { row: target, owner, approver } = await draftAccess(user.id, id);
  if (!target || (!owner && !approver)) return err("That design was not found.", "not_found");
  if (target.status !== "approved") return err("Only a published design can have a new version. Restore it first if it is archived.", "rule_violation");
  const [open] = await db
    .select({ id: studioDesigns.id })
    .from(studioDesigns)
    .where(and(eq(studioDesigns.revisesId, id), eq(studioDesigns.status, "draft"), eq(studioDesigns.createdById, user.id)))
    .limit(1);
  if (open) return ok({ id: open.id }, "Continuing your new version.");
  const revisionId = newDesignId(target.name);
  const bytes = Buffer.from(await fileStorage.read(target.backgroundRef));
  const stored = await fileStorage.upload({ key: `studio/designs/${revisionId}/background.png`, body: bytes, contentType: "image/png" });
  try {
    await db.insert(studioDesigns).values({
      id: revisionId,
      name: target.name,
      canvas: target.canvas,
      placement: target.placement,
      backgroundRef: stored.ref,
      sourceSha256: target.sourceSha256,
      createdById: user.id,
      revisesId: id,
      revisesVersion: target.version,
    });
  } catch (e) {
    /* The copy of the artwork just written belongs to a draft that does not exist; nothing else points at it. */
    await fileStorage.remove(stored.ref).catch(() => undefined);
    if (!isUniqueViolation(e)) throw e;
    /* Two requests at once: the database allows one open new version per design per person, so the other got there first. Continue theirs. */
    const [theirs] = await db
      .select({ id: studioDesigns.id })
      .from(studioDesigns)
      .where(and(eq(studioDesigns.revisesId, id), eq(studioDesigns.status, "draft"), eq(studioDesigns.createdById, user.id)))
      .limit(1);
    if (!theirs) return err("A new version could not be started. Try again.", "conflict");
    return ok({ id: theirs.id }, "Continuing your new version.");
  }
  await audit(user.id, "studio.design.revision_started", "studio_design", id, { name: target.name, fromVersion: target.version, draft: revisionId });
  refresh("/studio/designs");
  return ok({ id: revisionId }, "A new version is ready to edit.");
}

/**
 * Takes a published design out of the library: nothing new can be made from it,
 * and every poster already made keeps drawing (the registry reads an archived
 * design as an archived copy of its version). The uploader may archive their
 * own; whoever approves designs may archive anybody's. WHO archived it is
 * recorded, because it decides who may restore it.
 */
export async function archiveDesign(id: string): Promise<Result> {
  const user = await requireUser();
  const { row, owner, approver } = await draftAccess(user.id, id);
  /* The uploader needs the Designs screen; an approver may archive anybody's whether or not they hold it. */
  if (!approver && !(await needModule(user.id, "studio.designs"))) return err(NO_ACCESS, "not_permitted");
  if (!row || (!owner && !approver)) return err("That design was not found.", "not_found");
  if (row.status !== "approved") return err("Only a published design can be archived.", "rule_violation");
  const done = await db
    .update(studioDesigns)
    .set({ status: "archived", archivedAt: new Date(), archivedById: user.id, updatedAt: new Date() })
    .where(and(eq(studioDesigns.id, id), eq(studioDesigns.status, "approved")))
    .returning({ id: studioDesigns.id });
  if (!done.length) return err("That design was already archived.", "conflict");
  await audit(user.id, "studio.design.archived", "studio_design", id, { name: row.name, version: row.version, byOwner: owner, byApprover: approver });
  if (row.createdById !== user.id) {
    await notifyUsers([{ userId: row.createdById, title: "Your design was archived", body: `${row.name} is no longer offered for new posters. Posters already made from it are unchanged.`, href: "/studio/designs", kind: "info" }]);
  }
  refresh("/studio");
  return ok(undefined, "Archived. Posters already made from it are unchanged.");
}

/**
 * Puts an archived design back in the library, unchanged. Whoever approves
 * designs may restore anybody's. The uploader may restore their own ONLY if they
 * archived it themselves: a design an approver archived stays the approver's
 * to bring back.
 */
export async function restoreDesign(id: string): Promise<Result> {
  const user = await requireUser();
  const { row, owner, approver } = await draftAccess(user.id, id);
  if (!approver && !(await needModule(user.id, "studio.designs"))) return err(NO_ACCESS, "not_permitted");
  if (!row || (!owner && !approver)) return err("That design was not found.", "not_found");
  if (row.status !== "archived") return err("Only an archived design can be restored.", "rule_violation");
  if (!approver && row.archivedById !== user.id) return err("This design was archived by somebody who approves designs, so only they can restore it.", "not_permitted");
  const done = await db
    .update(studioDesigns)
    .set({ status: "approved", archivedAt: null, archivedById: null, updatedAt: new Date() })
    .where(and(eq(studioDesigns.id, id), eq(studioDesigns.status, "archived")))
    .returning({ id: studioDesigns.id });
  if (!done.length) return err("That design was already restored.", "conflict");
  await audit(user.id, "studio.design.restored", "studio_design", id, { name: row.name, version: row.version, byOwner: owner, byApprover: approver, archivedBy: row.archivedById });
  if (row.createdById !== user.id) {
    await notifyUsers([{ userId: row.createdById, title: "Your design is back in the library", body: `${row.name} is offered for new posters again.`, href: "/studio/designs", kind: "info" }]);
  }
  refresh("/studio");
  return ok(undefined, "Restored. It is offered for new posters again.");
}

/** Sends a draft back with what is wrong, in words. The draft stays the uploader's to fix. */
export async function sendDesignBack(id: string, note: string): Promise<Result> {
  const user = await requireUser();
  const { row, approver } = await draftAccess(user.id, id);
  if (!approver) return err("Approving designs is not part of your access.", "not_permitted");
  if (!row || row.status !== "draft") return err("That draft was not found.", "not_found");
  const text = note.trim();
  if (!text) return err("Say what needs changing.", "validation", [{ field: "note", message: "Say what needs changing." }]);
  await audit(user.id, "studio.design.sent_back", "studio_design", id, { name: row.name, note: text });
  await notifyUsers([{ userId: row.createdById, title: "Your design needs a change", body: `${row.name}: ${text}`, href: `/studio/designs/${id}`, kind: "warn" }]);
  return ok(undefined, "Sent back with your note.");
}

/* ------------------------------------------------------------------ shared dates */

export async function savePersonDate(raw: Record<string, unknown>, existing?: { id: string; version: number }): Promise<Result<{ id: string }>> {
  const user = await requireUser();
  if (!(await needModule(user.id, "studio.dates"))) return err(NO_ACCESS, "not_permitted");
  const parsed = parseReminderInput(raw, istDateKey(new Date()));
  if (!parsed.ok) {
    const fieldErrors = Object.entries(parsed.fieldErrors).map(([field, message]) => ({ field, message: String(message) }));
    return err(fieldErrors[0]?.message ?? "Check the form.", "validation", fieldErrors);
  }
  const v = parsed.value;
  let customerId: string | null = null;
  if (v.crmId) {
    const { scope } = await resolveScope();
    const r = await getRecipient(scope.userIds, v.crmId);
    if (!r) return err("That lead or customer is not in your book.", "not_found", [{ field: "crm", message: "not in your book" }]);
    customerId = r.id;
  }
  const values = { kind: v.kind, personName: v.personName, company: v.company, date: v.date, note: v.note, leadDays: v.leadDays, customerId };
  if (existing) {
    const updated = await db
      .update(studioPeopleDates)
      .set({ ...values, version: sql`${studioPeopleDates.version} + 1`, updatedById: user.id, updatedAt: new Date() })
      .where(and(eq(studioPeopleDates.id, existing.id), eq(studioPeopleDates.version, existing.version), isNull(studioPeopleDates.deletedAt)))
      .returning({ id: studioPeopleDates.id });
    if (!updated.length) return err("Somebody changed this date while you were editing it. Open it again to see their change.", "conflict");
    await audit(user.id, "studio.date.edited", "studio_people_date", existing.id, values);
    refresh("/studio/dates");
    return ok({ id: existing.id }, "Saved.");
  }
  const id = newId("pdt");
  await db.insert(studioPeopleDates).values({ id, ...values, createdById: user.id, updatedById: user.id });
  await audit(user.id, "studio.date.created", "studio_people_date", id, values);
  refresh("/studio/dates");
  return ok({ id }, "Added. Everybody in the Studio will be reminded.");
}

export async function deletePersonDate(id: string): Promise<Result> {
  const user = await requireUser();
  if (!(await needModule(user.id, "studio.dates"))) return err(NO_ACCESS, "not_permitted");
  const done = await db
    .update(studioPeopleDates)
    .set({ deletedAt: new Date(), deletedById: user.id })
    .where(and(eq(studioPeopleDates.id, id), isNull(studioPeopleDates.deletedAt)))
    .returning({ name: studioPeopleDates.personName });
  if (!done.length) return err("That date was not found.", "not_found");
  await audit(user.id, "studio.date.deleted", "studio_people_date", id, { name: done[0]!.name });
  refresh("/studio/dates");
  return ok(undefined, "Deleted.");
}

/* ------------------------------------------------------------------ reminders */

async function writeState(userId: string, next: Awaited<ReturnType<typeof reminderState>>) {
  await db
    .insert(studioReminderState)
    .values({ userId, state: next })
    .onConflictDoUpdate({ target: studioReminderState.userId, set: { state: next, updatedAt: new Date() } });
}

export async function dismissReminder(key: string, date: string): Promise<Result> {
  const user = await requireUser();
  const todayKey = istDateKey(new Date());
  await writeState(user.id, pruneState(dismiss(await reminderState(user.id), { key, date }), todayKey));
  refresh("/studio");
  return ok(undefined);
}

export async function markRemindersRead(items: { key: string; date: string }[]): Promise<Result> {
  const user = await requireUser();
  const todayKey = istDateKey(new Date());
  await writeState(user.id, pruneState(markRead(await reminderState(user.id), items.slice(0, 200)), todayKey));
  return ok(undefined);
}

