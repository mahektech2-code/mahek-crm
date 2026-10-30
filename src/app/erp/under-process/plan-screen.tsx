"use client";

import { NavLink } from "@/components/shell/nav-link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Badge, Button, Callout, Card, CardHeader, cx, EmptyState, Field, Input, SectionLabel, Select, Td, Th, Tr } from "@/components/ui/primitives";
import { ComboBox } from "@/components/ui/combo-box";
import { RowMenu } from "@/components/ui/overlays";
import { stamp } from "@/lib/format";
import { fdLong, nf } from "@/lib/erp/ui";
import { erpPlanHref, erpPlanPrintHref } from "@/lib/erp/trace-links";
import { categorySpec, PLAN_CATEGORIES, type LineState, type PlanCategory } from "@/lib/erp/engines/production-plan";
import type { PlanItem, PlanLineView, PlanSummary, PlanView } from "@/lib/erp/production-plan";
import { erpPlanDeleteLine, erpPlanOpen, erpPlanPrint, erpPlanSaveLine } from "@/lib/actions/erp-production-plan";
import { Page, PageLinks } from "../_ui/page-head";
import { linkClass, LinkButton, toggleClass } from "../_ui/look";
import { DialogBody, DialogFooter, DialogHeader, DialogTitle, ErpDialog } from "../_ui/dialog";
import { useErpUi } from "../_ui/erp-ui";

/* ---------------------------------------------------------------------------
 * UNDER PROCESS, drawn. The list of plans, and one plan: a section per work
 * category, a row per line, coloured by whether the floor already has it.
 * Every line is saved the moment it is added or edited, so nothing typed is
 * lost to a closed tab; Print records the sheet the floor is handed.
 * ------------------------------------------------------------------------- */

const planName = (n: number) => `PLAN-${n}`;

const STATE: Record<LineState, { label: string; tone: "success" | "warn" | "danger" }> = {
  given: { label: "Given", tone: "success" },
  new: { label: "New", tone: "warn" },
  edited: { label: "Edited", tone: "warn" },
  removed: { label: "Removed", tone: "danger" },
};

const UNIT_SHORT: Record<string, string> = { Litre: "L", Kg: "kg", Cans: "cans", Boxes: "boxes" };
const STOCK_UNIT: Record<PlanCategory, string> = { sfg: "L", loose: "cans", packing: "boxes" };

/* ================================================================== list */

export function PlanList({
  today,
  todays,
  previous,
  date,
  readOnly,
  missing,
}: {
  today: string;
  todays: PlanSummary | null;
  previous: PlanSummary[];
  date: string | null;
  readOnly: boolean;
  missing: boolean;
}) {
  const [creating, setCreating] = useState(false);
  return (
    <div className="grid gap-5">
      {missing ? <Callout tone="danger">That plan no longer exists.</Callout> : null}
      <Card>
        <CardHeader
          title={`Today · ${fdLong(today)}`}
          action={
            readOnly ? null : (
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
                {todays.prints ? `printed ${todays.prints === 1 ? "once" : `${todays.prints} times`}, last at ${stamp(todays.lastPrintedAt)}` : "not printed yet"} · updated {stamp(todays.updatedAt)}
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
                    <Td align="right" className="tabular-nums">{p.lines}</Td>
                    <Td align="right" className="tabular-nums">{p.prints}</Td>
                    <Td align="right">
                      <span className="inline-flex gap-3">
                        <NavLink href={erpPlanHref(p.id)} className={linkClass()}>
                          Open
                        </NavLink>
                        {p.prints ? (
                          <NavLink href={erpPlanPrintHref(p.id, p.prints)} className={linkClass()}>
                            Print
                          </NavLink>
                        ) : (
                          <span className="text-faint">Print</span>
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

      {creating ? <CreateDialog today={today} onClose={() => setCreating(false)} /> : null}
    </div>
  );
}

function buttonLink(variant: "primary" | "secondary" = "secondary"): string {
  return cx(
    "inline-flex h-9 items-center rounded-control border px-3.5 text-sm font-medium no-underline hover:no-underline",
    variant === "primary" ? "border-brand bg-brand text-white hover:bg-brand-hover" : "border-line bg-surface text-ink hover:bg-canvas",
  );
}

function CreateDialog({ today, onClose }: { today: string; onClose: () => void }) {
  const router = useRouter();
  const [date, setDate] = useState(today);
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
            <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </Field>
          <p className="text-meta text-muted">One plan per day. If this day already has a plan, it opens.</p>
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

export function PlanEditor({ plan, items, today, readOnly }: { plan: PlanView; items: PlanItem[]; today: string; readOnly: boolean }) {
  const router = useRouter();
  const ui = useErpUi();
  const [editing, setEditing] = useState<Editing>(null);
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
    ui.confirm(`Delete ${l.productName}${l.size ? " " + l.size : ""} · ${nf(l.quantity)} ${l.unit} from ${planName(plan.planNo)}?${l.state === "given" || l.state === "edited" ? " The floor already has it, so the next print lists it as removed." : ""}`, async () => {
      const res = await erpPlanDeleteLine(l.id);
      ui.toast(res.ok ? (res.message ?? "Line deleted") : res.error, res.ok ? "info" : "error");
      router.refresh();
    });

  return (
    <Page
      title={`${planName(plan.planNo)} · Daily production plan`}
      actions={
        <>
          <PageLinks>
            <NavLink href={erpPlanHref()} className={linkClass()}>
              ← All plans
            </NavLink>
          </PageLinks>
          {readOnly ? null : (
            <Button onClick={() => setEditing({ category: "loose", line: null })}>＋ Add more</Button>
          )}
          <Button variant="primary" onClick={print} disabled={printing || readOnly || !live.length}>
            {printing ? "Preparing…" : lastPrint && !plan.changed ? `Print again (Print ${lastPrint.printNo})` : `Print plan (Print ${nextPrint})`}
          </Button>
        </>
      }
    >
      <div className="mb-4 flex flex-wrap gap-x-8 gap-y-3 rounded-card border border-line bg-surface px-5 py-3.5">
        <Meta label="Plan number" value={planName(plan.planNo)} />
        <Meta label="Plan date" value={fdLong(plan.planDate)} />
        <Meta label="Created by" value={plan.createdBy ?? "—"} />
        <Meta label="Last updated" value={`${stamp(plan.updatedAt)}${plan.updatedBy ? ` · ${plan.updatedBy}` : ""}`} />
        <Meta label="Stock read at" value={plan.godown ?? "No godown"} />
        <Meta label="Prints" value={lastPrint ? `${plan.prints.length} · last ${stamp(lastPrint.printedAt)}` : "Not printed yet"} />
      </div>

      {plan.planDate !== today ? <Callout tone="neutral">This is the plan for {fdLong(plan.planDate)}, not today.</Callout> : null}
      {lastPrint && plan.changed ? (
        <Callout tone="warn">
          {plan.changed} {plan.changed === 1 ? "line has" : "lines have"} changed since Print {lastPrint.printNo} at {stamp(lastPrint.printedAt)}. Print again to hand the floor the new sheet — the changes are underlined on it.
        </Callout>
      ) : null}

      <div className="mb-3 flex flex-wrap gap-4 text-meta text-muted">
        <Key className="bg-success" label="Given — on the last sheet the floor has" />
        <Key className="bg-warn" label="New or edited — not printed yet" />
        <Key className="bg-danger" label="Removed — the next print tells the floor" />
        <span>Every change is saved as you make it.</span>
      </div>

      <div className="grid gap-4">
        {PLAN_CATEGORIES.map((c) => {
          const rows = plan.lines.filter((l) => l.category === c.key);
          return (
            <Card key={c.key} className="overflow-hidden">
              <CardHeader
                title={c.label}
                hint={(() => { const n = rows.filter((r) => r.state !== "removed").length; return `${n} ${n === 1 ? "line" : "lines"}`; })()}
                action={
                  readOnly ? null : (
                    <Button size="sm" onClick={() => setEditing({ category: c.key, line: null })}>
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
                        <Th>Code</Th>
                        {c.sizeLabel ? <Th>{c.sizeLabel}</Th> : null}
                        <Th align="right">{c.key === "loose" ? "Cans" : "Quantity"}</Th>
                        <Th>Unit</Th>
                        <Th align="right">Current available</Th>
                        <Th>Remarks</Th>
                        <Th>Status</Th>
                        <Th align="right"> </Th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((l) => (
                        <Tr
                          key={l.id}
                          className={cx((l.state === "new" || l.state === "edited") && "bg-warn-soft", l.state === "removed" && "text-faint line-through")}
                        >
                          <Td
                            className={cx(
                              "font-medium whitespace-normal",
                              l.state === "removed" ? "text-faint" : "text-ink",
                              l.state === "given" && "shadow-[inset_3px_0_0_var(--color-success)]",
                              (l.state === "new" || l.state === "edited") && "shadow-[inset_3px_0_0_var(--color-warn)]",
                              l.state === "removed" && "shadow-[inset_3px_0_0_var(--color-danger)]",
                            )}
                          >
                            {l.productName}
                          </Td>
                          <Td className="font-mono text-meta">{l.productCode ?? "—"}</Td>
                          {c.sizeLabel ? <Td>{l.size ?? "—"}</Td> : null}
                          <Td align="right" className="font-semibold tabular-nums">
                            {l.was != null ? <span className="mr-1.5 font-normal text-faint line-through">{nf(l.was)}</span> : null}
                            {nf(l.quantity)}
                          </Td>
                          <Td>{l.unit}</Td>
                          <Td align="right" className={cx("tabular-nums", l.available === 0 ? "text-danger" : "text-muted")}>
                            {l.available == null ? "—" : `${nf(l.available)} ${STOCK_UNIT[c.key]}`}
                          </Td>
                          <Td className="whitespace-normal text-body">{l.remarks ?? ""}</Td>
                          <Td>
                            <Badge tone={STATE[l.state].tone}>{STATE[l.state].label}</Badge>
                          </Td>
                          <Td align="right">
                            {readOnly || l.state === "removed" ? null : (
                              <RowMenu
                                items={[
                                  { label: "Edit", onSelect: () => setEditing({ category: c.key, line: l }) },
                                  { label: "Delete", destructive: true, onSelect: () => remove(l) },
                                ]}
                              />
                            )}
                          </Td>
                        </Tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <div className="px-5 py-4 text-meta text-muted">
                  Nothing planned.{" "}
                  {readOnly ? null : (
                    <LinkButton onClick={() => setEditing({ category: c.key, line: null })}>Add a line</LinkButton>
                  )}
                </div>
              )}
            </Card>
          );
        })}
      </div>

      {editing ? (
        <LineDialog
          key={editing.line?.id ?? `new-${editing.category}`}
          plan={plan}
          items={items}
          start={editing}
          onClose={() => setEditing(null)}
          onSaved={() => router.refresh()}
        />
      ) : null}
    </Page>
  );
}

function Meta({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid gap-0.5">
      <SectionLabel>{label}</SectionLabel>
      <span className="text-sm font-medium text-ink">{value}</span>
    </div>
  );
}

function Key({ className, label }: { className: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className={cx("inline-block h-2.5 w-2.5 rounded-[2px]", className)} />
      {label}
    </span>
  );
}

/* ---------------------------------------------------- add / edit a line */

function LineDialog({
  plan,
  items,
  start: begin,
  onClose,
  onSaved,
}: {
  plan: PlanView;
  items: PlanItem[];
  start: NonNullable<Editing>;
  onClose: () => void;
  onSaved: () => void;
}) {
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
      if (!itemId) return setErrors({ itemId: query.trim() ? `"${query.trim()}" is not on the ${spec.label.toLowerCase()} list.` : "Pick a product." });
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
                <button key={c.key} type="button" disabled={!!editingLine && c.key !== category} className={toggleClass(c.key === category, "disabled:cursor-not-allowed disabled:opacity-50")} onClick={() => pickCategory(c.key)}>
                  {c.label}
                </button>
              ))}
            </div>
          </Field>
          <Field label="Product" required error={errors.itemId}>
            <ComboBox value={query} options={options.map((o) => o.name)} onChange={pickProduct} label="Product" placeholder="Type to search" emptyHint="Nothing on this list matches" />
          </Field>
          <div className="grid grid-cols-2 gap-4">
            <Field label="Product code">
              <Input value={item?.code ?? (item ? "None recorded" : "")} readOnly disabled />
            </Field>
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
              <Input inputMode={spec.whole ? "numeric" : "decimal"} value={quantity} onChange={(e) => setQuantity(e.target.value)} placeholder="0" />
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
              Already on this plan: {already.map((l) => `${nf(l.quantity)} ${UNIT_SHORT[l.unit] ?? l.unit}${l.state === "given" ? " (given)" : ""}`).join(", ")}. {editingLine ? "" : "This adds a separate line, so the floor sees it as new."}
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
