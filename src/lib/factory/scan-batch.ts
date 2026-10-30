import "server-only";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { lorryBoard, lorryScan } from "./lorry";
import type { FactoryCtx } from "./server";
import type { FactoryData, LorryBatch, LorryBatchResult, LorryBoard, LorryHalf, LorryScan, LorryScanIn } from "./types";

/* ---------------------------------------------------------------------------
 * A LOADER SCANS FASTER THAN A ROUND TRIP. One label a second over factory
 * Wi-Fi to a small server is a queue that only grows when every label waits
 * for its own answer, so the phone sends what has queued up as ONE call and
 * this judges each in turn — with the same `lorryScan`, so the same order is
 * picked, the same desk verdict given and the same ERP scan row written.
 *
 * THE SCAN IS RECORDED BEFORE IT IS JUDGED. Each arrives with an id the phone
 * minted, and `factory_scan_events` takes the row first: a scan that reached
 * prod is on record even when judging it throws, and a resend of the same id
 * is answered from what was stored instead of being judged a second time.
 *
 * A REFUSAL STILL STOPS THE LOADER. One at a time, nothing behind a refused
 * label was counted until the loader had seen why; a batch keeps that rule by
 * stopping there and handing the rest back as `notJudged` — recorded, never
 * written to the ERP — for the phone to say "scan them again". A repeat ("already
 * on") is amber and does not stop, exactly as before.
 *
 * The pair rule carries across the batch: what one scan leaves held is what
 * the next is judged with, as the phone would have sent it one at a time.
 * ------------------------------------------------------------------------- */

/** More than this in one call is not a loader catching up; the rest go back unjudged. */
export const BATCH_MAX = 50;

type Stored = { status: string; result: LorryBatchResult | null; user: string };

/** A scan's answer without the board (sent once for the batch) or the factory data (likewise). */
const slim = (id: string, r: LorryScan): LorryBatchResult => {
  const rest: Record<string, unknown> = { ...r, id };
  delete rest.board;
  delete rest.data;
  return rest as LorryBatchResult;
};

const statusOf = (r: LorryBatchResult) => (r.ok ? "accepted" : r.repeat ? "repeat" : "refused");
/** A refusal stops the loader; a repeat, a half read and a box on do not. */
const halts = (r: LorryBatchResult) => !r.ok && !r.repeat;

export async function lorryScanBatch(
  fc: FactoryCtx,
  key: string,
  taskId: string | null,
  held: string | null,
  scans: LorryScanIn[],
  timings: { id: string; ms: number }[] = [],
  build: string | null = null,
): Promise<LorryBatch> {
  key = String(key ?? "");
  const list = (Array.isArray(scans) ? scans : [])
    .map((s) => ({ id: String(s?.id ?? "").slice(0, 80), code: String(s?.code ?? "").slice(0, 200), at: s?.at ? String(s.at) : null }))
    .filter((s) => s.id);
  await recordWaits(fc, timings);

  const results: LorryBatchResult[] = [];
  let board: LorryBoard | null = null;
  let data: FactoryData | null = null;
  let task = taskId && /^T-/.test(taskId) ? taskId : null;
  let half: LorryHalf | null = null;
  let heldCode = held ? String(held) : null;
  let stop = list.length;

  for (let i = 0; i < Math.min(list.length, BATCH_MAX); i++) {
    const s = list[i];
    const at = s.at && !Number.isNaN(Date.parse(s.at)) ? s.at : null;
    await db.execute(sql`
      insert into factory_scan_events (id, user_id, godown_id, lorry_key, task_id, code, held, scanned_at, app_build)
      values (${s.id}, ${fc.user.id}, ${fc.godown.id}, ${key}, ${task}, ${s.code}, ${heldCode}, ${at}::timestamptz, ${build})
      on conflict (id) do nothing`);
    const [row] = (await db.execute(sql`
      select status, result, user_id as "user" from factory_scan_events where id = ${s.id}`)) as unknown as Stored[];

    let r: LorryBatchResult;
    if (!row || row.user !== fc.user.id) {
      /* An id somebody else's phone already used: not ours to answer from. */
      r = { ok: false, id: s.id, code: s.code, title: "Not counted", text: "This scan could not be read on the server.", fix: "Scan it again.", task, override: null, half: null };
    } else if (row.result && (row.status === "accepted" || row.status === "repeat" || row.status === "refused")) {
      /* Sent before and judged: the same answer, and nothing written twice. */
      r = row.result;
    } else {
      const t0 = performance.now();
      try {
        const full = await lorryScan(fc, key, s.code, task, heldCode);
        r = slim(s.id, full);
        if (full.board) board = full.board;
        if (full.ok && full.data) data = full.data;
        await db.execute(sql`
          update factory_scan_events
             set status = ${statusOf(r)}, result = ${JSON.stringify(r)}::jsonb, judged_at = now(), judge_ms = ${Math.round(performance.now() - t0)}, error = null
           where id = ${s.id}`);
      } catch (e) {
        /* Judging failed on the server: on record, and the loader stops here as for any refusal. */
        console.error("[factory scan batch]", s.id, e);
        await db.execute(sql`
          update factory_scan_events set status = 'error', error = ${String((e as Error)?.message ?? e).slice(0, 500)}, judge_ms = ${Math.round(performance.now() - t0)}
           where id = ${s.id}`);
        r = { ok: false, id: s.id, code: s.code, title: "Not counted", text: "The server could not check this label.", fix: "Scan it again. If it keeps failing, tell the dispatch head.", task, override: null, half: null };
      }
    }
    results.push(r);
    if (r.task && /^T-/.test(r.task)) task = r.task;
    half = r.half ?? null;
    heldCode = half?.code ?? null;
    if (halts(r)) {
      stop = i + 1;
      break;
    }
    stop = i + 1;
  }

  /* Behind a refusal, or past the cap: on record as not judged, for the phone to have them scanned again. */
  const rest = list.slice(stop);
  for (const s of rest)
    await db.execute(sql`
      insert into factory_scan_events (id, user_id, godown_id, lorry_key, task_id, code, status, scanned_at, app_build)
      values (${s.id}, ${fc.user.id}, ${fc.godown.id}, ${key}, ${task}, ${s.code}, 'not_judged', ${s.at && !Number.isNaN(Date.parse(s.at)) ? s.at : null}::timestamptz, ${build})
      on conflict (id) do nothing`);

  /* Every answer came from a resend: the board is still wanted, once. */
  if (!board && results.length) board = await lorryBoard(fc, key);
  return { results, notJudged: rest.map((s) => s.id), board, data, task, half };
}

/** How long the loader waited for each scan of the last batch, as the phone measured it. */
async function recordWaits(fc: FactoryCtx, timings: { id: string; ms: number }[]) {
  const ts = (Array.isArray(timings) ? timings : [])
    .map((t) => ({ id: String(t?.id ?? "").slice(0, 80), ms: Math.round(Number(t?.ms)) }))
    .filter((t) => t.id && Number.isFinite(t.ms) && t.ms >= 0 && t.ms < 3_600_000)
    .slice(0, BATCH_MAX * 2);
  if (!ts.length) return;
  await db.execute(sql`
    update factory_scan_events e set wait_ms = t.ms
      from jsonb_to_recordset(${JSON.stringify(ts)}::jsonb) as t(id text, ms integer)
     where e.id = t.id and e.user_id = ${fc.user.id}`);
}
