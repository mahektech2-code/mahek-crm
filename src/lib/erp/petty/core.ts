import "server-only";
import { randomUUID } from "node:crypto";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  attachments,
  auditLog,
  erpCashClosings,
  erpFundAccounts,
  erpFundLedger,
  erpPettyEvidence,
  erpTallySync,
  type User,
} from "@/db/schema";
import { getConfig } from "@/lib/config/store";
import type { ErpContext } from "../access";
import { erpId } from "../server";
import type { Tx } from "../screens/common";
import type { FundType } from "../engines/petty-cash";

/* ---------------------------------------------------------------------------
 * The petty-cash module's shared machinery: who may do what, the ledger
 * posting every movement goes through, the evidence on a record, and the
 * Tally queue. Screens call these; nothing else writes `erp_fund_ledger`.
 * ------------------------------------------------------------------------- */

export type PettyConfig = {
  autoApproveUpToPaise: number;
  approverLimitPaise: number;
  budgetRule: string;
  reviewDays: number;
  handoverHours: number;
  dueSoonDays: number;
  matchWindowDays: number;
  splitWindowDays: number;
  tolerancePaise: number;
  duplicateDays: number;
  tallyMode: "off" | "export" | "live";
  tallyUrl: string;
  tallyCompany: string;
};

export async function pettyConfig(): Promise<PettyConfig> {
  const c = await getConfig();
  const mode = c["erp.tally.mode"];
  return {
    autoApproveUpToPaise: c["erp.pettyCash.autoApproveUpToPaise"],
    approverLimitPaise: c["erp.pettyCash.approverLimitPaise"],
    budgetRule: c["erp.pettyCash.budgetRule"],
    reviewDays: c["erp.pettyCash.reviewDays"],
    handoverHours: c["erp.pettyCash.handoverHours"],
    dueSoonDays: c["erp.pettyCash.dueSoonDays"],
    matchWindowDays: c["erp.pettyCash.matchWindowDays"],
    splitWindowDays: c["erp.pettyCash.splitWindowDays"],
    tolerancePaise: c["erp.pettyCash.roundingTolerancePaise"],
    duplicateDays: c["erp.ai.alerts.duplicateExpenseDays"],
    tallyMode: mode === "off" || mode === "live" ? mode : "export",
    tallyUrl: c["erp.tally.url"],
    tallyCompany: c["erp.tally.company"],
  };
}

/* --------------------------------------------------------------- roles */

/**
 * The four roles of PRD §3, read off ERP powers. Holding the Petty cash screen
 * is the Production Head's role; the others are powers an ERP administrator
 * hands out on the Access dialog (and holds all of without a row).
 */
export type PettyRoles = { accounts: boolean; approve: boolean; owner: boolean; admin: boolean };

export function pettyRoles(ctx: ErpContext): PettyRoles {
  return {
    accounts: ctx.powers.has("pettyAccounts"),
    approve: ctx.powers.has("pettyApprove"),
    owner: ctx.powers.has("pettyOwner"),
    admin: ctx.administrator,
  };
}

export const WHY = {
  accounts: "The accounts team does this (“Petty cash: accounts team”)",
  approve: "An approver does this (“Approve petty-cash expenses”)",
  owner: "The owner does this (“Owner-level petty-cash approvals”)",
  admin: "An ERP administrator does this",
};

/* --------------------------------------------------------------- funds */

export type FundRow = typeof erpFundAccounts.$inferSelect & { type: FundType };

export async function fundAccounts(opts: { activeOnly?: boolean } = {}): Promise<FundRow[]> {
  const rows = await db.select().from(erpFundAccounts).orderBy(asc(erpFundAccounts.code));
  return rows.filter((r) => !opts.activeOnly || r.status === "active").map((r) => ({ ...r, type: r.fundType as FundType }));
}

export async function ledgerEntries(fundId?: string) {
  return db
    .select()
    .from(erpFundLedger)
    .where(fundId ? eq(erpFundLedger.fundAccountId, fundId) : undefined)
    .orderBy(asc(erpFundLedger.txnDate), asc(erpFundLedger.postedAt));
}

/** Every fund's balance, read off the ledger. */
export async function balances(executor: { execute: typeof db.execute } = db): Promise<Map<string, number>> {
  const rows = (await executor.execute(sql`
    select fund_account_id as id,
           coalesce(sum(case when direction = 'credit' then amount_paise else -amount_paise end), 0)::float8 as bal
      from erp_fund_ledger group by fund_account_id`)) as unknown as { id: string; bal: number }[];
  return new Map(rows.map((r) => [r.id, Number(r.bal)]));
}

/** One fund's balance INSIDE a transaction, after `lock` — what a refusal must be measured against. */
export async function balanceIn(tx: Tx, fundId: string): Promise<number> {
  const rows = (await tx.execute(sql`
    select coalesce(sum(case when direction = 'credit' then amount_paise else -amount_paise end), 0)::float8 as bal
      from erp_fund_ledger where fund_account_id = ${fundId}`)) as unknown as { bal: number }[];
  return Number(rows[0]?.bal ?? 0);
}

/**
 * Serialises everything that reads-then-writes one thing — an expense being
 * paid, a fund being spent from. Released at commit. Take them in a fixed
 * order (expense, then funds by id) so two saves cannot wait on each other.
 */
export async function lock(tx: Tx, ...keys: string[]): Promise<void> {
  for (const k of [...keys].sort()) await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${"petty:" + k}))`);
}

type SeriesKey = "expense" | "payment" | "transfer" | "receipt" | "fundTxn" | "adjustment";

export async function nextCode(tx: Tx, key: SeriesKey, prefix: string): Promise<string> {
  const rows = (await tx.execute(sql`update erp_series set last = last + 1 where key = ${key} returning last`)) as unknown as { last: number }[];
  if (!rows[0]) throw new Error(`No ERP series "${key}"`);
  return `${prefix}-${rows[0].last}`;
}

export type Posting = {
  fundId: string;
  direction: "credit" | "debit";
  amountPaise: number;
  date: string;
  txnType: string;
  sourceType: string;
  sourceId: string;
  postingKey: string;
  transferId?: string | null;
  narration?: string | null;
  reversalOfId?: string | null;
};

/**
 * Posts one movement. The posting key makes a second post of the same source
 * a no-op answered with the first — so a retried request never moves money
 * twice. A movement dated into a day whose closing was approved REOPENS that
 * closing with the reason, rather than altering it silently (PRD §12).
 */
export async function post(tx: Tx, ctx: ErpContext, p: Posting): Promise<{ id: string; created: boolean }> {
  const [existing] = await tx.select({ id: erpFundLedger.id }).from(erpFundLedger).where(eq(erpFundLedger.postingKey, p.postingKey));
  if (existing) return { id: existing.id, created: false };
  if (!(p.amountPaise > 0)) throw new Error("A posting is always a positive amount with a direction.");
  const id = erpId("ftx");
  const code = await nextCode(tx, "fundTxn", "FT");
  await tx.insert(erpFundLedger).values({
    id,
    code,
    txnType: p.txnType,
    fundAccountId: p.fundId,
    txnDate: p.date,
    amountPaise: p.amountPaise,
    direction: p.direction,
    sourceType: p.sourceType,
    sourceId: p.sourceId,
    transferId: p.transferId ?? null,
    postingKey: p.postingKey,
    narration: p.narration ?? null,
    reversalOfId: p.reversalOfId ?? null,
    createdById: ctx.actor.id,
    postedById: ctx.actor.id,
  });
  await reopenClosings(tx, p.fundId, p.date, `${p.txnType.replace(/_/g, " ")} ${code} dated ${p.date} was posted after the day was closed`);
  return { id, created: true };
}

/** The ledger rows a source posted, so a reversal can name each one. */
export async function postingsOf(tx: Tx, sourceType: string, sourceId: string) {
  return tx
    .select()
    .from(erpFundLedger)
    .where(and(eq(erpFundLedger.sourceType, sourceType), eq(erpFundLedger.sourceId, sourceId)));
}

/** Reverses every posting a source made, as new rows dated `date`. */
export async function reverseSource(tx: Tx, ctx: ErpContext, sourceType: string, sourceId: string, date: string, reason: string): Promise<number> {
  const rows = (await postingsOf(tx, sourceType, sourceId)).filter((r) => !r.reversalOfId);
  for (const r of rows) {
    await post(tx, ctx, {
      fundId: r.fundAccountId,
      direction: r.direction === "credit" ? "debit" : "credit",
      amountPaise: r.amountPaise,
      date,
      txnType: `${r.txnType}_reversal`,
      sourceType,
      sourceId,
      postingKey: `reversal:${r.postingKey}`,
      transferId: r.transferId,
      narration: `Reverses ${r.code}: ${reason}`,
      reversalOfId: r.id,
    });
  }
  return rows.length;
}

async function reopenClosings(tx: Tx, fundId: string, date: string, reason: string): Promise<void> {
  await tx
    .update(erpCashClosings)
    .set({ status: "reopened", reopenedReason: reason, reopenedAt: new Date() })
    .where(and(eq(erpCashClosings.fundAccountId, fundId), eq(erpCashClosings.status, "approved"), sql`${erpCashClosings.closingDate} >= ${date}`));
}

/* -------------------------------------------------------------- audit */

/** An audit row written in the posting's own transaction — a financial write and its record commit together or not at all. */
export async function audit(tx: Tx, ctx: ErpContext, action: string, entityType: string, entityId: string, before?: unknown, after?: unknown): Promise<void> {
  await tx.insert(auditLog).values({
    id: `aud_${randomUUID().slice(0, 12)}`,
    actorId: ctx.actor.id,
    action,
    entityType,
    entityId,
    actorRole: ctx.viewingAs ? null : (ctx.level ?? null),
    actorApp: "erp",
    beforeState: (before ?? null) as never,
    afterState: (after ?? null) as never,
  });
}

/* ------------------------------------------------------------ evidence */

export type EvidenceRecord = "expense" | "payment" | "transfer" | "receipt" | "closing" | "adjustment";

/**
 * Files a document against a record. Only a file still unparented and
 * uploaded by this person is taken — an id typed into a request cannot claim
 * somebody else's file — and a file already filed stays where it is: evidence
 * is added, never replaced.
 */
export async function addEvidence(tx: Tx, ctx: ErpContext, recordType: EvidenceRecord, recordId: string, fileId: string | null | undefined, kind: string, note?: string | null): Promise<boolean> {
  if (!fileId) return false;
  const bound = await tx
    .update(attachments)
    .set({ parentType: "erp_petty", parentId: recordId, updatedAt: new Date() })
    .where(and(eq(attachments.id, fileId), sql`${attachments.parentId} is null`, eq(attachments.uploadedById, ctx.actor.id)))
    .returning({ id: attachments.id });
  if (!bound.length) return false;
  await tx.insert(erpPettyEvidence).values({ id: erpId("pev"), recordType, recordId, attachmentId: fileId, kind, note: note ?? null, uploadedById: ctx.actor.id });
  return true;
}

export type EvidenceItem = { id: string; kind: string; filename: string; at: Date; by: string | null };

export async function evidenceFor(recordType: EvidenceRecord, ids: string[]): Promise<Map<string, EvidenceItem[]>> {
  const out = new Map<string, EvidenceItem[]>();
  if (!ids.length) return out;
  const rows = (await db.execute(sql`
    select e.record_id as "recordId", e.attachment_id as id, e.kind, a.filename, e.uploaded_at as at, u.name as by
      from erp_petty_evidence e
      join attachments a on a.id = e.attachment_id
      left join users u on u.id = e.uploaded_by_id
     where e.record_type = ${recordType} and e.record_id in (${sql.join(
       ids.map((i) => sql`${i}`),
       sql`, `,
     )})
     order by e.uploaded_at`)) as unknown as { recordId: string; id: string; kind: string; filename: string; at: Date; by: string | null }[];
  for (const r of rows) out.set(r.recordId, [...(out.get(r.recordId) ?? []), { id: r.id, kind: r.kind, filename: r.filename, at: new Date(r.at), by: r.by }]);
  return out;
}

export const evidenceLinks = (list: EvidenceItem[] | undefined) => (list ?? []).map((e) => ({ l: `${e.kind} · ${e.filename}`, href: `/api/attachments/${e.id}` }));

/* ---------------------------------------------------------------- tally */

export type TallyRecord = "expense" | "payment" | "transfer" | "receipt" | "adjustment";

/** Queues a record for Tally under a stable remote id (its own code), once. Off means nothing is queued. */
export async function queueTally(tx: Tx, cfg: PettyConfig, recordType: TallyRecord, recordId: string, remoteId: string): Promise<void> {
  if (cfg.tallyMode === "off") return;
  await tx
    .insert(erpTallySync)
    .values({ id: erpId("tly"), recordType, recordId, remoteId: `MAHEKONE-${remoteId}`, status: "pending", tallyCompany: cfg.tallyCompany || null })
    .onConflictDoNothing();
}

/** A posted voucher whose record was reversed needs correcting in Tally; one not yet posted no longer needs posting. */
export async function tallyAfterReversal(tx: Tx, recordType: TallyRecord, recordId: string): Promise<void> {
  const [row] = await tx.select().from(erpTallySync).where(and(eq(erpTallySync.recordType, recordType), eq(erpTallySync.recordId, recordId)));
  if (!row) return;
  const status = row.status === "posted" ? "correction" : "not_required";
  await tx.update(erpTallySync).set({ status, updatedAt: new Date(), lastError: row.status === "posted" ? "Reversed in MahekOne after posting: correct or cancel the voucher in Tally" : null }).where(eq(erpTallySync.id, row.id));
}

/* --------------------------------------------------------------- people */

export async function userNames(ids: (string | null | undefined)[]): Promise<Map<string, string>> {
  const list = [...new Set(ids.filter((x): x is string => !!x))];
  if (!list.length) return new Map();
  const { users } = await import("@/db/schema");
  const rows = await db.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, list));
  return new Map(rows.map((r) => [r.id, r.name]));
}

export const nameOf = (m: Map<string, string>, id: string | null | undefined) => (id ? (m.get(id) ?? "—") : "—");

export type { User };
