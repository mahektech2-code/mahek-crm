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
import { assignTask, decideReview, requestCorrection, startMixingBatch } from "./head";
import { boxCode, mixDeviation, recipeLines, recipeProblem, recipeRm, resolveScan, startsOwnBatch, taskCode, typedCode } from "./rules";
import { boxInfo, loadBoard, lrKit, saveLr, scanBox, unloadBox } from "./dispatch";
import { setAccess } from "@/lib/actions/access";
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
             factory_reviews, factory_downtime, erp_dispatch_scans, erp_lrs, audit_log restart identity cascade`);
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

  test("a code typed off a label is matched however it was spaced or cased, then judged like a scan", async () => {
    const { data } = await as("kamalkant");
    const t = open(data, "filling");
    const lot = lotOf(data, "rm", Object.keys(data.rm)[0]);
    const sloppy = " " + lot.code.toLowerCase().split("").join(" ") + " ";
    assert.equal(typedCode(sloppy, data), lot.code, "the label's own spelling comes back");
    assert.equal(typedCode(taskCode(t).toLowerCase(), data), taskCode(t), "a task sheet's code too");
    assert.equal(typedCode("not a lot", data), "NOTALOT", "an unknown code comes back cleaned, for the scan's check to refuse");
    const d: Draft = { team: t.team, down: null, downR: null, downMin: null, sku: t.item };
    const r = resolveScan(typedCode(sloppy, data), { db: data, purpose: "sfg", meta: {}, task: t, d });
    assert.equal(r.ok, false, "typing is a way to read a label, never a way past the check");
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

  test("not enough in the drum refuses the whole batch, names the step, and the same key goes through once a second drum makes up the rest", async () => {
    const { fc, data } = await as("anil");
    const t = open(data, "mixing", (x) => data.sfg[x.item!].short === "NANO");
    const mek = Object.keys(data.rm).find((k) => data.rm[k].n === "MEK")!;
    const tol = Object.keys(data.rm).find((k) => data.rm[k].n === "Toluene")!;
    const k = key();
    const lotsBefore = (await q<{ n: number }>(sql`select count(*)::int as n from erp_sfg_lines`))[0].n;
    const bad = await submitJob(fc, sub(t, mixDraft(data, t, 700, { [mek]: 5000 }), k));
    assert.equal(bad.kind, "failed");
    assert.equal((bad as { step: string }).step, "materials");
    assert.equal((await q<{ n: number }>(sql`select count(*)::int as n from erp_sfg_lines`))[0].n, lotsBefore, "nothing posted");
    /* Less than the sheet from one drum is refused too: Next waits until the material matches. */
    const sheetTol = data.sfg[t.item!].recipe.find((r) => r[0] === tol)![1] * (t.batches ?? 1);
    const short = await submitJob(fc, sub(t, mixDraft(data, t, 600, { [tol]: sheetTol - 100 }), k));
    assert.equal(short.kind, "failed");
    assert.equal((short as { step: string }).step, "materials");
    /* The toluene comes from two drums: the sheet less 100 L from one, the last 100 L from another. */
    const d = mixDraft(data, t, 600, { [tol]: sheetTol - 100 });
    const at = d.rm!.findIndex((r) => r.item === tol);
    const other = Object.values(data.lots).find((l) => l.type === "rm" && l.item === tol && l.loc === data.loc && l.code !== d.rm![at].lot && l.avail >= 100)!;
    assert.ok(other, "the seed holds a second toluene lot");
    d.rm!.splice(at + 1, 0, { item: tol, per: d.rm![at].per, lot: other.code, qty: 100, extra: true });
    const fixed = await submitJob(fc, sub(t, d, k));
    assert.equal(fixed.kind, "done", JSON.stringify(fixed));
    const lines = await q<{ lot: string; use: number }>(sql`
      select l.rm_lot_no as lot, l.total_use::float8 as use from erp_sfg_lines l
       where l.lot_code = ${(fixed as { label: { code: string } }).label.code} and l.raw_material_id = ${tol} order by l.created_at`);
    assert.deepEqual(lines.map((x) => x.use), [sheetTol - 100, 100], "one ERP line per drum, both on the same batch");
    assert.equal(lines[1].lot, other.code);
    const [r] = await q<{ kind: string }>(sql`select kind from factory_reviews where task_id = ${t.id} and kind = 'tolerance'`);
    assert.ok(r, "far below the batch sheet goes to the Production Head");
  });

  test("a worker's own recipe posts what he poured, and the Production Head is told how it differs from the batch sheet", async () => {
    const { fc, data } = await as("anil");
    const nc = Object.keys(data.sfg).find((k) => data.sfg[k].short === "NC")!;
    const made = await startMixingBatch(fc, { item: nc, qty: 1 });
    assert.ok(made.ok, JSON.stringify(made));
    const { data: now } = await as("anil");
    const t = now.tasks.find((x) => x.id === (made.ok ? made.data.id : ""))!;
    const sheet = recipeLines(now, t, null);
    assert.ok(sheet.length >= 2, "the seed's NC batch sheet has two materials or more");
    const dropped = sheet[sheet.length - 1].item;
    const added = Object.keys(now.rm).find((k) => !sheet.some((l) => l.item === k) && lotOf(now, "rm", k, 20))!;
    assert.ok(added, "the seed holds a material the NC sheet does not ask for");
    const mine = [...sheet.slice(0, -1).map((l, i) => ({ item: l.item, per: i === 0 ? l.per + 10 : l.per })), { item: added, per: 20 }];

    assert.equal(recipeProblem(mine, now.rm), null);
    assert.match(recipeProblem([], now.rm)!, /at least one/);
    assert.match(recipeProblem([{ item: added, per: null }], now.rm)!, /needs litres/);
    assert.match(recipeProblem([{ item: added, per: 5 }, { item: added, per: 5 }], now.rm)!, /twice/);
    assert.match(recipeProblem([{ item: "gone", per: 5 }], now.rm)!, /not in the ERP/);

    const d: Draft = {
      team: { ...JSON.parse(JSON.stringify(t.team)), op: t.team.op ?? floor.users.rakesh.id }, down: false, downR: null, downMin: null, batches: 1, ownRecipe: true,
      rm: recipeRm(mine).map((r) => ({ ...r, lot: lotOf(now, "rm", r.item, r.per).code, qty: r.per })),
    };
    assert.deepEqual(recipeLines(now, t, d), mine, "the job's first step reads his recipe back");
    assert.equal(mixDeviation(now, t, d).exp, mine.reduce((a, l) => a + l.per, 0), "the yield is held to what his recipe makes");

    const r = await submitJob(fc, sub(t, d));
    assert.equal(r.kind, "done", JSON.stringify(r));
    const used = (await q<{ rm: string }>(sql`select raw_material_id as rm from erp_sfg_lines where lot_code = ${(r as { label: { code: string } }).label.code}`)).map((x) => x.rm);
    assert.ok(used.includes(added), "the added material is in the ERP batch");
    assert.ok(!used.includes(dropped), "the material he took off is not");
    const [rv] = await q<{ kind: string; body: string }>(sql`select kind, body from factory_reviews where task_id = ${t.id} and title = 'Own recipe used'`);
    assert.ok(rv, "the Production Head is told");
    assert.equal(rv.kind, "manual");
    assert.match(rv.body, new RegExp(now.rm[added].n));
    assert.match(rv.body, /batch sheet asks for/);
    const [out] = await q<{ own: boolean }>(sql`select (out->>'ownRecipe')::boolean as own from factory_tasks where id = ${t.id}`);
    assert.equal(out.own, true);
  });

  test("an unfinished own recipe is refused at the first step and nothing posts", async () => {
    const { fc, data } = await as("anil");
    const nc = Object.keys(data.sfg).find((k) => data.sfg[k].short === "NC")!;
    const made = await startMixingBatch(fc, { item: nc, qty: 1 });
    assert.ok(made.ok);
    const { data: now } = await as("anil");
    const t = now.tasks.find((x) => x.id === (made.ok ? made.data.id : ""))!;
    const sheet = recipeLines(now, t, null);
    const extra = Object.keys(now.rm).find((k) => !sheet.some((l) => l.item === k) && lotOf(now, "rm", k, 1))!;
    const d: Draft = {
      team: { ...JSON.parse(JSON.stringify(t.team)), op: t.team.op ?? floor.users.rakesh.id }, down: false, downR: null, downMin: null, batches: 1, ownRecipe: true,
      rm: [
        ...recipeRm(sheet).map((x) => ({ ...x, lot: lotOf(now, "rm", x.item, x.per).code, qty: x.per })),
        { item: extra, per: 0, lot: lotOf(now, "rm", extra, 1).code, qty: 1 },
      ],
    };
    const before = (await q<{ n: number }>(sql`select count(*)::int as n from erp_sfg_lines`))[0].n;
    const r = await submitJob(fc, sub(t, d));
    assert.equal(r.kind, "failed", JSON.stringify(r));
    assert.equal((r as { step: string }).step, "identify", JSON.stringify(r));
    assert.equal((await q<{ n: number }>(sql`select count(*)::int as n from erp_sfg_lines`))[0].n, before, "nothing posted");
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
  test("a box label scanned on the lorry is counted by the ERP's own dispatch scan, once, and can be taken off", async () => {
    const { fc, data } = await as("imran");
    /* The order the test above checked: loaded, still not sent, so still on the floor. */
    const t = data.tasks.find((x) => x.proc === "dispatch" && x.order && data.orders[x.order] && !data.orders[x.order].blocked)!;
    const no = Number(t.order!.replace("SO-", ""));
    const [bc] = await q<{ from: string; lot: string; godown: string; sku: string; cpb: number; fg: string | null }>(sql`
      select b.lot_from as "from", b.lot_code as lot, b.godown_id as godown, o.sku_id as sku, coalesce(p.cans_per_box, 1) as cpb, b.finished_good_id as fg
        from erp_batch_codes b join erp_orders o on o.id = b.order_id join products p on p.id = o.sku_id
       where o.order_no = ${no} limit 1`);
    /* Packing printed a label per box; take one of this lot's, or print one. */
    const [had] = await q<{ id: string }>(sql`select id from erp_units where lot_from = ${bc.from} and lot_code = ${bc.lot} and status = 'available' order by id limit 1`);
    const id = had?.id ?? (bc.from === "pack" ? "BX" : "LU") + "-991231-" + String(Date.now() % 1e6).padStart(6, "0");
    if (!had)
      await db.execute(sql`
        insert into erp_units (id, kind, sku_id, lot_from, lot_code, finished_good_id, seq, cans, godown_id, status)
        values (${id}, ${bc.from === "pack" ? "box" : "loose"}, ${bc.sku}, ${bc.from}, ${bc.lot}, ${bc.fg}, 1, ${bc.from === "pack" ? bc.cpb : 1}, ${bc.godown}, 'available')`);

    assert.equal(boxCode("https://one.mahekindia.com/t/" + id.toLowerCase() + "?x=1"), id, "a QR carrying the tracking link reads as the box");
    const first = await scanBox(fc, t.order!, id);
    assert.equal(first.ok, true, JSON.stringify(first));
    assert.equal(first.board?.boxes.length, 1);
    assert.equal(first.board?.perLot[bc.lot], 1);
    const [u] = await q<{ status: string; by: string }>(sql`select status, scanned_by_id as by from erp_units where id = ${id}`);
    assert.deepEqual([u.status, u.by], ["scanned", fc.user.id], "the desk sees the same box, scanned by the loader");
    const [log] = await q<{ n: number }>(sql`select count(*)::int as n from erp_dispatch_scans where code = ${id} and result = 'ok'`);
    assert.equal(log.n, 1);

    const again = await scanBox(fc, t.order!, id);
    assert.equal(again.ok, false);
    assert.equal((again as { title: string }).title, "Already scanned");
    assert.equal((await loadBoard(fc, t.order!))?.boxes.length, 1, "scanned twice, counted once");

    const info = await boxInfo(id);
    assert.ok(info.ok && info.line.includes(t.order!), JSON.stringify(info));

    const off = await unloadBox(fc, t.order!, id);
    assert.equal(off.ok, true, JSON.stringify(off));
    assert.equal(off.board?.boxes.length, 0);
    const [back] = await q<{ status: string }>(sql`select status from erp_units where id = ${id}`);
    assert.equal(back.status, "available");

    const stranger = await scanBox((await as("anil")).fc, t.order!, id);
    assert.equal(stranger.ok, false);
    assert.equal((stranger as { title: string }).title, "Not your work", "mixing does not load lorries");
    const elsewhere = await scanBox(fc, "SO-999999", id);
    assert.equal((elsewhere as { title: string }).title, "This order is not here");
  });

  test("an LR uploaded from the phone lands in the register the LR desk reads, and only dispatch may upload one", async () => {
    const { fc } = await as("imran");
    const kit = await lrKit(fc);
    assert.equal(kit.ok, true);
    const none = await saveLr(fc, { lrNo: null, lrDate: null, transporter: null, destination: null, packages: null, freightTerm: null, freightRupees: null, fileId: null, readingId: null });
    assert.equal(none.ok, false, "an LR needs its photo or its number");
    const lr = { lrNo: "bh 4471", lrDate: null, transporter: "Shree Roadways", destination: "Nagpur", packages: 12, freightTerm: "To pay", freightRupees: 1450, fileId: null, readingId: null };
    const saved = await saveLr(fc, lr);
    assert.equal(saved.ok, true, JSON.stringify(saved));
    const [row] = await q<{ lrNo: string; transporter: string; packages: number; freight: number; by: string; status: string }>(sql`
      select lr_no as "lrNo", transporter, packages, freight_paise::int as freight, uploaded_by_id as by, status from erp_lrs`);
    assert.deepEqual([row.lrNo, row.transporter, row.packages, row.freight, row.by], ["BH 4471", "Shree Roadways", 12, 145000, fc.user.id]);
    assert.ok(saved.ok && saved.recent.some((r) => r.lrNo === "BH 4471"));
    const dup = await saveLr(fc, lr);
    assert.equal(dup.ok, false);
    assert.match((dup as { text: string }).text, /already uploaded/);
    const mixing = await saveLr((await as("anil")).fc, { ...lr, lrNo: "BH 4472" });
    assert.equal((mixing as { title: string }).title, "Not your work");
  });

  test("up to twenty LR photos are stored at once, each its own LR, and a resend stores nothing twice", async () => {
    const { saveLrPhotos } = await import("./dispatch");
    const { fc } = await as("imran");
    const file = async (owner: string) => {
      const id = "att_lrb_" + randomUUID().slice(0, 8);
      await db.execute(sql`insert into attachments (id, filename, stored_ref, content_type, size_bytes, status, uploaded_by_id)
                           values (${id}, 'lr.jpg', ${"ref/" + id}, 'image/jpeg', 1000, 'available', ${owner})`);
      return id;
    };
    const mine = await Promise.all(Array.from({ length: 3 }, () => file(fc.user.id)));
    const theirs = await file(floor.users.anil.id);
    const r = await saveLrPhotos(fc, [...mine, theirs]);
    assert.ok(r.ok, JSON.stringify(r));
    assert.equal(r.stored, 3);
    assert.equal(r.refused, 1, "somebody else's file is not stored");
    const rows = await q<{ n: number }>(sql`select count(*)::int as n from erp_lrs where file_id in (${sql.join(mine.map((m) => sql`${m}`), sql`, `)}) and lr_no is null`);
    assert.equal(rows[0].n, 3, "each photo is its own photo-only LR");
    const again = await saveLrPhotos(fc, mine);
    assert.ok(again.ok && again.stored === 0 && again.already === 3);
    const tooMany = await saveLrPhotos(fc, Array.from({ length: 21 }, (_, i) => "att_x" + i));
    assert.equal(tooMany.ok, false);
    assert.equal((await saveLrPhotos((await as("anil")).fc, mine)).ok, false, "only dispatch uploads LRs");
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

  test("a mixing worker starts his own batch, in charge of it; nobody outside mixing can", async () => {
    const { fc: anil, data } = await as("anil");
    const nc = Object.keys(data.sfg).find((k) => data.sfg[k].short === "NC")!;
    const pu = Object.keys(data.sfg).find((k) => data.sfg[k].short === "PU")!;
    assert.equal((await startMixingBatch(anil, { item: pu, qty: 1 })).ok, false, "a base with no recipe cannot be started");
    assert.equal((await startMixingBatch(anil, { item: nc, qty: 11 })).ok, false, "ten batches at most");
    assert.equal((await startMixingBatch(anil, { item: nc, qty: 10 })).ok, true, "ten batches is allowed");
    const made = await startMixingBatch(anil, { item: nc, qty: 2 });
    assert.ok(made.ok, JSON.stringify(made));
    const id = made.ok ? made.data.id : "";
    const [t] = await q<{ proc: string; batches: number; status: string; createdBy: string }>(sql`select proc, batches, status, created_by_id as "createdBy" from factory_tasks where id = ${id}`);
    assert.deepEqual([t.proc, t.batches, t.status, t.createdBy], ["mixing", 2, "ready", floor.users.anil.id]);
    const team = await q<{ userId: string; role: string }>(sql`select user_id as "userId", role from factory_task_members where task_id = ${id} order by role, user_id`);
    assert.deepEqual(team.find((m) => m.role === "owner")?.userId, floor.users.anil.id, "the one who starts it is in charge");
    assert.equal(team.filter((m) => m.userId === floor.users.anil.id).length, 1, "and is on the team once");
    assert.ok(team.some((m) => m.userId === floor.users.rakesh.id), "the usual person in charge stays on the team");
    assert.ok(startsOwnBatch({ head: false, area: "filling", areas: ["filling", "mixing"] }), "a worker with mixing among his departments");
    assert.equal(startsOwnBatch({ head: true, area: "head" }), false, "a supervisor gives tasks instead");
    assert.equal(startsOwnBatch({ head: false, area: "packing" }), false);
    const { fc: sunita } = await as("sunita");
    assert.equal((await startMixingBatch(sunita, { item: nc, qty: 1 })).ok, false, "packing cannot start a mixing batch");
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

describe("staffed from Admin Console → Access, with department-level permissions", () => {
  let admin: User;
  const grant = (role: "associate" | "manager") => [{ app: "factory", modules: ["factory.app"], role }];
  before(async () => {
    const [a] = await db.insert(users).values({ id: "usr_console", name: "Console Admin", email: "console@x.test", phone: "9000000009", passwordHash: "x", role: "admin", initials: "CA" }).returning();
    await db.insert(appAccess).values({ id: "aca_console", userId: a.id, app: "admin", role: "admin" });
    admin = a as User;
  });

  test("the Access dialog's place writes the department and the crew seat, and taking the app away takes them", async () => {
    const [p] = await db.insert(users).values({ id: "usr_newhelper", name: "New Helper", email: "nh@x.test", phone: "9000000010", passwordHash: "x", role: "associate", initials: "NH" }).returning();
    setTestUser(admin);
    const r = await setAccess({ userId: p.id, grants: grant("associate") as never, factoryPlace: { depts: ["packing"], crews: { packing: "helper" }, badge: "EMP-9010", hrConfirmed: false } });
    assert.ok(r.ok, r.ok ? "" : r.error);
    const [row] = await q<{ area: string; badge: string; confirmed: boolean }>(sql`select area, badge_code as badge, hr_confirmed as confirmed from factory_staff where user_id = ${p.id}`);
    assert.deepEqual([row.area, row.badge, row.confirmed], ["packing", "EMP-9010", false]);
    const [seat] = await q<{ role: string }>(sql`select role from factory_team_defaults where user_id = ${p.id} and proc = 'packing'`);
    assert.equal(seat.role, "helper");
    const fc = (await contextFor(p as User))!;
    assert.equal(fc.area, "packing");
    assert.equal(fc.head, false);

    setTestUser(admin);
    const gone = await setAccess({ userId: p.id, grants: [] });
    assert.ok(gone.ok);
    assert.equal((await q(sql`select 1 from factory_staff where user_id = ${p.id}`)).length, 0);
  });

  test("the whole floor needs the manager level", async () => {
    const [p] = await db.insert(users).values({ id: "usr_wannahead", name: "Wanna Head", email: "wh@x.test", phone: "9000000011", passwordHash: "x", role: "associate", initials: "WH" }).returning();
    setTestUser(admin);
    const r = await setAccess({ userId: p.id, grants: grant("associate") as never, factoryPlace: { depts: ["head"], crews: {}, badge: null, hrConfirmed: true } });
    assert.equal(r.ok, false);
  });

  test("a manager of one department supervises that department and no other", async () => {
    const [p] = await db.insert(users).values({ id: "usr_mixsup", name: "Mixing Supervisor", email: "ms@x.test", phone: "9000000012", passwordHash: "x", role: "manager", initials: "MS" }).returning();
    await db.execute(sql`insert into erp_godown_staff (godown_id, user_id) values ('erpg_bhiwandi', ${p.id})`);
    setTestUser(admin);
    const r = await setAccess({ userId: p.id, grants: grant("manager") as never, factoryPlace: { depts: ["mixing"], crews: {}, badge: null, hrConfirmed: true } });
    assert.ok(r.ok, r.ok ? "" : r.error);
    setTestUser(p as User);
    const fc = (await contextFor(p as User))!;
    assert.equal(fc.head, true);
    assert.equal(fc.scope, "mixing");
    const data = await bootstrap(fc);
    assert.ok(data.tasks.length && data.tasks.every((t) => t.proc === "mixing"), "their floor is their department");
    const nc = Object.keys(data.sfg).find((k) => data.sfg[k].short === "NC")!;
    assert.ok((await assignTask(fc, { proc: "mixing", item: nc, qty: 1, due: "16:00" })).ok);
    const sku = Object.keys(data.box)[0];
    const other = await assignTask(fc, { proc: "packing", item: sku, qty: 10, due: "16:00" });
    assert.equal(other.ok, false, "packing is not theirs to give");

    const { fc: head, data: all } = await as("vijay");
    assert.equal(head.scope, null, "the Production Head is the whole floor");
    assert.ok(new Set(all.tasks.map((t) => t.proc)).size > 1);
  });

  test("somebody can work several departments: a crew seat in each, jobs from each, nothing from the rest", async () => {
    const [p] = await db.insert(users).values({ id: "usr_twodept", name: "Two Dept", email: "td@x.test", phone: "9000000013", passwordHash: "x", role: "associate", initials: "TD" }).returning();
    await db.execute(sql`insert into erp_godown_staff (godown_id, user_id) values ('erpg_bhiwandi', ${p.id})`);
    setTestUser(admin);
    const bad = await setAccess({ userId: p.id, grants: grant("associate") as never, factoryPlace: { depts: ["mixing", "nowhere"] as never, crews: {}, badge: null, hrConfirmed: true } });
    assert.equal(bad.ok, false, "an unknown department is refused, never dropped");
    const seatless = await setAccess({ userId: p.id, grants: grant("associate") as never, factoryPlace: { depts: ["mixing"], crews: { packing: "helper" }, badge: null, hrConfirmed: true } });
    assert.equal(seatless.ok, false, "a seat needs its department ticked");
    const r = await setAccess({ userId: p.id, grants: grant("associate") as never, factoryPlace: { depts: ["packing", "mixing"], crews: { mixing: "helper", packing: "operator" }, badge: null, hrConfirmed: true } });
    assert.ok(r.ok, r.ok ? "" : r.error);
    const [row] = await q<{ area: string; areas: string[] }>(sql`select area, areas from factory_staff where user_id = ${p.id}`);
    assert.deepEqual([row.area, row.areas], ["mixing", ["mixing", "packing"]], "stored in department order, home first");
    const seats = await q<{ proc: string; role: string }>(sql`select proc, role from factory_team_defaults where user_id = ${p.id} order by proc`);
    assert.deepEqual(seats.map((x) => x.proc + ":" + x.role), ["mixing:helper", "packing:operator"]);
    const fc = (await contextFor(p as User))!;
    assert.deepEqual(fc.areas, ["mixing", "packing"]);
    assert.equal(fc.head, false);
    const { worksOn } = await import("./server");
    assert.ok(worksOn(fc, "mixing") && worksOn(fc, "packing"));
    assert.equal(worksOn(fc, "filling"), false, "a department they were not given is not theirs");

    /* A manager of two departments supervises both, and only those. */
    setTestUser(admin);
    assert.ok((await setAccess({ userId: p.id, grants: grant("manager") as never, factoryPlace: { depts: ["mixing", "packing"], crews: {}, badge: null, hrConfirmed: true } })).ok);
    const mc = (await contextFor(p as User))!;
    assert.deepEqual(mc.scopes, ["mixing", "packing"]);
    assert.equal(mc.scope, null, "an old phone reads one department, and there are two");
    const data = await bootstrap(mc);
    assert.ok(data.tasks.every((t) => t.proc === "mixing" || t.proc === "packing"));
    assert.equal((await assignTask(mc, { proc: "filling", item: Object.keys(data.sku)[0], qty: 1, due: "16:00" })).ok, false, "filling is not theirs to give");
  });
});

describe("stock check, each department its own stock", () => {
  test("any item of any kind is listed blind to the whole floor, checked, judged against the book, and a mismatch takes a reason", async () => {
    const { stockKit, saveStockCheck, saveCheckReason } = await import("./counts");
    const { fc } = await as("vijay");
    const kit = await stockKit(fc);
    assert.ok(kit.ok);
    assert.deepEqual(kit.stages, ["rm", "sfg", "fg", "pack"]);
    for (const stage of ["rm", "sfg", "fg", "pack"] as const) assert.ok(kit.items.some((i) => i.stage === stage && i.here), `${stage} is listed`);
    assert.ok(kit.items.every((i) => !("book" in i)), "the list never carries the book");

    const fgItem = kit.items.find((i) => i.stage === "fg" && i.here)!;
    const k = "CHK-" + randomUUID().slice(0, 8);
    const r = await saveStockCheck(fc, { stage: "fg", itemId: fgItem.id, qty: 0, key: k });
    assert.ok(r.ok && r.kind === "check" && r.unit === "Cans" && !r.matched && (r.book ?? 0) > 0, JSON.stringify(r));
    const again = await saveStockCheck(fc, { stage: "fg", itemId: fgItem.id, qty: 0, key: k });
    assert.ok(again.ok && again.replay && again.id === r.id);
    assert.ok((await saveCheckReason(fc, "check", r.id, "Not entered yet")).ok);
    const after = await stockKit(fc);
    assert.ok(after.ok && after.items.find((i) => i.stage === "fg" && i.id === fgItem.id)?.checkedToday?.matched === false);

    const packItem = kit.items.find((i) => i.stage === "pack" && i.here)!;
    const p0 = await saveStockCheck(fc, { stage: "pack", itemId: packItem.id, qty: 0, key: "CHK-" + randomUUID().slice(0, 8) });
    assert.ok(p0.ok && p0.unit === "Boxes");
    const p1 = await saveStockCheck(fc, { stage: "pack", itemId: packItem.id, qty: p0.book!, key: "CHK-" + randomUUID().slice(0, 8) });
    assert.ok(p1.ok && p1.matched, "counting what the book holds matches");
  });

  test("mixing checks chemicals and SFG, filling cans, drums, FG and boxes packed, packing empty boxes and stationery — and nothing else", async () => {
    const { stockKit, saveStockCheck, saveOfficeCount } = await import("./counts");
    const types = new Map((await q<{ id: string; t: string }>(sql`select id, material_type as t from erp_raw_materials`)).map((r) => [r.id, r.t]));
    const kitOf = async (who: string) => {
      const { fc } = await as(who);
      const kit = await stockKit(fc);
      assert.ok(kit.ok);
      return { fc, kit, rmTypes: new Set(kit.items.filter((i) => i.stage === "rm").map((i) => types.get(i.id))) };
    };

    const mixing = await kitOf("anil");
    assert.deepEqual(mixing.kit.stages, ["rm", "sfg"]);
    assert.deepEqual([...mixing.rmTypes], ["Chemical"]);
    assert.ok(mixing.kit.items.some((i) => i.stage === "sfg"));
    assert.ok(!mixing.kit.items.some((i) => i.stage === "fg" || i.stage === "pack"));

    const filling = await kitOf("kamalkant");
    assert.deepEqual(filling.kit.stages, ["rm", "fg", "pack"]);
    assert.ok([...filling.rmTypes].every((t) => t === "Can" || t === "Drum") && filling.rmTypes.size > 0, [...filling.rmTypes].join());

    const packing = await kitOf("sunita");
    assert.deepEqual(packing.kit.stages, ["rm"]);
    assert.ok([...packing.rmTypes].every((t) => t === "Box" || t === "Stationary") && packing.rmTypes.size > 0, [...packing.rmTypes].join());

    /* The server refuses what the list hides, because a URL is not a list. */
    const fgItem = filling.kit.items.find((i) => i.stage === "fg")!;
    const refused = await saveStockCheck(mixing.fc, { stage: "fg", itemId: fgItem.id, qty: 1, key: "CHK-" + randomUUID().slice(0, 8) });
    assert.ok(!refused.ok && refused.title === "Not your department's stock");
    const chemical = mixing.kit.items.find((i) => i.stage === "rm" && i.here)!;
    assert.equal((await saveStockCheck(packing.fc, { stage: "rm", itemId: chemical.id, qty: 1, key: "CHK-" + randomUUID().slice(0, 8) })).ok, false);

    /* The office's count of a chemical is mixing's, not packing's. */
    const { openCount } = await import("@/lib/erp/stock-check");
    const opened = await db.transaction((tx) => openCount(tx, { kind: "event", rawMaterialId: chemical.id, godownId: mixing.fc.godown.id, reason: "A spill", byId: mixing.fc.user.id }));
    const pk = await stockKit(packing.fc);
    assert.ok(pk.ok && !pk.office.some((t) => t.id === opened.id), "packing is not offered a chemical's count");
    const notTheirs = await saveOfficeCount(packing.fc, { id: opened.id, qty: 0 });
    assert.ok(!notTheirs.ok && notTheirs.kind === "notAllowed");
    const mk = await stockKit(mixing.fc);
    assert.ok(mk.ok && mk.office.some((t) => t.id === opened.id), "mixing is offered it");
    const c = await saveOfficeCount(mixing.fc, { id: opened.id, qty: 0 });
    assert.ok(c.ok && c.kind === "count" && c.no, JSON.stringify(c));
    const resent = await saveOfficeCount(mixing.fc, { id: opened.id, qty: 0 });
    assert.ok(resent.ok && resent.replay, "a resend of a saved count is not an error");
  });
});

describe("quality check of SFG lots, with the Testing list", () => {
  test("Quality decides a lot test by test; approving needs every test passed, rejecting needs a reason", async () => {
    const { qcKit, saveQcDecision } = await import("./qc");
    const { refValues } = await import("@/lib/erp/refs");
    const tests = await refValues("testingList");
    assert.ok(tests.length >= 2, "the seeded Testing list has tests to ask");
    const pass = Object.fromEntries(tests.map((t) => [t, "Pass"]));

    const { fc: worker } = await as("anil");
    assert.equal(worker.qc, false, "a mixing worker does not decide QC");
    assert.equal((await qcKit(worker)).ok, false);
    assert.equal((await saveQcDecision(worker, { lot: "x", verdict: "Approved", results: pass, note: null })).ok, false);

    const { fc } = await as("pooja");
    assert.equal(fc.qc, true, "somebody placed in Quality decides QC");
    const kit = await qcKit(fc);
    assert.ok(kit.ok);
    assert.deepEqual(kit.tests, tests, "the phone is asked the Testing list's active tests");
    const lot = kit.decided[0];
    assert.ok(lot && lot.status === "Approved", "the seeded lot was approved this week");

    const noReason = await saveQcDecision(fc, { lot: lot.lot, verdict: "Rejected", results: { [tests[0]]: "Fail" }, note: null });
    assert.ok(!noReason.ok && /why/i.test(noReason.title), "a reject needs a reason");
    const rej = await saveQcDecision(fc, { lot: lot.lot, verdict: "Rejected", results: { [tests[0]]: "Fail" }, note: "Smells off" });
    assert.ok(rej.ok, JSON.stringify(rej));
    const [stored] = await q<{ status: string; tests: Record<string, string>; note: string }>(sql`select status, tests, note from erp_sfg_qc where lot_code = ${lot.lot}`);
    assert.deepEqual(stored, { status: "Rejected", tests: { [tests[0]]: "Fail" }, note: "Smells off" });
    const { data } = await as("sujit");
    assert.equal(data.lots[lot.lot]?.status, "hold", "a rejected lot is held from filling");

    const { fc: qc } = await as("pooja");
    const missing = await saveQcDecision(qc, { lot: lot.lot, verdict: "Approved", results: { [tests[0]]: "Pass" }, note: null });
    assert.ok(!missing.ok && missing.test === tests[1], "every test must be answered to approve");
    const failed = await saveQcDecision(qc, { lot: lot.lot, verdict: "Approved", results: { ...pass, [tests[1]]: "Fail" }, note: null });
    assert.ok(!failed.ok && failed.test === tests[1], "a failed test cannot be approved");
    const ok = await saveQcDecision(qc, { lot: lot.lot, verdict: "Approved", results: { ...pass, Invented: "Pass" }, note: null });
    assert.ok(ok.ok, JSON.stringify(ok));
    const [back] = await q<{ status: string; tests: Record<string, string> }>(sql`select status, tests from erp_sfg_qc where lot_code = ${lot.lot}`);
    assert.deepEqual(back, { status: "Approved", tests: pass }, "only the list's tests are stored");
    const audit = await q<{ action: string }>(sql`select action from audit_log where entity_id = ${lot.lot} and action like 'erp.sfg.qc%' order by at`);
    assert.deepEqual(audit.slice(-2).map((a) => a.action), ["erp.sfg.qcReject", "erp.sfg.qcApprove"], "the ERP's history reads the same");
  });
});
