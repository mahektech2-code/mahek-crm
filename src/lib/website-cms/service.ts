import "server-only";
import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  websiteContent,
  websiteMedia,
  websitePublishLog,
  type User,
  type WebsiteContentRow,
} from "@/db/schema";
import { err, ok, type FieldError, type Result } from "@/lib/result";
import { buildBundle, type ContentRowLike } from "./bundle";
import type { WebsiteBundle } from "./contract";
import {
  KINDS,
  KIND_KEYS,
  SINGLETON_SLUG,
  slugFromData,
  validateKindData,
  type KindKey,
} from "./kinds";
import { previewLink, refreshLiveSite, type LiveRefresh } from "./live-site";
import { parseSeed, seedToRows } from "./seed";
import seedJson from "./seed/cms-seed.bundle.json";

/* ---------------------------------------------------------------------------
 * THE WEBSITE CONTENT SERVICE — every read and write of `website_content`.
 *
 * Authorisation is NOT here: the actions and routes ask `access.ts` first and
 * pass the person in. What IS here is everything that must hold whoever asks:
 *
 *   - saving writes the WORKING copy and never the live one;
 *   - publishing copies working → live, in one transaction, for every row it
 *     names or none of them;
 *   - the live site is told to refresh only AFTER that transaction commits, and
 *     what it answered is returned — never assumed;
 *   - only a draft that was never published can be deleted; everything else is
 *     archived, so nothing a visitor has seen disappears without a trace.
 * ------------------------------------------------------------------------- */

const rowId = () => `wc_${randomUUID().slice(0, 12)}`;
const logId = () => `wl_${randomUUID().slice(0, 12)}`;

export type ItemView = {
  id: string;
  kind: KindKey;
  slug: string;
  sort: number;
  state: "draft" | "published" | "archived";
  label: string;
  data: Record<string, unknown>;
  version: number;
  /** Live, and the working copy differs from what is live. */
  hasChanges: boolean;
  /** Has been live at some point (so an unpublished one is "taken down", not "new"). */
  everPublished: boolean;
  publishedAt: string | null;
  updatedAt: string;
};

function view(row: WebsiteContentRow): ItemView {
  const kind = row.kind as KindKey;
  return {
    id: row.id,
    kind,
    slug: row.slug,
    sort: row.sort,
    state: row.state,
    label: KINDS[kind]?.labelOf(row.data) ?? row.slug,
    data: row.data,
    version: row.version,
    hasChanges: row.state === "published" && row.version !== row.publishedVersion,
    everPublished: row.publishedAt !== null,
    publishedAt: row.publishedAt ? row.publishedAt.toISOString() : null,
    updatedAt: row.updatedAt.toISOString(),
  };
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Db = typeof db | Tx;

async function writeLog(
  client: Db,
  actorId: string | null,
  action: string,
  row: { kind?: string | null; slug?: string | null; id?: string | null } | null,
  detail?: string,
  ok_ = true,
) {
  await client.insert(websitePublishLog).values({
    id: logId(),
    actorId,
    action,
    kind: row?.kind ?? null,
    slug: row?.slug ?? null,
    contentId: row?.id ?? null,
    ok: ok_,
    detail: detail?.slice(0, 500) ?? null,
  });
}

const toFieldErrors = (issues: { path: string; message: string }[]): FieldError[] =>
  issues.map((i) => ({ field: i.path, message: i.message }));

/* ------------------------------------------------------------------- reads */

export async function listItems(kind: KindKey): Promise<ItemView[]> {
  const rows = await db
    .select()
    .from(websiteContent)
    .where(eq(websiteContent.kind, kind))
    .orderBy(asc(websiteContent.sort), asc(websiteContent.slug));
  return rows.map(view);
}

export async function getItem(id: string): Promise<ItemView | null> {
  const [row] = await db.select().from(websiteContent).where(eq(websiteContent.id, id)).limit(1);
  return row ? view(row) : null;
}

/** Every row, shaped for the bundle builder. */
export async function loadBundleRows(): Promise<ContentRowLike[]> {
  const rows = await db.select().from(websiteContent);
  return rows.map((r) => ({
    kind: r.kind,
    slug: r.slug,
    sort: r.sort,
    publishedSort: r.publishedSort,
    state: r.state,
    data: r.data,
    publishedData: r.publishedData,
  }));
}

export async function currentBundle(draft: boolean): Promise<WebsiteBundle> {
  return buildBundle(await loadBundleRows(), { draft });
}

/* ------------------------------------------------------------------ writes */

const CREATABLE: KindKey[] = KIND_KEYS.filter((k) => !KINDS[k].singleton && k !== "page");

export async function createItem(user: User, kind: KindKey, input: unknown): Promise<Result<ItemView>> {
  if (!CREATABLE.includes(kind)) {
    return err(
      kind === "page"
        ? "Pages are defined by the website itself; their copy is edited, not added."
        : `${KINDS[kind].noun[0].toUpperCase()}${KINDS[kind].noun.slice(1)} already exists once — edit it instead.`,
      "rule_violation",
    );
  }
  const checked = validateKindData(kind, input);
  if (!checked.ok) return err("Some fields need attention.", "validation", toFieldErrors(checked.issues));

  const slug = slugFromData(kind, checked.data) ?? `${KINDS[kind].idPrefix}-${randomUUID().slice(0, 8)}`;
  const clash = await duplicateProblem(db, kind, slug, checked.data, null);
  if (clash) return clash;

  const [last] = await db
    .select({ max: sql<number>`coalesce(max(${websiteContent.sort}), 0)::int` })
    .from(websiteContent)
    .where(eq(websiteContent.kind, kind));
  const id = rowId();
  try {
    const [row] = await db
      .insert(websiteContent)
      .values({
        id,
        kind,
        slug,
        sort: (last?.max ?? 0) + 10,
        state: "draft",
        data: checked.data,
        createdById: user.id,
        updatedById: user.id,
      })
      .returning();
    await writeLog(db, user.id, "save", row, "Created.");
    return ok(view(row), `${capital(KINDS[kind].noun)} created as a draft.`);
  } catch (e) {
    if (isUniqueViolation(e)) return err(slugClash(kind), "duplicate", [{ field: kind === "seo" ? "path" : "slug", message: slugClash(kind) }]);
    throw e;
  }
}

export async function updateItem(
  user: User,
  id: string,
  input: unknown,
  expectedVersion?: number,
): Promise<Result<ItemView>> {
  const [existing] = await db.select().from(websiteContent).where(eq(websiteContent.id, id)).limit(1);
  if (!existing) return err("That item no longer exists.", "not_found");
  const kind = existing.kind as KindKey;

  if (expectedVersion !== undefined && expectedVersion !== existing.version) {
    return err(
      "Somebody else changed this after you opened it. Close it and open it again to see their version — nothing of yours was saved.",
      "conflict",
    );
  }
  const checked = validateKindData(kind, input);
  if (!checked.ok) return err("Some fields need attention.", "validation", toFieldErrors(checked.issues));

  const slug = KINDS[kind].singleton || kind === "page" ? existing.slug : (slugFromData(kind, checked.data) ?? existing.slug);
  if (slug !== existing.slug) {
    const clash = await duplicateProblem(db, kind, slug, checked.data, existing.id);
    if (clash) return clash;
  } else if (kind === "product") {
    const clash = await duplicateProblem(db, kind, slug, checked.data, existing.id);
    if (clash) return clash;
  }

  try {
    const [row] = await db
      .update(websiteContent)
      .set({
        data: checked.data,
        slug,
        version: sql`${websiteContent.version} + 1`,
        updatedAt: new Date(),
        updatedById: user.id,
      })
      // The version check is in the statement too, so two saves racing each
      // other cannot both win.
      .where(and(eq(websiteContent.id, id), eq(websiteContent.version, existing.version)))
      .returning();
    if (!row) {
      return err("Somebody else changed this a moment ago. Close it and open it again — nothing of yours was saved.", "conflict");
    }
    await writeLog(db, user.id, "save", row);
    return ok(view(row), row.state === "published" ? "Saved. The live site still shows the published version until you publish." : "Saved as a draft.");
  } catch (e) {
    if (isUniqueViolation(e)) return err(slugClash(kind), "duplicate", [{ field: kind === "seo" ? "path" : "slug", message: slugClash(kind) }]);
    throw e;
  }
}

/** Throws the person's own working copy away and goes back to what is live. */
export async function discardChanges(user: User, id: string): Promise<Result<ItemView>> {
  const [row] = await db.select().from(websiteContent).where(eq(websiteContent.id, id)).limit(1);
  if (!row) return err("That item no longer exists.", "not_found");
  if (row.state !== "published" || !row.publishedData) {
    return err("Only an item that is live has a published version to go back to.", "rule_violation");
  }
  if (row.version === row.publishedVersion) return ok(view(row), "There were no unpublished changes.");
  const [updated] = await db
    .update(websiteContent)
    .set({
      data: row.publishedData,
      version: sql`${websiteContent.version} + 1`,
      publishedVersion: sql`${websiteContent.version} + 1`,
      updatedAt: new Date(),
      updatedById: user.id,
    })
    .where(eq(websiteContent.id, id))
    .returning();
  await writeLog(db, user.id, "discard", updated);
  return ok(view(updated), "Unpublished changes discarded.");
}

/** Only a draft that has never been live can be deleted. Anything a visitor may have seen is archived instead. */
export async function deleteDraft(user: User, id: string): Promise<Result> {
  const [row] = await db.select().from(websiteContent).where(eq(websiteContent.id, id)).limit(1);
  if (!row) return err("That item no longer exists.", "not_found");
  const kind = row.kind as KindKey;
  if (KINDS[kind].singleton || kind === "page") return err("This cannot be deleted.", "rule_violation");
  if (row.state !== "draft" || row.publishedAt !== null) {
    return err("Only a draft that was never published can be deleted. Archive anything that has been live instead.", "rule_violation");
  }
  await db.delete(websiteContent).where(and(eq(websiteContent.id, id), eq(websiteContent.state, "draft")));
  await writeLog(db, user.id, "delete", row);
  return { ok: true, data: undefined, message: "Draft deleted." };
}

/**
 * Moves an item one place within its list. The new order is the WORKING order:
 * the live site keeps its published order until the list is next published.
 */
export async function moveItem(user: User, id: string, direction: "up" | "down"): Promise<Result> {
  const [row] = await db.select().from(websiteContent).where(eq(websiteContent.id, id)).limit(1);
  if (!row) return err("That item no longer exists.", "not_found");
  const siblings = await db
    .select({ id: websiteContent.id })
    .from(websiteContent)
    .where(eq(websiteContent.kind, row.kind))
    .orderBy(asc(websiteContent.sort), asc(websiteContent.slug));
  const ids = siblings.map((s) => s.id);
  const at = ids.indexOf(id);
  const to = direction === "up" ? at - 1 : at + 1;
  if (to < 0 || to >= ids.length) return { ok: true, data: undefined, message: "Already at the end." };
  [ids[at], ids[to]] = [ids[to], ids[at]];
  await db.transaction(async (tx) => {
    for (let i = 0; i < ids.length; i++) {
      await tx.update(websiteContent).set({ sort: (i + 1) * 10, updatedAt: new Date() }).where(eq(websiteContent.id, ids[i]));
    }
    await writeLog(tx, user.id, "reorder", row, `${direction}`);
  });
  return { ok: true, data: undefined, message: "Order changed here. It goes live with the next publish of this list." };
}

/* ------------------------------------------------------------- publishing */

export type PublishOutcome = {
  changed: number;
  items: { id: string; label: string; kind: KindKey }[];
  live: LiveRefresh | null;
};

type Transition = "publish" | "unpublish" | "archive" | "restore";

/** One sentence that says exactly what happened on the live site — never more than is true. */
export function describeLive(prefix: string, live: LiveRefresh | null): string {
  if (!live) return prefix;
  if (live.status === "refreshed") return `${prefix} The live site has been refreshed.`;
  if (live.status === "not_configured") {
    return `${prefix} The live site is not connected yet, so nothing has changed on mahekindia.com.`;
  }
  return `${prefix} BUT the live site did not refresh: ${live.detail} It will pick the change up the next time it reads content (within a few minutes), or use "Refresh the live site" to retry.`;
}

export async function transitionItems(
  user: User,
  ids: string[],
  action: Transition,
): Promise<Result<PublishOutcome>> {
  if (ids.length === 0) return err("Nothing was selected.", "validation");
  const result = await db.transaction(async (tx) => {
    const rows = await tx.select().from(websiteContent).where(inArray(websiteContent.id, ids));
    if (rows.length !== new Set(ids).size) return { error: err("One of those items no longer exists.", "not_found") as Result<PublishOutcome> };

    // Validate everything BEFORE changing anything: all or none.
    if (action === "publish") {
      const problems: FieldError[] = [];
      for (const r of rows) {
        const checked = validateKindData(r.kind as KindKey, r.data);
        if (!checked.ok) {
          problems.push(...checked.issues.map((i) => ({ field: `${KINDS[r.kind as KindKey].labelOf(r.data)}: ${i.path}`, message: i.message })));
        }
      }
      if (problems.length) {
        return { error: err(`Nothing was published: ${problems[0].field} — ${problems[0].message}${problems.length > 1 ? ` (and ${problems.length - 1} more)` : ""}`, "validation", problems) as Result<PublishOutcome> };
      }
    }
    for (const r of rows) {
      const kind = r.kind as KindKey;
      if (action === "archive" && (KINDS[kind].singleton || kind === "page")) {
        return { error: err("This cannot be archived. Unpublish it to go back to the content built into the site.", "rule_violation") as Result<PublishOutcome> };
      }
      if (action === "restore" && r.state !== "archived") {
        return { error: err("Only an archived item can be restored.", "rule_violation") as Result<PublishOutcome> };
      }
    }

    const touched: WebsiteContentRow[] = [];
    const now = new Date();
    for (const r of rows) {
      let patch: Partial<typeof websiteContent.$inferInsert> | null = null;
      if (action === "publish") {
        const unchanged = r.state === "published" && r.version === r.publishedVersion;
        if (!unchanged) {
          patch = {
            state: "published",
            publishedData: r.data,
            publishedVersion: r.version,
            publishedAt: now,
            publishedById: user.id,
          };
        }
      } else if (action === "unpublish") {
        if (r.state === "published") patch = { state: "draft", publishedData: null, publishedVersion: null, publishedSort: null };
      } else if (action === "archive") {
        if (r.state !== "archived") patch = { state: "archived", publishedData: null, publishedVersion: null, publishedSort: null };
      } else if (action === "restore") {
        patch = { state: "draft" };
      }
      if (!patch) continue;
      const [updated] = await tx
        .update(websiteContent)
        .set({ ...patch, updatedAt: now, updatedById: user.id })
        .where(eq(websiteContent.id, r.id))
        .returning();
      touched.push(updated);
      await writeLog(tx, user.id, action, updated);
    }

    // The live ORDER of a list is published together with the list.
    const kinds = new Set(touched.map((t) => t.kind));
    if (action !== "restore") {
      for (const kind of kinds) await syncPublishedOrder(tx, kind);
    }
    return { touched };
  });

  if ("error" in result && result.error) return result.error;
  const touched = (result as { touched: WebsiteContentRow[] }).touched;
  const items = touched.map((t) => ({ id: t.id, label: KINDS[t.kind as KindKey].labelOf(t.data), kind: t.kind as KindKey }));

  if (touched.length === 0) {
    return ok({ changed: 0, items: [], live: null }, action === "publish" ? "Nothing to publish — everything selected is already live." : "Nothing changed.");
  }

  const wentLive = action === "restore" ? false : true;
  const live = wentLive ? await refreshLiveSite(user.id, action) : null;
  const verb = { publish: "Published", unpublish: "Unpublished", archive: "Archived", restore: "Restored as a draft" }[action];
  const subject = touched.length === 1 ? `“${items[0].label}”` : `${touched.length} items`;
  const warnings = await crossReferenceWarnings(touched, action);
  return ok({ changed: touched.length, items, live }, describeLive(`${verb} ${subject} in MahekOne.`, live), warnings);
}

async function syncPublishedOrder(client: Db, kind: string) {
  await client
    .update(websiteContent)
    .set({ publishedSort: sql`${websiteContent.sort}` })
    .where(and(eq(websiteContent.kind, kind), eq(websiteContent.state, "published")));
}

/** Publishes the current order of one or more lists without publishing any item's text. */
export async function publishOrder(user: User, kinds: KindKey[]): Promise<Result<PublishOutcome>> {
  await db.transaction(async (tx) => {
    for (const kind of kinds) {
      await syncPublishedOrder(tx, kind);
      await writeLog(tx, user.id, "publish", { kind, slug: null, id: null }, "Order published.");
    }
  });
  const live = await refreshLiveSite(user.id, "publish-order");
  const what = kinds.map((k) => KINDS[k].plural).join(", ");
  return ok({ changed: 0, items: [], live }, describeLive(`The order of ${what} was published in MahekOne.`, live));
}

async function crossReferenceWarnings(touched: WebsiteContentRow[], action: Transition): Promise<string[] | undefined> {
  const warnings: string[] = [];
  const products = touched.filter((t) => t.kind === "product");
  if (products.length && (action === "unpublish" || action === "archive")) {
    const liveIndustries = await db
      .select()
      .from(websiteContent)
      .where(and(eq(websiteContent.kind, "industry"), eq(websiteContent.state, "published")));
    for (const p of products) {
      const slug = String((p.data as { slug?: string }).slug ?? p.slug);
      const using = liveIndustries.filter((i) => ((i.publishedData as { productSlugs?: string[] } | null)?.productSlugs ?? []).includes(slug));
      if (using.length) {
        warnings.push(`“${KINDS.product.labelOf(p.data)}” is no longer shown under ${using.map((i) => `“${KINDS.industry.labelOf(i.data)}”`).join(", ")}. Its web address now shows "not found".`);
      } else {
        warnings.push(`The web address /products/${slug} now shows "not found" to visitors.`);
      }
    }
  }
  return warnings.length ? warnings : undefined;
}

/** Publishes everything pending: live items with unpublished changes, and drafts that have never been live. */
export async function publishPending(user: User, kinds?: KindKey[]): Promise<Result<PublishOutcome>> {
  const rows = await db.select().from(websiteContent);
  const ids = rows
    .filter((r) => !kinds || kinds.includes(r.kind as KindKey))
    .filter((r) => (r.state === "published" && r.version !== r.publishedVersion) || (r.state === "draft" && r.publishedAt === null))
    .map((r) => r.id);
  if (ids.length === 0) {
    const orderOnly = await orderChangedKinds(kinds);
    if (orderOnly.length) return publishOrder(user, orderOnly);
    return ok({ changed: 0, items: [], live: null }, "Nothing to publish — everything is already live.");
  }
  return transitionItems(user, ids, "publish");
}

export async function orderChangedKinds(kinds?: KindKey[]): Promise<KindKey[]> {
  const rows = await db
    .select({ kind: websiteContent.kind })
    .from(websiteContent)
    .where(and(eq(websiteContent.state, "published"), sql`${websiteContent.publishedSort} is distinct from ${websiteContent.sort}`));
  return [...new Set(rows.map((r) => r.kind as KindKey))].filter((k) => !kinds || kinds.includes(k));
}

/** Re-sends the refresh without changing any content — the retry after a failed one. */
export async function refreshLive(user: User): Promise<Result<{ live: LiveRefresh }>> {
  const live = await refreshLiveSite(user.id, "manual");
  return ok({ live }, describeLive("Refresh requested.", live));
}

export async function previewFor(id: string): Promise<Result<{ url: string }>> {
  const item = await getItem(id);
  if (!item) return err("That item no longer exists.", "not_found");
  const path = KINDS[item.kind].previewPath(item.data, item.slug);
  const link = await previewLink(path);
  if ("error" in link) return err(link.error, "rule_violation");
  return ok({ url: link.url });
}

/** A preview of a kind's page with no particular item (settings, menus, a list). */
export async function previewForKind(kind: KindKey, path?: string): Promise<Result<{ url: string }>> {
  const link = await previewLink(path ?? KINDS[kind].previewPath({}, SINGLETON_SLUG));
  if ("error" in link) return err(link.error, "rule_violation");
  return ok({ url: link.url });
}

/* ------------------------------------------------------------------ import */

export type ImportReport = {
  created: Record<string, number>;
  skipped: number;
  media: number;
  problems: string[];
  /** Product and industry page descriptions the website exported but that were deliberately not imported as overrides. */
  detailSeoSkipped: number;
};

/**
 * Brings the website's CURRENT content into the CMS, as live, exactly as it is.
 * Insert-only: a row that exists is never touched, so it is safe to run twice
 * and can never overwrite an edit. Nothing is deleted. Because the imported
 * content is identical to what the site shows today, importing changes nothing
 * for a visitor.
 */
export async function importWebsiteContent(user: User): Promise<Result<ImportReport>> {
  const parsed = parseSeed(seedJson);
  if (!parsed.ok) return err(parsed.error, "validation");
  const plan = seedToRows(parsed.seed);
  const created: Record<string, number> = {};
  let skipped = 0;
  let mediaCount = 0;
  const now = new Date();

  await db.transaction(async (tx) => {
    for (const r of plan.rows) {
      const inserted = await tx
        .insert(websiteContent)
        .values({
          id: rowId(),
          kind: r.kind,
          slug: r.slug,
          sort: r.sort,
          publishedSort: r.sort,
          state: "published",
          data: r.data,
          publishedData: r.data,
          version: 1,
          publishedVersion: 1,
          publishedAt: now,
          publishedById: user.id,
          createdById: user.id,
          updatedById: user.id,
        })
        .onConflictDoNothing({ target: [websiteContent.kind, websiteContent.slug] })
        .returning({ id: websiteContent.id });
      if (inserted.length) created[r.kind] = (created[r.kind] ?? 0) + 1;
      else skipped += 1;
    }
    for (const m of plan.media) {
      const filename = decodeURIComponentSafe(m.path.split("/").pop() ?? m.path);
      const inserted = await tx
        .insert(websiteMedia)
        .values({
          id: `wm_${randomUUID().slice(0, 12)}`,
          source: "site",
          filename,
          contentType: contentTypeForPath(filename),
          sitePath: m.path,
          alt: m.label,
          uploadedById: user.id,
        })
        .onConflictDoNothing()
        .returning({ id: websiteMedia.id });
      mediaCount += inserted.length;
    }
    const total = Object.values(created).reduce((a, b) => a + b, 0);
    await writeLog(tx, user.id, "import", null, `${total} created, ${skipped} already present, ${mediaCount} image files listed, ${plan.problems.length} problems.`);
  });

  const total = Object.values(created).reduce((a, b) => a + b, 0);
  return ok(
    { created, skipped, media: mediaCount, problems: plan.problems, detailSeoSkipped: plan.detailSeoSkipped },
    total === 0 && skipped > 0
      ? "Everything from the website was already here — nothing was changed."
      : `Imported ${total} item${total === 1 ? "" : "s"} from the website as live. Nothing on mahekindia.com changed.`,
    plan.problems.length ? plan.problems : undefined,
  );
}

/* ---------------------------------------------------------------- dashboard */

export type KindSummary = {
  kind: KindKey;
  total: number;
  live: number;
  draft: number;
  archived: number;
  changes: number;
  neverPublished: number;
  orderChanged: boolean;
};

export type DashboardSummary = {
  imported: boolean;
  kinds: KindSummary[];
  pending: number;
  mediaUploads: number;
  mediaSite: number;
  lastPublish: { at: string; label: string | null; by: string | null } | null;
  lastRefresh: { ok: boolean; at: string; detail: string | null } | null;
  /** A publish or unpublish happened after the last refresh that succeeded. */
  refreshOutstanding: boolean;
  activity: { at: string; action: string; label: string | null; ok: boolean; detail: string | null }[];
};

export async function dashboardSummary(): Promise<DashboardSummary> {
  const rows = await db.select().from(websiteContent);
  const kinds: KindSummary[] = KIND_KEYS.map((kind) => {
    const mine = rows.filter((r) => r.kind === kind);
    return {
      kind,
      total: mine.length,
      live: mine.filter((r) => r.state === "published").length,
      draft: mine.filter((r) => r.state === "draft").length,
      archived: mine.filter((r) => r.state === "archived").length,
      changes: mine.filter((r) => r.state === "published" && r.version !== r.publishedVersion).length,
      neverPublished: mine.filter((r) => r.state === "draft" && r.publishedAt === null).length,
      orderChanged: mine.some((r) => r.state === "published" && r.publishedSort !== r.sort),
    };
  });

  const media = await db
    .select({ source: websiteMedia.source, n: sql<number>`count(*)::int` })
    .from(websiteMedia)
    .where(sql`${websiteMedia.deletedAt} is null`)
    .groupBy(websiteMedia.source);

  const logs = await db.select().from(websitePublishLog).orderBy(desc(websitePublishLog.at)).limit(40);
  const refresh = logs.find((l) => l.action === "refresh") ?? null;
  const lastGood = logs.find((l) => l.action === "refresh" && l.ok) ?? null;
  const lastChange = logs.find((l) => ["publish", "unpublish", "archive"].includes(l.action)) ?? null;

  const lastPublished = rows
    .filter((r) => r.publishedAt)
    .sort((a, b) => b.publishedAt!.getTime() - a.publishedAt!.getTime())[0];

  return {
    imported: rows.length > 0,
    kinds,
    pending: kinds.reduce((n, k) => n + k.changes + k.neverPublished + (k.orderChanged ? 1 : 0), 0),
    mediaUploads: media.find((m) => m.source === "upload")?.n ?? 0,
    mediaSite: media.find((m) => m.source === "site")?.n ?? 0,
    lastPublish: lastPublished
      ? {
          at: lastPublished.publishedAt!.toISOString(),
          label: KINDS[lastPublished.kind as KindKey]?.labelOf(lastPublished.data) ?? null,
          by: lastPublished.publishedById,
        }
      : null,
    lastRefresh: refresh ? { ok: refresh.ok, at: refresh.at.toISOString(), detail: refresh.detail } : null,
    refreshOutstanding: lastChange !== null && (lastGood === null || lastChange.at.getTime() > lastGood.at.getTime()),
    activity: logs
      .filter((l) => l.action !== "save")
      .slice(0, 12)
      .map((l) => ({ at: l.at.toISOString(), action: l.action, label: l.slug, ok: l.ok, detail: l.detail })),
  };
}

/* ----------------------------------------------------------------- helpers */

const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

function slugClash(kind: KindKey): string {
  return kind === "seo" ? "An entry for this path already exists." : `Another ${KINDS[kind].noun} already uses this slug.`;
}

function isUniqueViolation(e: unknown): boolean {
  return !!e && typeof e === "object" && "code" in e && (e as { code: unknown }).code === "23505";
}

async function duplicateProblem(
  client: Db,
  kind: KindKey,
  slug: string,
  data: Record<string, unknown>,
  exceptId: string | null,
): Promise<Result<never> | null> {
  const rows = await client
    .select({ id: websiteContent.id })
    .from(websiteContent)
    .where(and(eq(websiteContent.kind, kind), eq(websiteContent.slug, slug)));
  if (rows.some((r) => r.id !== exceptId)) {
    return err(slugClash(kind), "duplicate", [{ field: kind === "seo" ? "path" : "slug", message: slugClash(kind) }]);
  }
  if (kind === "product" && typeof data.id === "string") {
    const same = await client
      .select({ id: websiteContent.id })
      .from(websiteContent)
      .where(and(eq(websiteContent.kind, "product"), sql`${websiteContent.data}->>'id' = ${data.id}`));
    if (same.some((r) => r.id !== exceptId)) {
      return err("Another product already uses this product code.", "duplicate", [{ field: "id", message: "Another product already uses this product code." }]);
    }
  }
  return null;
}

function decodeURIComponentSafe(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

function contentTypeForPath(p: string): string {
  const ext = p.split("?")[0].split(".").pop()?.toLowerCase();
  return ext === "webp" ? "image/webp" : ext === "png" ? "image/png" : ext === "gif" ? "image/gif" : ext === "jpg" || ext === "jpeg" ? "image/jpeg" : "application/octet-stream";
}
