import "server-only";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { erpId } from "@/lib/erp/server";
import { screenModule } from "@/lib/erp/screens";
import { calendarDate } from "@/lib/business-date";
import { firstBlockedStep, mixDeviation, nf, normalizeDraft, savedInstant } from "./rules";
import { hhmm } from "./time";
import type { Draft, FactoryData, Proc, Submission, SubmitResult, Task } from "./types";
import { OFFLINE_HOURS } from "./types";
import {
  erpCtxFor,
  factoryAudit,
  inList,
  lotsFor,
  masters,
  nowHM,
  openPackBatches,
  orderNoOf,
  ordersFor,
  people,
  tasksFor,
  writeTeam,
  type FactoryCtx,
} from "./server";

/* ---------------------------------------------------------------------------
 * Sending one job: exactly once, checked against the stock the server holds,
 * and posted through the ERP's own handlers.
 *
 * THE KEY IS THE JOB. The phone mints it when the work is started and every
 * attempt carries it — a second tap, a retry after the network dropped, the
 * queue draining after the app was killed. The first attempt claims the row;
 * every later one is answered from it. That is what makes "tapping again is
 * safe" a true sentence on the review screen (PRD §11).
 *
 * THE ERP DECIDES. Nothing here writes a stock table. A mixing batch is
 * `sfgBatches.forms.new`, a fill is `fgFill.forms.new`, packing is one
 * `packBatches.forms.new` per lot per batch — so the lot locks, the QC gate,
 * the can and box stock checks and the complete-batch rule all apply to the
 * floor exactly as they apply to the office.
 * ------------------------------------------------------------------------- */

type Row = Record<string, unknown>;
const q = async <T = Row>(s: ReturnType<typeof sql>) => (await db.execute(s)) as unknown as T[];
const n = (v: unknown) => Number(v ?? 0) || 0;

/** What has already been written for this key — so a resumed job skips it. */
type Progress = { step: number; doc: string; ref: string }[];

type Claim =
  | { kind: "new" | "resume"; progress: Progress }
  | { kind: "answered"; result: SubmitResult }
  | { kind: "busy" };

/** A send already being worked on for longer than this is taken to have died, and resumed. */
const STALE_SECONDS = 120;

async function claim(fc: FactoryCtx, sub: Submission): Promise<Claim> {
  const made = await q<{ key: string }>(sql`
    insert into factory_submissions (key, task_id, user_id, payload, saved_at, app_build, schema_version)
    values (${sub.key}, ${sub.taskId}, ${fc.user.id}, ${JSON.stringify(sub.d)}::jsonb, ${sub.savedAt}, ${sub.build ?? null}, ${sub.v ?? 1})
    on conflict (key) do nothing returning key`);
  if (made.length) return { kind: "new", progress: [] };
  const [row] = await q<{ status: string; result: SubmitResult | null; progress: Progress; age: number; taskId: string }>(sql`
    select status, result, progress, extract(epoch from now() - coalesce(finished_at, created_at))::int as age, task_id as "taskId"
      from factory_submissions where key = ${sub.key}`);
  if (!row) return { kind: "busy" };
  if (row.taskId !== sub.taskId) return { kind: "answered", result: failed(sub.key, "This job does not match", "The phone sent work for a different job with the same number.", "Start the job again from your list.", null) };
  if ((row.status === "done" || row.status === "held") && row.result) {
    await factoryAudit(fc, "factory.duplicate", sub.taskId, "Sent again — the first save was used, nothing posted twice", { key: sub.key });
    return { kind: "answered", result: { ...row.result, replay: true } as SubmitResult };
  }
  if (row.status === "processing" && n(row.age) < STALE_SECONDS) return { kind: "busy" };
  await db.execute(sql`
    update factory_submissions set status = 'processing', attempts = attempts + 1, payload = ${JSON.stringify(sub.d)}::jsonb,
           app_build = ${sub.build ?? null}, schema_version = ${sub.v ?? 1}, created_at = now(), finished_at = null
     where key = ${sub.key}`);
  return { kind: "resume", progress: row.progress ?? [] };
}

const failed = (key: string, title: string, text: string, fix: string, step: string | null): SubmitResult => ({ kind: "failed", key, title, text, fix, step });

async function settle(key: string, status: "done" | "failed" | "held", result: SubmitResult, progress?: Progress) {
  await db.execute(sql`
    update factory_submissions
       set status = ${status}, result = ${JSON.stringify(result)}::jsonb, finished_at = now()
           ${progress ? sql`, progress = ${JSON.stringify(progress)}::jsonb` : sql``}
     where key = ${key}`);
}

async function saveProgress(key: string, progress: Progress) {
  await db.execute(sql`update factory_submissions set progress = ${JSON.stringify(progress)}::jsonb where key = ${key}`);
}

/** The floor as the server sees it now — the copy the rules are run against before anything posts. */
async function liveData(fc: FactoryCtx): Promise<FactoryData> {
  const m = await masters();
  const lots = await lotsFor(fc.godown, m);
  const orders = await ordersFor(fc.godown, m, lots);
  const open = await openPackBatches(fc.godown.id);
  const tasks = await tasksFor(fc.godown.id, open);
  const { emp } = await people(fc.godown.id);
  return {
    loc: fc.godown.name, locId: fc.godown.id, shift: "", dateLine: "", at: new Date().toISOString(), emp, teams: {} as FactoryData["teams"], hours: {},
    rm: m.rm, sfg: m.sfg, sku: m.sku, pm: m.pm, box: m.box, orders, lots, tasks, review: [], audit: [], down: {}, dup: 0, corr: 0,
  };
}

/** Where a refusal from the ERP points the worker back to. */
const STEP_OF: Record<Proc, Record<string, string>> = {
  mixing: { default: "materials" },
  filling: { cans: "count", sfgLot: "sfg", canUse: "pack", default: "count" },
  packing: { boxes: "boxes", lot: "fglot", cans: "fglot", default: "boxes" },
  dispatch: { default: "load" },
};

function erpRefusal(key: string, proc: Proc, r: { error: string; fieldErrors?: { field: string; message: string }[] }): SubmitResult {
  const field = r.fieldErrors?.[0]?.field?.replace(/^l\d+\./, "") ?? "";
  const step = STEP_OF[proc][field] ?? STEP_OF[proc].default;
  return failed(key, r.error, "The ERP did not accept this. Nothing was saved.", "Tap Fix it, check the step, then send again.", step);
}

/** The day the work was done — what the ERP document is dated, not the day the network came back. */
const workDay = (sub: Submission) => calendarDate(savedInstant(sub.savedAt, new Date()));

/* =========================================================== holding */

/**
 * RECEIVED, SAFE, AND WITH THE PRODUCTION HEAD.
 *
 * A job that comes in from a phone's queue was finished hours ago, maybe two
 * days ago. If the ERP will not take it now — the drum was used by somebody
 * else while the phone was offline, the job was closed meanwhile — handing
 * the worker an error helps nobody: the work happened, and they cannot go
 * back to Tuesday to fix it. So it is kept exactly as sent and put in front
 * of the person who can decide, with the reason in words. The worker is told
 * the truth: it is with the supervisor, not in the ERP.
 */
async function hold(fc: FactoryCtx, sub: Submission, why: { title: string; text?: string }): Promise<SubmitResult> {
  const [t] = await q<{ proc: Proc }>(sql`select proc from factory_tasks where id = ${sub.taskId}`);
  const at = savedInstant(sub.savedAt, new Date());
  const when = calendarDate(at) + " " + hhmm(at);
  const [open] = await q<{ id: string }>(sql`
    select id from factory_reviews where kind = 'unposted' and status = 'open' and change->>'key' = ${sub.key} limit 1`);
  if (!open)
    await db.execute(sql`
      insert into factory_reviews (id, kind, task_id, title, body, meta, change, created_by_id)
      values (${erpId("frv")}, 'unposted', ${sub.taskId}, 'Work not yet in the ERP',
              ${why.title + ". " + (why.text ? why.text + " " : "") + "Saved on the phone " + when + "."},
              ${"Sent " + (sub.queued ? "from the phone's queue" : "to the supervisor") + " · " + fc.user.name},
              ${JSON.stringify({ key: sub.key })}::jsonb, ${fc.user.id})`);
  await factoryAudit(fc, "factory.held", sub.taskId, "Received, not posted · " + why.title, { key: sub.key });
  return {
    kind: "held",
    key: sub.key,
    task: sub.taskId,
    proc: t?.proc ?? "mixing",
    title: "Sent to your supervisor",
    text: "Your work is safe. Your supervisor will check it and put it in the ERP. You do not need to do it again.",
  };
}

/* =========================================================== the entry point */

export async function submitJob(fc: FactoryCtx, raw: Submission, opts: { repost?: boolean } = {}): Promise<SubmitResult> {
  /* Whatever page sent it, read it as today's shape. */
  const sub: Submission = { ...raw, d: normalizeDraft(raw.d, raw.v ?? 1) };
  if (opts.repost) await db.execute(sql`update factory_submissions set status = 'failed', result = null where key = ${sub.key} and status = 'held'`);
  const c = await claim(fc, sub);
  if (c.kind === "answered") return c.result;
  if (c.kind === "busy") return { kind: "retry", key: sub.key, why: "Still being saved" };

  try {
    let result: SubmitResult;
    const ageH = (Date.now() - savedInstant(sub.savedAt, new Date()).getTime()) / 3_600_000;
    if (ageH > OFFLINE_HOURS && !opts.repost)
      /* Stock read two days late cannot be trusted to still be there: a person looks first. */
      result = await hold(fc, sub, { title: "Saved more than " + OFFLINE_HOURS + " hours before it reached the ERP", text: "The stock may have changed since." });
    else {
      result = await run(fc, sub, c.progress);
      if (result.kind === "failed" && (sub.queued || sub.toSupervisor) && !opts.repost) result = await hold(fc, sub, result);
    }
    await settle(sub.key, result.kind === "done" ? "done" : result.kind === "held" ? "held" : "failed", result);
    return result;
  } catch (e) {
    /* Not the worker's problem and not an answer: release the key so the
       phone's next try resumes it, and tell the phone to keep it. */
    console.error("[factory] submit failed", sub.key, e);
    await db.execute(sql`update factory_submissions set status = 'failed', finished_at = now() where key = ${sub.key}`).catch(() => {});
    return { kind: "retry", key: sub.key, why: "The system did not answer" };
  }
}

async function run(fc: FactoryCtx, sub: Submission, progress: Progress): Promise<SubmitResult> {
  const live = await liveData(fc);
  const t = live.tasks.find((x) => x.id === sub.taskId);
  const answeredBefore = async () => {
    const [other] = await q<{ result: SubmitResult }>(sql`
      select result from factory_submissions where task_id = ${sub.taskId} and status in ('done', 'held') and key <> ${sub.key} limit 1`);
    return other?.result ? ({ ...other.result, replay: true } as SubmitResult) : null;
  };
  if (!t || t.status === "done" || t.status === "held") {
    const prev = await answeredBefore();
    if (prev) return prev;
    if (!t) return failed(sub.key, "This job is not on today's list", "It may have been finished or taken off by your supervisor.", "Go back to your list and pick the job again.", null);
    return failed(sub.key, "This job is already saved", "Somebody sent it before you.", "Go back to your list.", null);
  }
  if ((!fc.head && t.proc !== fc.area) || (fc.head && fc.scope && t.proc !== fc.scope)) return failed(sub.key, "This work is not yours", "It belongs to the " + t.proc + " team.", "Ask your supervisor.", null);
  const d = sub.d;
  const team = d.team;
  for (const k of [team.owner, team.op, team.ver, ...team.helpers])
    if (k && !live.emp[k]) return failed(sub.key, "Somebody in the team is not on the list", "One of the people chosen cannot be found.", "Tap Fix it and choose the team again.", "team");

  /* Steps already posted were checked when they were posted; checking stock
     again would refuse the half that is left because of the half that went. */
  if (!progress.length) {
    const blocked = firstBlockedStep(live, t, d);
    if (blocked) return failed(sub.key, blocked.msg, "The stock changed after you checked it, or a step is missing. Nothing was saved.", "Tap Fix it and do that step again.", blocked.step);
  }

  let out: SubmitResult;
  if (t.proc === "mixing") out = await postMixing(fc, sub, live, t, d, progress);
  else if (t.proc === "filling") out = await postFilling(fc, sub, live, t, d, progress);
  else if (t.proc === "packing") out = await postPacking(fc, sub, live, t, d, progress);
  else out = await postDispatch(fc, sub, live, t, d);
  if (out.kind !== "done") return out;

  await finish(fc, sub, live, t, d, out);
  return out;
}

/* =========================================================== mixing */

async function postMixing(fc: FactoryCtx, sub: Submission, live: FactoryData, t: Task, d: Draft, progress: Progress): Promise<SubmitResult> {
  const sf = live.sfg[t.item!];
  const lines = d.rm ?? [];
  const poured = lines.reduce((a, r) => a + (r.qty ?? 0), 0);
  const made = d.out ?? 0;
  if (made > poured + 1e-9)
    return failed(sub.key, "More litres than you poured", "You poured " + nf(poured) + " L but entered " + nf(made) + " L made. Nothing was saved.", "Tap Fix it and read the tank gauge again.", "output");

  let lot = progress.find((p) => p.doc === "sfg")?.ref;
  if (!lot) {
    /* The loss is what went in less what came out. The ERP holds it per
       material line, so it is laid over the lines in order — the total is
       what the yield is computed from, and it is exactly the loss. */
    let loss = Math.max(0, poured - made);
    const batches = d.batches ?? 1;
    const erpLines = lines.map((r) => {
      const total = r.qty ?? 0;
      const adj = Math.min(total, loss);
      loss -= adj;
      return { item: live.rm[r.item].n, lot: r.lot!, qty: String(total / batches), adjusted: String(Math.round(adj * 1000) / 1000) };
    });
    const res = await screenModule("sfgBatches")!.forms!.new(
      erpCtxFor(fc),
      { date: workDay(sub), godown: fc.godown.name, product: sf.n, batches: String(batches) },
      erpLines,
    );
    if (!res.ok) return erpRefusal(sub.key, "mixing", res);
    const [row] = await q<{ lot: string }>(sql`
      select lot_code as lot from erp_sfg_lines where created_by_id = ${fc.user.id} and formulation_id = ${t.item}
       order by created_at desc limit 1`);
    lot = row?.lot ?? "—";
    progress.push({ step: 0, doc: "sfg", ref: lot });
    await saveProgress(sub.key, progress);
  }
  const at = nowHM();
  return {
    kind: "done", key: sub.key, task: t.id, proc: "mixing",
    rows: [["New batch", lot], ["Made", nf(made) + " L"], ["Drums used", String(lines.length)], ["Saved at", at]],
    label: { code: lot, name: sf.n, meta: nf(made) + " L · " + at },
    msg: nf(made) + " L of " + sf.short + " base is now in stock. Quality must pass it before it is filled.",
  };
}

/* =========================================================== filling */

async function postFilling(fc: FactoryCtx, sub: Submission, live: FactoryData, t: Task, d: Draft, progress: Progress): Promise<SubmitResult> {
  const k = live.sku[d.sku!];
  const fgId = d.sku!.split(":")[0];
  const unit = k.kind === "drum" ? "drums" : "cans";
  const filled = d.filled ?? 0, rej = d.rej ?? 0, good = filled - rej;
  let lot = progress.find((p) => p.doc === "fg")?.ref;
  if (!lot) {
    const [fg] = await q<{ name: string }>(sql`select name from finished_goods where id = ${fgId}`);
    const res = await screenModule("fgFill")!.forms!.new(
      erpCtxFor(fc),
      {
        date: workDay(sub),
        godown: fc.godown.name,
        sfg: live.sfg[k.sfg].n,
        sfgLot: d.sfg!,
        fg: fg?.name ?? k.n,
        size: String(k.l),
        canUse: live.pm[k.pm] ?? "",
        cans: String(filled),
        adjusted: String(rej),
      },
      [],
    );
    if (!res.ok) return erpRefusal(sub.key, "filling", res);
    const [row] = await q<{ lot: string }>(sql`
      select lot_code as lot from erp_fg_fills where created_by_id = ${fc.user.id} and finished_good_id = ${fgId}
       order by created_at desc limit 1`);
    lot = row?.lot ?? "—";
    progress.push({ step: 0, doc: "fg", ref: lot });
    await saveProgress(sub.key, progress);
  }
  const at = nowHM();
  return {
    kind: "done", key: sub.key, task: t.id, proc: "filling",
    rows: [["New lot", lot], ["Good " + unit, nf(good)], ["Damaged", nf(rej)], ["Base liquid used", nf(filled * k.l) + " L"]],
    label: { code: lot, name: k.n + " " + k.size, meta: nf(good) + " " + unit + " · " + at },
    msg: nf(good) + " good " + unit + " are now in stock. Stick this label on the pallet.",
  };
}

/* =========================================================== packing */

type PackCall = { batch: "carry" | number; serial: number | null; boxes: number; lot: string; cans: number };

/**
 * The packing count, as ERP packing lines.
 *
 * Boxes first finish the open batch this SKU already has, then fill new
 * batches of the configured size. Each batch's cans are drawn from the
 * scanned pallets in the order they were scanned. A last batch short of its
 * size is written as it is — the ERP's complete-batch rule keeps it out of
 * packing stock until a later count fills it (PRD §7.3.5).
 */
function packPlan(live: FactoryData, t: Task, d: Draft, carry: { serial: number; boxes: number; cans: number } | null): PackCall[] {
  const b = live.box[d.box!];
  const pool = (d.fg ?? []).map((g) => ({ lot: g.lot, left: live.lots[g.lot]?.avail ?? 0 }));
  const take = (cans: number, batch: PackCall["batch"], serial: number | null, boxes: number, calls: PackCall[]) => {
    for (const p of pool) {
      if (cans <= 0) break;
      const c = Math.min(p.left, cans);
      if (c <= 0) continue;
      p.left -= c;
      cans -= c;
      calls.push({ batch, serial, boxes, lot: p.lot, cans: c });
    }
  };
  const calls: PackCall[] = [];
  let left = d.boxes ?? 0;
  if (carry) {
    const room = Math.floor((carry.boxes * b.cpb - carry.cans) / b.cpb);
    const put = Math.min(room, left);
    if (put > 0) take(put * b.cpb, "carry", carry.serial, carry.boxes, calls);
    left -= Math.max(0, put);
  }
  let i = 0;
  while (left > 0) {
    const put = Math.min(b.batch, left);
    take(put * b.cpb, i, null, b.batch, calls);
    left -= put;
    i++;
  }
  return calls;
}

async function postPacking(fc: FactoryCtx, sub: Submission, live: FactoryData, t: Task, d: Draft, progress: Progress): Promise<SubmitResult> {
  const b = live.box[d.box!];
  const k = live.sku[b.sku];
  const open = (await openPackBatches(fc.godown.id)).find((x) => x.skuId === d.box);
  /* The plan is fixed on the first attempt and stored, so a resumed send
     replays the same calls rather than re-planning around half a posting. */
  const stored = progress.find((p) => p.doc === "plan");
  const plan: PackCall[] = stored ? JSON.parse(stored.ref) : packPlan(live, t, d, open ? { serial: open.serial, boxes: open.boxes, cans: open.cans } : null);
  if (!stored) {
    progress.push({ step: -1, doc: "plan", ref: JSON.stringify(plan) });
    await saveProgress(sub.key, progress);
  }
  const [{ fgName, skuName }] = await q<{ fgName: string; skuName: string }>(sql`
    select fg.name as "fgName", p.name as "skuName" from products p join finished_goods fg on fg.id = p.finished_good_id where p.id = ${d.box}`);
  const serials = new Map<PackCall["batch"], number>();
  for (const p of progress) if (p.doc === "serial") serials.set(p.step === -2 ? "carry" : Number(p.ref.split(":")[0]), Number(p.ref.split(":")[1]));

  for (let i = 0; i < plan.length; i++) {
    if (progress.some((p) => p.doc === "pack" && p.step === i)) continue;
    const c = plan[i];
    const serial = c.serial ?? serials.get(c.batch) ?? null;
    const res = await screenModule("packBatches")!.forms!.new(
      erpCtxFor(fc),
      {
        date: workDay(sub),
        godown: fc.godown.name,
        fg: fgName,
        sku: skuName,
        boxes: String(c.boxes),
        lot: c.lot,
        cans: String(c.cans),
        remarks: "Factory app · " + t.id,
        ...(serial != null ? { serialFixed: String(serial) } : {}),
      },
      [],
    );
    if (!res.ok) {
      if (i === 0) return erpRefusal(sub.key, "packing", res);
      /* Part of the count is already in the ERP. Saying "nothing was saved"
         would be false; the rest resumes on the next try with the same key. */
      return failed(sub.key, res.error, "Part of this count is saved. The rest is not.", "Tap Try again. Only the missing part will be sent.", null);
    }
    if (serial == null) {
      const [row] = await q<{ serial: number }>(sql`
        select batch_serial as serial from erp_pack_lines where created_by_id = ${fc.user.id} and sku_id = ${d.box} and fg_lot_code = ${c.lot}
         order by created_at desc limit 1`);
      serials.set(c.batch, n(row?.serial));
      progress.push({ step: c.batch === "carry" ? -2 : 0, doc: "serial", ref: c.batch + ":" + n(row?.serial) });
    }
    progress.push({ step: i, doc: "pack", ref: c.lot });
    await saveProgress(sub.key, progress);
  }

  /* What the batches now are, read back from the ERP rather than assumed. */
  const batchSerials = [...new Set([...serials.values()])];
  const batches = batchSerials.length
    ? await q<{ no: string; boxes: number; cans: number; cpb: number }>(sql`
        select l.batch_no as no, max(l.boxes) as boxes, sum(l.cans)::float8 as cans, max(p.cans_per_box) as cpb
          from erp_pack_lines l join products p on p.id = l.sku_id
         where l.batch_serial in ${inList(batchSerials.map(String))} and l.godown_id = ${fc.godown.id}
         group by l.batch_no order by min(l.created_at)`)
    : [];
  const complete = batches.filter((x) => n(x.cans) >= n(x.boxes) * n(x.cpb));
  const openNow = batches.filter((x) => n(x.cans) < n(x.boxes) * n(x.cpb));
  const rem = openNow.reduce((a, x) => a + Math.floor(n(x.cans) / Math.max(1, n(x.cpb))), 0);
  const full = complete.length;
  const at = nowHM();
  const first = complete[0];
  return {
    kind: "done", key: sub.key, task: t.id, proc: "packing",
    rows: [["Boxes packed", nf(d.boxes)], ["Full batches ready", String(full)], ["Next batch", rem + " boxes waiting"], ["Cans used", nf((d.boxes ?? 0) * b.cpb)]],
    label: first ? { code: first.no, name: k.n + " " + k.size + " · box of " + b.cpb, meta: n(first.boxes) + " boxes · " + at } : null,
    msg: full ? full + " full batch" + (full > 1 ? "es are" : " is") + " ready to sell." : "No batch is full yet. Your boxes are saved.",
  };
}

/* =========================================================== dispatch */

/**
 * Loading is CHECKED here, never dispatched. The ERP's verification — the
 * scan gate, the transport row, the order book — stays with the office
 * (PRD §7.4.6): the floor says the right lots went on the right lorry in the
 * right numbers, with a photograph to prove it.
 */
async function postDispatch(fc: FactoryCtx, sub: Submission, live: FactoryData, t: Task, d: Draft): Promise<SubmitResult> {
  const ord = live.orders[t.order!];
  if (d.photoId)
    await db.execute(sql`
      update attachments set parent_type = 'factory_task', parent_id = ${t.id}, updated_at = now()
       where id = ${d.photoId} and parent_id is null and uploaded_by_id = ${fc.user.id}`);
  const at = nowHM();
  return {
    kind: "done", key: sub.key, task: t.id, proc: "dispatch",
    rows: [["Order", t.order!], ["Customer", ord?.cust ?? "—"], ["Next", "Office sends it"], ["Checked at", at]],
    label: null,
    msg: "Loading is checked. The office will now send the order.",
  };
}

/* =========================================================== after the ERP */

async function finish(fc: FactoryCtx, sub: Submission, live: FactoryData, t: Task, d: Draft, r: Extract<SubmitResult, { kind: "done" }>) {
  const who = fc.user.name;
  /* The job's time on every screen is when it was DONE, not when the network came back. */
  const at = hhmm(savedInstant(sub.savedAt, new Date()));
  const names = (ids: (string | null)[]) => ids.filter((x): x is string => !!x).map((k) => live.emp[k]?.n ?? "?").join(", ");
  let outRow: NonNullable<Task["out"]>;
  if (t.proc === "mixing") outRow = { good: d.out ?? 0, unit: "L", lot: r.label?.code, at };
  else if (t.proc === "filling") {
    const k = live.sku[d.sku!];
    outRow = { good: (d.filled ?? 0) - (d.rej ?? 0), rej: d.rej ?? 0, unit: k.kind === "drum" ? "drums" : "cans", lot: r.label?.code, at };
  } else if (t.proc === "packing") outRow = { good: d.boxes ?? 0, unit: "boxes", lot: r.label?.code ?? "—", at };
  else outRow = { good: 1, unit: "order", at };
  const extra: Record<string, unknown> = { key: sub.key, savedAt: sub.savedAt, rejR: d.rejR ?? null };
  if (t.proc === "dispatch") Object.assign(extra, { loads: d.loads, checks: d.checks, photoId: d.photoId ?? null, order: orderNoOf(t.order!) });
  if (t.proc === "filling" && d.sku !== t.item) extra.sizeChangedFrom = t.item;

  await db.transaction(async (tx) => {
    await tx.execute(sql`
      update factory_tasks set status = 'done', out = ${JSON.stringify({ ...outRow, ...extra })}::jsonb, done_at = now()
       where id = ${t.id}`);
    await writeTeam(tx, t.id, d.team, fc.user.id);
    if (d.down && d.downR && d.downMin)
      await tx.execute(sql`
        insert into factory_downtime (id, task_id, godown_id, proc, reason, minutes, recorded_by_id)
        values (${erpId("fdt")}, ${t.id}, ${fc.godown.id}, ${t.proc}, ${d.downR}, ${d.downMin}, ${fc.user.id})`);
  });

  const review = async (kind: string, title: string, body: string, meta: string) =>
    db.execute(sql`
      insert into factory_reviews (id, kind, task_id, title, body, meta, created_by_id)
      values (${erpId("frv")}, ${kind}, ${t.id}, ${title}, ${body}, ${meta}, ${fc.user.id})`);

  if (t.proc === "mixing") {
    const { exp, dev, over } = mixDeviation(live, t, d);
    if (over) {
      const sf = live.sfg[t.item!];
      await review("tolerance", "Mixing output outside the limit",
        `${r.label?.code} made ${nf(d.out)} L against ${nf(exp)} L expected (${dev >= 0 ? "+" : ""}${dev.toFixed(1)}%). The limit is ±${sf.tol}%.`,
        "Today " + at + " · " + names([d.team.owner, d.team.op, ...d.team.helpers]));
    }
    const manual = (d.rm ?? []).filter((x) => x.manual);
    if (manual.length)
      await review("manual", "Material picked by photo", manual.map((x) => x.lot + " (" + live.rm[x.item].n + ")").join(", ") + " — chosen from pictures in " + t.id + ".", "Mixing · today " + at + " · " + who);
  }
  if (t.proc === "filling" && (d.sfgManual || d.pmManual))
    await review("manual", "Lot picked by photo", [d.sfgManual ? d.sfg : null, d.pmManual ? d.pm : null].filter(Boolean).join(", ") + " — the label was not scanned in " + t.id + ".", "Filling · today " + at + " · " + who);
  if (t.proc === "filling" && d.sku !== t.item)
    await review("manual", "Size changed from the task sheet", `${t.id} was filled as ${live.sku[d.sku!].size} instead of ${live.sku[t.item!]?.size}.`, "Filling · today " + at + " · " + who);
  if (t.proc === "packing" && (d.fg ?? []).some((g) => g.manual))
    await review("manual", "Lot picked by photo", (d.fg ?? []).filter((g) => g.manual).map((g) => g.lot).join(", ") + " — the label was damaged; chosen from the pictures.", "Packing · today " + at + " · " + who);
  const loadedByPhoto = Object.keys(d.loadsManual ?? {}).filter((k) => d.loadsManual![k]);
  if (t.proc === "dispatch" && loadedByPhoto.length)
    await review("manual", "Lot picked by photo", loadedByPhoto.join(", ") + " — loaded for " + t.order + " without its label being scanned.", "Dispatch · today " + at + " · " + who);
  if (!d.team.helpers.length) await review("attribution", "No helper recorded", t.id + " was saved without a helper.", "Today " + at + " · " + who);

  const what =
    t.proc === "mixing" ? `Saved mixing batch ${r.label?.code} · ${nf(d.out)} L`
    : t.proc === "filling" ? `Saved filling ${r.label?.code} · ${nf((d.filled ?? 0) - (d.rej ?? 0))} good, ${nf(d.rej)} rejected`
    : t.proc === "packing" ? `Saved packing · ${nf(d.boxes)} boxes · ${r.rows[1][1]} full batch${r.rows[1][1] === "1" ? "" : "es"}`
    : `Loading checked for ${t.order} · photo ${d.photo ?? "—"}`;
  await factoryAudit(fc, "factory." + t.proc + ".save", t.id, what + (sub.queued ? ` · saved on phone ${hhmm(savedInstant(sub.savedAt, new Date()))}, sent from its queue` : ""), { key: sub.key, team: d.team });
  if (d.down && d.downR) await factoryAudit(fc, "factory.downtime", t.id, `Machine stopped ${d.downMin} min · ${d.downR}`);
}
