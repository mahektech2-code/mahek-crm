import "server-only";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { getConfig } from "@/lib/config/store";
import { calendarDate } from "@/lib/business-date";
import type { ErpContext } from "./access";
import { incompletePackIds, testsAwaitingIds } from "./counts";
import { departmentsOf, ERP_DEPARTMENTS, requirementStep, requirementVisibleTo, type ErpDepartment } from "./departments";
import { erpLink, erpListLabel } from "./registry";
import { FLOW_STEPS } from "./engines/purchase-flow";
import { requirementViews, stageOf } from "./screens/purchase-flow";
import { today } from "./screens/common";
import { fgLots, rmLots, sfgLots } from "./stock";
import { fd, nf, type Tone } from "./ui";

/* ---------------------------------------------------------------------------
 * THE DEPARTMENTS PAGE: purchase and production, step by step, for each
 * department the person works in (`lib/erp/departments.ts`) — or all three
 * for the production head and for anybody not in one.
 *
 * Every figure is read from the records the step's own screen lists, and
 * every link lands on those records, so the page can never say something
 * the screen behind it does not.
 * ------------------------------------------------------------------------- */

export type BoardFigure = { l: string; v: string; tone?: Tone; href?: string };
export type BoardRow = { title: string; detail: string; tag: string; tone?: Tone; href: string };

export type BoardStep = {
  key: string;
  n: number;
  label: string;
  sentence: string;
  /** Whether the person holds the screen the step is done on. */
  open: boolean;
  /** The step's main button: start the work, already filled in. */
  start: { label: string; href: string } | null;
  /** The screen it is done on. */
  list: { label: string; href: string };
  figures: BoardFigure[];
  rows: BoardRow[];
  /** Said when there is nothing to list. */
  empty: string;
};

export type BoardDepartment = { key: ErpDepartment["key"]; label: string; steps: BoardStep[] };

type Row = Record<string, unknown>;
const q = async (s: ReturnType<typeof sql>) => (await db.execute(s)) as unknown as Row[];

export async function departmentBoard(ctx: ErpContext): Promise<BoardDepartment[]> {
  const depts = ctx.department ? departmentsOf(ctx.department) : [...ERP_DEPARTMENTS];
  const day = today();
  const monthStart = `${day.slice(0, 7)}-01`;
  const has = (k: string) => ctx.screens.has(k);
  const newHref = (screen: string, query: Record<string, string> = {}) => erpLink(screen, { new: "1", ...query });
  /* A link only to a list the person holds; anything else is drawn as plain figures. */
  const L = (key: string, query: Record<string, string> = {}) => (has(key) ? erpLink(key, query) : undefined);

  const [views, config, rm, sfg, fg, testsWaiting, incomplete, awaitingTest, made] = await Promise.all([
    requirementViews(),
    getConfig(),
    rmLots(),
    sfgLots(),
    fgLots(),
    testsAwaitingIds(),
    incompletePackIds(),
    q(sql`
      select i.id, i.pr_number as pr, m.name as item, i.quantity::float8 as qty, i.unit, g.name as godown, i.received_date::text as date
        from erp_inward i
        join erp_raw_materials m on m.id = i.raw_material_id
        join erp_godowns g on g.id = i.godown_id
       where i.routed = 'Testing' and m.material_type = 'Chemical'
         and not exists (select 1 from erp_tests t where t.inward_id = i.id)
       order by i.received_date, i.pr_number`),
    q(sql`
      select
        (select count(distinct sfg_no) from erp_sfg_lines where batch_date = ${day}::date)::int as sfg_today,
        (select count(distinct sfg_no) from erp_sfg_lines where batch_date >= ${monthStart}::date)::int as sfg_month,
        (select coalesce(sum(total_use - litres_adjusted), 0) from erp_sfg_lines where batch_date >= ${monthStart}::date)::float8 as sfg_litres,
        (select count(*) from erp_fg_fills where fill_date = ${day}::date)::int as fill_today,
        (select count(*) from erp_fg_fills where fill_date >= ${monthStart}::date)::int as fill_month,
        (select coalesce(sum(cans - can_adjusted), 0) from erp_fg_fills where fill_date >= ${monthStart}::date)::float8 as fill_cans,
        (select count(*) from erp_pack_entries where source_type = 'batch' and entry_date = ${day}::date)::int as pack_today,
        (select count(*) from erp_pack_entries where source_type = 'batch' and entry_date >= ${monthStart}::date)::int as pack_month,
        (select coalesce(sum(boxes), 0) from erp_pack_entries where source_type = 'batch' and entry_date >= ${monthStart}::date)::float8 as pack_boxes`),
  ]);
  const min = config["erp.purchase.minQuotations"];
  const m = made[0] ?? {};
  const n = (k: string) => Number(m[k] ?? 0);

  /* What each requirement step lists: the open requirements that step asked
     for, and those received this month — narrowed to what this person's own
     requirements list shows them. */
  const reqs = views
    .filter((v) => requirementVisibleTo(ctx.department, v.r.department, v.r.createdById === ctx.user.id))
    .map((v) => ({ v, st: stageOf(v, min), at: requirementStep(v.r.department, v.itemType) }));

  const requirementStepView = (dept: ErpDepartment, step: ErpDepartment["steps"][number]): Pick<BoardStep, "figures" | "rows" | "start" | "empty"> => {
    const mine = reqs.filter((x) => x.at?.department.key === dept.key && x.at.step.key === step.key);
    const live = mine.filter((x) => x.st.step >= 0 && x.st.step < FLOW_STEPS.length && x.v.r.status !== "Cancelled" && x.v.r.status !== "Received");
    const ordered = (x: (typeof mine)[number]) => !!x.v.po || x.v.legacy;
    const waiting = live.filter((x) => !ordered(x));
    const onOrder = live.filter(ordered);
    const overdue = live.filter((x) => x.v.r.requiredBy && x.v.r.requiredBy < day);
    /* Done this month: received, or closed short, since the 1st (the requirement's last write is when the flow finished it). */
    const received = mine.filter((x) => x.st.step >= FLOW_STEPS.length && calendarDate(x.v.r.updatedAt) >= monthStart);
    const ids = (list: typeof mine) => list.map((x) => x.v.r.id).join(",");
    const link = (list: typeof mine, label: string) => (list.length ? L("requisitions", { f: ids(list), fl: label }) : undefined);
    return {
      start: { label: step.label, href: newHref("requisitions", { department: dept.label, type: step.materialTypes?.[0] ?? "" }) },
      figures: [
        { l: "Waiting on purchase", v: String(waiting.length), tone: waiting.length ? "warn" : undefined, href: link(waiting, `${dept.label} · waiting on purchase`) },
        { l: "On order", v: String(onOrder.length), tone: onOrder.length ? "info" : undefined, href: link(onOrder, `${dept.label} · on order`) },
        { l: "Needed by — overdue", v: String(overdue.length), tone: overdue.length ? "danger" : undefined, href: link(overdue, `${dept.label} · overdue`) },
        { l: "Received this month", v: String(received.length), tone: received.length ? "success" : undefined, href: link(received, `${dept.label} · received`) },
      ],
      rows: live
        .slice()
        .sort((a, b) => (a.v.r.requiredBy ?? "9999").localeCompare(b.v.r.requiredBy ?? "9999"))
        .slice(0, 6)
        .map((x) => ({
          title: x.v.item,
          detail: `${nf(x.v.r.requiredQty)} ${x.v.r.unit} · ${x.v.godown}${x.v.r.requiredBy ? ` · needed by ${fd(x.v.r.requiredBy)}` : ""}`,
          tag: x.st.stage,
          tone: x.v.r.requiredBy && x.v.r.requiredBy < day ? "danger" : ordered(x) ? "info" : "warn",
          href: erpLink("requisitions", { open: x.v.r.id }),
        })),
      empty: `Nothing raised at this step is open for ${dept.label}.`,
    };
  };

  const chemicalsInStock = rm.filter((l) => l.materialType === "Chemical" && l.stock > 0);
  const sfgInStock = sfg.filter((l) => l.stock > 0);
  const filledCans = fg.filter((l) => l.stock > 0);

  const workStep = (dept: ErpDepartment, step: ErpDepartment["steps"][number]): Pick<BoardStep, "figures" | "rows" | "start" | "empty"> => {
    switch (step.key) {
      case "chemicalTest":
        return {
          start: { label: "Record a test", href: newHref("testing") },
          figures: [
            { l: "Chemical lots waiting for a test", v: String(awaitingTest.length), tone: awaitingTest.length ? "warn" : undefined, href: L("testing") },
            { l: "Tests waiting for verification", v: String(testsWaiting.length), tone: testsWaiting.length ? "info" : undefined, href: testsWaiting.length ? L("testing", { f: testsWaiting.join(","), fl: "Awaiting verification" }) : L("testing") },
            {
              l: "Tested chemical in stock",
              v: `${nf(chemicalsInStock.reduce((a, l) => a + l.stock, 0))}`,
              href: L("rmStock"),
            },
          ],
          rows: awaitingTest.slice(0, 6).map((r) => ({
            title: String(r.item),
            detail: `PR ${r.pr} · ${nf(Number(r.qty))} ${String(r.unit)} · ${String(r.godown)} · arrived ${fd(String(r.date))}`,
            tag: "Needs a test",
            tone: "warn" as Tone,
            href: newHref("testing", { line: `PR ${r.pr} · ${r.item}` }),
          })),
          empty: "No chemical lot is waiting for a test.",
        };
      case "sfg":
        return {
          start: { label: "Start an SFG batch", href: newHref("sfgBatches") },
          figures: [
            { l: "SFG batches today", v: String(n("sfg_today")), href: L("sfgBatches") },
            { l: "SFG batches this month", v: String(n("sfg_month")), href: L("sfgBatches") },
            { l: "Litres made this month", v: `${nf(n("sfg_litres"))} Ltr` },
            { l: "Chemical lots ready to use", v: String(chemicalsInStock.length), href: L("rmStock") },
          ],
          rows: [],
          empty: "",
        };
      case "fill":
        return {
          start: { label: "Record a filling", href: newHref("fgFill") },
          figures: [
            { l: "Fillings today", v: String(n("fill_today")), href: L("fgFill") },
            { l: "Fillings this month", v: String(n("fill_month")), href: L("fgFill") },
            { l: "Cans filled this month", v: nf(n("fill_cans")) },
            { l: "SFG ready to fill", v: `${nf(sfgInStock.reduce((a, l) => a + l.stock, 0))} Ltr`, href: L("sfgStock") },
          ],
          rows: [],
          empty: "",
        };
      case "pack":
        return {
          start: { label: "Start a packing batch", href: newHref("packBatches") },
          figures: [
            { l: "Packing batches today", v: String(n("pack_today")), href: L("packBatches") },
            { l: "Packing batches this month", v: String(n("pack_month")), href: L("packBatches") },
            { l: "Boxes packed this month", v: nf(n("pack_boxes")) },
            {
              l: "Incomplete packing batches",
              v: String(incomplete.length),
              tone: incomplete.length ? "warn" : undefined,
              href: incomplete.length ? L("packBatches", { f: incomplete.join(","), fl: "Incomplete" }) : undefined,
            },
            { l: "Filled cans ready to pack", v: nf(filledCans.reduce((a, l) => a + l.stock, 0)), href: L("fgStock") },
          ],
          rows: [],
          empty: "",
        };
      default:
        return { start: null, figures: [], rows: [], empty: "" };
    }
  };

  return depts.map((d) => ({
    key: d.key,
    label: d.label,
    steps: d.steps.map((step, i) => {
      const open = has(step.screen);
      const body = step.materialTypes ? requirementStepView(d, step) : workStep(d, step);
      return {
        key: step.key,
        n: i + 1,
        label: step.label,
        sentence: step.sentence,
        open,
        start: open ? body.start : null,
        list: { label: erpListLabel(step.screen), href: erpLink(step.screen) },
        figures: body.figures,
        rows: open ? body.rows : [],
        empty: open ? body.empty : `${erpListLabel(step.screen)} is not on your account.`,
      };
    }),
  }));
}
