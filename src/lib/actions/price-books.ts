"use server";

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { and, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { priceChangeEvents, priceChanges, priceLists, type PriceChangeNotify } from "@/db/schema";
import { requirePriceDesk } from "@/lib/services/price-desk";
import { getConfig } from "@/lib/config/store";
import { addDays } from "@/lib/business-date";
import { today } from "@/lib/recompute";
import { notifyUsers } from "@/lib/notify";
import { exFromIncl, listInclFromEx } from "@/lib/engines/price-math";
import {
  approvalRefusal,
  changedCells,
  countChanges,
  diffRates,
  goLiveProblem,
  largestDrop,
  needsSecondApprover,
  openFlags,
  ratesHash,
  revenueEffect,
  runChecks,
  submitRefusal,
  type ChangeFlag,
} from "@/lib/engines/price-change";
import { applyInstruction, describeRule, parseSimpleInstruction, ruleQuestions, type InstructionRule, type ProposedPrice } from "@/lib/engines/price-instruction";
import { audit, draftVersionIn, lockedList, publishDraftIn, Refused, type Tx } from "@/lib/services/price-write";
import { supersedeEndedPriceLists } from "@/lib/services/price-supersede";
import {
  billedFor,
  changeFacts,
  listBooks,
  neighbourRates,
  overridesForShops,
  shopResolutions,
  volumeFor,
  type ChangeFacts,
} from "@/lib/services/price-book-service";
import { priceDeskPeople } from "@/lib/services/price-desk-people";
import { aiReadInstruction, aiReviewChange, aiSecondOpinion, type ReviewEvidence } from "@/lib/price-ai/change-ai";
import { aiReadiness } from "@/lib/price-ai/providers";
import type { ChangeAiReview } from "@/lib/price-book-views";
import { err, fieldErr, fromThrown, ok, okVoid, type Result } from "@/lib/result";

/* ---------------------------------------------------------------------------
 * EVERY WRITE A PRICE BOOK TAKES — start a change, edit it, check it, send
 * it, approve it, send it back, schedule or cancel it.
 *
 * A change is a DRAFT VERSION of the book's newest revision, so publishing it
 * is the same `publishDraftIn` the list screens use, run inside the approval's
 * own transaction: the change is marked approved in the same commit that puts
 * its prices in force, or neither happens. The base revision is dated out to
 * the day before the go-live date and goes on pricing until then.
 *
 * EVERY CHECK RUNS HERE, NOT IN THE BROWSER. The step bar draws what these
 * functions will answer, from the same engine, but a server action is a URL:
 * sending a change re-runs the date check and compares the rates against the
 * ones that were checked, and approving does both again under a lock.
 * ------------------------------------------------------------------------- */

const gen = (prefix: string) => `${prefix}_${randomUUID().slice(0, 12)}`;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function refresh(bookId?: string) {
  try {
    for (const base of ["/accounts/price-lists", "/founder/price-lists", "/crm/price-lists"]) {
      revalidatePath(base, "layout");
      if (bookId) revalidatePath(`${base}/books/${bookId}`);
    }
  } catch {
    /* No request context — a job or a test. */
  }
}

type DeskCtx = Awaited<ReturnType<typeof requirePriceDesk>>;

async function event(
  tx: Pick<Tx, "insert">,
  input: { changeId: string; bookId: string; kind: string; actorId: string | null; note?: string | null; detail?: unknown },
) {
  await tx.insert(priceChangeEvents).values({
    id: gen("pce"),
    changeId: input.changeId,
    bookId: input.bookId,
    kind: input.kind,
    actorId: input.actorId,
    note: input.note ?? null,
    detail: (input.detail ?? null) as never,
  });
}

/** The change row LOCKED, inside the caller's transaction. */
async function lockedChange(tx: Tx, id: string) {
  const [row] = await tx.select().from(priceChanges).where(eq(priceChanges.id, id)).for("update");
  if (!row) throw new Refused(err("That change does not exist.", "not_found"));
  return row;
}

function editable(status: string): boolean {
  return status === "draft" || status === "sent_back";
}

/** Only the maker edits — anybody else takes the change over first, openly. */
function assertMaker(row: { makerId: string }, ctx: DeskCtx) {
  if (row.makerId !== ctx.user.id) {
    throw new Refused(err("This change is somebody else's. Take it over first if you are finishing it for them.", "rule_violation"));
  }
}

function linkFor(basePath: string, bookId: string, changeId?: string) {
  return changeId ? `${basePath}/books/${bookId}/changes/${changeId}` : `${basePath}/books/${bookId}`;
}

/* ------------------------------------------------------------- starting */

/**
 * Open a change on a book: a draft copy of its newest revision. An open
 * change already on the book is returned rather than a second one made — one
 * book, one next revision. `restoreFromListId` starts from an older revision's
 * prices instead, as a new change that goes through Check and Approve again.
 */
export async function startChange(
  bookId: string,
  input?: { title?: string | null; restoreFromListId?: string | null },
): Promise<Result<{ changeId: string; existing: boolean }>> {
  try {
    const ctx = await requirePriceDesk();
    const day = await today();
    const made = await db.transaction(async (tx) => {
      const [open] = await tx.execute<{ id: string }>(sql`
        select id from price_changes where book_id = ${bookId} and status in ('draft', 'submitted', 'sent_back') limit 1
      `);
      if (open) return { changeId: open.id, existing: true };

      // The newest published version: scheduled if one is waiting, else in force.
      const [head] = await tx.execute<{ id: string; effectiveFrom: string }>(sql`
        select id, effective_from::text as "effectiveFrom" from price_lists
         where book_id = ${bookId} and status = 'published'
         order by version desc, effective_from desc limit 1
      `);
      if (!head) {
        throw new Refused(err("This book has no published revision to change. Publish it from the list screens first.", "rule_violation"));
      }
      // A day after today, and after the base's own start — the earliest it could go live.
      const earliest = [addDays(day, 1), addDays(head.effectiveFrom, 1)].sort().at(-1)!;
      const draft = await draftVersionIn(tx, ctx, head.id, { effectiveFrom: earliest });

      if (input?.restoreFromListId) {
        const [from] = await tx.execute<{ id: string; bookId: string }>(sql`
          select id, book_id as "bookId" from price_lists where id = ${input.restoreFromListId}
        `);
        if (!from || from.bookId !== bookId) throw new Refused(err("That revision is not part of this book.", "not_found"));
        await tx.execute(sql`delete from price_list_rates where price_list_id = ${draft.id}`);
        await tx.execute(sql`
          insert into price_list_rates (id, price_list_id, product_id, rate_ex_gst_paise, rate_incl_gst_paise,
                                        min_cans, max_cans, offered, match_status, updated_by_id)
          select ${sql.raw("'plr_' || substr(md5(random()::text), 1, 12)")}, ${draft.id}, r.product_id,
                 r.rate_ex_gst_paise, r.rate_incl_gst_paise, r.min_cans, r.max_cans, r.offered, 'manual', ${ctx.user.id}
            from price_list_rates r where r.price_list_id = ${from.id}
        `);
      }

      const changeId = gen("pch");
      await tx.insert(priceChanges).values({
        id: changeId,
        bookId,
        baseListId: head.id,
        draftListId: draft.id,
        status: "draft",
        title: input?.title?.trim() || null,
        source: input?.restoreFromListId ? "restore" : "editor",
        restoredFromListId: input?.restoreFromListId ?? null,
        makerId: ctx.user.id,
        goLive: earliest,
      });
      await event(tx, {
        changeId,
        bookId,
        kind: input?.restoreFromListId ? "restored" : "created",
        actorId: ctx.user.id,
        detail: { base: head.id, draft: draft.id, adoptedDraft: draft.existing, restoredFrom: input?.restoreFromListId ?? null },
      });
      await audit(tx, ctx, { action: "pricebook.change.start", entityType: "price_change", entityId: changeId, after: { bookId, base: head.id } });
      return { changeId, existing: false };
    });
    refresh(bookId);
    return ok(made, made.existing ? "This book already has a change open — opened it." : "Started. Shops keep paying the live prices until this is approved and its day comes.");
  } catch (e) {
    if (e instanceof Refused) return e.result;
    return fromThrown(e);
  }
}

/* -------------------------------------------------------------- editing */

const cellInput = z.object({
  productId: z.string().min(1),
  minCans: z.number().int().positive().nullable(),
  /** Exactly one of the two prices, in paise; the other is derived. */
  inclPaise: z.number().int().nullable().optional(),
  exPaise: z.number().int().nullable().optional(),
  offered: z.boolean().optional(),
  remove: z.boolean().optional(),
});
export type ChangeCellInput = z.input<typeof cellInput>;

/** Writes cells into the change's draft, in the caller's transaction. Refuses a change that is not being edited. */
async function writeCells(
  tx: Tx,
  ctx: DeskCtx,
  change: { id: string; bookId: string; draftListId: string },
  cells: z.infer<typeof cellInput>[],
): Promise<number> {
  const list = await lockedList(tx, change.draftListId);
  if (!list || list.status !== "draft") throw new Refused(err("The change's draft is no longer a draft.", "conflict"));
  const derived = !!(list.parentListId && list.derivation);
  let written = 0;
  for (const c of cells) {
    if (c.remove) {
      const gone = await tx.execute(sql`
        delete from price_list_rates where price_list_id = ${list.id} and product_id = ${c.productId}
           and coalesce(min_cans, 0) = ${c.minCans ?? 0}
      `);
      written += Number((gone as unknown as { count?: number }).count ?? 1);
      continue;
    }
    let ex: number;
    let incl: number;
    if (c.inclPaise != null) {
      incl = c.inclPaise;
      ex = exFromIncl(incl, list.gstBp);
    } else if (c.exPaise != null) {
      ex = c.exPaise;
      incl = listInclFromEx(ex, list.gstBp, derived);
    } else if (c.offered != null) {
      await tx.execute(sql`
        update price_list_rates set offered = ${c.offered}, updated_at = now(), updated_by_id = ${ctx.user.id}
         where price_list_id = ${list.id} and product_id = ${c.productId} and coalesce(min_cans, 0) = ${c.minCans ?? 0}
      `);
      written++;
      continue;
    } else {
      continue;
    }
    if (!Number.isFinite(ex) || ex < 0) throw new Refused(fieldErr(`cell.${c.productId}`, "A price cannot be negative."));
    await tx.execute(sql`
      insert into price_list_rates (id, price_list_id, product_id, rate_ex_gst_paise, rate_incl_gst_paise,
                                    min_cans, offered, match_status, updated_by_id)
      values (${gen("plr")}, ${list.id}, ${c.productId}, ${ex}, ${incl}, ${c.minCans}, ${c.offered ?? true}, 'manual', ${ctx.user.id})
      on conflict (price_list_id, product_id, coalesce(min_cans, 0)) do update
        set rate_ex_gst_paise = excluded.rate_ex_gst_paise,
            rate_incl_gst_paise = excluded.rate_incl_gst_paise,
            offered = ${c.offered ?? true},
            updated_at = now(), updated_by_id = ${ctx.user.id}
    `);
    written++;
  }
  // Any edit makes the last check stale; the hash would say so too, this says it on the row.
  await tx.update(priceChanges).set({ checkedHash: null, updatedAt: new Date() }).where(eq(priceChanges.id, change.id));
  await tx.update(priceLists).set({ updatedAt: new Date(), updatedById: ctx.user.id }).where(eq(priceLists.id, list.id));
  return written;
}

/** One "edited" event per sitting rather than one per keystroke. */
async function editedEvent(tx: Tx, change: { id: string; bookId: string }, ctx: DeskCtx, count: number, kind = "edited", note?: string) {
  if (kind === "edited") {
    const [recent] = await tx.execute<{ id: string }>(sql`
      select id from price_change_events
       where change_id = ${change.id} and kind = 'edited' and actor_id = ${ctx.user.id}
         and created_at > now() - interval '15 minutes'
       limit 1
    `);
    if (recent) return;
  }
  await event(tx, { changeId: change.id, bookId: change.bookId, kind, actorId: ctx.user.id, note: note ?? null, detail: { cells: count } });
}

export async function setChangeCells(changeId: string, cells: ChangeCellInput[]): Promise<Result<{ written: number }>> {
  try {
    const ctx = await requirePriceDesk();
    const parsed = z.array(cellInput).max(5000).safeParse(cells);
    if (!parsed.success) return err(parsed.error.issues[0]?.message ?? "Those prices are not valid.", "validation");
    const written = await db.transaction(async (tx) => {
      const row = await lockedChange(tx, changeId);
      if (!editable(row.status)) throw new Refused(err("This change has been sent for approval. Withdraw it to edit again.", "rule_violation"));
      assertMaker(row, ctx);
      const n = await writeCells(tx, ctx, row, parsed.data);
      await editedEvent(tx, row, ctx, n);
      return n;
    });
    return ok({ written });
  } catch (e) {
    if (e instanceof Refused) return e.result;
    return fromThrown(e);
  }
}

/** Copy prices from another book's live revision — every cell, or only products this one lacks. */
export async function copyFromBook(changeId: string, sourceListId: string, mode: "missing" | "all"): Promise<Result<{ written: number }>> {
  try {
    const ctx = await requirePriceDesk();
    const written = await db.transaction(async (tx) => {
      const row = await lockedChange(tx, changeId);
      if (!editable(row.status)) throw new Refused(err("This change is not being edited.", "rule_violation"));
      assertMaker(row, ctx);
      const src = await tx.execute<{ productId: string; minCans: number | null; ex: string | number; offered: boolean }>(sql`
        select r.product_id as "productId", r.min_cans as "minCans", r.rate_ex_gst_paise as ex, r.offered
          from price_list_rates r join price_lists l on l.id = r.price_list_id
         where r.price_list_id = ${sourceListId} and l.status = 'published'
      `);
      if (!src.length) throw new Refused(err("That book has no prices to copy.", "not_found"));
      const have = new Set(
        [...(await tx.execute<{ k: string }>(sql`
          select product_id || '|' || coalesce(min_cans, 0) as k from price_list_rates where price_list_id = ${row.draftListId}
        `))].map((r) => r.k),
      );
      const cells = [...src]
        .filter((r) => mode === "all" || !have.has(`${r.productId}|${r.minCans ?? 0}`))
        .map((r) => ({ productId: r.productId, minCans: r.minCans == null ? null : Number(r.minCans), exPaise: Number(r.ex), offered: r.offered }));
      const n = await writeCells(tx, ctx, row, cells);
      await editedEvent(tx, row, ctx, n, "copied", `From ${sourceListId} (${mode === "all" ? "every price" : "missing products only"})`);
      return n;
    });
    return ok({ written }, `${written} price${written === 1 ? "" : "s"} copied.`);
  } catch (e) {
    if (e instanceof Refused) return e.result;
    return fromThrown(e);
  }
}

/* ---------------------------------------------------------- instruction */

const targetZ = z.object({
  families: z.array(z.string()),
  productIds: z.array(z.string()),
  minLitres: z.number().nullable(),
  maxLitres: z.number().nullable(),
});
const ruleZ: z.ZodType<InstructionRule> = z.object({
  op: z.enum(["percent", "per_litre", "per_can", "set"]),
  valueBp: z.number().int().nullable(),
  valuePaise: z.number().int().nullable(),
  basis: z.enum(["incl", "ex"]),
  target: targetZ,
  rounding: z.enum(["none", "rupee", "five", "ten"]),
  exceptions: z.array(
    targetZ.extend({
      action: z.enum(["hold", "percent", "set"]),
      valueBp: z.number().int().nullable(),
      valuePaise: z.number().int().nullable(),
    }),
  ),
});

export type InstructionPreview = {
  rule: InstructionRule;
  words: string;
  questions: string[];
  proposals: ProposedPrice[];
  /** Who read the sentence: the plain-sentence reader, or a named model. */
  by: string;
};

/**
 * Reads a sentence into a rule and shows what it would do — WRITING NOTHING.
 * Plain sentences are read by code; anything else is read by a model, whose
 * rule is then computed here like any other. The prices in the preview are
 * this engine's, never the model's.
 */
export async function previewInstruction(changeId: string, text: string): Promise<Result<InstructionPreview>> {
  try {
    const ctx = await requirePriceDesk();
    if (!text.trim()) return fieldErr("text", "Describe the change, e.g. “everything up 5%, Nano held, round to the rupee”.");
    const facts = await changeFacts(changeId);
    if (!facts) return err("That change does not exist.", "not_found");
    const families = [...new Set(facts.draft.map((r) => r.family))];
    let rule = parseSimpleInstruction(text, families);
    let by = "MahekOne";
    let question: string | null = null;
    if (!rule) {
      const ai = await aiReadInstruction({
        changeId,
        text,
        families,
        products: facts.draft.map((r) => ({ id: r.productId, name: r.productName })),
        userId: ctx.user.id,
      });
      if (!ai.rule) {
        return err(
          ai.question ?? ai.reason ?? "That sentence could not be read. Try a plain form: “+5% on everything, round to the rupee”.",
          "validation",
        );
      }
      rule = ai.rule;
      by = ai.by ?? "AI";
      question = ai.question;
    }
    const proposals = applyInstruction(facts.draft, rule, facts.draftList.gstBp);
    const questions = [...(question ? [question] : []), ...ruleQuestions(facts.draft, rule, facts.draftList.gstBp)];
    return ok({ rule, words: describeRule(rule), questions, proposals, by });
  } catch (e) {
    return fromThrown(e);
  }
}

/** Applies a previewed rule. The prices are COMPUTED AGAIN here from the draft as it now stands. */
export async function applyInstructionRule(changeId: string, rule: InstructionRule, text: string): Promise<Result<{ written: number }>> {
  try {
    const ctx = await requirePriceDesk();
    const parsed = ruleZ.safeParse(rule);
    if (!parsed.success) return err("That rule is not valid.", "validation");
    const facts = await changeFacts(changeId);
    if (!facts) return err("That change does not exist.", "not_found");
    const proposals = applyInstruction(facts.draft, parsed.data, facts.draftList.gstBp);
    if (!proposals.length) return err("This instruction does not change any price.", "rule_violation");
    const written = await db.transaction(async (tx) => {
      const row = await lockedChange(tx, changeId);
      if (!editable(row.status)) throw new Refused(err("This change is not being edited.", "rule_violation"));
      assertMaker(row, ctx);
      const n = await writeCells(
        tx,
        ctx,
        row,
        proposals.map((p) => ({ productId: p.productId, minCans: p.minCans, exPaise: p.afterExPaise, inclPaise: null, offered: true })),
      );
      // The printed figure is what the rule rounded; keep it exactly.
      for (const p of proposals) {
        await tx.execute(sql`
          update price_list_rates set rate_incl_gst_paise = ${p.afterInclPaise}
           where price_list_id = ${row.draftListId} and product_id = ${p.productId} and coalesce(min_cans, 0) = ${p.minCans ?? 0}
        `);
      }
      if (!row.reason) await tx.update(priceChanges).set({ reason: text.trim().slice(0, 500) }).where(eq(priceChanges.id, row.id));
      await editedEvent(tx, row, ctx, n, "instruction", `${text.trim()} → ${describeRule(parsed.data)}`);
      return n;
    });
    return ok({ written }, `${written} price${written === 1 ? "" : "s"} changed. Nothing is live until the change is approved.`);
  } catch (e) {
    if (e instanceof Refused) return e.result;
    return fromThrown(e);
  }
}

/* ------------------------------------------------------------- details */

export async function setChangeDetails(
  changeId: string,
  input: { title?: string | null; reason?: string | null; goLive?: string | null; notify?: PriceChangeNotify },
): Promise<Result> {
  try {
    const ctx = await requirePriceDesk();
    if (input.goLive != null && !ISO_DATE.test(input.goLive)) return fieldErr("goLive", "That is not a date.");
    if (input.notify?.shopsOn && !ISO_DATE.test(input.notify.shopsOn)) return fieldErr("notify.shopsOn", "That is not a date.");
    const day = await today();
    await db.transaction(async (tx) => {
      const row = await lockedChange(tx, changeId);
      if (!editable(row.status)) throw new Refused(err("This change has been sent; its details are fixed until it comes back.", "rule_violation"));
      assertMaker(row, ctx);
      if (input.goLive) {
        const [base] = row.baseListId
          ? await tx.execute<{ effectiveFrom: string }>(sql`select effective_from::text as "effectiveFrom" from price_lists where id = ${row.baseListId}`)
          : [];
        const problem = goLiveProblem(input.goLive, day, base?.effectiveFrom ?? null);
        if (problem) throw new Refused(fieldErr("goLive", problem.message));
      }
      await tx
        .update(priceChanges)
        .set({
          ...(input.title !== undefined ? { title: input.title?.trim() || null } : {}),
          ...(input.reason !== undefined ? { reason: input.reason?.trim() || null } : {}),
          ...(input.goLive !== undefined ? { goLive: input.goLive } : {}),
          ...(input.notify !== undefined ? { notify: input.notify } : {}),
          updatedAt: new Date(),
        })
        .where(eq(priceChanges.id, changeId));
      if (input.goLive) await tx.update(priceLists).set({ effectiveFrom: input.goLive }).where(eq(priceLists.id, row.draftListId));
    });
    refresh();
    return okVoid("Saved.");
  } catch (e) {
    if (e instanceof Refused) return e.result;
    return fromThrown(e);
  }
}

/* ---------------------------------------------------------------- check */

async function evidenceFor(facts: ChangeFacts): Promise<ReviewEvidence & { flagsInput: Parameters<typeof runChecks>[0] }> {
  const config = await getConfig();
  const diffs = diffRates(facts.base, facts.draft);
  const changed = changedCells(diffs);
  const [neighbours, overrides, volume, billed] = await Promise.all([
    neighbourRates(facts.change.bookId, facts.day),
    overridesForShops(facts.shopIds, facts.day),
    volumeFor(facts.shopIds, config["pricing.changes.effectVolumeMonths"], facts.day),
    billedFor(facts.shopIds, changed.map((d) => d.productId), 6, facts.day),
  ]);
  const byProduct = new Map<string, number[]>();
  for (const n of neighbours) byProduct.set(n.productId, [...(byProduct.get(n.productId) ?? []), n.rateExGstPaise]);
  const neighbourMedian = new Map<string, number>();
  for (const [k, v] of byProduct) {
    const s = [...v].sort((a, b) => a - b);
    const m = Math.floor(s.length / 2);
    neighbourMedian.set(k, s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2));
  }
  const counts = countChanges(diffs);
  const effect = revenueEffect(diffs, volume);
  return {
    bookName: facts.baseList?.name ?? facts.draftList.name,
    freightTerm: facts.draftList.freightTerm,
    gstBp: facts.draftList.gstBp,
    reason: facts.change.reason,
    changed,
    neighbourMedian,
    billed,
    totals: { changed: counts.changed, up: counts.up, down: counts.down, effectPerMonthPaise: effect.totalPerMonthPaise },
    flagsInput: {
      base: facts.base,
      draft: facts.draft,
      gstBp: facts.draftList.gstBp,
      derived: facts.draftList.derived,
      goLive: facts.change.goLive,
      baseEffectiveFrom: facts.baseList?.effectiveFrom ?? null,
      today: facts.day,
      neighbours,
      overrides,
      bigMoveBp: config["pricing.changes.bigMovePercent"] * 100,
      typoFactor: config["pricing.changes.typoFactor"],
    },
  };
}

/**
 * Runs the rule checks and — where asked and connected — the two independent
 * AI reviews, and stores the result against the exact rates it read.
 */
export async function checkChange(changeId: string, input?: { ai?: boolean }): Promise<Result<{ flags: ChangeFlag[]; reviews: ChangeAiReview[] }>> {
  try {
    const ctx = await requirePriceDesk();
    const facts = await changeFacts(changeId);
    if (!facts) return err("That change does not exist.", "not_found");
    if (!editable(facts.change.status)) return err("Only a change being edited is checked; this one has been sent.", "rule_violation");
    const evidence = await evidenceFor(facts);
    const flags = runChecks(evidence.flagsInput);
    const hash = ratesHash(facts.draft);

    let reviews: ChangeAiReview[] = [];
    if (input?.ai !== false && evidence.changed.length) {
      const ready = await aiReadiness();
      if (ready.openai || ready.anthropic) reviews = await aiReviewChange({ changeId, userId: ctx.user.id, evidence });
    }
    const all = [...flags, ...reviews.flatMap((r) => r.findings)];
    const counts = countChanges(diffRates(facts.base, facts.draft));

    await db.transaction(async (tx) => {
      const row = await lockedChange(tx, changeId);
      if (!editable(row.status)) throw new Refused(err("This change was sent while it was being checked.", "conflict"));
      /* The draft must still be what was checked — a cell saved while the
         reviewers were thinking makes this check describe other prices. */
      const now = (await changeFacts(changeId))!;
      if (ratesHash(now.draft) !== hash) throw new Refused(err("Prices changed while the check ran. Check again.", "conflict"));
      const stale = (row.checks ?? {}) as { secondOpinion?: unknown };
      await tx
        .update(priceChanges)
        .set({
          checks: { flags: all, reviews, counts, secondOpinion: stale.secondOpinion ?? null } as never,
          checkedAt: new Date(),
          checkedHash: hash,
          updatedAt: new Date(),
        })
        .where(eq(priceChanges.id, changeId));
      await event(tx, {
        changeId,
        bookId: row.bookId,
        kind: "checked",
        actorId: ctx.user.id,
        detail: {
          flags: flags.length,
          blocking: flags.filter((f) => f.blocking).length,
          ai: reviews.map((r) => ({ provider: r.provider, ok: r.ok, findings: r.findings.length })),
        },
      });
    });
    refresh(facts.change.bookId);
    return ok({ flags: all, reviews }, all.length ? `${all.length} thing${all.length === 1 ? "" : "s"} to look at.` : "Checked. Nothing found.");
  } catch (e) {
    if (e instanceof Refused) return e.result;
    return fromThrown(e);
  }
}

/** Mark one flag as intended, with why. Blocking flags cannot be: they must be fixed. */
export async function acknowledgeFlag(changeId: string, key: string, note: string): Promise<Result> {
  try {
    const ctx = await requirePriceDesk();
    if (!note.trim()) return fieldErr("note", "Say why it is intended. The approver reads this.");
    await db.transaction(async (tx) => {
      const row = await lockedChange(tx, changeId);
      if (!editable(row.status)) throw new Refused(err("This change is not being edited.", "rule_violation"));
      assertMaker(row, ctx);
      const flags = ((row.checks ?? {}) as { flags?: ChangeFlag[] }).flags ?? [];
      const flag = flags.find((f) => f.key === key);
      if (!flag) throw new Refused(err("That flag is no longer on the check. Check again.", "not_found"));
      if (flag.blocking) throw new Refused(err("This one has to be fixed, not explained.", "rule_violation"));
      const acks = { ...(row.acks ?? {}), [key]: { note: note.trim(), byId: ctx.user.id, at: new Date().toISOString() } };
      await tx.update(priceChanges).set({ acks, updatedAt: new Date() }).where(eq(priceChanges.id, changeId));
      await event(tx, { changeId, bookId: row.bookId, kind: "ack", actorId: ctx.user.id, note: note.trim(), detail: { key, message: flag.message } });
    });
    return okVoid("Noted. It travels to the approver.");
  } catch (e) {
    if (e instanceof Refused) return e.result;
    return fromThrown(e);
  }
}

export async function clearAcknowledgement(changeId: string, key: string): Promise<Result> {
  try {
    const ctx = await requirePriceDesk();
    await db.transaction(async (tx) => {
      const row = await lockedChange(tx, changeId);
      if (!editable(row.status)) throw new Refused(err("This change is not being edited.", "rule_violation"));
      assertMaker(row, ctx);
      const acks = { ...(row.acks ?? {}) };
      delete acks[key];
      await tx.update(priceChanges).set({ acks, updatedAt: new Date() }).where(eq(priceChanges.id, changeId));
    });
    return okVoid("Cleared.");
  } catch (e) {
    if (e instanceof Refused) return e.result;
    return fromThrown(e);
  }
}

/* ----------------------------------------------------------------- send */

export async function submitChange(changeId: string): Promise<Result> {
  try {
    const ctx = await requirePriceDesk();
    const config = await getConfig();
    const facts = await changeFacts(changeId);
    if (!facts) return err("That change does not exist.", "not_found");
    const volume = await volumeFor(facts.shopIds, config["pricing.changes.effectVolumeMonths"], facts.day);
    const diffs = diffRates(facts.base, facts.draft);
    const effect = revenueEffect(diffs, volume);
    const needsSecond = needsSecondApprover({
      effectPerMonthPaise: effect.totalPerMonthPaise,
      dropPerMonthPaise: effect.dropPerMonthPaise,
      largestDropBp: largestDrop(diffs),
      aboveEffectPaise: config["pricing.changes.secondApproverAbovePaise"],
      dropPercent: config["pricing.changes.secondApproverDropPercent"],
    });
    const hash = ratesHash(facts.draft);
    let bookId = "";
    await db.transaction(async (tx) => {
      const row = await lockedChange(tx, changeId);
      bookId = row.bookId;
      assertMaker(row, ctx);
      const flags = ((row.checks ?? {}) as { flags?: ChangeFlag[] }).flags ?? [];
      const refusal = submitRefusal({
        status: row.status,
        checkedHash: row.checkedHash,
        currentHash: hash,
        flags,
        acks: row.acks ?? {},
        goLive: row.goLive,
        reason: row.reason,
      });
      if (refusal) throw new Refused(err(refusal, "rule_violation"));
      const date = goLiveProblem(row.goLive, facts.day, facts.baseList?.effectiveFrom ?? null);
      if (date) throw new Refused(fieldErr("goLive", date.message));
      await tx
        .update(priceChanges)
        .set({
          status: "submitted",
          submittedAt: new Date(),
          needsSecond,
          sendBackReason: null,
          approverId: null,
          approvedAt: null,
          summary: { counts: countChanges(diffs), effectPerMonthPaise: effect.totalPerMonthPaise, dropPerMonthPaise: effect.dropPerMonthPaise } as never,
          updatedAt: new Date(),
        })
        .where(and(eq(priceChanges.id, changeId), inArray(priceChanges.status, ["draft", "sent_back"])));
      await event(tx, { changeId, bookId: row.bookId, kind: "submitted", actorId: ctx.user.id, detail: { needsSecond, effect: effect.totalPerMonthPaise } });
      await audit(tx, ctx, { action: "pricebook.change.submit", entityType: "price_change", entityId: changeId, after: { needsSecond } });
    });
    const desk = (await priceDeskPeople()).filter((p) => p.id !== ctx.user.id);
    const bookName = facts.baseList?.name ?? facts.draftList.name;
    await notifyUsers(
      desk.map((p) => ({
        userId: p.id,
        title: `Price change waiting: ${bookName}`,
        body: `${ctx.user.name} has sent a change to ${bookName} for approval${needsSecond ? " — it needs two approvers" : ""}. Reason: ${facts.change.reason ?? ""}`.trim(),
        href: linkFor(p.basePath, bookId, changeId),
      })),
    );
    refresh(bookId);
    return okVoid(desk.length ? "Sent. The Price Desk has been told." : "Sent. Nobody else holds the Price Desk to approve it yet.");
  } catch (e) {
    if (e instanceof Refused) return e.result;
    return fromThrown(e);
  }
}

/** The maker pulls a sent change back to edit it. */
export async function withdrawSubmission(changeId: string): Promise<Result> {
  try {
    const ctx = await requirePriceDesk();
    let bookId = "";
    await db.transaction(async (tx) => {
      const row = await lockedChange(tx, changeId);
      bookId = row.bookId;
      assertMaker(row, ctx);
      if (row.status !== "submitted") throw new Refused(err("Only a change waiting for approval can be pulled back.", "rule_violation"));
      await tx
        .update(priceChanges)
        .set({ status: "draft", approverId: null, approvedAt: null, updatedAt: new Date() })
        .where(and(eq(priceChanges.id, changeId), eq(priceChanges.status, "submitted")));
      await event(tx, { changeId, bookId: row.bookId, kind: "sent_back", actorId: ctx.user.id, note: "Pulled back by its maker." });
    });
    refresh(bookId);
    return okVoid("Back with you to edit.");
  } catch (e) {
    if (e instanceof Refused) return e.result;
    return fromThrown(e);
  }
}

/* -------------------------------------------------------------- approve */

/**
 * Approve. Where a second approver is needed the first approval is recorded
 * and the change waits; the last approval PUBLISHES the draft as the book's
 * next revision on its go-live date, in the same transaction.
 */
export async function approveChange(
  changeId: string,
  input?: { note?: string | null; goLive?: string | null; notify?: PriceChangeNotify },
): Promise<Result<{ published: boolean }>> {
  try {
    const ctx = await requirePriceDesk();
    const config = await getConfig();
    const day = await today();
    if (input?.goLive && !ISO_DATE.test(input.goLive)) return fieldErr("goLive", "That is not a date.");
    const facts = await changeFacts(changeId);
    if (!facts) return err("That change does not exist.", "not_found");
    const hash = ratesHash(facts.draft);

    let published = false;
    let goLive = "";
    await db.transaction(async (tx) => {
      const row = await lockedChange(tx, changeId);
      const refusal = approvalRefusal({
        status: row.status,
        makerId: row.makerId,
        approverId: row.approverId,
        actorId: ctx.user.id,
        makerChecker: config["pricing.changes.makerChecker"],
        needsSecond: row.needsSecond,
        checkedHash: row.checkedHash,
        currentHash: hash,
      });
      if (refusal) throw new Refused(err(refusal, "rule_violation"));
      goLive = input?.goLive ?? row.goLive ?? addDays(day, 1);
      const problem = goLiveProblem(goLive, day, facts.baseList?.effectiveFrom ?? null);
      if (problem) throw new Refused(fieldErr("goLive", problem.message));

      const second = !!row.approverId;
      if (row.needsSecond && !second) {
        await tx
          .update(priceChanges)
          .set({ approverId: ctx.user.id, approvedAt: new Date(), approverNote: input?.note?.trim() || null, goLive, notify: input?.notify ?? row.notify, updatedAt: new Date() })
          .where(and(eq(priceChanges.id, changeId), eq(priceChanges.status, "submitted")));
        await event(tx, { changeId, bookId: row.bookId, kind: "approved", actorId: ctx.user.id, note: input?.note?.trim() || null, detail: { waitingForSecond: true } });
        return;
      }

      await tx.update(priceLists).set({ effectiveFrom: goLive }).where(eq(priceLists.id, row.draftListId));
      await publishDraftIn(tx, ctx, row.draftListId, { supersedesId: row.baseListId, effectiveFrom: goLive }, config, day);
      await tx
        .update(priceChanges)
        .set({
          status: "approved",
          goLive,
          notify: input?.notify ?? row.notify,
          ...(second
            ? { secondApproverId: ctx.user.id, secondApprovedAt: new Date() }
            : { approverId: ctx.user.id, approvedAt: new Date(), approverNote: input?.note?.trim() || null }),
          ...(second && input?.note?.trim() ? { approverNote: [row.approverNote, input.note.trim()].filter(Boolean).join(" · ") } : {}),
          updatedAt: new Date(),
        })
        .where(and(eq(priceChanges.id, changeId), eq(priceChanges.status, "submitted")));
      await event(tx, { changeId, bookId: row.bookId, kind: second ? "second_approved" : "approved", actorId: ctx.user.id, note: input?.note?.trim() || null });
      await event(tx, { changeId, bookId: row.bookId, kind: goLive > day ? "scheduled" : "live", actorId: ctx.user.id, detail: { goLive } });
      await audit(tx, ctx, { action: "pricebook.change.approve", entityType: "price_change", entityId: changeId, after: { goLive, second } });
      published = true;
    });

    const bookName = facts.baseList?.name ?? facts.draftList.name;
    const desk = await priceDeskPeople();
    const pathOf = new Map(desk.map((p) => [p.id, p.basePath]));
    if (published) {
      const people = new Set<string>([facts.change.makerId]);
      const tellTeam = (input?.notify ?? facts.change.notify)?.team;
      if (tellTeam) {
        const shops = await shopResolutions(day);
        for (const s of shops) if (facts.shopIds.includes(s.customerId) && s.salesAmId) people.add(s.salesAmId);
      }
      people.delete(ctx.user.id);
      await notifyUsers(
        [...people].map((userId) => ({
          userId,
          title: goLive > day ? `New prices from ${goLive}: ${bookName}` : `New prices live: ${bookName}`,
          body: goLive > day
            ? `${bookName} has a new revision approved by ${ctx.user.name}. Shops keep today's prices until ${goLive}.`
            : `${bookName} has new prices from today, approved by ${ctx.user.name}.`,
          href: pathOf.has(userId) ? linkFor(pathOf.get(userId)!, facts.change.bookId) : `/crm/price-lists/books/${facts.change.bookId}`,
        })),
      );
      if (goLive <= day) await supersedeEndedPriceLists(day);
    } else {
      await notifyUsers(
        desk
          .filter((p) => p.id !== ctx.user.id && p.id !== facts.change.makerId)
          .map((p) => ({
            userId: p.id,
            title: `Second approval needed: ${bookName}`,
            body: `${ctx.user.name} approved a change to ${bookName}. It needs one more approver before it goes live.`,
            href: linkFor(p.basePath, facts.change.bookId, changeId),
          })),
      );
    }
    refresh(facts.change.bookId);
    return ok(
      { published },
      published
        ? goLive > day
          ? `Approved. It goes live on ${goLive}; until then shops pay the current prices.`
          : "Approved and live from today."
        : "Approved. It needs one more approver.",
    );
  } catch (e) {
    if (e instanceof Refused) return e.result;
    return fromThrown(e);
  }
}

export async function sendBackChange(changeId: string, reason: string): Promise<Result> {
  try {
    const ctx = await requirePriceDesk();
    if (!reason.trim()) return fieldErr("reason", "Say what needs to change. The maker reads this.");
    let row0: { makerId: string; bookId: string } | null = null;
    await db.transaction(async (tx) => {
      const row = await lockedChange(tx, changeId);
      row0 = row;
      if (row.status !== "submitted") throw new Refused(err("Only a change waiting for approval can be sent back.", "rule_violation"));
      if (row.makerId === ctx.user.id) throw new Refused(err("It is your own change — pull it back instead.", "rule_violation"));
      await tx
        .update(priceChanges)
        .set({ status: "sent_back", sendBackReason: reason.trim(), approverId: null, approvedAt: null, updatedAt: new Date() })
        .where(and(eq(priceChanges.id, changeId), eq(priceChanges.status, "submitted")));
      await event(tx, { changeId, bookId: row.bookId, kind: "sent_back", actorId: ctx.user.id, note: reason.trim() });
      await audit(tx, ctx, { action: "pricebook.change.sendBack", entityType: "price_change", entityId: changeId, after: { reason: reason.trim() } });
    });
    const r = row0 as { makerId: string; bookId: string } | null;
    if (r) {
      const desk = await priceDeskPeople();
      const base = desk.find((p) => p.id === r.makerId)?.basePath ?? "/accounts/price-lists";
      await notifyUsers([
        { userId: r.makerId, title: "Price change sent back", body: `${ctx.user.name}: ${reason.trim()}`, kind: "warn", href: linkFor(base, r.bookId, changeId) },
      ]);
      refresh(r.bookId);
    }
    return okVoid("Sent back with your reason.");
  } catch (e) {
    if (e instanceof Refused) return e.result;
    return fromThrown(e);
  }
}

/** Take over another person's change — said in the log, so the maker-checker rule then applies to you. */
export async function takeOverChange(changeId: string): Promise<Result> {
  try {
    const ctx = await requirePriceDesk();
    await db.transaction(async (tx) => {
      const row = await lockedChange(tx, changeId);
      if (!editable(row.status)) throw new Refused(err("Only a change being edited can be taken over.", "rule_violation"));
      if (row.makerId === ctx.user.id) return;
      await tx.update(priceChanges).set({ makerId: ctx.user.id, checkedHash: null, updatedAt: new Date() }).where(eq(priceChanges.id, changeId));
      await event(tx, { changeId, bookId: row.bookId, kind: "edited", actorId: ctx.user.id, note: "Took the change over." });
    });
    refresh();
    return okVoid("It is yours now. Check it again before sending.");
  } catch (e) {
    if (e instanceof Refused) return e.result;
    return fromThrown(e);
  }
}

/* ------------------------------------------------------ cancel and dates */

/** Cancel a change that has not gone live. A scheduled one is taken off and the current revision stays in force. */
export async function cancelChange(changeId: string, reason: string): Promise<Result> {
  try {
    const ctx = await requirePriceDesk();
    if (!reason.trim()) return fieldErr("reason", "Say why it is being cancelled.");
    const day = await today();
    let bookId = "";
    await db.transaction(async (tx) => {
      const row = await lockedChange(tx, changeId);
      bookId = row.bookId;
      if (row.status === "cancelled") throw new Refused(err("Already cancelled.", "rule_violation"));
      const list = await lockedList(tx, row.draftListId);
      if (!list) throw new Refused(err("The change's list is missing.", "not_found"));
      if (row.status === "approved") {
        if (!(list.status === "published" && list.effectiveFrom > day)) {
          throw new Refused(err("This change is already live. Make a new change to undo it.", "rule_violation"));
        }
        // Taken off before it started: the revision it was to replace goes on.
        await tx
          .update(priceLists)
          .set({ status: "withdrawn", effectiveTo: addDays(list.effectiveFrom, -1), withdrawnAt: new Date(), withdrawnById: ctx.user.id, withdrawReason: `Change cancelled: ${reason.trim()}`, updatedAt: new Date() })
          .where(and(eq(priceLists.id, list.id), eq(priceLists.status, "published")));
        if (list.supersedesId) {
          await tx
            .update(priceLists)
            .set({ effectiveTo: null, updatedAt: new Date(), updatedById: ctx.user.id })
            .where(and(eq(priceLists.id, list.supersedesId), eq(priceLists.status, "published"), eq(priceLists.effectiveTo, addDays(list.effectiveFrom, -1))));
        }
      } else if (list.status === "draft") {
        // A draft that never priced anybody is closed rather than deleted: the change keeps pointing at it.
        await tx
          .update(priceLists)
          .set({ status: "withdrawn", withdrawnAt: new Date(), withdrawnById: ctx.user.id, withdrawReason: `Change cancelled: ${reason.trim()}`, updatedAt: new Date() })
          .where(and(eq(priceLists.id, list.id), eq(priceLists.status, "draft")));
      }
      await tx
        .update(priceChanges)
        .set({ status: "cancelled", cancelledAt: new Date(), cancelledById: ctx.user.id, cancelReason: reason.trim(), updatedAt: new Date() })
        .where(eq(priceChanges.id, changeId));
      await event(tx, { changeId, bookId: row.bookId, kind: row.status === "approved" ? "unscheduled" : "cancelled", actorId: ctx.user.id, note: reason.trim() });
      await audit(tx, ctx, { action: "pricebook.change.cancel", entityType: "price_change", entityId: changeId, after: { reason: reason.trim(), was: row.status } });
    });
    refresh(bookId);
    return okVoid("Cancelled. The current prices stay in force.");
  } catch (e) {
    if (e instanceof Refused) return e.result;
    return fromThrown(e);
  }
}

/** Move a scheduled change's go-live date — before it starts. Today puts it live now. */
export async function moveGoLive(changeId: string, newDate: string): Promise<Result> {
  try {
    const ctx = await requirePriceDesk();
    if (!ISO_DATE.test(newDate)) return fieldErr("goLive", "That is not a date.");
    const day = await today();
    let bookId = "";
    await db.transaction(async (tx) => {
      const row = await lockedChange(tx, changeId);
      bookId = row.bookId;
      if (row.status !== "approved") throw new Refused(err("Only an approved change has a date to move.", "rule_violation"));
      const list = await lockedList(tx, row.draftListId);
      if (!list || list.status !== "published" || list.effectiveFrom <= day) {
        throw new Refused(err("This change is already live; its date cannot move.", "rule_violation"));
      }
      const pred = list.supersedesId ? await lockedList(tx, list.supersedesId) : null;
      const problem = goLiveProblem(newDate, day, pred?.effectiveFrom ?? null);
      if (problem) throw new Refused(fieldErr("goLive", problem.message));
      await tx.update(priceLists).set({ effectiveFrom: newDate, updatedAt: new Date(), updatedById: ctx.user.id }).where(eq(priceLists.id, list.id));
      if (pred && pred.status === "published" && pred.effectiveTo === addDays(list.effectiveFrom, -1)) {
        await tx.update(priceLists).set({ effectiveTo: addDays(newDate, -1), updatedAt: new Date(), updatedById: ctx.user.id }).where(eq(priceLists.id, pred.id));
      }
      await tx.update(priceChanges).set({ goLive: newDate, updatedAt: new Date() }).where(eq(priceChanges.id, changeId));
      await event(tx, { changeId, bookId: row.bookId, kind: newDate <= day ? "live" : "date_moved", actorId: ctx.user.id, detail: { from: list.effectiveFrom, to: newDate } });
      await audit(tx, ctx, { action: "pricebook.change.move", entityType: "price_change", entityId: changeId, before: { goLive: list.effectiveFrom }, after: { goLive: newDate } });
    });
    if (newDate <= day) await supersedeEndedPriceLists(day);
    refresh(bookId);
    return okVoid(newDate <= day ? "Live from today." : `Moved to ${newDate}.`);
  } catch (e) {
    if (e instanceof Refused) return e.result;
    return fromThrown(e);
  }
}

/* ------------------------------------------------------- second opinion */

export async function requestSecondOpinion(changeId: string): Promise<Result<{ text: string; recommendation: string; provider: string }>> {
  try {
    const ctx = await requirePriceDesk();
    const facts = await changeFacts(changeId);
    if (!facts) return err("That change does not exist.", "not_found");
    const evidence = await evidenceFor(facts);
    const flags = ((facts.change.checks ?? {}) as { flags?: ChangeFlag[] }).flags ?? [];
    const acks = facts.change.acks ?? {};
    const answer = await aiSecondOpinion({
      changeId,
      userId: ctx.user.id,
      evidence,
      acknowledged: flags.filter((f) => acks[f.key]).map((f) => ({ message: f.message, note: acks[f.key].note })),
    });
    if ("error" in answer) return err(answer.error, "rule_violation");
    await db.transaction(async (tx) => {
      const row = await lockedChange(tx, changeId);
      const checks = { ...((row.checks ?? {}) as Record<string, unknown>), secondOpinion: { provider: answer.provider, text: answer.text, recommendation: answer.recommendation, at: new Date().toISOString() } };
      await tx.update(priceChanges).set({ checks: checks as never }).where(eq(priceChanges.id, changeId));
      await event(tx, { changeId, bookId: row.bookId, kind: "second_opinion", actorId: ctx.user.id, detail: { recommendation: answer.recommendation } });
    });
    return ok({ text: answer.text, recommendation: answer.recommendation, provider: answer.provider });
  } catch (e) {
    if (e instanceof Refused) return e.result;
    return fromThrown(e);
  }
}

/* ----------------------------------------------------- the books, listed */

/** For a client that wants to refresh the list without a navigation. */
export async function booksNow() {
  await requirePriceDesk();
  return listBooks();
}

/** Every flag still standing on a change — for a screen deciding what to draw. */
export async function openFlagsOf(changeId: string): Promise<ChangeFlag[]> {
  await requirePriceDesk();
  const facts = await changeFacts(changeId);
  if (!facts) return [];
  const flags = ((facts.change.checks ?? {}) as { flags?: ChangeFlag[] }).flags ?? [];
  return openFlags(flags, facts.change.acks ?? {});
}
