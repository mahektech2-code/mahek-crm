"use client";

import { useMemo, useRef, useState } from "react";
import type { GrnNext, NextStep } from "@/lib/erp/engines/goods-in";
import { Button, Callout, Progress, SectionLabel, buttonClass, controlClass, cx } from "@/components/ui/primitives";
import { DialogBody, DialogTitle, DialogFooter, DialogHeader, ErpDialog, StepBar } from "./dialog";
import { Badge } from "./badge";
import { LinkButton, eyebrowClass, fieldLabelClass } from "./look";
import { runCalc } from "@/lib/erp/calc";
import "@/lib/erp/calcs";
import { fd, nf, resolveField, whenHolds, type FieldSpec, type FormSpec } from "@/lib/erp/ui";
import { hitSummary, linesFor, searchGrnItems, type GrnItem, type GrnPoLine } from "@/lib/erp/engines/grn-pick";
import { grnReview } from "@/lib/erp/engines/grn-review";
import { Field } from "./field";
import { GrnReview } from "./grn-review";
import { checkField, optsFor } from "./form-check";
import { useKit } from "./kit";
import { formSub } from "./quiet-copy";

/* ---------------------------------------------------------------------------
 * THE GOODS RECEIPT STARTS FROM THE ITEM THAT ARRIVED. The storekeeper knows
 * what came off the truck, not the PO number, so the record asks for the item
 * first, then offers only the approved PO lines still waiting for it (picked
 * for them where there is one), then the ordinary line fields. A second item
 * on the same truck is searched among the same vendor's open lines only: one
 * GRN is one vendor's delivery. The rules are the server's (`inward.new`),
 * which reads every line's PO back and refuses what it no longer allows.
 * ------------------------------------------------------------------------- */

type Step = "item" | "po" | "lines" | "review" | "next";
type Line = Record<string, string>;

/** Line fields the pick already answered: drawn in the card's heading, not as boxes. */
const PICKED = new Set(["poLine", "type", "item", "pending"]);
/** Header fields the pick already answered: the vendor and PO come from the lines, the PR number on save. */
const HEADER_SKIP = new Set(["po", "pr", "supplier"]);

const keyOf = (l: Pick<GrnPoLine, "po" | "poLine">) => `${l.po}|${l.poLine}`;

/** The PR's transport is recorded once, with its first lines: a second visit to the same PR does not ask it again. */
const COST_KEYS = new Set(["transportMode", "transportCost", "km", "ownCost", "tempo", "otherCost", "otherNote", "landing"]);

const STEPS = ["Item received", "Purchase order", "Receipt details", "Review", "What's next"];

/** A picked PO line as a receipt line: the fields that fill from the PO (type, item, the quantity still pending) filled. */
function lineFor(spec: FormSpec, h: Record<string, string>, it: GrnItem, x: GrnPoLine): Line {
  let l: Line = { po: x.po, poLine: x.poLine, type: it.type, item: it.item };
  (spec.line ?? []).forEach((f) => (l[f.k] ??= f.def ?? ""));
  for (const f of spec.line ?? []) {
    if (!f.fillBy) continue;
    const v = f.fillBy.map[f.fillBy.by.map((k) => l[k] ?? h[k] ?? "").join("|")];
    if (v != null) l = { ...l, [f.k]: v };
  }
  return l;
}

/** The lines a receipt opened from Goods in's Expected at the gate starts with (`data.grnStart`). */
function startLines(spec: FormSpec, h: Record<string, string>): Line[] {
  const items = (spec.data?.grn ?? []) as GrnItem[];
  const start = (spec.data?.grnStart ?? []) as { po: string; poLine: string; item: string }[];
  return start.flatMap((s) => {
    const it = items.find((x) => x.item === s.item);
    const x = it?.lines.find((y) => y.po === s.po && y.poLine === s.poLine);
    return it && x ? [lineFor(spec, h, it, x)] : [];
  });
}

export function GrnDialog({ spec, onClose, onSaved }: { spec: FormSpec; onClose: () => void; onSaved: (msg: string) => void }) {
  const kit = useKit();
  const data = useMemo(() => spec.data ?? {}, [spec.data]);
  /* Items already saved on this PR (same truck, more items): their lot is taken on it, and the open lines the form was sent with are stale. */
  const [onPr, setOnPr] = useState<string[]>([]);
  const items = useMemo(() => ((data.grn ?? []) as GrnItem[]).map((it) => (onPr.includes(it.item) ? { ...it, lines: [] } : it)), [data, onPr]);
  /* Opened on PO lines from Expected at the gate: those lines are on the receipt and it opens on Receipt details. */
  const [step, setStep] = useState<Step>(() => ((spec.data?.grnStart as unknown[] | undefined)?.length ? "lines" : "item"));
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const [picked, setPicked] = useState<GrnItem | null>(null);
  const [choice, setChoice] = useState<string>("");
  const [h, setH] = useState<Record<string, string>>(() => {
    const init: Record<string, string> = { ...(spec.init ?? {}) };
    spec.header.forEach((f) => (init[f.k] = spec.init?.[f.k] ?? f.def ?? ""));
    return init;
  });
  const [lines, setLines] = useState<Line[]>(() => startLines(spec, h));
  /* After a save: what is left to do on each line (step 5), and the vendor a second visit to the same PR keeps to. */
  const [next, setNext] = useState<GrnNext | null>(null);
  const [savedMsg, setSavedMsg] = useState("");
  const [sameTruck, setSameTruck] = useState<string | null>(null);
  const [godownTouched, setGodownTouched] = useState(false);
  const [errs, setErrs] = useState<Record<string, string>>({});
  const [topError, setTopError] = useState("");
  const [busy, setBusy] = useState(false);
  /* Set the instant Save is pressed: `busy` is state and a second click can land before it renders. */
  const inFlight = useRef(false);

  /* Which open line each line of this receipt is, so it is not offered twice. */
  const onReceipt = new Set(lines.map((l) => `${l.po}|${l.poLine}`));
  const lineOf = (l: Line) => {
    for (const it of items) for (const x of it.lines) if (x.po === l.po && x.poLine === l.poLine) return x;
    return undefined;
  };
  const vendor = lines.length ? (lineOf(lines[0])?.supplier ?? null) : sameTruck;
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
    const l: Line = { ...blankLine(), ...lineFor(spec, h, it, x) };
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
  const headerFields = spec.header.filter((f) => !HEADER_SKIP.has(f.k) && !(h.prFixed && COST_KEYS.has(f.k)) && visible(f)).map((f) => resolved(f));
  const lineFields = (l: Line) => (spec.line ?? []).filter((f) => !PICKED.has(f.k) && visible(f, l)).map((f) => resolved(f, l));

  /** The same browser checks the save always ran; true when every box passes. */
  const validate = (): boolean => {
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
    return Object.keys(e).length === 0;
  };

  /** Receipt details → Review: nothing is sent, the boxes are only checked. */
  const toReview = () => {
    setTopError("");
    if (validate()) setStep("review");
  };

  const submit = async () => {
    if (inFlight.current) return;
    if (!validate()) {
      setStep("lines");
      return;
    }
    inFlight.current = true;
    setBusy(true);
    setTopError("");
    let res: Awaited<ReturnType<typeof kit.submitForm>>;
    try {
      res = await kit.submitForm(spec.screen, spec.id, h, lines, spec.recordId);
    } catch {
      setTopError("That could not be saved. Check the connection and try again.");
      return;
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
    if (res.ok) {
      /* Step 5: what the save did to each line, and what is left to do on it. */
      const done = (res.data as { next?: GrnNext } | undefined)?.next;
      if (!done) return onSaved(res.message ?? "Saved");
      setNext(done);
      setSavedMsg(res.message ?? "Saved");
      setStep("next");
      return;
    }
    const fe: Record<string, string> = {};
    res.fieldErrors?.forEach((x) => {
      const key = /^l\d+\./.test(x.field) || x.field.startsWith("h.") ? x.field : `h.${x.field}`;
      fe[key] = x.message;
    });
    /* A refusal that names a box is shown beside it, so go back to the step with the boxes. */
    if (Object.keys(fe).length) {
      setErrs(fe);
      setStep("lines");
    } else setTopError(res.error);
  };

  /* No closing while the receipt is on its way; closed after a save, the list behind is drawn again. */
  const close = () => {
    if (inFlight.current) return;
    if (next) onSaved(savedMsg);
    else onClose();
  };

  /* SAME TRUCK, MORE ITEMS: the next item goes on the same PR, from the same vendor; its transport is already recorded. */
  const sameTruckAgain = () => {
    if (!next) return;
    setSameTruck(next.supplier);
    setH((x) => ({ ...x, pr: String(next.pr), prFixed: String(next.pr) }));
    setLines([]);
    setErrs({});
    setTopError("");
    setOnPr((x) => [...x, ...lines.map((l) => l.item)]);
    setNext(null);
    setStep("item");
  };

  const stepNo = step === "item" ? 1 : step === "po" ? 2 : step === "lines" ? 3 : step === "review" ? 4 : 5;
  const prFixed = h.prFixed || spec.init?.prFixed;
  const sub =
    step === "next" && next
      ? `${next.supplier} · PR ${next.pr}`
      : step === "lines" || step === "review"
      ? `${vendor ?? ""} · ${prFixed ? `PR ${prFixed}` : "PR number on save"}`
      : step === "po"
        ? null
        : vendor
          ? `Same truck · ${vendor}`
          : formSub(spec.sub);

  const poLines = picked ? offered(picked) : [];

  return (
    <ErpDialog onClose={close} label={spec.title} width={step === "lines" || step === "review" || step === "next" ? 920 : 760}>
      <DialogHeader onClose={close}>
        <DialogTitle>{spec.title}</DialogTitle>
        {sub ? <div className="mt-0.5 text-meta text-muted">{sub}</div> : null}
      </DialogHeader>
      {/* The steps follow the truck, not a page order: adding a second item goes back to the first. */}
      <StepBar steps={STEPS} active={stepNo - 1} reached={stepNo - 1} onChange={() => {}} />

      {/* Keyed on the step: a step starts at the top, whatever the last one was scrolled to. */}
      <DialogBody key={step}>
        {step === "item" ? (
          <section className="grid gap-2">
            <label htmlFor="grn-item" className={fieldLabelClass}>
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
              className={controlClass({ className: "h-10" })}
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
                          {hit.receivable ? hitSummary(hit.lines, nf) : onPr.includes(hit.item.item) ? `Already received on PR ${h.prFixed} — one lot per item on a PR` : vendor ? `No open PO from ${vendor} for this item` : "No PO is waiting for this item"}
                        </span>
                      </span>
                      <span className="flex-none">
                        <Badge label={hit.receivable ? hit.item.type : "Cannot receive"} tone={hit.receivable ? "brand" : "muted"} />
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <div className="rounded-card border border-dashed border-line px-3 py-4 text-center text-meta text-muted">
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
              <LinkButton className="text-meta" onClick={() => setStep("item")}>
                Change item
              </LinkButton>
            </div>
            <SectionLabel>Approved POs waiting for {picked.item}</SectionLabel>
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
                        {x.received > 0 ? <Badge label="Partly received" tone="muted" /> : null}
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
                      <Progress value={done} className="mt-2" />
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
                  <div className="flex items-center justify-between gap-2 rounded-t-card border-b border-divider bg-canvas px-3 py-2">
                    <span className="min-w-0 text-meta font-semibold text-ink">
                      {l.item} · against {x?.poNumber ?? l.po}
                    </span>
                    <span className="flex flex-none items-center gap-2">
                      {x ? (
                        <Badge label={`pending ${nf(x.pending)} ${x.unit}`} tone="brand" />
                      ) : null}
                      <LinkButton tone="danger" className="text-meta" onClick={() => removeLine(i)}>
                        Remove
                      </LinkButton>
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
              <div className="rounded-t-card border-b border-divider bg-canvas px-3 py-2 text-meta font-semibold text-ink">The delivery</div>
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
          </>
        ) : null}

        {step === "review" ? (
          <>
            {/* Read-only: it says back what was entered. A mistake is put right on its own step, which each Change goes back to. */}
            <GrnReview
              model={grnReview({ header: spec.header, line: spec.line ?? [], h, lines, data })}
              go={{
                items: () => setStep("item"),
                /* The PO belongs to the item's line: to pick another, remove the line on Receipt details and search the item again. */
                orders: () => setStep("lines"),
                lines: () => setStep("lines"),
                delivery: () => setStep("lines"),
              }}
            />
          </>
        ) : null}
        {step === "next" && next ? <WhatsNext next={next} /> : null}
      </DialogBody>

      {/* A refusal that names no box is said here, beside Save, where it cannot be scrolled out of sight. */}
      {topError ? (
        <div className="flex-none px-6 pt-3">
          <Callout tone="danger" className="mb-0">
            <span className="text-sm font-medium text-danger">{topError}</span>
          </Callout>
        </div>
      ) : null}

      <DialogFooter left={step === "next" ? "Same truck, more items?" : `Step ${stepNo} of ${STEPS.length}`}>
        {step === "next" ? (
          <>
            <Button variant="secondary" onClick={sameTruckAgain}>
              Add another item from this truck
            </Button>
            <Button variant="primary" onClick={() => onSaved(savedMsg)}>
              Done
            </Button>
          </>
        ) : null}
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
            <Button variant="primary" onClick={toReview}>
              Review
            </Button>
          </>
        ) : null}
        {step === "review" ? (
          <>
            <Button
              variant="secondary"
              onClick={() => {
                setTopError("");
                setStep("lines");
              }}
              disabled={busy}
            >
              Back
            </Button>
            <Button variant="primary" onClick={() => void submit()} disabled={busy}>
              {busy ? "Saving…" : spec.submit}
            </Button>
          </>
        ) : null}
      </DialogFooter>
    </ErpDialog>
  );
}

/* ---------------------------------------------------------------------------
 * STEP 5 · WHAT'S NEXT. The receipt is saved; each line says what is left to
 * do on it — its drum labels, its testing, its bill — as a button where it can
 * be done now, or what it waits for. Everything here is the save's own answer
 * (`whatsNext`, engines/goods-in.ts): the routing it did, the register rows it
 * made, and what this person may open. A button opens the real screen in a
 * new tab, so the other lines stay in front of them.
 * ------------------------------------------------------------------------- */

function WhatsNext({ next }: { next: GrnNext }) {
  const n = next.lines.length;
  return (
    <section className="grid gap-3">
      <div className="flex items-start gap-3 rounded-card border border-success/30 bg-success-soft px-4 py-3">
        <span aria-hidden className="mt-0.5 flex size-6 flex-none items-center justify-center rounded-full border-2 border-success text-success">
          <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
            <path d="M5 12l5 5 9-10" />
          </svg>
        </span>
        <span className="min-w-0">
          <span className="block text-sm font-semibold text-ink">
            PR {next.pr} saved · {n} line{n === 1 ? "" : "s"} from {next.supplier}
          </span>
          <span className="block text-meta text-body">
            Received at {next.godown}. {listWords(next.pos)} {next.pos.length === 1 ? "is" : "are"} updated.
          </span>
        </span>
      </div>
      <span className="text-meta font-medium text-muted">Finish each line now — or later from its own screen</span>
      {next.lines.map((l, i) => (
        <div key={`${l.item}:${i}`} className="min-w-0 overflow-hidden rounded-card border border-line">
          <div className="flex flex-wrap items-center gap-2.5 border-b border-divider px-4 py-2.5">
            <span className="text-sm font-semibold text-ink">{l.item}</span>
            <Badge label={l.type} tone={l.type === "Chemical" ? "brand" : "neutral"} />
            <span className="text-meta text-muted">{l.facts}</span>
          </div>
          <div className="grid grid-cols-3 divide-x divide-divider">
            <NextCell title="Drum labels" step={l.labels} />
            <NextCell title="Testing" step={l.testing} />
            <NextCell title="Bill" step={l.bill} />
          </div>
        </div>
      ))}
    </section>
  );
}

function listWords(xs: string[]): string {
  return xs.length <= 1 ? (xs[0] ?? "The PO") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`;
}

function NextCell({ title, step }: { title: string; step: NextStep }) {
  return (
    <div className="flex min-w-0 flex-col gap-2 px-4 py-3">
      <span className={eyebrowClass}>{title}</span>
      {step.kind === "print" || step.kind === "record" ? (
        <a
          href={step.href}
          target="_blank"
          rel="noopener"
          className={buttonClass({ variant: step.kind === "print" ? "primary" : "secondary", size: "sm", className: "self-start whitespace-nowrap" })}
        >
          {step.label}
        </a>
      ) : step.kind === "done" ? (
        <span className="rounded-control bg-success-soft px-2 py-1 text-meta font-medium text-success">✓ {step.label}</span>
      ) : step.kind === "waiting" ? (
        <span className={cx("rounded-control px-2 py-1 text-meta font-medium", step.tone === "warn" ? "bg-warn-soft text-warn" : "bg-canvas text-body")}>{step.label}</span>
      ) : (
        <span className="text-meta text-body">{step.label}</span>
      )}
    </div>
  );
}
