import "server-only";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { readQcTests, testKey } from "@/lib/erp/engines/sfg-tests";
import { sfgQcMap, sfgQcOf, setSfgQc } from "@/lib/erp/qc";
import { refValues } from "@/lib/erp/refs";
import type { ErpPower } from "@/lib/erp/powers";
import { erpAudit } from "@/lib/erp/server";
import { sfgLots } from "@/lib/erp/stock";
import { erpCtxFor, factoryAudit, today, type FactoryCtx } from "./server";
import type { QcInput, QcKit, QcLot, QcSave } from "./types";

/* ---------------------------------------------------------------------------
 * SFG quality check from the floor.
 *
 * The same decision as ERP → SFG batches → Approve / Reject, written to the
 * same `erp_sfg_qc` row and audited under the same action names — so the fill
 * gate, the batch drawer and the trace cannot tell which door it came in by.
 * The Testing list (ERP → Settings → Reference lists) is asked test by test,
 * Pass or Fail, and `readQcTests` is the one rule: approving needs every
 * active test answered and every answer Pass; rejecting records what was run
 * and needs a reason. The list is read again here at the save, so a phone
 * holding an older list cannot approve past a test added since.
 *
 * Who may decide is `FactoryCtx.qc`: the Mixing & Blending department.
 * ------------------------------------------------------------------------- */

const NOT_YOURS = { title: "Not yours to decide", text: "Only Mixing & Blending decides whether a base liquid may be filled.", fix: "Ask Mixing & Blending, or the office to place you in it." };

/** How far back a decided lot stays on the list, so a wrong answer can be changed. */
const DECIDED_DAYS = 7;

async function lotsWithVerdicts(): Promise<QcLot[]> {
  const lots = await sfgLots();
  const qc = await sfgQcMap(lots.map((l) => l.lotCode));
  /* sfgLots is a row per lot per godown: a lot moved between godowns is one
     lot, decided once, so it is summed here and named by where most of it is. */
  const byLot = new Map<string, { product: string; made: string; litres: number; godown: string; most: number }>();
  for (const l of lots) {
    const cur = byLot.get(l.lotCode);
    const stock = Math.max(0, l.stock);
    if (!cur) byLot.set(l.lotCode, { product: l.product, made: l.latestDate, litres: stock, godown: l.godown, most: stock });
    else {
      cur.litres += stock;
      if (l.latestDate < cur.made) cur.made = l.latestDate;
      if (stock > cur.most) {
        cur.most = stock;
        cur.godown = l.godown;
      }
    }
  }
  return [...byLot.entries()].map(([lot, l]) => {
    const v = qc.get(lot);
    return {
      lot,
      product: l.product,
      made: l.made,
      litres: Math.round(l.litres * 100) / 100,
      godown: l.godown,
      status: (v?.status ?? "Pending") as QcLot["status"],
      tests: v?.tests ?? {},
      note: v?.note ?? null,
      by: v?.by ?? null,
    };
  });
}

/** The lots waiting for a decision, the ones decided lately, and the tests to ask. */
export async function qcKit(fc: FactoryCtx): Promise<QcKit> {
  if (!fc.qc) return { ok: false, ...NOT_YOURS };
  const [tests, lots, recent] = await Promise.all([
    refValues("testingList"),
    lotsWithVerdicts(),
    db.execute(sql`select lot_code as lot from erp_sfg_qc where decided_at > now() - make_interval(days => ${DECIDED_DAYS})`) as unknown as Promise<{ lot: string }[]>,
  ]);
  const lately = new Set(recent.map((r) => r.lot));
  /* Waiting: still Pending with something left to fill. A lot used up before
     anybody decided it has nothing left to protect. */
  const waiting = lots.filter((l) => l.status === "Pending" && l.litres > 0).sort((a, b) => a.made.localeCompare(b.made) || a.lot.localeCompare(b.lot));
  const decided = lots.filter((l) => l.status !== "Pending" && lately.has(l.lot)).sort((a, b) => b.made.localeCompare(a.made) || a.lot.localeCompare(b.lot));
  return { ok: true, tests, waiting, decided };
}

/** One decision on one lot. */
export async function saveQcDecision(fc: FactoryCtx, input: QcInput): Promise<QcSave> {
  if (!fc.qc) return { ok: false, ...NOT_YOURS };
  const lot = String(input?.lot ?? "").trim();
  const verdict = input?.verdict === "Approved" ? "Approved" : input?.verdict === "Rejected" ? "Rejected" : null;
  if (!lot || !verdict) return { ok: false, title: "Choose approve or reject", text: "The decision was not saved.", fix: "Pick the lot again and press Approve or Reject." };
  const note = String(input.note ?? "").trim().slice(0, 500) || null;
  const approving = verdict === "Approved";

  const tests = await refValues("testingList");
  const values: Record<string, string> = {};
  for (const t of tests) {
    const v = input.results?.[t];
    if (typeof v === "string") values[testKey(t)] = v;
  }
  const read = readQcTests(tests, values, approving);
  if (!read.ok) {
    const test = tests.find((t) => testKey(t) === read.field);
    return { ok: false, title: read.message, text: "The decision was not saved.", fix: approving ? "Answer every test. A lot that fails a test is rejected." : "Choose Pass or Fail for that test.", test };
  }
  if (!approving && !note) return { ok: false, title: "Say why it failed", text: "A rejected lot needs a reason — the mixing team reads it.", fix: "Write the reason, then press Reject again." };

  const lots = await lotsWithVerdicts();
  const found = lots.find((l) => l.lot === lot);
  if (!found) return { ok: false, title: "Lot " + lot + " not found", text: "No SFG batch carries this lot code.", fix: "Go back and pick it from the list." };
  const before = await sfgQcOf(lot);
  if (before === verdict) return { ok: false, title: "Already " + verdict.toLowerCase(), text: "Lot " + lot + " is already " + verdict.toLowerCase() + ".", fix: "Go back to the list — nothing needs saving." };

  await db.transaction((tx) => setSfgQc(tx, lot, verdict, note, fc.user.id, read.results));
  /* The ERP's own audit line, so the batch's history reads the same whichever
     door decided it — and the factory's, so the phone's history does too. */
  const ctx = { ...erpCtxFor(fc), powers: new Set<ErpPower>(["approveSfgQc"]) };
  await erpAudit(ctx, approving ? "erp.sfg.qcApprove" : "erp.sfg.qcReject", "erp_sfg_qc", lot, { status: before }, { status: verdict, note, tests: read.results, from: "factory" });
  await factoryAudit(fc, approving ? "factory.qc.approve" : "factory.qc.reject", null, "SFG lot " + lot + " " + verdict.toLowerCase(), { lot, tests: read.results, note, on: today() });

  return {
    ok: true,
    msg: approving ? "Lot " + lot + " approved · it can be filled now" : "Lot " + lot + " rejected · it cannot be filled",
    lot: { ...found, status: verdict, tests: read.results, note, by: fc.user.name },
  };
}
