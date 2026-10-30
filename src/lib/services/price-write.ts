import "server-only";
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { auditLog, priceListScopes, priceLists, type PriceDerivation } from "@/db/schema";
import type { requirePriceDesk } from "@/lib/services/price-desk";
import type { Config } from "@/lib/config/registry";
import { deriveRate } from "@/lib/engines/price-math";
import { publishedSuccessor, supersedePredecessor } from "@/lib/services/price-supersede";
import { newVersionRefusal } from "@/lib/engines/price-supersede";
import { err, fieldErr, type Err } from "@/lib/result";
import { leaveShopOutOfBook, loadWorld, newClashRefusal } from "@/lib/services/price-one-list-service";

/* ---------------------------------------------------------------------------
 * THE TWO WRITES A NEW REVISION IS MADE OF, shared by the old list screens and
 * the price-book workflow: opening a draft version of a list, and publishing a
 * draft. They live here, outside any "use server" file, so the price-book
 * actions run the SAME code as the list actions — one set of locks, one rule
 * about successors, one audit row — rather than a second copy that drifts.
 *
 * Both run inside the CALLER's transaction and throw `Refused` to roll it
 * back; the caller turns that into the Result a screen reads.
 * ------------------------------------------------------------------------- */

const gen = (prefix: string) => `${prefix}_${randomUUID().slice(0, 12)}`;

export type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
export type DeskCtx = Awaited<ReturnType<typeof requirePriceDesk>>;

/** A refusal decided inside a transaction: thrown to roll it back, caught and returned. */
export class Refused extends Error {
  constructor(readonly result: Err) {
    super(result.error);
  }
}

/** The list row, LOCKED for the rest of the transaction — the read a status check must be made on. */
export async function lockedList(tx: Tx, id: string) {
  const [row] = await tx.select().from(priceLists).where(eq(priceLists.id, id)).for("update");
  return row ?? null;
}

export async function audit(
  tx: { insert: typeof db.insert },
  ctx: { user: { id: string }; authorisedBy: string; authorisedIn: string | null },
  input: { action: string; entityType: string; entityId: string; before?: unknown; after?: unknown },
) {
  await tx.insert(auditLog).values({
    id: gen("aud"),
    actorId: ctx.user.id,
    action: input.action,
    entityType: input.entityType,
    entityId: input.entityId,
    actorRole: ctx.authorisedBy as never,
    actorApp: ctx.authorisedIn as never,
    beforeState: (input.before ?? null) as never,
    afterState: (input.after ?? null) as never,
  });
}

export type VersionInput = { effectiveFrom: string; name?: string; refNo?: string | null };

/**
 * The source LOCKED, checked, and either the draft version already open on it
 * or a new one copied from it — inside the caller's transaction, so a second
 * click cannot make a second draft and `bulkRevise` cannot leave a half-made one.
 */
export async function draftVersionIn(
  tx: Tx,
  ctx: DeskCtx,
  id: string,
  input: VersionInput,
): Promise<{ id: string; version: number; existing: boolean }> {
  const row = await lockedList(tx, id);
  if (!row) throw new Refused(err("That price list does not exist.", "not_found"));
  const refusal = newVersionRefusal(row.status);
  if (refusal) throw new Refused(err(refusal, "rule_violation"));

  /* One open draft per list. Two would each publish as "the next version" and
     the second would find the first already taking over. */
  const [open] = await tx
    .select({ id: priceLists.id, version: priceLists.version })
    .from(priceLists)
    .where(and(eq(priceLists.supersedesId, id), eq(priceLists.status, "draft")))
    .limit(1);
  if (open) return { id: open.id, version: open.version, existing: true };

  const newId = gen("pl");
  await tx.insert(priceLists).values({
    id: newId,
    refNo: input.refNo !== undefined ? input.refNo : row.refNo,
    name: input.name?.trim() || row.name,
    version: row.version + 1,
    supersedesId: row.id,
    documentId: null,
    effectiveFrom: input.effectiveFrom,
    validityDays: row.validityDays,
    taxBasis: row.taxBasis,
    gstBp: row.gstBp,
    deliveryBasis: row.deliveryBasis,
    freightTerm: row.freightTerm,
    freightPerLitrePaise: row.freightPerLitrePaise,
    parentListId: row.parentListId,
    derivation: row.derivation,
    unitBasis: row.unitBasis,
    kind: row.kind,
    status: "draft",
    termsText: row.termsText,
    signatory: row.signatory,
    notes: row.notes,
    createdById: ctx.user.id,
    updatedById: ctx.user.id,
  });

  await tx.execute(sql`
    insert into price_list_rates (id, price_list_id, product_id, rate_ex_gst_paise, rate_incl_gst_paise,
                                  min_cans, max_cans, offered, match_status, updated_by_id)
    select ${sql.raw("'plr_' || substr(md5(random()::text), 1, 12)")}, ${newId}, r.product_id,
           r.rate_ex_gst_paise, r.rate_incl_gst_paise, r.min_cans, r.max_cans, r.offered,
           'manual', ${ctx.user.id}
      from price_list_rates r where r.price_list_id = ${id}
  `);
  await tx.execute(sql`
    insert into price_list_discount_terms (id, price_list_id, kind, percent_bp, threshold_litres, threshold_paise, raw_text)
    select ${sql.raw("'plt_' || substr(md5(random()::text), 1, 12)")}, ${newId}, t.kind, t.percent_bp,
           t.threshold_litres, t.threshold_paise, t.raw_text
      from price_list_discount_terms t where t.price_list_id = ${id}
  `);
  await tx.execute(sql`
    insert into price_list_scopes (id, price_list_id, scope_kind, scope_value, scope_label, parent_key,
                                   freight_term_match, priority, valid_from, valid_to, excluded, created_by_id)
    select ${sql.raw("'pls_' || substr(md5(random()::text), 1, 12)")}, ${newId}, s.scope_kind, s.scope_value,
           s.scope_label, s.parent_key, s.freight_term_match, s.priority, s.valid_from, s.valid_to, s.excluded, ${ctx.user.id}
      from price_list_scopes s where s.price_list_id = ${id}
  `);

  await audit(tx, ctx, {
    action: "pricelist.version",
    entityType: "price_list",
    entityId: newId,
    after: { from: id, version: row.version + 1, effectiveFrom: input.effectiveFrom },
  });
  return { id: newId, version: row.version + 1, existing: false };
}

/**
 * Publish a draft inside the caller's transaction: the checks, the predecessor
 * dated out (still in force until the new one starts), the scopes carried
 * over, the status guard and the audit row. Returns the list's name and the
 * warnings a screen should show.
 */
export async function publishDraftIn(
  tx: Tx,
  ctx: DeskCtx,
  id: string,
  input: { supersedesId?: string | null; effectiveFrom: string },
  config: Config,
  day: string,
): Promise<{ name: string; warnings: string[] }> {
  const effectiveFrom = input.effectiveFrom;
  const warnings: string[] = [];
  let name = "";
  let rateCount = 0;
  const row = await lockedList(tx, id);
  if (!row) throw new Refused(err("That price list does not exist.", "not_found"));
  if (row.status !== "draft") throw new Refused(err(`This list is already ${row.status}.`, "rule_violation"));
  name = row.name;
  /* One list per shop: the picture BEFORE this publish, read on the same
     transaction, so the check at the end can tell a shop this list newly puts
     on a second book from one that was on both already. A shop's own agreed
     prices are not an allocation and are not checked. */
  const oneList = config["pricing.oneListPerShop"] && row.kind !== "agreed";
  const before = oneList ? await loadWorld(tx) : null;

  const [{ rates }] = await tx.execute<{ rates: number }>(sql`
    select count(*)::int as rates from price_list_rates where price_list_id = ${id}
  `);
  rateCount = Number(rates);
  if (!rateCount) {
    throw new Refused(err("This list has no rates in it. A list with no prices is not a list.", "rule_violation"));
  }
  const [{ scopes }] = await tx.execute<{ scopes: number }>(sql`
    select count(*)::int as scopes from price_list_scopes where price_list_id = ${id}
  `);

  const supersedes = input?.supersedesId ? await lockedList(tx, input.supersedesId) : null;
  if (input?.supersedesId && !supersedes) throw new Refused(fieldErr("supersedesId", "That list does not exist."));
  if (supersedes && supersedes.status !== "published") {
    throw new Refused(fieldErr("supersedesId", `That list is ${supersedes.status}, so there is nothing to supersede.`));
  }
  if (supersedes) {
    /* One successor per list. A second would date the old list out to a
       different day and leave two versions claiming to take over. */
    const already = await publishedSuccessor(tx, supersedes.id, id);
    if (already) {
      throw new Refused(
        fieldErr(
          "supersedesId",
          `${supersedes.name} is already being replaced by ${already.name} from ${already.effectiveFrom}. Supersede that version instead.`,
        ),
      );
    }
  }

  // A derived list is checked against its own rule before it goes out. Not
  // refused: the office overrides a cell deliberately often enough that a
  // block would be worked around, and a warning is read.
  if (row.parentListId && row.derivation) {
    const drift = await tx.execute<{ name: string; expected: number; actual: number }>(sql`
      select p.name,
             child.rate_ex_gst_paise as actual,
             parent.rate_ex_gst_paise as expected
        from price_list_rates child
        join price_list_rates parent
          on parent.price_list_id = ${row.parentListId}
         and parent.product_id = child.product_id
         and coalesce(parent.min_cans, 0) = coalesce(child.min_cans, 0)
        join products p on p.id = child.product_id
       where child.price_list_id = ${id}
    `);
    const tolerance = config["pricing.derivationTolerancePaise"];
    let off = 0;
    for (const d of drift) {
      const expected = deriveRate(Number(d.expected), null, row.derivation as PriceDerivation);
      if (expected != null && Math.abs(expected - Number(d.actual)) > tolerance) off++;
    }
    if (off) warnings.push(`${off} rate${off === 1 ? " is" : "s are"} further from this list's own rule than the tolerance allows.`);
  }

  if (supersedes) {
    /* Dated out to the day before this one starts — and still PUBLISHED
       until then when that day is in the future, so the shops on it keep
       their prices instead of falling to a wider list in between. */
    const ended = await supersedePredecessor(tx, {
      oldId: supersedes.id,
      newFrom: effectiveFrom,
      day,
      userId: ctx.user.id,
    });
    if (ended.status === "published") {
      warnings.push(`${supersedes.name} stays in force until ${ended.effectiveTo}; this one takes over on ${effectiveFrom}.`);
    }

    // A new version with nobody on it would silently apply to nothing;
    // inheriting the scopes is what makes "publish next month's list"
    // one act rather than two, and the second one easy to forget.
    if (!Number(scopes)) {
      const old = await tx.select().from(priceListScopes).where(eq(priceListScopes.priceListId, supersedes.id));
      if (old.length) {
        await tx.insert(priceListScopes).values(
          old.map((s) => ({
            id: gen("pls"),
            priceListId: id,
            scopeKind: s.scopeKind,
            scopeValue: s.scopeValue,
            scopeLabel: s.scopeLabel,
            parentKey: s.parentKey,
            freightTermMatch: s.freightTermMatch,
            priority: s.priority,
            validFrom: s.validFrom,
            validTo: s.validTo,
            excluded: s.excluded,
            createdById: ctx.user.id,
          })),
        );
        warnings.push(`Carried ${old.length} scope${old.length === 1 ? "" : "s"} over from ${supersedes.name}.`);
      }
    }
  } else if (!Number(scopes)) {
    warnings.push("Nobody is on this list yet, so no shop will be priced from it. Add who it applies to.");
  }

  const published = await tx
    .update(priceLists)
    .set({
      status: "published",
      effectiveFrom,
      supersedesId: supersedes?.id ?? row.supersedesId,
      publishedAt: new Date(),
      publishedById: ctx.user.id,
      updatedAt: new Date(),
      updatedById: ctx.user.id,
    })
    .where(and(eq(priceLists.id, id), eq(priceLists.status, "draft")))
    .returning({ id: priceLists.id });
  if (!published.length) throw new Refused(err("This list has just been published by somebody else.", "conflict"));

  /* "Move here" answered while this was a draft: each shop leaves the book it
     was on, from the day this list starts, so the old book goes on pricing it
     until then. */
  const moves = (row.pendingMoves ?? []).filter((m) => m && m.customerId && m.fromBookId);
  if (moves.length) {
    const [mine] = await tx.execute<{ bookId: string | null }>(sql`select book_id as "bookId" from price_lists where id = ${id}`);
    for (const m of moves) {
      if (m.fromBookId === (mine?.bookId ?? id)) continue;
      const [shop] = await tx.execute<{ name: string }>(sql`select name from customers where id = ${m.customerId}`);
      if (!shop) continue;
      await leaveShopOutOfBook(tx, {
        bookId: m.fromBookId,
        customerId: m.customerId,
        label: shop.name,
        validFrom: effectiveFrom > day ? effectiveFrom : null,
        userId: ctx.user.id,
        day,
      });
    }
    await tx.update(priceLists).set({ pendingMoves: null }).where(eq(priceLists.id, id));
    warnings.push(`Moved ${moves.length} shop${moves.length === 1 ? "" : "s"} onto this list from the list${moves.length === 1 ? "" : "s"} they were on.`);
  }

  if (before) {
    const [mine] = await tx.execute<{ bookId: string | null }>(sql`select book_id as "bookId" from price_lists where id = ${id}`);
    const refusal = await newClashRefusal(tx, before, mine?.bookId ?? id, day);
    if (refusal) throw new Refused(err(refusal, "rule_violation"));
  }

  await audit(tx, ctx, {
    action: "pricelist.publish",
    entityType: "price_list",
    entityId: id,
    before: { status: "draft" },
    after: { status: "published", effectiveFrom, supersedes: supersedes?.id ?? null, rates: rateCount },
  });
  return { name, warnings };
}
