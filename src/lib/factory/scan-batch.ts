import "server-only";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { lorryBoard, lorryScan } from "./lorry";
import type { FactoryCtx } from "./server";
import { looksLikeUnitId } from "@/lib/erp/engines/trace";
import type { FactoryData, LorryBatch, LorryBatchResult, LorryBoard, LorryHalf, LorryLocal, LorryScan, LorryScanIn } from "./types";

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
 *
 * FOLLOW MODE IS THE OFFLINE-FIRST PHONE, and there a refusal does NOT stop.
 * A phone holding the lorry's loading pack judges each label itself, sounds the
 * answer at once and keeps the scan on disk until this has it — so by the time a
 * batch arrives the loader is long past every label in it, and stopping at a
 * refusal would throw away boxes already counted on the phone and already on
 * the lorry. So every scan is judged, in order, each with the half the PHONE
 * held when it read it (`held` on the scan) — a scan the phone refused never
 * reaches the server's pair chain, so the phone's own sequence is the only
 * truthful one. A scan the phone REFUSED is recorded and never judged: the
 * loader was told "not counted" and set the box aside, and the server counting
 * it now would put on paper a box that is on the floor. Anything else is judged
 * here as always, and where the server refuses what the phone took, the phone
 * says so loudly when the answer lands — the server still has the last word.
 *
 * SHADOW MODE: a phone with a loading pack judges each scan itself first
 * (`lorry-judge.ts`) and sends that answer as `local`. It changes nothing here
 * — the server still decides — but both are stored with whether they agreed,
 * which is the evidence for ever letting a phone count a box on its own.
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
/** The server's answer in the phone's words: a half read is not a box on. */
const shadowOf = (r: LorryBatchResult) => (r.ok && r.half ? "half" : statusOf(r));
/** Results the phone's pack cannot decide; the server saying something definite to one of them is not a disagreement. */
const UNJUDGED = new Set(["unknown", "lot"]);

function localOf(x: unknown): LorryLocal | null {
  const l = x as Partial<LorryLocal> | null | undefined;
  if (!l || typeof l.result !== "string") return null;
  const packAt = l.packAt && !Number.isNaN(Date.parse(String(l.packAt))) ? String(l.packAt) : null;
  const us = Number(l.us);
  return { result: l.result.slice(0, 20), line: l.line ? String(l.line).slice(0, 80) : null, why: String(l.why ?? "").slice(0, 40), us: Number.isFinite(us) && us >= 0 && us < 2e9 ? Math.round(us) : 0, packAt: packAt ?? "" };
}
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
  follow = false,
): Promise<LorryBatch> {
  key = String(key ?? "");
  const list = (Array.isArray(scans) ? scans : [])
    .map((s) => ({
      id: String(s?.id ?? "").slice(0, 80),
      code: String(s?.code ?? "").slice(0, 200),
      at: s?.at ? String(s.at) : null,
      local: localOf(s?.local),
      /* Follow mode: the half the phone held when it read this label. Absent is "nothing held", never "keep the last". */
      held: s?.held ? String(s.held).slice(0, 200) : null,
    }))
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
    const l = s.local;
    if (follow) heldCode = s.held;
    await db.execute(sql`
      insert into factory_scan_events (id, user_id, godown_id, lorry_key, task_id, code, held, scanned_at, app_build, local_result, local_line, local_why, local_us, pack_at)
      values (${s.id}, ${fc.user.id}, ${fc.godown.id}, ${key}, ${task}, ${s.code}, ${heldCode}, ${at}::timestamptz, ${build},
              ${l?.result ?? null}, ${l?.line ?? null}, ${l?.why ?? null}, ${l ? l.us : null}, ${l?.packAt || null}::timestamptz)
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
    } else if (follow && l?.result === "refused") {
      /* The phone refused it and the loader set it aside: on record, never counted here. */
      r = { ok: false, id: s.id, code: s.code, title: "Not counted", text: "Refused on the phone (" + l.why + ").", fix: "Keep it aside.", task, override: null, half: null };
      await db.execute(sql`
        update factory_scan_events set status = 'refused', result = ${JSON.stringify(r)}::jsonb, judged_at = now(), judge_ms = 0 where id = ${s.id}`);
    } else {
      const t0 = performance.now();
      try {
        const full = await lorryScan(fc, key, s.code, task, heldCode);
        r = slim(s.id, full);
        if (full.board) board = full.board;
        if (full.ok && full.data) data = full.data;
        const judgeMs = Math.round(performance.now() - t0);
        const said = l ? await shadowAgree(l, r, heldCode) : null;
        await db.execute(sql`
          update factory_scan_events
             set status = ${statusOf(r)}, result = ${JSON.stringify(r)}::jsonb, judged_at = now(), judge_ms = ${judgeMs}, error = null,
                 server_line = ${said?.line ?? null}, agree = ${said?.agree ?? null}
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
    if (!follow && halts(r)) {
      stop = i + 1;
      break;
    }
    stop = i + 1;
  }

  /* Behind a refusal, or past the cap: on record as not judged, for the phone to have them scanned again. */
  const rest = list.slice(stop);
  for (const s of rest)
    await db.execute(sql`
      insert into factory_scan_events (id, user_id, godown_id, lorry_key, task_id, code, status, scanned_at, app_build, local_result, local_line, local_why, local_us, pack_at)
      values (${s.id}, ${fc.user.id}, ${fc.godown.id}, ${key}, ${task}, ${s.code}, 'not_judged', ${s.at && !Number.isNaN(Date.parse(s.at)) ? s.at : null}::timestamptz, ${build},
              ${s.local?.result ?? null}, ${s.local?.line ?? null}, ${s.local?.why ?? null}, ${s.local ? s.local.us : null}, ${s.local?.packAt || null}::timestamptz)
      on conflict (id) do nothing`);

  /* Every answer came from a resend: the board is still wanted, once. */
  if (!board && results.length) board = await lorryBoard(fc, key);
  return { results, notJudged: rest.map((s) => s.id), board, data, task, half };
}

/**
 * Whether the phone's judgement matched the server's: the same kind of answer,
 * and for a box that went on, the same line. Null where the phone could not
 * judge. A box that went on with its sticker is on the sticker's line.
 */
async function shadowAgree(l: LorryLocal, r: LorryBatchResult, held: string | null): Promise<{ line: string | null; agree: boolean | null }> {
  const kind = shadowOf(r);
  let line: string | null = null;
  if (kind === "accepted") {
    const box = looksLikeUnitId(r.code) ? r.code : held && looksLikeUnitId(held) ? held : null;
    const [row] = (box
      ? await db.execute(sql`select order_id as line from erp_units where id = ${box}`)
      : await db.execute(sql`select order_id as line from erp_dispatch_stickers where id = ${r.code}`)) as unknown as { line: string | null }[];
    line = row?.line ?? null;
  }
  if (UNJUDGED.has(l.result)) return { line, agree: null };
  return { line, agree: l.result === kind && (kind !== "accepted" || l.line === line) };
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
