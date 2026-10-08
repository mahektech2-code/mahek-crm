"use client";

import { Fragment, createContext, useCallback, useContext, useState } from "react";
import { useRouter } from "next/navigation";
import { Button, cx } from "@/components/ui/primitives";
import { ConfirmDialog, Drawer, DrawerHeader, Modal } from "@/components/ui/overlays";
import { useToast } from "@/components/ui/toast";
import type { ActionSpec, BulkSpec, FieldSpec, FormSpec, PromptSpec, ToolResult, ToolSpec } from "@/lib/erp/ui";
import { resolveField, whenHolds } from "@/lib/erp/ui";
import { runCalc } from "@/lib/erp/calc";
import "@/lib/erp/calcs";
import type { Result } from "@/lib/result";
import { Field } from "./field";
import { LineTable } from "./line-table";
import { ErpVoice } from "./voice";
import { ERP_KIT, KitContext, useKit, type ScreenKit } from "./kit";

/* ---------------------------------------------------------------------------
 * The ERP's overlays, held once for the whole app: the form drawer, the prompt
 * dialog and the confirm dialog. Screens ask for them through `useErpUi()`.
 *
 * They are the CRM's overlays — `Drawer`, `Modal`, `ConfirmDialog` and the
 * shared toast — carrying the ERP's form specs. The ERP drew its own of each
 * once, in its own colours and at its own layer, and a confirmation that looks
 * different in two apps of one suite reads as two different kinds of question.
 * ------------------------------------------------------------------------- */

type Confirm = { msg: string; fn: () => void };
type PromptState = { spec: PromptSpec; done: (v: Record<string, string>) => Promise<Result<unknown> | void> };

type Ui = {
  toast: (t: string, tone?: "info" | "error") => void;
  confirm: (msg: string, fn: () => void) => void;
  prompt: (spec: PromptSpec, done: (v: Record<string, string>) => Promise<Result<unknown> | void>) => void;
  openForm: (spec: FormSpec) => void;
  /** Runs a record action: confirm → prompt/form → server → toast → refresh. */
  act: (screen: string, a: ActionSpec, recordId: string, after?: () => void) => void;
  bulk: (screen: string, b: BulkSpec, ids: string[], after?: () => void) => void;
  /** Runs a header tool: confirm → prompt → server → toast, and its dialog if it answered with one. */
  tool: (screen: string, t: ToolSpec) => void;
};

const Ctx = createContext<Ui | null>(null);

export function useErpUi(): Ui {
  const u = useContext(Ctx);
  if (!u) throw new Error("useErpUi outside ErpUiProvider");
  return u;
}

export function ErpUiProvider({
  children,
  voice = false,
  kit = ERP_KIT,
}: {
  children: React.ReactNode;
  voice?: boolean;
  /** The app whose server actions, uploads and vocabulary the screens use. The ERP's unless another app says so. */
  kit?: ScreenKit;
}) {
  const router = useRouter();
  const { push } = useToast();
  const [confirmState, setConfirmState] = useState<Confirm | null>(null);
  const [promptState, setPromptState] = useState<PromptState | null>(null);
  const [form, setForm] = useState<FormSpec | null>(null);
  const [formKey, setFormKey] = useState(0);
  const [resultDialog, setResultDialog] = useState<{ screen: string; d: NonNullable<ToolResult["dialog"]> } | null>(null);

  const toast = useCallback((t: string, tone: "info" | "error" = "info") => push(t, tone), [push]);

  const confirm = useCallback((msg: string, fn: () => void) => setConfirmState({ msg, fn }), []);
  const prompt = useCallback(
    (spec: PromptSpec, done: PromptState["done"]) => setPromptState({ spec, done }),
    [],
  );
  const openForm = useCallback((spec: FormSpec) => {
    setForm(spec);
    setFormKey((k) => k + 1);
  }, []);

  const finish = useCallback(
    (res: Result<unknown> | void, after?: () => void, screen?: string) => {
      if (!res) return;
      if (res.ok) {
        toast(res.message ?? "Saved");
        router.refresh();
        after?.();
        /* An action may answer like a tool does: "Send to vendor" hands back the PO written out. */
        const dialog = (res.data as ToolResult | undefined)?.dialog;
        if (dialog && screen) setResultDialog({ screen, d: dialog });
        /* …or send the person on: "Print labels" over a selection opens the sheet. */
        const navigate = (res.data as ToolResult | undefined)?.navigate;
        if (navigate) router.push(navigate);
      } else {
        toast(res.error, "error");
      }
    },
    [router, toast],
  );

  const act = useCallback(
    (screen: string, a: ActionSpec, recordId: string, after?: () => void) => {
      if (a.why) return;
      if (a.href) {
        router.push(a.href);
        return;
      }
      if (a.form) {
        openForm(a.form);
        return;
      }
      if (a.loadsForm) {
        void kit.loadForm(screen, a.id, recordId).then((res) => {
          if (res.ok) openForm(res.data);
          else toast(res.error, "error");
        });
        return;
      }
      const go = () => {
        if (a.prompt) {
          prompt(a.prompt, async (v) => {
            const res = await kit.runAction(screen, a.id, recordId, v);
            if (res.ok) finish(res, after, screen);
            return res;
          });
          return;
        }
        void kit.runAction(screen, a.id, recordId).then((res) => finish(res, after, screen));
      };
      if (a.confirm) confirm(a.confirm, go);
      else go();
    },
    [confirm, finish, kit, openForm, prompt, router, toast],
  );

  const bulk = useCallback(
    (screen: string, b: BulkSpec, ids: string[], after?: () => void) => {
      const go = () => {
        if (b.prompt) {
          prompt(b.prompt, async (v) => {
            const res = await kit.runBulk(screen, b.id, ids, v);
            if (res.ok) finish(res, after);
            return res;
          });
          return;
        }
        void kit.runBulk(screen, b.id, ids).then((res) => finish(res, after));
      };
      if (b.confirm) confirm(b.confirm, go);
      else go();
    },
    [confirm, finish, kit, prompt],
  );

  const tool = useCallback(
    (screen: string, t: ToolSpec) => {
      if (t.why) return;
      if (t.href) {
        router.push(t.href);
        return;
      }
      const run = kit.runTool;
      if (!run) return;
      const land = (res: Result<unknown>) => {
        if (!res.ok) {
          toast(res.error, "error");
          return;
        }
        const data = (res.data ?? {}) as ToolResult;
        if (res.message) toast(res.message);
        router.refresh();
        if (data.dialog) setResultDialog({ screen, d: data.dialog });
        if (data.navigate) router.push(data.navigate);
      };
      const go = () => {
        if (t.prompt) {
          prompt(t.prompt, async (v) => {
            const res = await run(screen, t.id, v);
            if (res.ok) land(res);
            return res;
          });
          return;
        }
        void run(screen, t.id).then(land);
      };
      if (t.confirm) confirm(t.confirm, go);
      else go();
    },
    [confirm, kit, prompt, router, toast],
  );

  return (
    <KitContext.Provider value={kit}>
    <ErpVoice.Provider value={voice}>
      <Ctx.Provider value={{ toast, confirm, prompt, openForm, act, bulk, tool }}>
        {children}
        {form ? (
          <FormDrawer
            key={formKey}
            spec={form}
            onClose={() => setForm(null)}
            onSaved={(msg) => {
              setForm(null);
              toast(msg);
              router.refresh();
            }}
            confirm={confirm}
          />
        ) : null}
        {promptState ? (
          <PromptDialog key={promptState.spec.title} state={promptState} onClose={() => setPromptState(null)} />
        ) : null}
        {resultDialog ? (
          <ResultDialog
            d={resultDialog.d}
            onClose={() => setResultDialog(null)}
            onNext={
              resultDialog.d.next && kit.runTool
                ? async () => {
                    const n = resultDialog.d.next!;
                    const res = await kit.runTool!(resultDialog.screen, n.tool, n.values ?? {});
                    setResultDialog(null);
                    if (res.ok) {
                      toast(res.message ?? "Done");
                      router.refresh();
                    } else toast(res.error, "error");
                  }
                : undefined
            }
          />
        ) : null}
        <ConfirmDialog
          open={!!confirmState}
          title="Please confirm"
          body={confirmState?.msg ?? ""}
          confirmLabel="Yes, go ahead"
          onConfirm={() => {
            const fn = confirmState?.fn;
            setConfirmState(null);
            fn?.();
          }}
          onClose={() => setConfirmState(null)}
        />
      </Ctx.Provider>
    </ErpVoice.Provider>
    </KitContext.Provider>
  );
}

/* ------------------------------------------------------------ validation */

function checkField(f: FieldSpec, v: string): string {
  if (f.t === "derived" || f.t === "suggest") return "";
  if (f.req && (v == null || v === "")) return `${f.l} is required`;
  if (v !== "" && f.t === "num") {
    const n = Number(v);
    if (!Number.isFinite(n)) return "INVALID";
    if (n < 0 && (f.min == null || f.min >= 0)) return "Minus Quantity Not Allowed";
    if (f.min != null && n < f.min) return "INVALID";
    if (f.max != null && n > f.max) return "INVALID";
  }
  return "";
}

function optsFor(f: FieldSpec, values: Record<string, string>): string[] | undefined {
  if (f.optsBy) {
    const by = Array.isArray(f.optsBy.by) ? f.optsBy.by : [f.optsBy.by];
    return f.optsBy.map[by.map((k) => values[k] ?? "").join("|")] ?? [];
  }
  return f.opts;
}

/* -------------------------------------------------------------- prompt */

function PromptDialog({ state, onClose }: { state: PromptState; onClose: () => void }) {
  const { spec } = state;
  const [v, setV] = useState<Record<string, string>>(() => {
    const init: Record<string, string> = {};
    spec.fields.forEach((f) => (init[f.k] = spec.init?.[f.k] ?? f.def ?? ""));
    return init;
  });
  const [errs, setErrs] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    const e: Record<string, string> = {};
    spec.fields.filter((f) => whenHolds(f.when, v)).forEach((f) => {
      const m = checkField(f, v[f.k] ?? "");
      if (m) e[f.k] = m;
    });
    setErrs(e);
    if (Object.keys(e).length) return;
    setBusy(true);
    const res = await state.done(v);
    setBusy(false);
    if (res && !res.ok) {
      const fe: Record<string, string> = {};
      res.fieldErrors?.forEach((x) => (fe[x.field] = x.message));
      if (Object.keys(fe).length) return setErrs(fe);
      return;
    }
    onClose();
  };
  return (
    <Modal
      open
      onClose={onClose}
      width={480}
      title={
        <>
          {spec.title}
          {spec.sub ? <span className="mt-0.5 block text-[13px] font-normal text-muted">{spec.sub}</span> : null}
        </>
      }
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={submit} disabled={busy}>
            {busy ? "Saving…" : spec.submit}
          </Button>
        </>
      }
    >
      <div className="grid gap-3.5">
        {spec.fields
          .filter((f) => whenHolds(f.when, v))
          .map((f) => (
            <Field
              key={f.k}
              f={f}
              value={v[f.k] ?? ""}
              error={errs[f.k]}
              options={optsFor(f, v)}
              onChange={(x) => {
                setV((s) => ({ ...s, [f.k]: x }));
                setErrs((s) => ({ ...s, [f.k]: "" }));
              }}
            />
          ))}
      </div>
    </Modal>
  );
}

/* ---------------------------------------------------------------- form */

function FormDrawer({
  spec,
  onClose,
  onSaved,
  confirm,
}: {
  spec: FormSpec;
  onClose: () => void;
  onSaved: (msg: string) => void;
  confirm: (msg: string, fn: () => void) => void;
}) {
  const [h, setH] = useState<Record<string, string>>(() => {
    /* Every init key travels, not only the drawn ones: "ADD More" carries the
       document's number (prFixed, sfgFixed, orderFixed…) as a value the form
       never draws, and dropping it would start a new document instead. */
    const init: Record<string, string> = { ...(spec.init ?? {}) };
    spec.header.forEach((f) => (init[f.k] = spec.init?.[f.k] ?? f.def ?? ""));
    return init;
  });
  const blankLine = () => {
    const l: Record<string, string> = {};
    (spec.line ?? []).forEach((f) => (l[f.k] = f.def ?? ""));
    return l;
  };
  const table = spec.lineLayout === "table";
  /* A table starts empty — its lines arrive from the search or a paste — and a card layout starts with one blank card. */
  const [lines, setLines] = useState<Record<string, string>[]>(() =>
    spec.line ? (spec.initLines?.length ? spec.initLines.map((l) => ({ ...blankLine(), ...l })) : table ? [] : [blankLine()]) : [],
  );
  const [errs, setErrs] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [topError, setTopError] = useState("");
  const data = spec.data ?? {};

  /* A line's `fillBy` fields, refreshed after `changed` moved — header or line. */
  const fillLine = (l: Record<string, string>, hdr: Record<string, string>, changed: string) => {
    let out = l;
    for (const f of spec.line ?? []) {
      if (!f.fillBy || !f.fillBy.by.includes(changed)) continue;
      const v = f.fillBy.map[f.fillBy.by.map((k) => ({ ...hdr, ...out })[k] ?? "").join("|")];
      if (v != null) out = { ...out, [f.k]: v };
    }
    return out;
  };

  const visible = (f: FieldSpec, l: Record<string, string> = {}) => whenHolds(f.when, { ...h, ...l }, data);
  const resolved = (f: FieldSpec, l: Record<string, string> = {}) => resolveField(f, { ...h, ...l }, data);

  const current = lines;
  const submit = () => {
    /* A table row nobody filled in is not a line: it is dropped before anything is checked, so the errors name the rows that are left. */
    const lines = table
      ? current.filter((l) => (spec.line ?? []).some((f) => f.t !== "derived" && (l[f.k] ?? "") !== "" && (l[f.k] ?? "") !== (f.def ?? "")))
      : current;
    if (lines.length !== current.length) setLines(lines);
    const e: Record<string, string> = {};
    spec.header.filter((f) => visible(f)).map((f) => resolved(f)).forEach((f) => {
      const m = checkField(f, h[f.k] ?? "");
      if (m) e[`h.${f.k}`] = m;
    });
    lines.forEach((l, i) =>
      (spec.line ?? []).filter((f) => visible(f, l)).map((f) => resolved(f, l)).forEach((f) => {
        const m = checkField(f, l[f.k] ?? "");
        if (m) e[`l${i}.${f.k}`] = m;
      }),
    );
    setErrs(e);
    if (Object.keys(e).length) return;
    const save = async () => {
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
    if (spec.confirm) {
      const msg = spec.confirm.replace(/\{(\w+)\}/g, (_, k: string) => h[k] ?? "");
      confirm(msg, () => void save());
    } else void save();
  };

  const kit = useKit();
  const summary = runCalc(`${spec.screen}.summary`, { h, l: {}, lines, i: -1, data });

  return (
    <Drawer open onClose={onClose} width={table ? 1040 : 680} label={spec.title}>
      <DrawerHeader onClose={onClose}>
        <div className="text-lg leading-6 font-semibold text-ink">{spec.title}</div>
        {spec.sub ? <div className="mt-0.5 text-[13px] text-muted">{spec.sub}</div> : null}
      </DrawerHeader>
      <div className="grid min-h-0 flex-1 auto-rows-max content-start gap-3.5 overflow-y-auto px-5 py-4">
        {spec.evidence ? <Evidence e={spec.evidence} /> : null}
        <Block title={spec.line ? (table ? "Details" : "Header") : ""}>
          {spec.header
            .filter((f) => visible(f))
            .map((f) => resolved(f))
            .map((f, i, shown) => (
              <Fragment key={f.k}>
              {f.sec && f.sec !== shown[i - 1]?.sec ? (
                <div className="col-span-full mt-1 border-b border-divider pb-1 text-[12px] font-semibold tracking-[0.04em] text-muted uppercase">{f.sec}</div>
              ) : null}
              <Field
                f={f}
                value={h[f.k] ?? ""}
                error={errs[`h.${f.k}`]}
                options={optsFor(f, h)}
                derived={f.t === "derived" || f.t === "suggest" ? runCalc(f.calc, { h, l: {}, lines, i: -1, data }) : undefined}
                onUseSuggestion={(v) => {
                  const target = f.k.replace(/^ai/, "").replace(/^./, (c) => c.toLowerCase());
                  setH((s) => ({ ...s, [target]: v }));
                }}
                onChange={(v) => {
                  let nh = { ...h, [f.k]: v };
                  /* A header field filled from another (a PO item fills the item it names). */
                  for (const g of spec.header) {
                    if (!g.fillBy || !g.fillBy.by.includes(f.k)) continue;
                    const x = g.fillBy.map[g.fillBy.by.map((k) => nh[k] ?? "").join("|")];
                    if (x != null) nh = { ...nh, [g.k]: x };
                  }
                  setH(nh);
                  if (spec.line?.some((x) => x.fillBy?.by.includes(f.k))) setLines((s) => s.map((x) => fillLine(x, nh, f.k)));
                  setErrs((s) => ({ ...s, [`h.${f.k}`]: "" }));
                }}
              />
              </Fragment>
            ))}
        </Block>
        {spec.line && table ? (
          <LineTable
            spec={spec}
            h={h}
            lines={lines}
            setLines={setLines}
            errs={errs}
            clearErr={(k) => setErrs((s) => ({ ...s, [k]: "" }))}
            options={optsFor}
          />
        ) : null}
        {spec.line && !table
          ? lines.map((l, i) => (
              <Block
                key={i}
                title={`${spec.lineLabel ?? "Line"} ${i + 1} of ${lines.length}`}
                onRemove={lines.length > 1 ? () => setLines((s) => s.filter((_, j) => j !== i)) : undefined}
              >
                {spec.line!
                  .filter((f) => visible(f, l))
                  .map((f) => resolved(f, l))
                  .map((f) => (
                    <Field
                      key={f.k}
                      f={f}
                      value={l[f.k] ?? ""}
                      error={errs[`l${i}.${f.k}`]}
                      options={optsFor(f, { ...h, ...l })}
                      derived={f.t === "derived" ? runCalc(f.calc, { h, l, lines, i, data }) : undefined}
                      onChange={(v) => {
                        setLines((s) => s.map((x, j) => (j === i ? fillLine({ ...x, [f.k]: v }, h, f.k) : x)));
                        setErrs((s) => ({ ...s, [`l${i}.${f.k}`]: "" }));
                      }}
                    />
                  ))}
              </Block>
            ))
          : null}
        {spec.line && !table ? (
          <div className="flex flex-wrap items-center gap-3">
            <Button variant="secondary" onClick={() => setLines((s) => [...s, blankLine()])} className="border-dashed text-[#5223E0]">
              + Add more {(spec.lineLabel ?? "line").toLowerCase()}
            </Button>
            <span className="text-xs text-muted">
              Each new line keeps the header:{" "}
              {spec.header
                .filter((f) => f.t !== "derived")
                .slice(0, 3)
                .map((f) => f.l.toLowerCase())
                .join(", ")}
              .
            </span>
          </div>
        ) : null}
        {summary ? <FormSummary text={summary} /> : null}
        {topError ? (
          <div className="rounded-[4px] border border-danger-soft border-l-[3px] border-l-danger bg-danger-soft px-4 py-2.5 text-sm font-medium text-danger">
            {topError}
          </div>
        ) : null}
      </div>
      <div className="flex flex-none justify-end gap-2.5 border-t border-divider px-5 py-3">
        <Button variant="secondary" onClick={onClose}>
          Cancel
        </Button>
        <Button variant="primary" onClick={submit} disabled={busy}>
          {busy ? "Saving…" : spec.submit}
        </Button>
      </div>
    </Drawer>
  );
}

/** What an AI reading was read from — the photographs and words — and what the checks found, beside the proposed values. */
function Evidence({ e }: { e: NonNullable<FormSpec["evidence"]> }) {
  const tone: Record<string, string> = {
    danger: "bg-danger-soft text-danger",
    warn: "bg-warn-soft text-warn-ink",
    success: "bg-success-soft text-success",
    info: "bg-brand-soft text-[#5223E0]",
    brand: "bg-brand-soft text-[#5223E0]",
    neutral: "bg-canvas text-body",
    muted: "bg-canvas text-muted",
  };
  return (
    <section className="grid gap-2.5 rounded-[6px] border border-brand-softer border-l-[3px] border-l-brand bg-brand-soft/40 p-3">
      <span className="text-xs font-medium tracking-[0.04em] text-[#5223E0] uppercase">Read by AI · check it against the source</span>
      {e.images?.length ? (
        <div className="flex gap-2 overflow-x-auto">
          {e.images.map((id) => (
            <a key={id} href={`/api/attachments/${id}`} target="_blank" rel="noreferrer" className="flex-none">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={`/api/attachments/${id}`} alt="Source" className="h-40 max-w-[260px] rounded-[4px] border border-divider bg-surface object-contain" />
            </a>
          ))}
        </div>
      ) : null}
      {e.text ? (
        <blockquote className="m-0 rounded-[4px] border border-divider bg-surface px-2.5 py-2 text-[13px] whitespace-pre-wrap text-body">{e.text}</blockquote>
      ) : null}
      {e.flags?.map((f, i) => (
        <span key={i} className={cx("rounded-[4px] px-2.5 py-1.5 text-[13px]", tone[f.tone] ?? tone.neutral)}>
          {f.text}
        </span>
      ))}
      {e.note ? <span className="text-xs text-muted">{e.note}</span> : null}
    </section>
  );
}

/** A summary line under a form: "ok:…" draws success, "warn:…" draws a warning. */
function FormSummary({ text }: { text: string }) {
  const warn = text.startsWith("warn:");
  const body = text.replace(/^(ok|warn):/, "");
  return (
    <div
      className={cx(
        "rounded-[4px] border border-l-[3px] px-4 py-2.5 text-sm font-medium",
        warn ? "border-warn-line border-l-warn bg-warn-soft text-warn-ink" : "border-success-soft border-l-success bg-success-soft text-success",
      )}
    >
      {body}
    </div>
  );
}

function Block({ title, onRemove, children }: { title: string; onRemove?: () => void; children: React.ReactNode }) {
  return (
    <div className="min-w-0 rounded-[6px] border border-line">
      {title ? (
        <div className="flex items-center justify-between rounded-t-[6px] border-b border-divider bg-canvas px-3 py-2">
          <span className="text-[13px] font-semibold text-ink">{title}</span>
          {onRemove ? (
            <button onClick={onRemove} className="h-6 cursor-pointer px-2 text-[13px] text-danger hover:underline">
              Remove line
            </button>
          ) : null}
        </div>
      ) : null}
      <div className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-3.5 px-3 py-3.5">{children}</div>
    </div>
  );
}

/** What a header tool answered with: a message to send, a preview to confirm. */
function ResultDialog({ d, onClose, onNext }: { d: NonNullable<ToolResult["dialog"]>; onClose: () => void; onNext?: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const tone: Record<string, string> = {
    danger: "bg-danger-soft text-danger",
    warn: "bg-warn-soft text-warn-ink",
    success: "bg-success-soft text-success",
    info: "bg-brand-soft text-[#5223E0]",
    brand: "bg-brand-soft text-[#5223E0]",
  };
  return (
    <Modal
      open
      onClose={onClose}
      width={560}
      title={
        <>
          {d.title}
          {d.sub ? <span className="mt-0.5 block text-[13px] font-normal text-muted">{d.sub}</span> : null}
        </>
      }
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Close
          </Button>
          {d.copy && d.text ? (
            <Button
              variant="secondary"
              onClick={() => {
                void navigator.clipboard?.writeText(d.text ?? "").then(() => setCopied(true));
              }}
            >
              {copied ? "Copied" : "Copy"}
            </Button>
          ) : null}
          {d.open ? (
            <a href={d.open.href} target="_blank" rel="noreferrer" onClick={onClose}>
              <Button variant="primary">{d.open.label}</Button>
            </a>
          ) : null}
          {d.next && onNext ? (
            <Button
              variant="primary"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                await onNext();
                setBusy(false);
              }}
            >
              {busy ? "Working…" : d.next.label}
            </Button>
          ) : null}
        </>
      }
    >
      {d.text ? <pre className="m-0 max-h-[50vh] overflow-y-auto rounded-[6px] bg-canvas p-3 text-[13px] leading-5 whitespace-pre-wrap text-ink">{d.text}</pre> : null}
      {d.lines?.length ? (
        <div className="max-h-[50vh] overflow-y-auto rounded-[6px] border border-line">
          {d.lines.map((l, i) => (
            <div key={i} className={cx("border-b border-divider px-3 py-2 text-[13px] last:border-0", l.tone ? tone[l.tone] : "text-body")}>
              {l.text}
            </div>
          ))}
        </div>
      ) : null}
    </Modal>
  );
}
