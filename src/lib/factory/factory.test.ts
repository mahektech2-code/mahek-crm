/**
 * The factory floor app, end to end against a real database through the real
 * ERP handlers (PRD §14's checklist).
 *
 *   npm run test:integration
 *
 * Needs `mahekone_test` (npm run test:db). It truncates what it touches.
 */
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";

import { db } from "@/db";
import { appAccess, users, type User } from "@/db/schema";
import { setTestUser } from "@/lib/auth";
import { invalidateConfig, seedConfig } from "@/lib/config/store";
import { seedFactoryFloor, type SeededFloor } from "./demo-seed";
import { bootstrap, contextFor, type FactoryCtx } from "./server";
import { submitJob } from "./post";
import { assignTask, decideReview, requestCorrection } from "./head";
import { resolveScan } from "./rules";
import type { Draft, FactoryData, Submission, Task } from "./types";

type Row = Record<string, unknown>;
const q = async <T = Row>(s: ReturnType<typeof sql>) => (await db.execute(s)) as unknown as T[];
let floor: SeededFloor;

async function as(key: string): Promise<{ fc: FactoryCtx; data: FactoryData }> {
  const u = floor.users[key];
  setTestUser(u);
  const fc = (await contextFor(u))!;
  return { fc, data: await bootstrap(fc) };
}

const key = () => "MOB-test-" + randomUUID().slice(0, 10);
const sub = (t: Task, d: Draft, k = key()): Submission => ({ key: k, taskId: t.id, d, savedAt: "10:00" });
const open = (data: FactoryData, proc: string, pred: (t: Task) => boolean = () => true) =>
  data.tasks.find((t) => t.proc === proc && t.status === "ready" && pred(t))!;
const lotOf = (data: FactoryData, type: string, item: string, minAvail = 1) =>
  Object.values(data.lots).find((l) => l.type === type && l.item === item && l.status === "ok" && l.avail >= minAvail && l.loc === data.loc)!;

function mixDraft(data: FactoryData, t: Task, out: number, pour?: Record<string, number>): Draft {
  const sf = data.sfg[t.item!];
  return {
    team: JSON.parse(JSON.stringify(t.team)),
    down: false, downR: null, downMin: null,
    batches: t.batches,
    rm: sf.recipe.map(([rm, per]) => {
      const qty = pour?.[rm] ?? per * (t.batches ?? 1);
      /* The drum a person would pick: one with enough in it, else the fullest. */
      const lot = lotOf(data, "rm", rm, qty) ?? Object.values(data.lots).filter((l) => l.type === "rm" && l.item === rm && l.loc === data.loc).sort((a, b) => b.avail - a.avail)[0];
      return { item: rm, per, lot: lot.code, qty };
    }),
    out,
  };
}

before(async () => {
  await db.execute(sql`
    truncate users, customers, erp_raw_materials, erp_suppliers, erp_inward, erp_tests, erp_purchases, erp_rm_entries,
             erp_sfg_lines, erp_sfg_entries, erp_fg_fills, erp_fg_entries, erp_pack_lines, erp_pack_entries,
             erp_transfers, erp_rm_levels, erp_fg_levels, erp_requisitions, erp_user_powers, erp_godown_staff,
             erp_user_settings, erp_sfg_qc, erp_units, erp_unit_events, erp_orders, erp_batch_codes, erp_order_details,
             erp_recipes, products, finished_goods, product_brands, product_formulations,
             factory_staff, factory_team_defaults, factory_tasks, factory_task_members, factory_submissions,
             factory_reviews, factory_downtime, audit_log restart identity cascade`);
  await db.execute(sql`update erp_series set last = 0`);
  await db.execute(sql`delete from erp_series where key = 'factoryTask'`);
  /* A packing batch of 20 boxes, so the seed's cans make one full batch and some over. */
  await seedConfig();
  await db.execute(sql`update app_settings set value = '20'::jsonb where key = 'erp.factory.packBatchBoxes'`);
  invalidateConfig();
  floor = await seedFactoryFloor({ pin: "1234" });
});

after(async () => {
  setTestUser(null);
  await db.$client.end();
});

describe("who sees what", () => {
  test("a worker opens the app with their own team's work; somebody without the grant gets nothing", async () => {
    const { fc, data } = await as("anil");
    assert.equal(fc.area, "mixing");
    assert.equal(fc.head, false);
    assert.ok(data.tasks.some((t) => t.proc === "mixing"));
    const [stranger] = await db
      .insert(users)
      .values({ id: "usr_stranger", name: "Not Factory", email: "nf@x.test", phone: "9000000001", passwordHash: "x", role: "associate", initials: "NF" })
      .returning();
    assert.equal(await contextFor(stranger), null, "no Factory grant, no factory");
  });

  test("a scan answers in the step's own terms — wrong stage, wrong material, wrong place", async () => {
    const { data } = await as("kamalkant");
    const t = open(data, "filling");
    const d: Draft = { team: t.team, down: null, downR: null, downMin: null, sku: t.item };
    const rmLot = lotOf(data, "rm", Object.keys(data.rm)[0]);
    const r = resolveScan(rmLot.code, { db: data, purpose: "sfg", meta: {}, task: t, d });
    assert.equal(r.ok, false);
    assert.match((r as { title: string }).title, /not base liquid/);
    const unknown = resolveScan("NOT-A-LOT", { db: data, purpose: "sfg", meta: {}, task: t, d });
    assert.equal((unknown as { title: string }).title, "We do not know this QR");
  });
});

describe("mixing", () => {
  test("one batch posts once however many times it is sent", async () => {
    const { fc, data } = await as("anil");
    const t = open(data, "mixing", (x) => data.sfg[x.item!].short === "NC");
    const d = mixDraft(data, t, 990);
    const s = sub(t, d);
    const before = (await q<{ n: number }>(sql`select count(distinct sfg_no)::int as n from erp_sfg_lines`))[0].n;
    const first = await submitJob(fc, s);
    assert.equal(first.kind, "done", JSON.stringify(first));
    const again = await submitJob(fc, s);
    assert.equal(again.kind, "done");
    assert.equal((again as { replay?: boolean }).replay, true, "the second send is answered from the first");
    const after = (await q<{ n: number }>(sql`select count(distinct sfg_no)::int as n from erp_sfg_lines`))[0].n;
    assert.equal(after, before + 1, "exactly one ERP batch");
    const [lot] = await q<{ lot: string; yld: number }>(sql`
      select lot_code as lot, sum(total_use - litres_adjusted)::float8 as yld from erp_sfg_lines where created_by_id = ${fc.user.id} group by lot_code`);
    assert.equal(lot.yld, 990, "the ERP yield is what the tank gauge said");
    const [dup] = await q<{ n: number }>(sql`select count(*)::int as n from audit_log where action = 'factory.duplicate'`);
    assert.equal(dup.n, 1, "the blocked double send is counted for the Machines screen");
  });

  test("the team is recorded by role, and the person who pressed Send is not assumed to be any of them", async () => {
    const [t] = await q<{ id: string }>(sql`select id from factory_tasks where status = 'done' and out->>'key' is not null and proc = 'mixing' limit 1`);
    const members = await q<{ role: string; name: string }>(sql`
      select m.role, u.name from factory_task_members m join users u on u.id = m.user_id where m.task_id = ${t.id} order by m.role`);
    assert.deepEqual(members.map((m) => m.role + ":" + m.name).sort(), ["helper:Gangaram", "operator:Anil", "owner:Rakesh"]);
    const [s] = await q<{ name: string }>(sql`select u.name from factory_submissions s join users u on u.id = s.user_id where s.task_id = ${t.id}`);
    assert.equal(s.name, "Anil");
    const [out] = await q<{ good: number }>(sql`select (out->>'good')::int as good from factory_tasks where id = ${t.id}`);
    assert.equal(out.good, 990, "the batch is counted once for the team, not once per person");
  });

  test("not enough in the drum refuses the whole batch, names the step, and the same key can be sent again once fixed", async () => {
    const { fc, data } = await as("anil");
    const t = open(data, "mixing", (x) => data.sfg[x.item!].short === "NANO");
    const mek = Object.keys(data.rm).find((k) => data.rm[k].n === "MEK")!;
    const k = key();
    const lotsBefore = (await q<{ n: number }>(sql`select count(*)::int as n from erp_sfg_lines`))[0].n;
    const bad = await submitJob(fc, sub(t, mixDraft(data, t, 700, { [mek]: 5000 }), k));
    assert.equal(bad.kind, "failed");
    assert.equal((bad as { step: string }).step, "materials");
    assert.equal((await q<{ n: number }>(sql`select count(*)::int as n from erp_sfg_lines`))[0].n, lotsBefore, "nothing posted");
    const avail = lotOf(data, "rm", mek).avail;
    const fixed = await submitJob(fc, sub(t, mixDraft(data, t, 600, { [mek]: avail }), k));
    assert.equal(fixed.kind, "done", JSON.stringify(fixed));
    const [r] = await q<{ kind: string }>(sql`select kind from factory_reviews where task_id = ${t.id} and kind = 'tolerance'`);
    assert.ok(r, "far below the batch sheet goes to the Production Head");
  });
});

describe("filling and packing", () => {
  test("a fill goes through the ERP's QC gate and records the damaged cans as its adjustment", async () => {
    const { fc, data } = await as("kamalkant");
    const t = open(data, "filling", (x) => data.sku[x.item!].size === "1 L");
    const k = data.sku[t.item!];
    const d: Draft = {
      team: t.team, down: true, downR: "Cleaning", downMin: 20,
      sku: t.item, sfg: t.sfg!, pm: lotOf(data, "pm", k.pm).code, filled: 100, rej: 3, rejR: "Leaking",
    };
    const r = await submitJob(fc, sub(t, d));
    assert.equal(r.kind, "done", JSON.stringify(r));
    const [fill] = await q<{ cans: number; adj: number }>(sql`select cans, can_adjusted as adj from erp_fg_fills where lot_code = ${(r as { label: { code: string } }).label.code}`);
    assert.deepEqual([fill.cans, fill.adj], [100, 3]);
    const [down] = await q<{ minutes: number }>(sql`select minutes from factory_downtime where task_id = ${t.id}`);
    assert.equal(down.minutes, 20);
  });

  test("packing finishes full batches into stock and keeps the remainder out of it", async () => {
    const { fc, data } = await as("ganesh");
    const t = open(data, "packing", (x) => data.box[x.item!].cpb === 12);
    const b = data.box[t.item!];
    const pallets = Object.values(data.lots).filter((l) => l.type === "fg" && l.item === b.sku && l.avail > 0);
    const have = pallets.reduce((a, l) => a + l.avail, 0);
    const boxes = Math.min(b.batch + 5, Math.floor(have / b.cpb));
    assert.ok(boxes > b.batch, "the seed leaves enough cans for one full batch and some over: " + have);
    const entriesBefore = (await q<{ n: number }>(sql`select count(*)::int as n from erp_pack_entries`))[0].n;
    const r = await submitJob(fc, sub(t, { team: t.team, down: false, downR: null, downMin: null, box: t.item, fg: pallets.map((p) => ({ lot: p.code })), boxes }));
    assert.equal(r.kind, "done", JSON.stringify(r));
    const entriesAfter = (await q<{ n: number }>(sql`select count(*)::int as n from erp_pack_entries`))[0].n;
    assert.equal(entriesAfter, entriesBefore + 1, "one batch completed, and only that one reached packing stock");
    const [units] = await q<{ n: number }>(sql`select count(*)::int as n from erp_units where lot_code = ${(r as { label: { code: string } }).label.code}`);
    assert.equal(units.n, b.batch, "each box of the complete batch has its own id");
    const open2 = await q<{ cans: number }>(sql`
      select sum(l.cans)::float8 as cans from erp_pack_lines l join products p on p.id = l.sku_id
       where l.sku_id = ${t.item} group by l.batch_no having sum(l.cans) < max(l.boxes) * max(p.cans_per_box)`);
    assert.equal(open2.length, 1);
    assert.equal(open2[0].cans, (boxes - b.batch) * b.cpb, "the remainder waits in an open batch");
  });
});

describe("dispatch", () => {
  test("loading is checked against the allocation, and checking it never marks the order dispatched", async () => {
    const { fc, data } = await as("imran");
    const t = open(data, "dispatch", (x) => !data.orders[x.order!]?.blocked);
    const o = data.orders[t.order!];
    const loads = Object.fromEntries(o.lines.flatMap((ln) => ln.alloc.map((a) => [a[0], a[1]])));
    const short = { ...loads, [Object.keys(loads)[0]]: 1 };
    const checks = { seal: true, labels: true, clean: true, papers: true };
    const bad = await submitJob(fc, sub(t, { team: t.team, down: null, downR: null, downMin: null, loads: short, checks, photo: "10:00" }));
    assert.equal(bad.kind, "failed");
    assert.equal((bad as { step: string }).step, "load");
    const ok = await submitJob(fc, sub(t, { team: t.team, down: null, downR: null, downMin: null, loads, checks, photo: "10:00" }));
    assert.equal(ok.kind, "done", JSON.stringify(ok));
    const [v] = await q<{ verification: string; status: string }>(sql`
      select d.verification, d.dispatch_status as status from erp_order_details d join erp_orders o on o.id = d.order_id where o.order_no = ${Number(t.order!.replace("SO-", ""))} limit 1`);
    assert.deepEqual([v.verification, v.status], ["Pending", "Pending"], "the office still sends it");
  });

  test("an order the office has not readied cannot be loaded", async () => {
    const { data } = await as("imran");
    assert.ok(data.tasks.some((t) => t.proc === "dispatch" && t.status === "blocked"));
  });
});

describe("the Production Head", () => {
  test("a worker cannot give work; the head can, and the team comes with it", async () => {
    const { fc: worker, data } = await as("anil");
    const nc = Object.keys(data.sfg).find((k) => data.sfg[k].short === "NC")!;
    const refused = await assignTask(worker, { proc: "mixing", item: nc, qty: 1, due: "16:00" });
    assert.equal(refused.ok, false);
    const { fc: head } = await as("vijay");
    const made = await assignTask(head, { proc: "mixing", item: nc, qty: 2, due: "16:00" });
    assert.ok(made.ok, JSON.stringify(made));
    const members = await q<{ n: number }>(sql`select count(*)::int as n from factory_task_members where task_id = ${made.ok ? made.data.id : ""}`);
    assert.equal(members[0].n, 3);
  });

  test("a correction changes nothing until somebody else approves it, and then goes through the ERP", async () => {
    const { fc: head } = await as("vijay");
    const [t] = await q<{ id: string; lot: string; rej: number }>(sql`
      select id, out->>'lot' as lot, (out->>'rej')::int as rej from factory_tasks where proc = 'filling' and status = 'done' and out->>'key' is not null limit 1`);
    const asked = await requestCorrection(head, t.id, "Rejected count was wrong", "test", t.rej + 2);
    assert.ok(asked.ok, JSON.stringify(asked));
    const [item] = await q<{ id: string }>(sql`select id from factory_reviews where task_id = ${t.id} and kind = 'correction' and status = 'open'`);
    const self = await decideReview(head, item.id, "Approve correction", 0, "Checked on the floor — correct");
    assert.equal(self.ok, false, "the person who asked does not approve their own change");
    const [second] = await db.insert(users).values({ id: "usr_head2", name: "Second Head", email: "h2@x.test", phone: "9000000002", passwordHash: "x", role: "manager", initials: "SH" }).returning();
    await db.insert(appAccess).values({ id: "aca_head2", userId: second.id, app: "factory", role: "manager" });
    await db.execute(sql`insert into erp_godown_staff (godown_id, user_id) values ('erpg_bhiwandi', ${second.id})`);
    setTestUser(second as User);
    const fc2 = (await contextFor(second as User))!;
    const ok = await decideReview(fc2, item.id, "Approve correction", 0, "Checked on the floor — correct");
    assert.ok(ok.ok, JSON.stringify(ok));
    const [fill] = await q<{ adj: number }>(sql`select can_adjusted as adj from erp_fg_fills where lot_code = ${t.lot}`);
    assert.equal(fill.adj, t.rej + 2);
    const [hist] = await q<{ n: number }>(sql`select count(*)::int as n from audit_log where entity_id = ${t.id} and action = 'factory.review.decide'`);
    assert.equal(hist.n, 1, "the decision and its reason are in the job's history");
  });
});

describe("offline, old phones, and never an error", () => {
  test("a job from the queue that the ERP now refuses is HELD for the supervisor, not failed", async () => {
    const { fc, data } = await as("kamalkant");
    const t = open(data, "filling");
    const k = data.sku[t.item!];
    const s = { ...sub(t, { team: t.team, down: false, downR: null, downMin: null, sku: t.item, sfg: t.sfg!, pm: lotOf(data, "pm", k.pm).code, filled: 999999, rej: 0 }), queued: true };
    const r = await submitJob(fc, s);
    assert.equal(r.kind, "held", JSON.stringify(r));
    const [rev] = await q<{ kind: string }>(sql`select kind from factory_reviews where change->>'key' = ${s.key}`);
    assert.equal(rev.kind, "unposted");
    const again = await submitJob(fc, s);
    assert.equal(again.kind, "held", "sending it again answers the same, and raises nothing new");
    const [n] = await q<{ n: number }>(sql`select count(*)::int as n from factory_reviews where change->>'key' = ${s.key}`);
    assert.equal(n.n, 1);
    const { data: after } = await as("kamalkant");
    assert.equal(after.tasks.find((x) => x.id === t.id)?.status, "held", "the worker sees it is with the supervisor and cannot do it twice");
  });

  test("an old page's payload — text numbers, an HH:MM time, no version — still posts", async () => {
    const { fc, data } = await as("anil");
    const t = open(data, "mixing", (x) => data.sfg[x.item!].short === "NC");
    const d = mixDraft(data, t, 1000) as unknown as Record<string, unknown>;
    const old = {
      key: key(),
      taskId: t.id,
      savedAt: "09:15",
      d: { ...d, batches: String(t.batches), out: "1000", rm: (d.rm as Record<string, unknown>[]).map((x) => ({ ...x, qty: String(x.qty) })) },
    } as unknown as Submission;
    const r = await submitJob(fc, old);
    assert.equal(r.kind, "done", JSON.stringify(r));
  });

  test("work saved more than 48 hours before it arrived goes to the supervisor, who can put it in", async () => {
    const { fc: head, data } = await as("vijay");
    const nc = Object.keys(data.sfg).find((k) => data.sfg[k].short === "NC")!;
    const made = await assignTask(head, { proc: "mixing", item: nc, qty: 1, due: "16:00" });
    assert.ok(made.ok);
    const { fc, data: d2 } = await as("anil");
    const t = d2.tasks.find((x) => x.id === (made.ok ? made.data.id : ""))!;
    const s = { ...sub(t, mixDraft(d2, t, 995)), savedAt: new Date(Date.now() - 50 * 3_600_000).toISOString(), v: 2, queued: true };
    const r = await submitJob(fc, s);
    assert.equal(r.kind, "held");
    const { fc: head2, data: d3 } = await as("vijay");
    const item = d3.review.find((x) => x.kind === "unposted" && x.task === t.id)!;
    assert.deepEqual(item.acts, ["Put it in the ERP", "Close — not needed"]);
    const ok = await decideReview(head2, item.id, item.acts[0], 0, "Checked on the floor — correct");
    assert.ok(ok.ok, JSON.stringify(ok));
    const [row] = await q<{ status: string; by: string }>(sql`
      select s.status, u.name as by from factory_submissions s join erp_sfg_lines l on l.created_by_id = s.user_id join users u on u.id = l.created_by_id
       where s.key = ${s.key} limit 1`);
    assert.equal(row.status, "done");
    assert.equal(row.by, "Anil", "posted under the worker who did it, not the head who approved it");
    const [day] = await q<{ d: string }>(sql`select batch_date::text as d from erp_sfg_lines where created_by_id = ${fc.user.id} order by created_at desc limit 1`);
    assert.equal(day.d, new Date(Date.now() - 50 * 3_600_000).toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" }), "dated the day the work was done");
  });
});
