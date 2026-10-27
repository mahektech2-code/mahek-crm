"use client";

import { resultError } from "./use-act";
import { Fragment, createContext, useCallback, useContext, useState } from "react";
import { useRouter } from "next/navigation";
import { Button, Callout, cx, SectionLabel, Td, Th, Tr, buttonClass } from "@/components/ui/primitives";
import { labelClass, LinkButton } from "./look";
import { ConfirmDialog, Modal } from "@/components/ui/overlays";
import { DialogBody, DialogTitle, DialogFooter, DialogHeader, ErpDialog, StepBar } from "./dialog";
import { pageOfError, planPages, plural } from "./form-pages";
import { useToast } from "@/components/ui/toast";
import type { ActionSpec, BulkSpec, FieldSpec, FormSpec, PromptSpec, ToolResult, ToolSpec } from "@/lib/erp/ui";
import { fillOf, resolveField, whenHolds } from "@/lib/erp/ui";
import { runCalc } from "@/lib/erp/calc";
import "@/lib/erp/calcs";
import type { Result } from "@/lib/result";
import { Field, PhotoTile } from "./field";
import { checkField, optsFor } from "./form-check";
import { GrnDialog } from "./grn-dialog";
import { ShareDialog } from "./share-dialog";
import { CardGrid } from "@/components/ui/card-grid";
import { LineTable } from "./line-table";
import { ErpVoice } from "./voice";
import { ERP_KIT, KitContext, safeKit, useKit, type ScreenKit } from "./kit";

/* ---------------------------------------------------------------------------
 * The ERP's overlays, held once for the whole app: the form dialog, the prompt
 * dialog and the confirm dialog. Screens ask for them through `useErpUi()`.
 *
 * The prompt, the confirm and the toast are the CRM's own (`Modal`,
 * `ConfirmDialog`), because a confirmation that looks different in two apps of
 * one suite reads as two different kinds of question. The form is the ERP's
 * `ErpDialog` — a wide dialog of pages (`form-pages.ts`) — because an ERP
 * document runs to twenty fields and a line table, which no side drawer held.
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
  kit: rawKit = ERP_KIT,
}: {
  children: React.ReactNode;
  voice?: boolean;
  /** The app whose server actions, uploads and vocabulary the screens use. The ERP's unless another app says so. */
  kit?: ScreenKit;
}) {
  // The provider calls its kit directly too, so it gets the throw-safe one.
  const kit = safeKit(rawKit);
  const router = useRouter();
  const { push } = useToast();
  const [confirmState, setConfirmState] = useState<Confirm | null>(null);
  const [promptState, setPromptState] = useState<PromptState | null>(null);
  const [form, setForm] = useState<FormSpec | null>(null);
  const [formKey, setFormKey] = useState(0);
  const [resultDialog, setResultDialog] = useState<{ screen: string; d: NonNullable<ToolResult["dialog"]> } | null>(null);
  const [share, setShare] = useState<{ screen: string; a: ActionSpec; recordId: string; after?: () => void; key: number } | null>(null);

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
        toast(resultError(res), "error");
      }
    },
    [router, toast],
  );

  const act = useCallback(
    (screen: string, a: ActionSpec, recordId: string, after?: () => void) => {
      if (a.why) return;
      if (a.share) {
        setShare({ screen, a, recordId, after, key: Date.now() });
        return;
      }
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
        {form?.flow === "grn" ? (
          <GrnDialog
            key={formKey}
            spec={form}
            onClose={() => setForm(null)}
            onSaved={(msg) => {
              setForm(null);
              toast(msg);
              router.refresh();
            }}
          />
        ) : form ? (
          <FormDialog
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
        {share?.a.share ? (
          <ShareDialog
            key={share.key}
            screen={share.screen}
            actionId={share.a.id}
            recordId={share.recordId}
            spec={share.a.share}
            onClose={() => setShare(null)}
            onDone={(msg) => {
              toast(msg);
              router.refresh();
              share.after?.();
            }}
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
      width={spec.fields.some((f) => f.tile) ? 600 : 480}
      title={
        <>
          {spec.title}
          {spec.sub ? <span className="mt-0.5 block text-meta font-normal text-muted">{spec.sub}</span> : null}
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
        {promptRuns(spec.fields.filter((f) => whenHolds(f.when, v))).map((run) => {
          const field = (f: FieldSpec) => {
            const onChange = (x: string) => {
              setV((s) => ({ ...s, [f.k]: x }));
              setErrs((s) => ({ ...s, [f.k]: "" }));
            };
            return f.tile ? (
              <PhotoTile key={f.k} f={f} value={v[f.k] ?? ""} error={errs[f.k]} onChange={onChange} />
            ) : (
              <Field key={f.k} f={f} value={v[f.k] ?? ""} error={errs[f.k]} options={optsFor(f, v)} onChange={onChange} />
            );
          };
          return (
            <section key={run.fields[0].k} className="grid gap-2">
              {run.heading ? <SectionLabel>{run.heading}</SectionLabel> : null}
              {run.kind === "one" ? (
                field(run.fields[0])
              ) : run.kind === "tiles" ? (
                /* auto-fill, not a CardGrid's auto-fit: two tiles stay tile-sized rather than stretching across the dialog. */
                <div className="grid grid-cols-[repeat(auto-fill,minmax(112px,1fr))] gap-2.5">{run.fields.map(field)}</div>
              ) : (
                <CardGrid min={130} gap="gap-x-3 gap-y-2.5">
                  {run.fields.map(field)}
                </CardGrid>
              )}
            </section>
          );
        })}
      </div>
    </Modal>
  );
}

/**
 * A prompt's fields in runs: tiles beside each other in one grid, inline
 * fields sharing a row, everything else one to a row. A run starts where the
 * kind or the section changes, and carries the section's heading the first
 * time it is reached.
 */
type PromptRun = { heading?: string; kind: "tiles" | "inline" | "one"; fields: FieldSpec[] };
function promptRuns(fields: FieldSpec[]): PromptRun[] {
  const runs: PromptRun[] = [];
  let lastSec: string | undefined;
  for (const f of fields) {
    const kind: PromptRun["kind"] = f.tile ? "tiles" : f.inline ? "inline" : "one";
    const prev = runs.at(-1);
    const newSec = f.sec !== lastSec;
    if (prev && !newSec && kind !== "one" && prev.kind === kind) prev.fields.push(f);
    else runs.push({ heading: newSec && f.sec?.toLowerCase() !== f.l.toLowerCase() ? f.sec : undefined, kind, fields: [f] });
    lastSec = f.sec;
  }
  return runs;
}

/* ---------------------------------------------------------------- form */

/*
 * A form is a dialog of PAGES (`form-pages.ts`): a short form is one page, a
 * long one is cut at its sections, a document's lines are a page of their
 * own, and a form of several pages ends on Review, which says back what will
 * be saved before Save is pressed. Next checks the page you are on; Save
 * checks everything and, where a field is wrong — in the browser or on the
 * server — goes back to the page it is on, so an error is never on a page
 * nobody is looking at.
 */
function FormDialog({
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
  const [page, setPage] = useState(0);
  const [reached, setReached] = useState(0);
  /* The lines a `linesFrom` pick (or the opening recipe) laid out, so a later pick knows whether anybody has touched them. */
  const [laidOut, setLaidOut] = useState<string | null>(() => (spec.initLines?.length ? JSON.stringify(spec.initLines.map((l) => ({ ...blankLine(), ...l }))) : null));
  const data = spec.data ?? {};
  const kit = useKit();

  /* A line's `fillBy` fields, refreshed after `changed` moved — header or line. */
  const fillLine = (l: Record<string, string>, hdr: Record<string, string>, changed: string) => {
    let out = l;
    for (const f of spec.line ?? []) {
      if (!f.fillBy || !f.fillBy.by.includes(changed)) continue;
      const v = fillOf(f, { ...hdr, ...out });
      if (v != null) out = { ...out, [f.k]: v };
    }
    return out;
  };

  const visible = (f: FieldSpec, l: Record<string, string> = {}) => whenHolds(f.when, { ...h, ...l }, data);
  const resolved = (f: FieldSpec, l: Record<string, string> = {}) => resolveField(f, { ...h, ...l }, data);

  const shownHeader = spec.header.filter((f) => visible(f)).map((f) => resolved(f));
  const pages = planPages(shownHeader, { lines: spec.line ? spec.lineLabel ?? "Line" : null });
  const at = Math.min(page, pages.length - 1);
  const current = pages[at];
  const last = at === pages.length - 1;

  /* A table row nobody filled in is not a line: it is dropped before anything is checked, so the errors name the rows that are left. */
  const filledLines = () =>
    table ? lines.filter((l) => (spec.line ?? []).some((f) => f.t !== "derived" && (l[f.k] ?? "") !== "" && (l[f.k] ?? "") !== (f.def ?? ""))) : lines;

  const checkHeader = (keys?: string[]) => {
    const e: Record<string, string> = {};
    shownHeader
      .filter((f) => !keys || keys.includes(f.k))
      .forEach((f) => {
        const m = checkField(f, h[f.k] ?? "");
        if (m) e[`h.${f.k}`] = m;
      });
    return e;
  };
  const checkLines = (ls: Record<string, string>[]) => {
    const e: Record<string, string> = {};
    ls.forEach((l, i) =>
      (spec.line ?? []).filter((f) => visible(f, l)).map((f) => resolved(f, l)).forEach((f) => {
        const m = checkField(f, l[f.k] ?? "");
        if (m) e[`l${i}.${f.k}`] = m;
      }),
    );
    return e;
  };

  const go = (i: number) => {
    setPage(i);
    setReached((r) => Math.max(r, i));
  };
  /** Shows the errors and goes to the first page carrying one. */
  const land = (e: Record<string, string>) => {
    setErrs(e);
    const first = Object.keys(e)
      .map((k) => pageOfError(pages, k))
      .filter((i) => i >= 0)
      .sort((a, b) => a - b)[0];
    if (first != null) setPage(first);
  };

  const next = () => {
    let e: Record<string, string> = {};
    if (current.kind === "fields") e = checkHeader(current.keys);
    if (current.kind === "lines") {
      const ls = filledLines();
      if (ls.length !== lines.length) setLines(ls);
      e = checkLines(ls);
    }
    setErrs((s) => ({ ...s, ...e }));
    if (Object.keys(e).length) return;
    go(at + 1);
  };

  const submit = () => {
    const ls = filledLines();
    if (ls.length !== lines.length) setLines(ls);
    const e = { ...checkHeader(), ...checkLines(ls) };
    if (Object.keys(e).length) return land(e);
    setErrs({});
    const save = async () => {
      setBusy(true);
      setTopError("");
      const res = await kit.submitForm(spec.screen, spec.id, h, ls, spec.recordId);
      setBusy(false);
      if (res.ok) return onSaved(res.message ?? "Saved");
      const fe: Record<string, string> = {};
      res.fieldErrors?.forEach((x) => {
        const key = /^l\d+\./.test(x.field) || x.field.startsWith("h.") ? x.field : `h.${x.field}`;
        fe[key] = x.message;
      });
      if (Object.keys(fe).length) land(fe);
      else setTopError(res.error);
    };
    if (spec.confirm) {
      const msg = spec.confirm.replace(/\{(\w+)\}/g, (_, k: string) => h[k] ?? "");
      confirm(msg, () => void save());
    } else void save();
  };

  const summary = runCalc(`${spec.screen}.summary`, { h, l: {}, lines, i: -1, data });
  const errored = new Set(Object.entries(errs).filter(([, m]) => m).map(([k]) => pageOfError(pages, k)).filter((i) => i >= 0));

  const headerField = (f: FieldSpec, i: number, shown: FieldSpec[], drawSec: boolean) => (
    <Fragment key={f.k}>
      {/* A section named after its own first field ("Purchase rule" over
          "Purchase rule") says the word twice: the field alone does. A page
          named after its one section has the heading on the step already. */}
      {drawSec && f.sec && f.sec !== shown[i - 1]?.sec && !(f.sec.toLowerCase() === f.l.toLowerCase() && shown[i + 1]?.sec !== f.sec) ? (
        <SectionLabel className="col-span-full mt-1 border-b border-divider pb-1">{f.sec}</SectionLabel>
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
          /* A header field filled from another (a PO item fills the item it
             names). It moves too, so the lines reading it refill: the billing
             party fills its price list, and the list fills each line's rate. */
          const moved = [f.k];
          for (const g of spec.header) {
            if (!g.fillBy || !g.fillBy.by.includes(f.k)) continue;
            const x = fillOf(g, nh);
            if (x != null) {
              nh = { ...nh, [g.k]: x };
              moved.push(g.k);
            }
          }
          /* A pick that brings its own lines (an SFG product its recipe). */
          const from = spec.linesFrom?.by === f.k ? spec.linesFrom.map[v] : undefined;
          if (from?.length) {
            for (const [k, x] of Object.entries(spec.linesFrom!.set ?? {})) if (!nh[k]) nh = { ...nh, [k]: x };
            const nextLines = from.map((l) => ({ ...blankLine(), ...l }));
            const blank = JSON.stringify(blankLine());
            const untouched = lines.every((l) => JSON.stringify(l) === blank) || JSON.stringify(lines) === laidOut;
            const lay = () => {
              setLines(nextLines);
              setLaidOut(JSON.stringify(nextLines));
            };
            if (untouched) lay();
            else confirm(`Replace these lines with ${v}'s ${from.length === 1 ? "line" : `${from.length} lines`}? What you have entered on them is cleared.`, lay);
          }
          setH(nh);
          if (!from?.length && spec.line?.some((x) => x.fillBy?.by.some((k) => moved.includes(k)))) setLines((s) => s.map((x) => moved.reduce((l, k) => fillLine(l, nh, k), x)));
          setErrs((s) => ({ ...s, [`h.${f.k}`]: "" }));
        }}
      />
    </Fragment>
  );

  const fieldsPage = (keys: string[], titled: boolean) => {
    const shown = shownHeader.filter((f) => keys.includes(f.k));
    /* One section on the page: the step already names it. */
    const secs = new Set(shown.map((f) => f.sec).filter(Boolean));
    return <Block title="">{shown.map((f, i) => headerField(f, i, shown, !titled || secs.size > 1))}</Block>;
  };

  const linesPage = (
    <>
      {table ? (
        <LineTable
          spec={spec}
          h={h}
          lines={lines}
          setLines={setLines}
          errs={errs}
          clearErr={(k) => setErrs((s) => ({ ...s, [k]: "" }))}
          options={optsFor}
        />
      ) : (
        lines.map((l, i) => (
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
      )}
      {!table ? (
        <div className="flex flex-wrap items-center gap-3">
          <Button variant="secondary" onClick={() => setLines((s) => [...s, blankLine()])} className="border-dashed text-brand-hover">
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
    </>
  );

  /** What will be saved, page by page — each heading goes back to its page. */
  const review = (
    <div className="grid gap-3">
      {pages.map((p, pi) => {
        if (p.kind === "review") return null;
        return (
          <section key={pi} className="rounded-card border border-line">
            <div className="flex items-center justify-between border-b border-divider bg-canvas px-4 py-2">
              <span className="text-meta font-semibold text-ink">{p.title || "Details"}</span>
              <LinkButton onClick={() => setPage(pi)} className="text-meta">
                Change
              </LinkButton>
            </div>
            {p.kind === "fields" ? (
              <dl className="grid grid-cols-[repeat(auto-fill,minmax(200px,1fr))] gap-x-6 gap-y-3 px-4 py-3">
                {shownHeader
                  .filter((f) => p.keys.includes(f.k))
                  .map((f) => {
                    const shown = reviewValue(f, f.t === "derived" || f.t === "suggest" ? runCalc(f.calc, { h, l: {}, lines, i: -1, data }) ?? "" : h[f.k] ?? "");
                    return (
                      <div key={f.k} className="min-w-0">
                        <dt className={labelClass}>{f.l}</dt>
                        <dd className={cx("mt-0.5 text-sm break-words", shown ? "text-ink" : "text-line-strong")}>{shown || "—"}</dd>
                      </div>
                    );
                  })}
              </dl>
            ) : (
              <ReviewLines spec={spec} lines={filledLines()} h={h} data={data} />
            )}
          </section>
        );
      })}
    </div>
  );

  const width = spec.evidence ? 1180 : table ? 1080 : spec.line ? 920 : 760;

  return (
    <ErpDialog onClose={onClose} label={spec.title} width={width} tall={pages.length > 1 || !!spec.line || !!spec.evidence}>
      <DialogHeader onClose={onClose}>
        <DialogTitle>{spec.title}</DialogTitle>
        {spec.sub ? <div className="mt-0.5 text-meta text-muted">{spec.sub}</div> : null}
      </DialogHeader>
      {pages.length > 1 ? <StepBar steps={pages.map((p) => p.title || "Details")} active={at} reached={reached} errored={errored} onChange={setPage} /> : null}
      <div className={cx("flex min-h-0 flex-1", spec.evidence && "divide-x divide-divider")}>
        {/* What an AI reading was read from stays in view on every page, beside the values it proposed. */}
        {spec.evidence ? (
          <aside className="w-[380px] flex-none overflow-y-auto p-4">
            <Evidence e={spec.evidence} />
          </aside>
        ) : null}
        <DialogBody>
          {current.kind === "fields" ? fieldsPage(current.keys, pages.length > 1) : null}
          {current.kind === "lines" ? linesPage : null}
          {current.kind === "review" ? review : null}
          {last && summary ? <FormSummary text={summary} /> : null}
          {topError ? (
            <Callout tone="danger" className="mb-0 text-sm font-medium text-danger">
              {topError}
            </Callout>
          ) : null}
        </DialogBody>
      </div>
      <DialogFooter left={pages.length > 1 ? `Step ${at + 1} of ${pages.length}` : null}>
        {at === 0 ? (
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
        ) : (
          <Button variant="secondary" onClick={() => setPage(at - 1)}>
            Back
          </Button>
        )}
        {last ? (
          <Button variant="primary" onClick={submit} disabled={busy}>
            {busy ? "Saving…" : spec.submit}
          </Button>
        ) : (
          <Button variant="primary" onClick={next}>
            Next
          </Button>
        )}
      </DialogFooter>
    </ErpDialog>
  );
}

/** A value as the review says it back: a photo is "Attached", a list is commas. */
function reviewValue(f: FieldSpec, v: string): string {
  if (!v) return "";
  if (f.t === "photo" || f.t === "video") return "Attached";
  if (f.t === "csv") return "File read";
  if (f.t === "multi") return v.split("|").filter(Boolean).join(", ");
  return v;
}

/** The lines on the review: the fields somebody fills in, a row each. */
function ReviewLines({ spec, lines, h, data }: { spec: FormSpec; lines: Record<string, string>[]; h: Record<string, string>; data: Record<string, unknown> }) {
  if (!lines.length) return <div className="px-4 py-3 text-meta text-muted">No {(spec.lineLabel ?? "line").toLowerCase()}s yet.</div>;
  const cols = (spec.line ?? []).filter((f) => f.t !== "photo" && f.t !== "video" && f.t !== "area").slice(0, 6);
  return (
    <div className="overflow-x-auto">
      <table className="w-full">
        <thead>
          <tr>
            <Th className="px-4">#</Th>
            {cols.map((c) => (
              <Th key={c.k}>
                {c.l}
              </Th>
            ))}
          </tr>
        </thead>
        <tbody>
          {lines.map((l, i) => (
            <Tr key={i}>
              <Td className="px-4 text-meta text-muted tabular-nums">{i + 1}</Td>
              {cols.map((c) => (
                <Td key={c.k} className="text-meta text-ink tabular-nums">
                  {(c.t === "derived" ? runCalc(c.calc, { h, l, lines, i, data }) : l[c.k]) || "—"}
                </Td>
              ))}
            </Tr>
          ))}
        </tbody>
      </table>
      <div className="border-t border-divider px-4 py-2 text-xs text-muted">
        {lines.length} {lines.length === 1 ? (spec.lineLabel ?? "line").toLowerCase() : plural((spec.lineLabel ?? "line").toLowerCase())}
      </div>
    </div>
  );
}

/** What an AI reading was read from — the photographs and words — and what the checks found, beside the proposed values. */
function Evidence({ e }: { e: NonNullable<FormSpec["evidence"]> }) {
  const tone: Record<string, string> = {
    danger: "bg-danger-soft text-danger",
    warn: "bg-warn-soft text-warn-ink",
    success: "bg-success-soft text-success",
    info: "bg-brand-soft text-brand-hover",
    brand: "bg-brand-soft text-brand-hover",
    neutral: "bg-canvas text-body",
    muted: "bg-canvas text-muted",
  };
  return (
    <section className="grid gap-2.5 rounded-card border border-brand-softer border-l-[3px] border-l-brand bg-brand-soft/40 p-3">
      <SectionLabel>Read by AI · check it against the source</SectionLabel>
      {e.images?.length ? (
        <div className="flex gap-2 overflow-x-auto">
          {e.images.map((id) => (
            <a key={id} href={`/api/attachments/${id}`} target="_blank" rel="noreferrer" className="flex-none">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={`/api/attachments/${id}`} alt="Source" className="h-40 max-w-[260px] rounded-control border border-divider bg-surface object-contain" />
            </a>
          ))}
        </div>
      ) : null}
      {e.text ? (
        <blockquote className="m-0 rounded-control border border-divider bg-surface px-2.5 py-2 text-meta whitespace-pre-wrap text-body">{e.text}</blockquote>
      ) : null}
      {e.flags?.map((f, i) => (
        <span key={i} className={cx("rounded-control px-2.5 py-1.5 text-meta", tone[f.tone] ?? tone.neutral)}>
          {f.text}
        </span>
      ))}
      {e.note ? <span className="text-xs text-muted">{e.note}</span> : null}
    </section>
  );
}

/** A summary line under a form: "ok:…" draws success, "warn:…" draws a warning. */
/** A form's live summary line ("ok:" / "warn:" from its calc), drawn as the ordinary Callout. */
function FormSummary({ text }: { text: string }) {
  const warn = text.startsWith("warn:");
  return (
    <Callout tone={warn ? "warn" : "success"} className={cx("mb-0 text-sm font-medium", warn ? "text-warn-ink" : "text-success")}>
      {text.replace(/^(ok|warn):/, "")}
    </Callout>
  );
}

function Block({ title, onRemove, children }: { title: string; onRemove?: () => void; children: React.ReactNode }) {
  return (
    <div className="min-w-0 rounded-card border border-line">
      {title ? (
        <div className="flex items-center justify-between rounded-t-card border-b border-divider bg-canvas px-3 py-2">
          <span className="text-meta font-semibold text-ink">{title}</span>
          {onRemove ? (
            <LinkButton tone="danger" onClick={onRemove} className="px-2 text-meta">
              Remove line
            </LinkButton>
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
    info: "bg-brand-soft text-brand-hover",
    brand: "bg-brand-soft text-brand-hover",
  };
  return (
    <Modal
      open
      onClose={onClose}
      width={560}
      title={
        <>
          {d.title}
          {d.sub ? <span className="mt-0.5 block text-meta font-normal text-muted">{d.sub}</span> : null}
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
            <a href={d.open.href} target="_blank" rel="noreferrer" onClick={onClose} className={buttonClass({ variant: "primary" })}>
              {d.open.label}
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
      {d.text ? <pre className="m-0 max-h-[50vh] overflow-y-auto rounded-card bg-canvas p-3 text-meta leading-5 whitespace-pre-wrap text-ink">{d.text}</pre> : null}
      {d.lines?.length ? (
        <div className="max-h-[50vh] overflow-y-auto rounded-card border border-line">
          {d.lines.map((l, i) => (
            <div key={i} className={cx("border-b border-divider px-3 py-2 text-meta last:border-0", l.tone ? tone[l.tone] : "text-body")}>
              {l.text}
            </div>
          ))}
        </div>
      ) : null}
    </Modal>
  );
}
