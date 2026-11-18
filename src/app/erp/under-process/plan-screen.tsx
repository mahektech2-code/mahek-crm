"use client";

import { NavLink } from "@/components/shell/nav-link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Badge, Button, Callout, Card, CardHeader, cx, EmptyState, Field, Input, Select, Td, Th, Tr } from "@/components/ui/primitives";
import { ComboBox } from "@/components/ui/combo-box";
import { RowMenu } from "@/components/ui/overlays";
import { clock, stamp } from "@/lib/format";
import { addDays } from "@/lib/business-date";
import { fdLong, nf } from "@/lib/erp/ui";
import { erpPlanHref, erpPlanPrintHref } from "@/lib/erp/trace-links";
import { erpLink } from "@/lib/erp/registry";
import { QtyField } from "../_ui/units";
import { categorySpec, PLAN_CATEGORIES, type LineState, type PlanCategory } from "@/lib/erp/engines/production-plan";
import type { ExpectedEntry, PlanExpected, PlanItem, PlanLineView, PlanSummary, PlanView } from "@/lib/erp/production-plan";
import type { BaseRow, ProductRow } from "@/lib/erp/engines/expected-plan";
import { CardGrid } from "@/components/ui/card-grid";
import { cleanDecimal } from "@/lib/format";
import { BoardHeader, BoardTable, BoardTabs, Pill } from "../_ui/board";
import { erpPlanDeleteLine, erpPlanOpen, erpPlanPrint, erpPlanSaveLine } from "@/lib/actions/erp-production-plan";
import { PageLinks } from "../_ui/page-head";
import { linkClass, toggleClass } from "../_ui/look";
import { DialogBody, DialogFooter, DialogHeader, DialogTitle, ErpDialog } from "../_ui/dialog";
import { useErpUi } from "../_ui/erp-ui";

/* ---------------------------------------------------------------------------
 * UNDER PROCESS, drawn. The list of plans, and one plan: a section per work
 * category, a row per line, coloured by whether the floor already has it.
 * Every line is saved the moment it is added or edited, so nothing typed is
 * lost to a closed tab; Print records the sheet the floor is handed.
 * ------------------------------------------------------------------------- */

const planName = (n: number) => `PLAN-${n}`;

const NOT_PRINTED = "Not printed yet — open the plan and print it there.";

const STATE: Record<LineState, { label: string; tone: "success" | "warn" | "danger" }> = {
  given: { label: "Given", tone: "success" },
  new: { label: "New", tone: "warn" },
  edited: { label: "Edited", tone: "warn" },
  removed: { label: "Removed", tone: "danger" },
};

const UNIT_SHORT: Record<string, string> = {
  Litre: "L",
  Kg: "kg",
  Cans: "cans",
  Boxes: "boxes",
};
const STOCK_UNIT: Record<PlanCategory, string> = {
  sfg: "L",
  loose: "cans",
  packing: "boxes",
};

/* ================================================================== list */

export function PlanList({
  today,
  todays,
  previous,
  date,
  readOnly,
  missing,
  underProcess,
}: {
  today: string;
  todays: PlanSummary | null;
  previous: PlanSummary[];
  date: string | null;
  readOnly: boolean;
  missing: boolean;
  /** The order lines whose status is Under Process now — they come into the plan by themselves. */
  underProcess: {
    lines: number;
    orders: number;
    products: number;
    godown: string | null;
  };
}) {
  const [creating, setCreating] = useState(false);
  return (
    <div className="grid gap-5">
      {missing ? <Callout tone="danger">That plan no longer exists.</Callout> : null}
      {underProcess.lines ? (
        <Callout tone="info">
          <span>
            {underProcess.lines} order {underProcess.lines === 1 ? "line is" : "lines are"} Under Process on Orders → Production ({underProcess.orders} {underProcess.orders === 1 ? "order" : "orders"}
            {underProcess.godown ? ` at ${underProcess.godown}` : ""}).{" "}
            {todays
              ? `They are in today's plan as ${underProcess.products} ${underProcess.products === 1 ? "line" : "lines"}, one per product.`
              : `They come into today's plan the moment it is created, one line per product (${underProcess.products}).`}
          </span>
        </Callout>
      ) : null}
      <Card>
        <CardHeader
          title={`Today · ${fdLong(today)}`}
          action={
            readOnly ? null : todays ? (
              <Button onClick={() => setCreating(true)}>＋ Plan another day</Button>
            ) : (
              <Button variant="primary" onClick={() => setCreating(true)}>
                ＋ Create daily plan
              </Button>
            )
          }
        />
        {todays ? (
          <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-4">
            <div className="grid gap-0.5">
              <span className="text-sm font-semibold text-ink">{planName(todays.planNo)}</span>
              <span className="text-meta text-muted">
                {todays.lines} {todays.lines === 1 ? "line" : "lines"} ·{" "}
                {todays.prints
                  ? `printed ${todays.prints === 1 ? "once" : `${todays.prints} times`}, last at ${todays.lastPrintedAt ? clock(new Date(todays.lastPrintedAt)) : "—"}`
                  : "not printed yet"}{" "}
                · updated {clock(new Date(todays.updatedAt))}
              </span>
            </div>
            <div className="flex gap-2">
              <NavLink href={erpPlanHref(todays.id)} className={buttonLink("primary")}>
                Open plan
              </NavLink>
              {todays.prints ? (
                <NavLink href={erpPlanPrintHref(todays.id, todays.prints)} className={buttonLink()}>
                  Last print
                </NavLink>
              ) : null}
            </div>
          </div>
        ) : (
          <EmptyState title="No plan for today yet." body="Create today's plan and add the mixing, loose cans and packing the floor is to do." />
        )}
      </Card>

      <Card>
        <CardHeader
          title="Previous plans"
          action={
            <form method="get" className="flex items-center gap-2">
              <Input type="date" name="date" defaultValue={date ?? ""} aria-label="Plan date" className="h-8" />
              <Button type="submit" size="sm">
                Search
              </Button>
              {date ? (
                <NavLink href={erpPlanHref()} className={linkClass("brand", "text-meta")}>
                  Clear
                </NavLink>
              ) : null}
            </form>
          }
        />
        {previous.length ? (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse">
              <thead>
                <tr>
                  <Th>Plan number</Th>
                  <Th>Plan date</Th>
                  <Th>Created by</Th>
                  <Th>Last updated</Th>
                  <Th align="right">Lines</Th>
                  <Th align="right">Prints</Th>
                  <Th align="right">Action</Th>
                </tr>
              </thead>
              <tbody>
                {previous.map((p) => (
                  <Tr key={p.id}>
                    <Td className="font-medium text-ink">{planName(p.planNo)}</Td>
                    <Td>{fdLong(p.planDate)}</Td>
                    <Td>{p.createdBy ?? "—"}</Td>
                    <Td>{stamp(p.updatedAt)}</Td>
                    <Td align="right" className="tabular-nums">
                      {p.lines}
                    </Td>
                    <Td align="right" className="tabular-nums">
                      {p.prints}
                    </Td>
                    <Td align="right">
                      <span className="inline-flex gap-3">
                        <NavLink href={erpPlanHref(p.id)} className={linkClass()}>
                          Open
                        </NavLink>
                        {p.prints ? (
                          <NavLink href={erpPlanPrintHref(p.id, p.prints)} className={linkClass()}>
                            Last print
                          </NavLink>
                        ) : (
                          <span className="cursor-not-allowed text-faint" title={NOT_PRINTED}>
                            Last print
                          </span>
                        )}
                      </span>
                    </Td>
                  </Tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState title={date ? `No plan on ${fdLong(date)}.` : "No earlier plans yet."} />
        )}
      </Card>

      {creating ? <CreateDialog today={today} start={todays ? addDays(today, 1) : today} onClose={() => setCreating(false)} /> : null}
    </div>
  );
}

function buttonLink(variant: "primary" | "secondary" = "secondary"): string {
  return cx(
    "inline-flex h-9 items-center rounded-control border px-3.5 text-sm font-medium no-underline hover:no-underline",
    variant === "primary" ? "border-brand bg-brand text-white hover:bg-brand-hover" : "border-line bg-surface text-ink hover:bg-canvas",
  );
}

function CreateDialog({ today, start: startDate, onClose }: { today: string; start: string; onClose: () => void }) {
  const router = useRouter();
  const [date, setDate] = useState(startDate);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const go = () =>
    start(async () => {
      const res = await erpPlanOpen(date);
      if (!res.ok) return setError(res.error);
      router.push(erpPlanHref(res.data.id));
    });
  return (
    <ErpDialog onClose={onClose} size="sm" tall={false} label="Create daily plan">
      <DialogHeader onClose={onClose}>
        <DialogTitle>Create daily plan</DialogTitle>
      </DialogHeader>
      <DialogBody>
        <div className="grid gap-4">
          <Field label="Plan date" required error={error}>
            <Input type="date" value={date} min={today} onChange={(e) => setDate(e.target.value)} />
          </Field>
          <p className="text-meta text-muted">One plan per day, for today or a later day. If the day already has a plan, it opens.</p>
        </div>
      </DialogBody>
      <DialogFooter>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="primary" onClick={go} disabled={pending || !date}>
          {pending ? "Opening…" : "Create plan"}
        </Button>
      </DialogFooter>
    </ErpDialog>
  );
}

/* ================================================================ editor */

type Editing = { category: PlanCategory; line: PlanLineView | null } | null;

export function PlanEditor({
  plan,
  items,
  today,
  now,
  expected,
  readOnly,
  past,
}: {
  plan: PlanView;
  items: PlanItem[];
  today: string;
  now: number;
  /** What is not approved yet; null on a past day, which has nothing still to come. */
  expected: PlanExpected | null;
  readOnly: boolean;
  past: boolean;
}) {
  const router = useRouter();
  const ui = useErpUi();
  const [editing, setEditing] = useState<Editing>(null);
  const [tab, setTab] = useState<PlanTab>("product");
  const [ahead, setAhead] = useState<BaseRow | null>(null);
  const [printing, start] = useTransition();
  const lastPrint = plan.prints[plan.prints.length - 1] ?? null;
  const live = plan.lines.filter((l) => l.state !== "removed");
  const nextPrint = lastPrint ? (plan.changed ? lastPrint.printNo + 1 : lastPrint.printNo) : 1;

  const print = () =>
    start(async () => {
      const res = await erpPlanPrint(plan.id);
      if (!res.ok) return ui.toast(res.error, "error");
      router.push(erpPlanPrintHref(plan.id, res.data.printNo));
    });

  const remove = (l: PlanLineView) =>
    ui.confirm(
      `Delete ${l.productName}${l.size ? " " + l.size : ""} · ${nf(l.quantity)} ${l.unit} from ${planName(plan.planNo)}?${l.state === "given" || l.state === "edited" ? " The floor already has it, so the next print lists it as removed." : ""}`,
      async () => {
        const res = await erpPlanDeleteLine(l.id);
        ui.toast(res.ok ? (res.message ?? "Line deleted") : res.error, res.ok ? "info" : "error");
        router.refresh();
      },
    );

  const c = expected?.counts;
  const waitingWords = !c
    ? null
    : c.accountsTos && !c.mrpOrders
      ? "Accounts not in yet"
      : c.accountsTos
        ? `${c.accountsTos} ${c.accountsTos === 1 ? "TO" : "TOs"} still with Accounts`
        : c.mrpOrders
          ? "Accounts done"
          : null;
  const sub = [past ? planName(plan.planNo) : clock(new Date(now)), waitingWords].filter(Boolean).join(" · ");
  const sfgPlanned = (formulationId: string) => live.filter((l) => l.category === "sfg" && l.itemId === formulationId && l.unit === "Litre").reduce((n, l) => n + l.quantity, 0);
  const shortBases = new Map((expected?.bases ?? []).filter((b) => b.expectedLitres > 0).map((b) => [b.formulationId, b]));

  return (
    <div className="px-6 pt-6 pb-10">
      <BoardHeader
        title={planTitle(plan.planDate, plan.godown)}
        sub={sub}
        actions={
          <>
            <PageLinks>
              <NavLink href={erpPlanHref()} className={linkClass()}>
                ← All plans
              </NavLink>
            </PageLinks>
            {readOnly ? null : (
              <Button
                onClick={() =>
                  setEditing({
                    category: tab === "bases" ? "sfg" : "loose",
                    line: null,
                  })
                }
              >
                Add a line
              </Button>
            )}
            {lastPrint && (past || !plan.changed) ? (
              /* Nothing new to hand the floor: this opens the sheet already printed, it records no print. */
              <NavLink href={erpPlanPrintHref(plan.id, lastPrint.printNo)} className={buttonLink(past ? "secondary" : "primary")}>
                Open Print {lastPrint.printNo}
              </NavLink>
            ) : past ? null : (
              <Button
                variant="primary"
                onClick={print}
                disabled={printing || readOnly || !live.length}
                title={!live.length ? "Add at least one line before printing." : readOnly ? "You are previewing the ERP as somebody else." : `Print ${nextPrint}`}
              >
                {printing ? "Preparing…" : "Print plan"}
              </Button>
            )}
          </>
        }
      />
      {past ? (
        <Callout tone="neutral">
          This is the plan for {fdLong(plan.planDate)}, a day that has passed. It is the record of that day: its lines no longer follow the orders, and it cannot be changed or printed again.
        </Callout>
      ) : plan.planDate !== today ? (
        <Callout tone="neutral">This is the plan for {fdLong(plan.planDate)}, not today.</Callout>
      ) : null}
      {!past && lastPrint && plan.changed ? (
        <Callout tone="warn">
          {plan.changed} {plan.changed === 1 ? "line has" : "lines have"} changed since Print {lastPrint.printNo} at {stamp(lastPrint.printedAt)}. Print again to hand the floor the new sheet — the
          changes are underlined on it.
        </Callout>
      ) : null}

      {expected && c ? (
        <CardGrid min={200} gap="gap-2.5" className="mb-4">
          <PlanFigure label="Confirmed" value={plural(c.confirmedOrders, "order")} sub="cleared at MRP check" />
          <PlanFigure label="Waiting for MRP check" value={plural(c.mrpOrders, "order")} sub="approved, your check" />
          <PlanFigure
            label="Waiting for Accounts"
            value={`${c.accountsTos} ${c.accountsTos === 1 ? "TO" : "TOs"}`}
            sub={c.oldestAccounts ? `oldest ${waitShort(c.oldestAccounts, now)}` : "none waiting"}
          />
          <PlanFigure
            label="Short if all approved"
            value={plural(expected.shortProducts.length, "product")}
            danger={expected.shortProducts.length > 0}
            sub={expected.shortProducts.length ? namesLine(expected.shortProducts) : "enough of everything"}
          />
        </CardGrid>
      ) : null}

      <BoardTabs<PlanTab>
        value={tab}
        onChange={setTab}
        tabs={[
          { key: "product", label: "By product" },
          {
            key: "expected",
            label: expected ? `Expected orders (${expected.entries.length})` : "Expected orders",
          },
          { key: "bases", label: "Bases (SFG)" },
        ]}
      />

      {tab === "product" ? (
        <div className="grid gap-4">
          {expected && expected.products.length ? <ProductTable rows={expected.products} now={now} /> : null}
          {expected && expected.products.length ? (
            <div className="flex flex-wrap items-start gap-4 text-meta text-muted">
              <p className="m-0 max-w-[520px]">
                <b className="text-ink">Confirmed</b> is what the floor fills and packs. <b className="text-ink">Waiting</b> lines are expected: shown and counted so the day can be planned, never
                filled until Accounts approve and the MRP check clears them.
              </p>
              <p className="m-0 max-w-[420px]">When Accounts approve a TO, its line moves up by itself. A declined or cancelled TO drops off.</p>
            </div>
          ) : null}
          {(["loose", "packing"] as const).map((k) => (
            <CategoryCard
              key={k}
              category={k}
              plan={plan}
              readOnly={readOnly}
              past={past}
              onAdd={() => setEditing({ category: k, line: null })}
              onEdit={(l) => setEditing({ category: k, line: l })}
              onDelete={remove}
            />
          ))}
        </div>
      ) : tab === "expected" ? (
        <div className="grid gap-3">
          {expected ? (
            <>
              <p className="m-0 text-sm text-muted">
                Orders not yet confirmed. The stock check is for planning only: nothing here is cleared or filled until Accounts approve and the MRP check clears it.
              </p>
              {expected.entries.length ? (
                <ExpectedTable entries={expected.entries} now={now} bases={readOnly ? new Map() : shortBases} onAhead={setAhead} />
              ) : (
                <Card>
                  <EmptyState title="Nothing waiting." body="Every order for this godown is confirmed. New TOs show here the moment they are taken." />
                </Card>
              )}
              <div className="flex max-w-[640px] flex-col gap-2 text-meta text-muted">
                <p className="m-0">Only the base (SFG) can be started ahead. It is added to the plan as a manual SFG line, marked &quot;for expected orders&quot;.</p>
                <p className="m-0 flex flex-wrap items-center gap-2">
                  Filling and packing stay locked for an expected order:{" "}
                  <Button size="sm" disabled title="Only after Accounts approve and the MRP check clears it">
                    Fill cans
                  </Button>
                </p>
              </div>
            </>
          ) : (
            <Card>
              <EmptyState title="A past day has nothing still to come." />
            </Card>
          )}
        </div>
      ) : (
        <div className="grid gap-4">
          {expected && expected.bases.length ? <BaseTable rows={expected.bases} readOnly={readOnly} onAhead={setAhead} /> : null}
          <CategoryCard
            category="sfg"
            plan={plan}
            readOnly={readOnly}
            past={past}
            onAdd={() => setEditing({ category: "sfg", line: null })}
            onEdit={(l) => setEditing({ category: "sfg", line: l })}
            onDelete={remove}
          />
        </div>
      )}

      {editing ? <LineDialog key={editing.line?.id ?? `new-${editing.category}`} plan={plan} items={items} start={editing} onClose={() => setEditing(null)} onSaved={() => router.refresh()} /> : null}
      {ahead ? (
        <BaseAheadDialog
          key={ahead.formulationId}
          plan={plan}
          base={ahead}
          planned={sfgPlanned(ahead.formulationId)}
          onClose={() => setAhead(null)}
          onSaved={() => {
            setAhead(null);
            setTab("bases");
            router.refresh();
          }}
        />
      ) : null}
    </div>
  );
}

type PlanTab = "product" | "expected" | "bases";

const WEEKDAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTH_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "Plan · Wed 18 Nov · Bhiwandi". */
function planTitle(date: string, godown: string | null): string {
  const d = new Date(`${date}T00:00:00Z`);
  return ["Plan", `${WEEKDAY_SHORT[d.getUTCDay()]} ${d.getUTCDate()} ${MONTH_SHORT[d.getUTCMonth()]}`, godown].filter(Boolean).join(" · ");
}

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

/** "18 h", "40 min", "1 d" — how long something has waited, short. */
function waitShort(fromIso: string, now: number): string {
  const min = Math.max(0, Math.round((now - new Date(fromIso).getTime()) / 60000));
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  return h < 24 ? `${h} h` : `${Math.floor(h / 24)} d`;
}

/** Waited past half a day reads red. */
const waitedLong = (fromIso: string, now: number) => now - new Date(fromIso).getTime() > 12 * 3600000;

function namesLine(names: string[]): string {
  return names.length <= 2 ? names.join(", ") : `${names.slice(0, 2).join(", ")} and ${names.length - 2} more`;
}

function PlanFigure({ label, value, sub, danger }: { label: string; value: string; sub: string; danger?: boolean }) {
  return (
    <div className="rounded-card border border-line bg-surface px-3.5 py-3">
      <div className="text-meta text-muted">{label}</div>
      <div className={cx("text-xl leading-7 font-semibold tabular-nums", danger ? "text-danger" : "text-ink")}>{value}</div>
      <div className="truncate text-meta text-muted" title={sub}>
        {sub}
      </div>
    </div>
  );
}

const STAGE_PILL: Record<"confirmed" | "mrp" | "accounts", { tone: "success" | "warn" | "muted"; label: string }> = {
  confirmed: { tone: "success", label: "Confirmed" },
  mrp: { tone: "warn", label: "Waiting for MRP check" },
  accounts: { tone: "muted", label: "Waiting for Accounts" },
};

const dash = (n: number) => (n ? nf(n) : "—");

function ProductTable({ rows, now }: { rows: ProductRow[]; now: number }) {
  const [open, setOpen] = useState<Set<string>>(
    () =>
      new Set(
        rows
          .filter((r) => r.verdict.tone === "short" && r.mrp + r.accounts > 0)
          .slice(0, 1)
          .map((r) => r.key),
      ),
  );
  const flip = (k: string) =>
    setOpen((s) => {
      const n = new Set(s);
      if (n.has(k)) n.delete(k);
      else n.add(k);
      return n;
    });
  return (
    <BoardTable>
      <thead>
        <tr>
          <Th className="w-[30%]">Product</Th>
          <Th align="right">Confirmed</Th>
          <Th align="right">+ MRP check</Th>
          <Th align="right">+ Accounts</Th>
          <Th align="right">In stock</Th>
          <Th className="w-[22%]">If all approved</Th>
          <Th className="w-[130px]">
            <span className="sr-only">Open</span>
          </Th>
        </tr>
      </thead>
      <tbody>
        {rows.flatMap((r) => {
          const shown = open.has(r.key);
          const out = [
            <Tr key={r.key}>
              <Td className="whitespace-normal">
                <span className="font-semibold text-ink">{r.name}</span> <span className="text-meta text-muted">{r.packing}</span>
              </Td>
              <Td align="right" className="tabular-nums">
                {r.confirmed ? `${nf(r.confirmed)} cans` : "—"}
              </Td>
              <Td align="right" className="tabular-nums">
                {dash(r.mrp)}
              </Td>
              <Td align="right" className="tabular-nums">
                {dash(r.accounts)}
              </Td>
              <Td align="right" className="tabular-nums">
                {nf(r.stock)}
              </Td>
              <Td className="whitespace-normal">
                <span className={cx("font-semibold", r.verdict.tone === "short" ? "text-danger" : "text-success")}>{r.verdict.text}</span>
                {r.verdict.note ? <span className="text-meta text-muted"> {r.verdict.note}</span> : null}
              </Td>
              <Td>
                <Button size="sm" onClick={() => flip(r.key)} aria-expanded={shown}>
                  {shown ? "Hide orders" : "Show orders"}
                </Button>
              </Td>
            </Tr>,
          ];
          if (shown)
            for (const stage of ["confirmed", "mrp", "accounts"] as const) {
              const os = r.orders.filter((o) => o.stage === stage);
              if (!os.length) continue;
              out.push(
                <Tr key={`${r.key}:${stage}`}>
                  <Td colSpan={7} className="pl-7 text-meta whitespace-normal text-muted">
                    <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
                      {os.map((o) => (
                        <span key={o.ref} className="inline-flex items-center gap-1.5">
                          <Pill tone={STAGE_PILL[stage].tone}>{STAGE_PILL[stage].label}</Pill>
                          {o.ref} · {o.party} · {nf(o.cans)} cans
                          {o.since ? (stage === "mrp" ? ` · approved ${clock(new Date(o.since))}` : ` · waiting ${waitShort(o.since, now)}`) : ""}
                        </span>
                      ))}
                    </span>
                  </Td>
                </Tr>,
              );
            }
          return out;
        })}
      </tbody>
    </BoardTable>
  );
}

function ExpectedTable({ entries, now, bases, onAhead }: { entries: ExpectedEntry[]; now: number; bases: Map<string, BaseRow>; onAhead: (b: BaseRow) => void }) {
  return (
    <BoardTable>
      <thead>
        <tr>
          <Th className="w-[13%]">TO / order</Th>
          <Th className="w-[18%]">Where it is</Th>
          <Th className="w-[15%]">Party</Th>
          <Th className="w-[19%]">Goods</Th>
          <Th>Stock check</Th>
          <Th className="w-[13%]">Waiting</Th>
        </tr>
      </thead>
      <tbody>
        {entries.map((e) => {
          const ahead = e.check.tone === "short" ? e.baseIds.map((id) => bases.get(id)).find(Boolean) : undefined;
          return (
            <Tr key={e.key} className={cx(e.held && "opacity-70")}>
              <Td className="whitespace-normal">
                <b className="text-ink">{e.ref}</b>
                {e.fromTo ? <div className="text-meta text-muted">from {e.fromTo}</div> : null}
              </Td>
              <Td className="whitespace-normal">
                {e.stage === "mrp" ? (
                  <>
                    <Pill tone={e.held ? "danger" : "warn"}>{e.held ? "On hold at MRP check" : "Waiting for MRP check"}</Pill>
                    <div className="mt-0.5 text-meta text-muted">{e.held ? (e.holdReason ?? "") : `approved ${clock(new Date(e.since))}${e.by ? ` · ${e.by}` : ""}`}</div>
                  </>
                ) : (
                  <>
                    <Pill tone={e.held ? "danger" : "muted"}>{e.held ? "On hold with Accounts" : e.sentBack ? "Sent back to the taker" : "Waiting for Accounts"}</Pill>
                    {e.held && e.holdReason ? <div className="mt-0.5 text-meta text-muted">{e.holdReason}</div> : null}
                    {e.noGodown ? <div className="mt-0.5 text-meta text-muted">No godown yet</div> : null}
                  </>
                )}
              </Td>
              <Td className="whitespace-normal">{e.party}</Td>
              <Td className="whitespace-normal">
                {e.goods.map((g) => (
                  <div key={g}>{g}</div>
                ))}
              </Td>
              <Td className="whitespace-normal">
                {e.check.lines.map((l) => (
                  <div key={l.text} className={cx(l.tone === "short" ? "font-semibold text-danger" : l.tone === "ok" ? "font-semibold text-success" : "text-faint")}>
                    {l.text}
                  </div>
                ))}
                {ahead ? (
                  <button type="button" className={linkClass("brand", "text-meta")} onClick={() => onAhead(ahead)}>
                    Make the base ahead
                  </button>
                ) : null}
              </Td>
              <Td className="whitespace-normal">
                <span className={cx(!e.held && waitedLong(e.since, now) && "font-semibold text-danger")}>{waitShort(e.since, now)}</span>
                {e.stage === "mrp" && !e.held ? (
                  <NavLink href={erpLink("mrpCheck")} className={cx(linkClass("brand", "text-meta"), "block")}>
                    Open MRP check
                  </NavLink>
                ) : null}
              </Td>
            </Tr>
          );
        })}
      </tbody>
    </BoardTable>
  );
}

function BaseTable({ rows, readOnly, onAhead }: { rows: BaseRow[]; readOnly: boolean; onAhead: (b: BaseRow) => void }) {
  return (
    <BoardTable>
      <thead>
        <tr>
          <Th className="w-[24%]">Base</Th>
          <Th align="right">For confirmed</Th>
          <Th align="right">For expected</Th>
          <Th align="right">Approved in tank</Th>
          <Th className="w-[22%]">If all approved</Th>
          <Th className="w-[170px]">
            <span className="sr-only">Make ahead</span>
          </Th>
        </tr>
      </thead>
      <tbody>
        {rows.map((b) => (
          <Tr key={b.formulationId}>
            <Td className="font-semibold whitespace-normal text-ink">{b.name}</Td>
            <Td align="right" className="tabular-nums">
              {b.confirmedLitres ? `${nf(b.confirmedLitres)} L` : "—"}
            </Td>
            <Td align="right" className="tabular-nums">
              {b.expectedLitres ? `${nf(b.expectedLitres)} L` : "—"}
            </Td>
            <Td align="right" className="tabular-nums">
              {nf(b.inTank)} L
            </Td>
            <Td>
              <span className={cx("font-semibold", b.shortLitres > 0 ? "text-danger" : "text-success")}>{b.shortLitres > 0 ? `Short ${nf(b.shortLitres)} L` : "Enough"}</span>
            </Td>
            <Td>
              {!readOnly && b.expectedLitres > 0 ? (
                <Button size="sm" onClick={() => onAhead(b)}>
                  Make the base ahead
                </Button>
              ) : null}
            </Td>
          </Tr>
        ))}
      </tbody>
    </BoardTable>
  );
}

function refsLine(refs: string[]): string {
  if (!refs.length) return "expected orders";
  if (refs.length === 1) return refs[0];
  if (refs.length <= 3) return `${refs.slice(0, -1).join(", ")} and ${refs[refs.length - 1]}`;
  return `${refs.slice(0, 2).join(", ")} and ${refs.length - 2} more`;
}

function BaseAheadDialog({ plan, base, planned, onClose, onSaved }: { plan: PlanView; base: BaseRow; planned: number; onClose: () => void; onSaved: () => void }) {
  const ui = useErpUi();
  const suggest = Math.max(0, Math.ceil(base.confirmedLitres + base.expectedLitres - base.inTank - planned));
  const [litres, setLitres] = useState(suggest ? String(suggest) : "");
  const [error, setError] = useState<string | null>(null);
  const [pending, run] = useTransition();
  const save = () =>
    run(async () => {
      const remarks = base.expectedFor.join(", ");
      const res = await erpPlanSaveLine(plan.id, {
        category: "sfg",
        itemId: base.formulationId,
        quantity: litres,
        unit: "Litre",
        remarks: remarks.length > 300 ? `${remarks.slice(0, 299)}…` : remarks,
        forExpected: true,
      });
      if (!res.ok) return setError(res.fieldErrors?.[0]?.message ?? res.error);
      ui.toast(res.message ?? "Added");
      onSaved();
    });
  return (
    <ErpDialog onClose={onClose} size="sm" tall={false} label={`Make the base ahead · ${base.name}`}>
      <DialogHeader onClose={onClose}>
        <DialogTitle>Make the base ahead · {base.name}</DialogTitle>
        <p className="m-0 mt-1 text-meta text-muted">For {refsLine(base.expectedFor)}, not approved yet. A base is used by other orders if a TO is declined.</p>
      </DialogHeader>
      <DialogBody>
        <div className="grid gap-1.5">
          <Row label="Needed by expected orders" value={`${nf(base.expectedLitres)} L`} />
          {base.confirmedLitres ? <Row label="Needed by confirmed orders" value={`${nf(base.confirmedLitres)} L`} /> : null}
          <Row label="Approved base in tank" value={`${nf(base.inTank)} L`} />
          {planned ? <Row label="Already on this plan" value={`${nf(planned)} L`} /> : null}
          <Field label="Litres to make today" required error={error} className="mt-2">
            <Input inputMode="decimal" value={litres} onChange={(e) => setLitres(cleanDecimal(e.target.value))} placeholder="0" />
          </Field>
        </div>
      </DialogBody>
      <DialogFooter>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="primary" onClick={save} disabled={pending || !litres}>
          {pending ? "Adding…" : "Add base line to plan"}
        </Button>
      </DialogFooter>
    </ErpDialog>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-3 text-sm">
      <span className="text-body">{label}</span>
      <b className="text-ink tabular-nums">{value}</b>
    </div>
  );
}

/** One work category's lines: the sections the plan always had, now placed under its tab. */
function CategoryCard({
  category,
  plan,
  readOnly,
  past,
  onAdd,
  onEdit,
  onDelete,
}: {
  category: PlanCategory;
  plan: PlanView;
  readOnly: boolean;
  past: boolean;
  onAdd: () => void;
  onEdit: (l: PlanLineView) => void;
  onDelete: (l: PlanLineView) => void;
}) {
  const c = categorySpec(category)!;
  const rows = plan.lines.filter((l) => l.category === c.key);
  const n = rows.filter((r) => r.state !== "removed").length;
  return (
    <Card className="overflow-hidden">
      <CardHeader
        title={c.label}
        hint={`${n} ${n === 1 ? "line" : "lines"}`}
        action={
          readOnly ? null : (
            <Button size="sm" onClick={onAdd}>
              ＋ Add line
            </Button>
          )
        }
      />
      {rows.length ? (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse">
            <thead>
              <tr>
                <Th className="w-[34%]">Product</Th>
                {c.sizeLabel ? <Th>{c.sizeLabel}</Th> : null}
                <Th align="right">{c.key === "loose" ? "Cans" : "Quantity"}</Th>
                <Th>Unit</Th>
                {past ? null : <Th align="right">Available now</Th>}
                <Th>Remarks</Th>
                <Th>Status</Th>
                {readOnly ? null : <Th align="right">Change</Th>}
              </tr>
            </thead>
            <tbody>
              {rows.map((l) => (
                <Tr key={l.id} className={cx((l.state === "new" || l.state === "edited") && "bg-warn-soft", l.state === "removed" && "text-faint line-through")}>
                  <Td
                    className={cx(
                      "font-medium whitespace-normal",
                      l.state === "removed" ? "text-faint" : "text-ink",
                      l.state === "given" && "shadow-[inset_3px_0_0_var(--color-success)]",
                      (l.state === "new" || l.state === "edited") && "shadow-[inset_3px_0_0_var(--color-warn)]",
                      l.state === "removed" && "shadow-[inset_3px_0_0_var(--color-danger)]",
                    )}
                  >
                    <span className="flex flex-wrap items-center gap-1.5">
                      {l.productName}
                      {l.source === "order" ? <Badge tone="brand">From orders</Badge> : null}
                      {l.forExpected ? <Badge tone="warn">For expected orders</Badge> : null}
                    </span>
                  </Td>
                  {c.sizeLabel ? <Td>{l.size ?? "—"}</Td> : null}
                  <Td align="right" className="font-semibold tabular-nums">
                    {l.was != null ? <span className="mr-1.5 font-normal text-faint line-through">{nf(l.was)}</span> : null}
                    {nf(l.quantity)}
                  </Td>
                  <Td>{l.unit}</Td>
                  {past ? null : (
                    <Td align="right" className={cx("tabular-nums", l.available === 0 ? "text-danger" : "text-muted")}>
                      {l.available == null ? "—" : `${nf(l.available)} ${STOCK_UNIT[c.key]}`}
                    </Td>
                  )}
                  <Td className="whitespace-normal text-body">{l.remarks ?? ""}</Td>
                  <Td>
                    <Badge tone={STATE[l.state].tone}>{STATE[l.state].label}</Badge>
                  </Td>
                  {readOnly ? null : (
                    <Td align="right">
                      {l.state === "removed" ? null : l.source === "order" ? (
                        <NavLink href={erpLink("readyOrders")} className={linkClass("brand", "text-meta")} title="This line follows the orders. Change it on Orders → Production.">
                          Change on Orders
                        </NavLink>
                      ) : (
                        <RowMenu
                          items={[
                            { label: "Edit", onSelect: () => onEdit(l) },
                            {
                              label: "Delete",
                              destructive: true,
                              onSelect: () => onDelete(l),
                            },
                          ]}
                        />
                      )}
                    </Td>
                  )}
                </Tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="px-5 py-4 text-meta text-muted">Nothing planned.</div>
      )}
    </Card>
  );
}

/* ---------------------------------------------------- add / edit a line */

function LineDialog({ plan, items, start: begin, onClose, onSaved }: { plan: PlanView; items: PlanItem[]; start: NonNullable<Editing>; onClose: () => void; onSaved: () => void }) {
  const ui = useErpUi();
  const editingLine = begin.line;
  const [category, setCategory] = useState<PlanCategory>(begin.category);
  const [itemId, setItemId] = useState(editingLine?.itemId ?? "");
  const [query, setQuery] = useState(editingLine?.productName ?? "");
  const [quantity, setQuantity] = useState(editingLine ? String(editingLine.quantity) : "");
  const spec = categorySpec(category)!;
  const [unit, setUnit] = useState(editingLine?.unit ?? spec.units[0]);
  const [remarks, setRemarks] = useState(editingLine?.remarks ?? "");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [pending, run] = useTransition();

  const options = items.filter((i) => i.category === category);
  const item = options.find((i) => i.id === itemId) ?? null;
  const available = item ? (plan.available[`${category}:${item.id}`] ?? 0) : null;
  const already = item ? plan.lines.filter((l) => l.itemId === item.id && l.state !== "removed" && l.id !== editingLine?.id) : [];

  const pickCategory = (c: PlanCategory) => {
    if (editingLine) return;
    setCategory(c);
    setItemId("");
    setQuery("");
    setUnit(categorySpec(c)!.units[0]);
    setErrors({});
  };
  const pickProduct = (name: string) => {
    setQuery(name);
    const hit = options.find((o) => o.name.toLowerCase() === name.trim().toLowerCase());
    setItemId(hit?.id ?? "");
  };

  const save = (again: boolean) =>
    run(async () => {
      if (!itemId)
        return setErrors({
          itemId: query.trim() ? `"${query.trim()}" is not on the ${spec.label.toLowerCase()} list.` : "Pick a product.",
        });
      const res = await erpPlanSaveLine(plan.id, { category, itemId, quantity, unit, remarks }, editingLine?.id);
      if (!res.ok) {
        setErrors(Object.fromEntries((res.fieldErrors ?? [{ field: "quantity", message: res.error }]).map((f) => [f.field, f.message])));
        return;
      }
      ui.toast(res.message ?? "Saved");
      onSaved();
      if (again) {
        setItemId("");
        setQuery("");
        setQuantity("");
        setRemarks("");
        setErrors({});
      } else onClose();
    });

  return (
    <ErpDialog onClose={onClose} size="sm" tall={false} label={editingLine ? "Edit line" : "Add to plan"}>
      <DialogHeader onClose={onClose}>
        <DialogTitle>{editingLine ? `Edit line · ${planName(plan.planNo)}` : `Add to ${planName(plan.planNo)}`}</DialogTitle>
      </DialogHeader>
      <DialogBody>
        <div className="grid gap-4">
          <Field label="Work category" required group>
            <div className="flex flex-wrap gap-2">
              {PLAN_CATEGORIES.map((c) => (
                <button
                  key={c.key}
                  type="button"
                  disabled={!!editingLine && c.key !== category}
                  className={toggleClass(c.key === category, "disabled:cursor-not-allowed disabled:opacity-50")}
                  onClick={() => pickCategory(c.key)}
                >
                  {c.label}
                </button>
              ))}
            </div>
          </Field>
          <Field label="Product" required error={errors.itemId}>
            <ComboBox value={query} options={options.map((o) => o.name)} onChange={pickProduct} label="Product" placeholder="Type to search" emptyHint="Nothing on this list matches" />
          </Field>
          <div className="grid grid-cols-2 gap-4">
            {spec.sizeLabel ? (
              <Field label={spec.sizeLabel} required>
                <Input value={item?.size ?? ""} readOnly disabled placeholder="From the product" />
              </Field>
            ) : (
              <Field label="Current available">
                <Input value={available == null ? "" : `${nf(available)} ${STOCK_UNIT[category]} at ${plan.godown ?? "—"}`} readOnly disabled />
              </Field>
            )}
            <Field label={spec.qtyLabel} required error={errors.quantity}>
              {/* Typed in any unit of the kind picked beside it (a drum of litres, a dozen cans), kept in that unit. */}
              <QtyField
                base={unit}
                value={quantity}
                onChange={setQuantity}
                error={!!errors.quantity}
                placeholder="0"
                fallback={<Input inputMode={spec.whole ? "numeric" : "decimal"} value={quantity} onChange={(e) => setQuantity(e.target.value)} placeholder="0" />}
              />
            </Field>
            <Field label="Unit" required error={errors.unit}>
              <Select value={unit} onChange={(e) => setUnit(e.target.value)}>
                {spec.units.map((u) => (
                  <option key={u} value={u}>
                    {u}
                  </option>
                ))}
              </Select>
            </Field>
            {spec.sizeLabel ? (
              <Field label="Current available" className="col-span-2">
                <Input value={available == null ? "" : `${nf(available)} ${STOCK_UNIT[category]} at ${plan.godown ?? "—"}`} readOnly disabled />
              </Field>
            ) : null}
          </div>
          <Field label="Remarks" optional error={errors.remarks}>
            <Input value={remarks} onChange={(e) => setRemarks(e.target.value)} placeholder="Tank, urgency, the order it is for…" />
          </Field>
          {already.length ? (
            <Callout tone="info" className="mb-0">
              Already on this plan:{" "}
              {already.map((l) => `${nf(l.quantity)} ${UNIT_SHORT[l.unit] ?? l.unit}${l.source === "order" ? " from orders" : ""}${l.state === "given" ? " (given)" : ""}`).join(", ")}.{" "}
              {editingLine ? "" : "This adds a separate line, so the floor sees it as new."}
            </Callout>
          ) : null}
        </div>
      </DialogBody>
      <DialogFooter left={editingLine ? (editingLine.state === "given" ? "The floor has this line — the next print underlines the change." : undefined) : "Nothing already on the plan changes."}>
        <Button onClick={onClose}>Cancel</Button>
        {editingLine ? null : (
          <Button onClick={() => save(true)} disabled={pending}>
            Add and add another
          </Button>
        )}
        <Button variant="primary" onClick={() => save(false)} disabled={pending}>
          {pending ? "Saving…" : editingLine ? "Save" : "Add"}
        </Button>
      </DialogFooter>
    </ErpDialog>
  );
}
