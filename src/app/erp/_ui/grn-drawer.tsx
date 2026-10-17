"use client";

import { useMemo, useState } from "react";
import { Button, cx } from "@/components/ui/primitives";
import { Drawer, DrawerHeader } from "@/components/ui/overlays";
import { runCalc } from "@/lib/erp/calc";
import "@/lib/erp/calcs";
import { fd, nf, resolveField, whenHolds, type FieldSpec, type FormSpec } from "@/lib/erp/ui";
import { hitSummary, linesFor, searchGrnItems, type GrnItem, type GrnPoLine } from "@/lib/erp/engines/grn-pick";
import { Field } from "./field";
import { checkField, optsFor } from "./form-check";
import { useKit } from "./kit";

/* ---------------------------------------------------------------------------
 * THE GOODS RECEIPT STARTS FROM THE ITEM THAT ARRIVED. The storekeeper knows
 * what came off the truck, not the PO number, so the drawer asks for the item
 * first, then offers only the approved PO lines still waiting for it (picked
 * for them where there is one), then the ordinary line fields. A second item
 * on the same truck is searched among the same vendor's open lines only: one
 * GRN is one vendor's delivery. The rules are the server's (`inward.new`),
 * which reads every line's PO back and refuses what it no longer allows.
 * ------------------------------------------------------------------------- */

type Step = "item" | "po" | "lines";
type Line = Record<string, string>;

/** Line fields the pick already answered: drawn in the card's heading, not as boxes. */
const PICKED = new Set(["poLine", "type", "item", "pending"]);
/** Header fields the pick already answered: the vendor and PO come from the lines, the PR number on save. */
const HEADER_SKIP = new Set(["po", "pr", "supplier"]);

const keyOf = (l: Pick<GrnPoLine, "po" | "poLine">) => `${l.po}|${l.poLine}`;

export function GrnDrawer({ spec, onClose, onSaved }: { spec: FormSpec; onClose: () => void; onSaved: (msg: string) => void }) {
  const kit = useKit();
  const data = useMemo(() => spec.data ?? {}, [spec.data]);
  const items = useMemo(() => (data.grn ?? []) as GrnItem[], [data]);
  const [step, setStep] = useState<Step>("item");
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const [picked, setPicked] = useState<GrnItem | null>(null);
  const [choice, setChoice] = useState<string>("");
  const [lines, setLines] = useState<Line[]>([]);
  const [h, setH] = useState<Record<string, string>>(() => {
    const init: Record<string, string> = { ...(spec.init ?? {}) };
    spec.header.forEach((f) => (init[f.k] = spec.init?.[f.k] ?? f.def ?? ""));
    return init;
  });
  const [godownTouched, setGodownTouched] = useState(false);
  const [errs, setErrs] = useState<Record<string, string>>({});
  const [topError, setTopError] = useState("");
  const [busy, setBusy] = useState(false);

  /* Which open line each line of this receipt is, so it is not offered twice. */
  const onReceipt = new Set(lines.map((l) => `${l.po}|${l.poLine}`));
  const lineOf = (l: Line) => {
    for (const it of items) for (const x of it.lines) if (x.po === l.po && x.poLine === l.poLine) return x;
    return undefined;
  };
  const vendor = lines.length ? lineOf(lines[0])?.supplier ?? null : null;
  const offered = (it: GrnItem) => linesFor(it, vendor).filter((x) => !onReceipt.has(keyOf(x)));

  const hits = searchGrnItems(items, query, { supplier: vendor, limit: 40 }).map((hit) => {
    const open = hit.lines.filter((x) => !onReceipt.has(keyOf(x)));
    return { ...hit, lines: open, receivable: open.length > 0 };
  }).filter((hit) => hit.receivable || query.trim() !== "");

  const blankLine = (): Line => {
    const l: Line = {};
    (spec.line ?? []).forEach((f) => (l[f.k] = f.def ?? ""));
    return l;
  };

  /* A picked PO line becomes a receipt line: the fields that fill from the PO (type, item, the quantity still pending) fill now. */
  const addLine = (it: GrnItem, x: GrnPoLine) => {
    let l: Line = { ...blankLine(), po: x.po, poLine: x.poLine, type: it.type, item: it.item };
    for (const f of spec.line ?? []) {
      if (!f.fillBy) continue;
      const v = f.fillBy.map[f.fillBy.by.map((k) => l[k] ?? h[k] ?? "").join("|")];
      if (v != null) l = { ...l, [f.k]: v };
    }
    setLines((s) => [...s, l]);
    if (!lines.length && !godownTouched && x.godown) setH((s) => ({ ...s, godown: x.godown }));
    setPicked(null);
    setChoice("");
    setQuery("");
    setCursor(0);
    setStep("lines");
  };

  const pick = (it: GrnItem) => {
    const open = offered(it);
    if (!open.length) return;
    if (open.length === 1) return addLine(it, open[0]);
    setPicked(it);
    setChoice(keyOf(open[0]));
    setStep("po");
  };

  const removeLine = (i: number) => {
    const next = lines.filter((_, j) => j !== i);
    setLines(next);
    setErrs({});
    if (!next.length) setStep("item");
  };

  const visible = (f: FieldSpec, l: Line = {}) => whenHolds(f.when, { ...h, ...l }, data);
  const resolved = (f: FieldSpec, l: Line = {}) => resolveField(f, { ...h, ...l }, data);
  const headerFields = spec.header.filter((f) => !HEADER_SKIP.has(f.k) && visible(f)).map((f) => resolved(f));
  const lineFields = (l: Line) => (spec.line ?? []).filter((f) => !PICKED.has(f.k) && visible(f, l)).map((f) => resolved(f, l));

  const submit = async () => {
    const e: Record<string, string> = {};
    headerFields.forEach((f) => {
      const m = checkField(f, h[f.k] ?? "");
      if (m) e[`h.${f.k}`] = m;
    });
    lines.forEach((l, i) =>
      lineFields(l).forEach((f) => {
        const m = checkField(f, l[f.k] ?? "");
        if (m) e[`l${i}.${f.k}`] = m;
      }),
    );
    setErrs(e);
    if (Object.keys(e).length) return;
    setBusy(true);
    setTopError("");
    const res = await kit.submitForm(spec.screen, spec.id, h, lines, spec.recordId);
    setBusy(false);
    if (res.ok) return onSaved(res.message ?? "Saved");
    const fe: Record<string, string> = {};
    res.fieldErrors?.forEach((x) => {
      const key = /^l\d+\./.test(x.field) || x.field.startsWith("h.") ? x.field : `h.${x.field}`;
      fe[key] = x.message;
    });
    if (Object.keys(fe).length) setErrs(fe);
    else setTopError(res.error);
  };

  const stepNo = step === "item" ? 1 : step === "po" ? 2 : 3;
  const sub =
    step === "lines"
      ? `${vendor ?? ""} · ${spec.init?.prFixed ? `PR ${spec.init.prFixed}` : "PR number on save"}`
      : step === "po"
        ? "Pick the PO this delivery belongs to."
        : vendor
          ? `Another item from ${vendor}'s truck. Only their open POs are offered.`
          : (spec.sub ?? "Search the item that came in.");

  const poLines = picked ? offered(picked) : [];

  return (
    <Drawer open onClose={onClose} width={680} label={spec.title}>
      <DrawerHeader onClose={onClose}>
        <div className="text-lg leading-6 font-semibold text-ink">{spec.title}</div>
        <div className="mt-0.5 text-meta text-muted">{sub}</div>
        <div className="mt-3 flex gap-1.5" aria-label={`Step ${stepNo} of 3`}>
          {[1, 2, 3].map((n) => (
            <span key={n} className={cx("h-1 w-16 rounded-full", n <= stepNo ? "bg-brand" : "bg-divider")} />
          ))}
        </div>
      </DrawerHeader>

      <div className="grid min-h-0 flex-1 auto-rows-max grid-cols-[minmax(0,1fr)] content-start gap-3.5 overflow-y-auto px-5 py-4">
        {step === "item" ? (
          <section className="grid gap-2">
            <label htmlFor="grn-item" className="text-xs font-semibold tracking-[0.04em] text-muted uppercase">
              Item received
            </label>
            <input
              id="grn-item"
              autoFocus
              value={query}
              placeholder="Search the item — name or code"
              onChange={(e) => {
                setQuery(e.target.value);
                setCursor(0);
              }}
              onKeyDown={(e) => {
                if (e.key === "ArrowDown") {
                  e.preventDefault();
                  setCursor((c) => Math.min(c + 1, hits.length - 1));
                } else if (e.key === "ArrowUp") {
                  e.preventDefault();
                  setCursor((c) => Math.max(c - 1, 0));
                } else if (e.key === "Enter" && hits[cursor]?.receivable) {
                  e.preventDefault();
                  pick(hits[cursor].item);
                }
              }}
              className="h-10 w-full rounded-control border border-line bg-surface px-3 text-sm text-ink outline-none focus:border-brand"
            />
            <span className="text-xs text-muted">Items with an approved PO still waiting are listed first. ↑ ↓ and Enter work the list.</span>
            {hits.length ? (
              <ul className="mt-1 overflow-hidden rounded-card border border-line">
                {hits.map((hit, i) => (
                  <li key={hit.item.item} className="border-b border-divider last:border-0">
                    <button
                      type="button"
                      disabled={!hit.receivable}
                      onMouseEnter={() => setCursor(i)}
                      onClick={() => pick(hit.item)}
                      className={cx(
                        "flex w-full items-center justify-between gap-3 px-3 py-2.5 text-left",
                        hit.receivable ? "cursor-pointer" : "cursor-not-allowed",
                        hit.receivable && i === cursor ? "bg-brand-soft" : "",
                      )}
                    >
                      <span className="min-w-0">
                        <span className={cx("block text-sm font-semibold", hit.receivable ? "text-ink" : "text-muted")}>{hit.item.item}</span>
                        <span className="mt-0.5 block text-xs text-muted">
                          {hit.receivable ? hitSummary(hit.lines, nf) : vendor ? `No open PO from ${vendor} for this item` : "No approved PO is waiting for this item"}
                        </span>
                      </span>
                      <span
                        className={cx(
                          "flex-none rounded-control px-2 py-0.5 text-xs font-medium",
                          hit.receivable ? "bg-brand-soft text-brand-hover" : "bg-canvas text-muted",
                        )}
                      >
                        {hit.receivable ? hit.item.type : "Cannot receive"}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <div className="rounded-card bg-canvas px-3 py-3 text-meta text-muted">
                {query ? `No item matches "${query}".` : "No item is waiting on an approved PO."}
              </div>
            )}
            <span className="text-xs text-muted">
              An item with no approved PO cannot be received — raise its requirement and get the PO approved first.
            </span>
          </section>
        ) : null}

        {step === "po" && picked ? (
          <section className="grid gap-3">
            <div className="flex items-center justify-between rounded-card border border-brand-softer bg-brand-soft px-3 py-2.5">
              <span>
                <span className="block text-sm font-semibold text-ink">{picked.item}</span>
                <span className="text-xs text-muted">
                  {picked.type} · {picked.unit}
                </span>
              </span>
              <button type="button" className="cursor-pointer text-meta font-semibold text-brand hover:underline" onClick={() => setStep("item")}>
                Change item
              </button>
            </div>
            <h3 className="text-xs font-semibold tracking-[0.04em] text-muted uppercase">Approved POs waiting for {picked.item}</h3>
            <div role="radiogroup" className="grid gap-2.5">
              {poLines.map((x) => {
                const on = choice === keyOf(x);
                const done = x.ordered ? Math.min(100, (x.received / x.ordered) * 100) : 0;
                return (
                  <button
                    key={keyOf(x)}
                    type="button"
                    role="radio"
                    aria-checked={on}
                    onClick={() => setChoice(keyOf(x))}
                    onDoubleClick={() => addLine(picked, x)}
                    className={cx(
                      "flex cursor-pointer gap-3 rounded-card border px-3 py-3 text-left",
                      on ? "border-brand bg-brand-soft/40 ring-1 ring-brand" : "border-line",
                    )}
                  >
                    <span className={cx("mt-0.5 size-4 flex-none rounded-full border-2", on ? "border-[5px] border-brand" : "border-line")} />
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center justify-between gap-2">
                        <span className="text-sm font-semibold text-ink">
                          {x.poNumber} · {x.supplier}
                        </span>
                        {x.received > 0 ? <span className="rounded-control bg-canvas px-2 py-0.5 text-xs text-muted">Partly received</span> : null}
                      </span>
                      <span className="mt-1 block text-meta text-muted">
                        Ordered {nf(x.ordered)} {x.unit} · received {nf(x.received)} ·{" "}
                        <b className="font-semibold text-ink">
                          pending {nf(x.pending)} {x.unit}
                        </b>
                      </span>
                      <span className="block text-meta text-muted">
                        Deliver to {x.godown}
                        {x.due ? ` by ${fd(x.due)}` : ""}
                      </span>
                      <span className="mt-2 block h-1.5 overflow-hidden rounded-full bg-divider">
                        <span className="block h-full bg-brand" style={{ width: `${done}%` }} />
                      </span>
                    </span>
                  </button>
                );
              })}
            </div>
            <span className="text-xs text-muted">Oldest due date first. The vendor, the godown and what is pending come from the PO chosen here.</span>
          </section>
        ) : null}

        {step === "lines" ? (
          <>
            {lines.map((l, i) => {
              const x = lineOf(l);
              const lineErr = errs[`l${i}.poLine`];
              return (
                <div key={keyOf({ po: l.po, poLine: l.poLine })} className="min-w-0 rounded-card border border-line">
                  <div className="flex items-center justify-between gap-2 rounded-t-[6px] border-b border-divider bg-canvas px-3 py-2">
                    <span className="min-w-0 text-meta font-semibold text-ink">
                      {l.item} · against {x?.poNumber ?? l.po}
                    </span>
                    <span className="flex flex-none items-center gap-2">
                      {x ? (
                        <span className="rounded-control bg-brand-soft px-2 py-0.5 text-xs font-medium text-brand-hover">
                          pending {nf(x.pending)} {x.unit}
                        </span>
                      ) : null}
                      <button type="button" onClick={() => removeLine(i)} className="h-6 cursor-pointer px-1 text-meta text-danger hover:underline">
                        Remove
                      </button>
                    </span>
                  </div>
                  {lineErr ? <div className="border-b border-divider bg-danger-soft px-3 py-2 text-meta text-danger">{lineErr}</div> : null}
                  <div className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-3.5 px-3 py-3.5">
                    {lineFields(l).map((f) => (
                      <Field
                        key={f.k}
                        f={f}
                        value={l[f.k] ?? ""}
                        error={errs[`l${i}.${f.k}`]}
                        options={optsFor(f, { ...h, ...l })}
                        derived={f.t === "derived" ? runCalc(f.calc, { h, l, lines, i, data }) : undefined}
                        onChange={(v) => {
                          setLines((s) => s.map((y, j) => (j === i ? { ...y, [f.k]: v } : y)));
                          setErrs((s) => ({ ...s, [`l${i}.${f.k}`]: "" }));
                        }}
                      />
                    ))}
                  </div>
                </div>
              );
            })}
            <button
              type="button"
              onClick={() => setStep("item")}
              className="cursor-pointer rounded-card border border-dashed border-brand-softer bg-surface px-3 py-2.5 text-left"
            >
              <span className="block text-sm font-semibold text-brand-hover">+ Add another item from this truck</span>
              <span className="text-xs text-muted">Searches only {vendor ?? "this vendor"}&apos;s open POs — one GRN is one vendor&apos;s delivery.</span>
            </button>
            <div className="min-w-0 rounded-card border border-line">
              <div className="rounded-t-[6px] border-b border-divider bg-canvas px-3 py-2 text-meta font-semibold text-ink">The delivery</div>
              <div className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-3.5 px-3 py-3.5">
                {headerFields.map((f) => (
                  <Field
                    key={f.k}
                    f={f}
                    value={h[f.k] ?? ""}
                    error={errs[`h.${f.k}`]}
                    options={optsFor(f, h)}
                    derived={f.t === "derived" ? runCalc(f.calc, { h, l: {}, lines, i: -1, data }) : undefined}
                    onChange={(v) => {
                      if (f.k === "godown") setGodownTouched(true);
                      setH((s) => ({ ...s, [f.k]: v }));
                      setErrs((s) => ({ ...s, [`h.${f.k}`]: "" }));
                    }}
                  />
                ))}
              </div>
            </div>
            {topError ? (
              <div className="rounded-control border border-danger-soft border-l-[3px] border-l-danger bg-danger-soft px-4 py-2.5 text-sm font-medium text-danger">
                {topError}
              </div>
            ) : null}
          </>
        ) : null}
      </div>

      <div className="flex flex-none justify-end gap-2.5 border-t border-divider px-5 py-3">
        {step === "item" ? (
          lines.length ? (
            <Button variant="secondary" onClick={() => setStep("lines")}>
              Back to the receipt
            </Button>
          ) : (
            <Button variant="secondary" onClick={onClose}>
              Cancel
            </Button>
          )
        ) : null}
        {step === "po" && picked ? (
          <>
            <Button variant="secondary" onClick={() => setStep("item")}>
              Back
            </Button>
            <Button
              variant="primary"
              disabled={!choice}
              onClick={() => {
                const x = poLines.find((y) => keyOf(y) === choice);
                if (x) addLine(picked, x);
              }}
            >
              Next
            </Button>
          </>
        ) : null}
        {step === "lines" ? (
          <>
            <Button variant="secondary" onClick={onClose}>
              Cancel
            </Button>
            <Button variant="primary" onClick={() => void submit()} disabled={busy}>
              {busy ? "Saving…" : spec.submit}
            </Button>
          </>
        ) : null}
      </div>
    </Drawer>
  );
}
