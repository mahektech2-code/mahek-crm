"use client";

import { NavLink } from "@/components/shell/nav-link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Button, Callout, Card, CardHeader, Checkbox, checkboxClass, cx, EmptyState, Field, Input, Select, Td, Th, Tr } from "@/components/ui/primitives";
import { ComboBox } from "@/components/ui/combo-box";
import { cleanDecimal, cleanWhole, clock, stamp } from "@/lib/format";
import { addDays } from "@/lib/business-date";
import { fdLong, nf } from "@/lib/erp/ui";
import { erpPlanHref, erpPlanPrintHref } from "@/lib/erp/trace-links";
import { QtyField } from "../_ui/units";
import { categorySpec, PLAN_CATEGORIES, type PlanCategory } from "@/lib/erp/engines/production-plan";
import { facetValues, type BoardFacet } from "@/lib/erp/engines/plan-board";
import type { PlanBoardRow, PlanItem, PlanLineView, PlanSummary, PlanView } from "@/lib/erp/production-plan";
import { BoardHeader, BoardTable, Pill } from "../_ui/board";
import { erpPlanDeleteLine, erpPlanOpen, erpPlanPrintPicks, erpPlanSaveLine } from "@/lib/actions/erp-production-plan";
import { RowMenu } from "@/components/ui/overlays";
import { PageLinks } from "../_ui/page-head";
import { labelClass, linkClass, popoverClass, toggleClass } from "../_ui/look";
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

type Facet = BoardFacet;

const FACETS: { key: Facet; label: string }[] = [
  { key: "kind", label: "Product" },
  { key: "confirmed", label: "Confirmed" },
  { key: "waiting", label: "Waiting" },
  { key: "stock", label: "In stock" },
  { key: "verdict", label: "If all approved" },
  { key: "unit", label: "Unit" },
];

type RowEdit = { ticked: boolean; qty: string; unit: string };

export function PlanEditor({ plan, board, items, readOnly, past }: { plan: PlanView; board: PlanBoardRow[]; items: PlanItem[]; readOnly: boolean; past: boolean }) {
  const router = useRouter();
  const ui = useErpUi();
  const [adding, setAdding] = useState(false);
  /* The typed line whose ⋯ → Edit line opened the dialog. */
  const [editing, setEditing] = useState<PlanLineView | null>(null);
  const [edits, setEdits] = useState<Record<string, RowEdit>>(() => Object.fromEntries(board.map((r) => [r.key, { ticked: r.ticked, qty: String(r.qty), unit: r.unit }])));
  const [query, setQuery] = useState("");
  const [filters, setFilters] = useState<Partial<Record<Facet, string[]>>>({});
  const [openFacet, setOpenFacet] = useState<{ facet: Facet; x: number; y: number } | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [printing, start] = useTransition();
  const lastPrint = plan.prints[plan.prints.length - 1] ?? null;

  /* A row added since the page was drawn (Add a line, then a refresh) starts as the server says. */
  const edit = (r: PlanBoardRow): RowEdit => edits[r.key] ?? { ticked: r.ticked, qty: String(r.qty), unit: r.unit };
  const setEdit = (key: string, patch: Partial<RowEdit>) =>
    setEdits((all) => {
      const r = board.find((b) => b.key === key)!;
      return { ...all, [key]: { ...(all[key] ?? { ticked: r.ticked, qty: String(r.qty), unit: r.unit }), ...patch } };
    });

  const facetsOf = (r: PlanBoardRow) => facetValues(r, edit(r).unit);
  const options = (facet: Facet) => {
    const counts = new Map<string, number>();
    for (const r of board) for (const v of facetsOf(r)[facet]) counts.set(v, (counts.get(v) ?? 0) + 1);
    return [...counts].sort((a, b) => a[0].localeCompare(b[0]));
  };
  const active = (facet: Facet) => {
    const sel = filters[facet];
    return !!sel && sel.length > 0 && sel.length < options(facet).length;
  };
  const q = query.trim().toLowerCase();
  const visible = board.filter((r) => {
    if (q && !`${r.name} ${r.code ?? ""}`.toLowerCase().includes(q)) return false;
    const f = facetsOf(r);
    return FACETS.every(({ key }) => !active(key) || f[key].some((v) => filters[key]!.includes(v)));
  });
  const ticked = board.filter((r) => edit(r).ticked);
  const allVisibleTicked = visible.length > 0 && visible.every((r) => edit(r).ticked);

  const print = () =>
    start(async () => {
      setErrors({});
      const res = await erpPlanPrintPicks(
        plan.id,
        ticked.map((r) => ({ key: r.key, quantity: edit(r).qty, unit: edit(r).unit })),
      );
      if (!res.ok) {
        setErrors(Object.fromEntries((res.fieldErrors ?? []).map((f) => [f.field, f.message])));
        return ui.toast(res.error, "error");
      }
      router.push(erpPlanPrintHref(plan.id, res.data.printNo));
    });

  const sections: { label: string; rows: PlanBoardRow[] }[] = [
    { label: "Loose cans and packing", rows: visible.filter((r) => r.category !== "sfg") },
    { label: "Bases (SFG)", rows: visible.filter((r) => r.category === "sfg") },
  ].filter((s) => s.rows.length);

  const funnel = (facet: Facet) => (
    <button
      type="button"
      aria-label={`Filter ${FACETS.find((f) => f.key === facet)!.label}`}
      onClick={(e) => {
        const b = e.currentTarget.getBoundingClientRect();
        setOpenFacet(openFacet?.facet === facet ? null : { facet, x: b.left, y: b.bottom + 4 });
      }}
      className={cx("ml-1 inline-flex cursor-pointer align-middle", active(facet) ? "text-brand" : "text-faint hover:text-body")}
    >
      <svg width="11" height="11" viewBox="0 0 24 24" aria-hidden="true">
        <path d="M3 5h18l-7 8v6l-4 2v-8z" fill={active(facet) ? "currentColor" : "none"} stroke="currentColor" strokeWidth="2.4" />
      </svg>
    </button>
  );

  /* A row somebody typed (Add a line) is theirs to edit or take off; a row the orders put there is ticked or not, and changes when the orders do. */
  const typedLine = (r: PlanBoardRow): PlanLineView | null => (r.key.startsWith("line:") && r.lineId ? (plan.lines.find((l) => l.id === r.lineId && l.source === "manual") ?? null) : null);
  const forget = (key: string) =>
    setEdits((all) => {
      const next = { ...all };
      delete next[key];
      return next;
    });
  const removeLine = (r: PlanBoardRow, line: PlanLineView) =>
    ui.confirm(`Remove ${r.name} (${nf(line.quantity)} ${UNIT_SHORT[line.unit] ?? line.unit}) from ${planName(plan.planNo)}?${line.state === "given" ? " The floor already has it on an earlier print." : ""}`, () =>
      start(async () => {
        const res = await erpPlanDeleteLine(line.id);
        if (!res.ok) return ui.toast(res.error, "error");
        forget(r.key);
        ui.toast(res.message ?? "Line removed");
        router.refresh();
      }),
    );
  const showMenu = !past && !readOnly;

  const numberCell = (r: PlanBoardRow, n: number | null) => (n == null ? "—" : n === 0 ? "—" : `${nf(n)}${r.measure === "L" ? " L" : ""}`);

  return (
    <div className="px-6 pt-6 pb-10">
      <BoardHeader
        title={planTitle(plan.planDate, plan.godown)}
        sub={past ? planName(plan.planNo) : undefined}
        actions={
          <>
            <PageLinks>
              <NavLink href={erpPlanHref()} className={linkClass()}>
                ← All plans
              </NavLink>
            </PageLinks>
            {past ? (
              lastPrint ? (
                <NavLink href={erpPlanPrintHref(plan.id, lastPrint.printNo)} className={buttonLink()}>
                  Open Print {lastPrint.printNo}
                </NavLink>
              ) : null
            ) : (
              <>
                {readOnly ? null : <Button onClick={() => setAdding(true)}>Add a line</Button>}
                <Button variant="primary" onClick={print} disabled={printing || readOnly || !ticked.length} title={readOnly ? "You are previewing the ERP as somebody else." : !ticked.length ? "Tick at least one row." : undefined}>
                  {printing ? "Preparing…" : `Print plan (${ticked.length})`}
                </Button>
              </>
            )}
          </>
        }
      />

      {past ? null : (
        <div className="mb-3 flex flex-wrap items-center gap-2.5">
          <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search product" aria-label="Search product" className="h-8 w-60" />
          {readOnly ? null : (
            <button type="button" className={linkClass("brand", "text-sm")} onClick={() => setEdits(() => Object.fromEntries(board.map((r) => [r.key, { ...edit(r), ticked: (r.confirmed ?? 0) > 0 || r.key.startsWith("line:") }])))}>
              Select confirmed
            </button>
          )}
          {FACETS.filter((f) => active(f.key)).map((f) => (
            <span key={f.key} className="inline-flex items-center gap-1.5 rounded-full border border-line bg-surface px-2.5 py-0.5 text-xs text-body">
              {f.label}: {filters[f.key]!.length} of {options(f.key).length}
              <button type="button" aria-label={`Clear ${f.label}`} className="cursor-pointer text-muted hover:text-ink" onClick={() => setFilters((all) => ({ ...all, [f.key]: [] }))}>
                ×
              </button>
            </span>
          ))}
          {FACETS.some((f) => active(f.key)) ? (
            <button type="button" className={linkClass("brand", "text-xs")} onClick={() => setFilters({})}>
              Clear
            </button>
          ) : null}
        </div>
      )}

      {board.length ? (
        <BoardTable>
          <thead>
            <tr>
              {past ? null : (
                <Th className="w-10">
                  <input
                    type="checkbox"
                    className={checkboxClass}
                    aria-label="Tick every row shown"
                    checked={allVisibleTicked}
                    disabled={readOnly}
                    onChange={() => setEdits((all) => ({ ...all, ...Object.fromEntries(visible.map((r) => [r.key, { ...edit(r), ticked: !allVisibleTicked }])) }))}
                  />
                </Th>
              )}
              <Th className="w-[28%]">Product{past ? null : funnel("kind")}</Th>
              <Th align="right">Confirmed{past ? null : funnel("confirmed")}</Th>
              <Th className="w-[18%]">Waiting{past ? null : funnel("waiting")}</Th>
              <Th align="right">In stock{past ? null : funnel("stock")}</Th>
              <Th>If all approved{past ? null : funnel("verdict")}</Th>
              <Th align="right">Make today</Th>
              <Th>Unit{past ? null : funnel("unit")}</Th>
              {showMenu ? <Th className="w-10" aria-label="Actions" /> : null}
            </tr>
          </thead>
          <tbody>
            {sections.flatMap((s) => [
              <Tr key={`s-${s.label}`}>
                <Td colSpan={past ? 7 : showMenu ? 9 : 8} className={cx(labelClass, "bg-canvas py-1.5")}>
                  {s.label}
                </Td>
              </Tr>,
              ...s.rows.map((r) => {
                const e = edit(r);
                const whole = e.unit === "Cans" || e.unit === "Boxes";
                return (
                  <Tr key={r.key} className={cx(e.ticked ? "bg-brand-soft" : "text-muted")}>
                    {past ? null : (
                      <Td>
                        <input type="checkbox" className={checkboxClass} aria-label={r.name} checked={e.ticked} disabled={readOnly} onChange={() => setEdit(r.key, { ticked: !e.ticked })} />
                      </Td>
                    )}
                    <Td className="whitespace-normal">
                      <span className={cx("font-semibold", e.ticked ? "text-ink" : "text-body")}>{r.name}</span>
                      {r.size && r.category !== "sfg" && !r.name.includes(r.size) ? <span className="text-meta text-muted"> {r.size}</span> : null}
                      {r.packing ? <span className="text-meta text-muted"> · {r.packing}</span> : null}
                      {r.remarks ? (
                        <div className="text-meta text-body">
                          {r.orderRefs && r.key.includes(":o") ? `Order ${r.orderRefs} · ` : null}
                          {r.remarks}
                        </div>
                      ) : null}
                    </Td>
                    <Td align="right" className="tabular-nums">
                      {numberCell(r, r.confirmed)}
                    </Td>
                    <Td className="whitespace-normal">
                      <span className="flex flex-wrap gap-1">
                        {r.mrp > 0 ? <Pill tone="warn">MRP check {nf(r.mrp)}</Pill> : null}
                        {r.accounts > 0 ? <Pill tone="muted">{r.measure === "L" ? `Expected ${nf(r.accounts)} L` : `Accounts ${nf(r.accounts)}`}</Pill> : null}
                        {r.mrp + r.accounts === 0 ? "—" : null}
                      </span>
                    </Td>
                    <Td align="right" className="tabular-nums">
                      {r.stock == null ? "—" : `${nf(r.stock)}${r.measure === "L" ? " L" : ""}`}
                    </Td>
                    <Td>{r.verdict ? <span className={cx("font-semibold", r.verdict.tone === "short" ? "text-danger" : "text-success")}>{r.verdict.text}</span> : "—"}</Td>
                    <Td align="right">
                      {past ? (
                        <span className="font-semibold tabular-nums">{nf(r.qty)}</span>
                      ) : (
                        <Input
                          value={e.qty}
                          inputMode={whole ? "numeric" : "decimal"}
                          aria-label={`Make today · ${r.name}`}
                          disabled={readOnly}
                          invalid={!!errors[r.key]}
                          title={errors[r.key]}
                          onChange={(ev) => setEdit(r.key, { qty: whole ? cleanWhole(ev.target.value) : cleanDecimal(ev.target.value), ticked: true })}
                          className="h-8 w-20 text-right"
                        />
                      )}
                    </Td>
                    <Td>
                      {!past && r.units.length > 1 ? (
                        <Select value={e.unit} disabled={readOnly} aria-label={`Unit · ${r.name}`} onChange={(ev) => setEdit(r.key, { unit: ev.target.value })} className="h-8">
                          {r.units.map((u) => (
                            <option key={u} value={u}>
                              {u}
                            </option>
                          ))}
                        </Select>
                      ) : (
                        e.unit
                      )}
                    </Td>
                    {showMenu ? (
                      <Td align="right">
                        <LineMenu row={r} line={typedLine(r)} onEdit={setEditing} onRemove={removeLine} />
                      </Td>
                    ) : null}
                  </Tr>
                );
              }),
            ])}
            {!sections.length ? (
              <Tr>
                <Td colSpan={showMenu ? 9 : 8} className="py-6 text-center text-muted">
                  Nothing matches.
                </Td>
              </Tr>
            ) : null}
          </tbody>
        </BoardTable>
      ) : (
        <Card>
          <EmptyState title={past ? "Nothing was printed on this day." : "Nothing to plan yet."} />
        </Card>
      )}

      {openFacet ? (
        <FacetPopover
          key={openFacet.facet}
          label={FACETS.find((f) => f.key === openFacet.facet)!.label}
          options={options(openFacet.facet)}
          selected={filters[openFacet.facet]?.length ? filters[openFacet.facet]! : options(openFacet.facet).map(([v]) => v)}
          x={openFacet.x}
          y={openFacet.y}
          onClose={() => setOpenFacet(null)}
          onApply={(sel) => {
            setFilters((all) => ({ ...all, [openFacet.facet]: sel }));
            setOpenFacet(null);
          }}
        />
      ) : null}

      {adding ? <LineDialog plan={plan} items={items} start={{ category: "loose", line: null }} onClose={() => setAdding(false)} onSaved={() => router.refresh()} /> : null}
      {editing ? (
        <LineDialog
          key={editing.id}
          plan={plan}
          items={items}
          start={{ category: editing.category as PlanCategory, line: editing }}
          onClose={() => setEditing(null)}
          onSaved={() => {
            forget(`line:${editing.id}`);
            router.refresh();
          }}
        />
      ) : null}
    </div>
  );
}

/** A row's ⋯ menu. A row the orders put on the plan says why it has nothing to edit, rather than having no menu at all. */
function LineMenu({ row, line, onEdit, onRemove }: { row: PlanBoardRow; line: PlanLineView | null; onEdit: (l: PlanLineView) => void; onRemove: (r: PlanBoardRow, l: PlanLineView) => void }) {
  const why = line ? undefined : "This row comes from the orders. Untick it to leave it off the print, or change the order itself.";
  return (
    <RowMenu
      items={[
        { label: "Edit line", onSelect: () => line && onEdit(line), disabled: !line, title: why },
        { label: "Remove line", onSelect: () => line && onRemove(row, line), destructive: true, disabled: !line, title: why },
      ]}
    />
  );
}

/** One column's filter: its values with how many rows carry each, staged until Apply. */
function FacetPopover({
  label,
  options,
  selected,
  x,
  y,
  onClose,
  onApply,
}: {
  label: string;
  options: [string, number][];
  selected: string[];
  x: number;
  y: number;
  onClose: () => void;
  onApply: (sel: string[]) => void;
}) {
  const [sel, setSel] = useState<string[]>(selected);
  return (
    <>
      <div className="fixed inset-0 z-40" onClick={onClose} aria-hidden="true" />
      <div role="dialog" aria-label={`Filter ${label}`} className={cx(popoverClass, "fixed z-50 flex w-56 flex-col gap-2 p-3")} style={{ left: x, top: y }}>
        {options.map(([v, n]) => (
          <Checkbox
            key={v}
            label={
              <span className="flex flex-1 justify-between">
                {v}
                <span className="text-muted tabular-nums">{n}</span>
              </span>
            }
            checked={sel.includes(v)}
            onChange={() => setSel((s) => (s.includes(v) ? s.filter((x) => x !== v) : [...s, v]))}
          />
        ))}
                <div className="mt-1 flex justify-between">
          <Button size="sm" onClick={() => onApply([])}>
            Clear
          </Button>
          <Button size="sm" variant="primary" onClick={() => onApply(sel)} disabled={!sel.length}>
            Apply
          </Button>
        </div>
      </div>
    </>
  );
}

const WEEKDAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTH_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "Plan · Wed 18 Nov · Bhiwandi". */
function planTitle(date: string, godown: string | null): string {
  const d = new Date(`${date}T00:00:00Z`);
  return ["Plan", `${WEEKDAY_SHORT[d.getUTCDay()]} ${d.getUTCDate()} ${MONTH_SHORT[d.getUTCMonth()]}`, godown].filter(Boolean).join(" · ");
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
