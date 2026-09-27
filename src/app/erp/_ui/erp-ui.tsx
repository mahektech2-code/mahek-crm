"use client";

import { createContext, useCallback, useContext, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { ActionSpec, BulkSpec, FieldSpec, FormSpec, PromptSpec } from "@/lib/erp/ui";
import { whenHolds } from "@/lib/erp/ui";
import { runCalc } from "@/lib/erp/calc";
import "@/lib/erp/calcs";
import { erpLoadForm, erpRunAction, erpRunBulk, erpSubmitForm } from "@/lib/actions/erp";
import type { Result } from "@/lib/result";
import { Field } from "./field";
import { ErpVoice } from "./voice";

/* ---------------------------------------------------------------------------
 * The ERP's overlays, held once for the whole app: the form drawer, the prompt
 * dialog, the confirm dialog and the toast — the four things the design draws
 * above every screen. Screens ask for them through `useErpUi()`.
 * ------------------------------------------------------------------------- */

type Confirm = { msg: string; fn: () => void };
type PromptState = { spec: PromptSpec; done: (v: Record<string, string>) => Promise<Result<unknown> | void> };

type Ui = {
  toast: (t: string) => void;
  confirm: (msg: string, fn: () => void) => void;
  prompt: (spec: PromptSpec, done: (v: Record<string, string>) => Promise<Result<unknown> | void>) => void;
  openForm: (spec: FormSpec) => void;
  /** Runs a record action: confirm → prompt/form → server → toast → refresh. */
  act: (screen: string, a: ActionSpec, recordId: string, after?: () => void) => void;
  bulk: (screen: string, b: BulkSpec, ids: string[], after?: () => void) => void;
};

const Ctx = createContext<Ui | null>(null);

export function useErpUi(): Ui {
  const u = useContext(Ctx);
  if (!u) throw new Error("useErpUi outside ErpUiProvider");
  return u;
}

export function ErpUiProvider({ children, voice = false }: { children: React.ReactNode; voice?: boolean }) {
  const router = useRouter();
  const [toastText, setToastText] = useState("");
  const tRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [confirmState, setConfirmState] = useState<Confirm | null>(null);
  const [promptState, setPromptState] = useState<PromptState | null>(null);
  const [form, setForm] = useState<FormSpec | null>(null);
  const [formKey, setFormKey] = useState(0);

  const toast = useCallback((t: string) => {
    if (tRef.current) clearTimeout(tRef.current);
    setToastText(t);
    tRef.current = setTimeout(() => setToastText(""), 3200);
  }, []);

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
    (res: Result<unknown> | void, after?: () => void) => {
      if (!res) return;
      if (res.ok) {
        toast(res.message ?? "Saved");
        router.refresh();
        after?.();
      } else {
        toast(res.error);
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
        void erpLoadForm(screen, a.id, recordId).then((res) => {
          if (res.ok) openForm(res.data);
          else toast(res.error);
        });
        return;
      }
      const go = () => {
        if (a.prompt) {
          prompt(a.prompt, async (v) => {
            const res = await erpRunAction(screen, a.id, recordId, v);
            if (res.ok) finish(res, after);
            return res;
          });
          return;
        }
        void erpRunAction(screen, a.id, recordId).then((res) => finish(res, after));
      };
      if (a.confirm) confirm(a.confirm, go);
      else go();
    },
    [confirm, finish, openForm, prompt, router, toast],
  );

  const bulk = useCallback(
    (screen: string, b: BulkSpec, ids: string[], after?: () => void) => {
      const go = () => {
        if (b.prompt) {
          prompt(b.prompt, async (v) => {
            const res = await erpRunBulk(screen, b.id, ids, v);
            if (res.ok) finish(res, after);
            return res;
          });
          return;
        }
        void erpRunBulk(screen, b.id, ids).then((res) => finish(res, after));
      };
      if (b.confirm) confirm(b.confirm, go);
      else go();
    },
    [confirm, finish, prompt],
  );

  return (
    <ErpVoice.Provider value={voice}>
    <Ctx.Provider value={{ toast, confirm, prompt, openForm, act, bulk }}>
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
        <PromptDialog
          key={promptState.spec.title}
          state={promptState}
          onClose={() => setPromptState(null)}
        />
      ) : null}
      {confirmState ? (
        <div
          onClick={() => setConfirmState(null)}
          style={{ position: "fixed", inset: 0, zIndex: 32, background: "rgba(22,22,22,0.45)", display: "flex", alignItems: "center", justifyContent: "center", padding: 16, animation: "erp-fade 150ms cubic-bezier(0.2,0,0.2,1)" }}
        >
          <div
            role="alertdialog"
            onClick={(e) => e.stopPropagation()}
            style={{ width: "min(420px,100%)", background: "#FFFFFF", borderRadius: 8, boxShadow: "0 8px 24px rgba(22,22,22,0.18)", padding: 20 }}
          >
            <div style={{ fontSize: 16, lineHeight: "23px", fontWeight: 600, color: "#161616" }}>{confirmState.msg}</div>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 10, marginTop: 18 }}>
              <button onClick={() => setConfirmState(null)} style={secondaryBtn(36)}>
                Cancel
              </button>
              <button
                onClick={() => {
                  const fn = confirmState.fn;
                  setConfirmState(null);
                  fn();
                }}
                style={primaryBtn(36)}
              >
                Yes, go ahead
              </button>
            </div>
          </div>
        </div>
      ) : null}
      {toastText ? (
        <div
          role="status"
          style={{ position: "fixed", right: 20, bottom: 20, zIndex: 40, maxWidth: "calc(100vw - 40px)", display: "flex", alignItems: "center", gap: 10, padding: "12px 16px", background: "#3D14A8", color: "#FFFFFF", borderRadius: 8, boxShadow: "0 8px 24px rgba(22,22,22,0.18)", fontSize: 14, animation: "erp-fade 150ms cubic-bezier(0.2,0,0.2,1)" }}
        >
          <span style={{ width: 18, height: 18, borderRadius: "50%", background: "rgba(198,255,52,0.2)", color: "#C6FF34", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 12, flex: "none" }}>
            ✓
          </span>
          {toastText}
        </div>
      ) : null}
    </Ctx.Provider>
    </ErpVoice.Provider>
  );
}

export function primaryBtn(h = 38): React.CSSProperties {
  return { height: h, padding: "0 16px", border: "none", background: "#6835FB", borderRadius: 4, fontSize: 14, fontWeight: 500, color: "#FFFFFF", cursor: "pointer" };
}
export function secondaryBtn(h = 38): React.CSSProperties {
  return { height: h, padding: "0 16px", border: "1px solid #DDE1E8", background: "#FFFFFF", borderRadius: 4, fontSize: 14, fontWeight: 500, color: "#3D4453", cursor: "pointer" };
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
    <div
      onClick={onClose}
      style={{ position: "fixed", inset: 0, zIndex: 30, background: "rgba(22,22,22,0.45)", display: "flex", alignItems: "center", justifyContent: "center", padding: 16, animation: "erp-fade 150ms cubic-bezier(0.2,0,0.2,1)" }}
    >
      <div
        role="dialog"
        aria-label={spec.title}
        onClick={(e) => e.stopPropagation()}
        style={{ width: "min(480px,100%)", maxHeight: "calc(100vh - 32px)", background: "#FFFFFF", borderRadius: 8, boxShadow: "0 8px 24px rgba(22,22,22,0.18)", display: "flex", flexDirection: "column", overflow: "hidden" }}
      >
        <div style={{ padding: "16px 20px 12px 20px", borderBottom: "1px solid #EDEFF3" }}>
          <div style={{ fontSize: 18, fontWeight: 600, color: "#161616" }}>{spec.title}</div>
          {spec.sub ? <div style={{ fontSize: 13, color: "#6B7385", marginTop: 2 }}>{spec.sub}</div> : null}
        </div>
        <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "16px 20px", display: "grid", gap: 14, alignContent: "start", gridAutoRows: "max-content" }}>
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
        <div style={{ padding: "12px 20px", borderTop: "1px solid #EDEFF3", display: "flex", justifyContent: "flex-end", gap: 10 }}>
          <button onClick={onClose} style={secondaryBtn(36)}>
            Cancel
          </button>
          <button onClick={submit} disabled={busy} style={{ ...primaryBtn(36), opacity: busy ? 0.7 : 1 }}>
            {busy ? "Saving…" : spec.submit}
          </button>
        </div>
      </div>
    </div>
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
    const init: Record<string, string> = {};
    spec.header.forEach((f) => (init[f.k] = spec.init?.[f.k] ?? f.def ?? ""));
    return init;
  });
  const blankLine = () => {
    const l: Record<string, string> = {};
    (spec.line ?? []).forEach((f) => (l[f.k] = f.def ?? ""));
    return l;
  };
  const [lines, setLines] = useState<Record<string, string>[]>(() => (spec.line ? [blankLine()] : []));
  const [errs, setErrs] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [topError, setTopError] = useState("");
  const data = spec.data ?? {};

  const visible = (f: FieldSpec, l: Record<string, string> = {}) => whenHolds(f.when, { ...h, ...l }, data);

  const submit = () => {
    const e: Record<string, string> = {};
    spec.header.filter((f) => visible(f)).forEach((f) => {
      const m = checkField(f, h[f.k] ?? "");
      if (m) e[`h.${f.k}`] = m;
    });
    lines.forEach((l, i) =>
      (spec.line ?? []).filter((f) => visible(f, l)).forEach((f) => {
        const m = checkField(f, l[f.k] ?? "");
        if (m) e[`l${i}.${f.k}`] = m;
      }),
    );
    setErrs(e);
    if (Object.keys(e).length) return;
    const save = async () => {
      setBusy(true);
      setTopError("");
      const res = await erpSubmitForm(spec.screen, spec.id, h, lines, spec.recordId);
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

  return (
    <div
      onClick={onClose}
      style={{ position: "fixed", inset: 0, zIndex: 22, background: "rgba(22,22,22,0.35)", display: "flex", justifyContent: "flex-end", animation: "erp-fade 150ms cubic-bezier(0.2,0,0.2,1)" }}
    >
      <div
        role="dialog"
        aria-label={spec.title}
        onClick={(e) => e.stopPropagation()}
        style={{ width: "min(680px,100vw)", height: "100%", background: "#FFFFFF", boxShadow: "0 8px 24px rgba(22,22,22,0.12)", display: "flex", flexDirection: "column", animation: "erp-drawer 200ms cubic-bezier(0.2,0,0.2,1)" }}
      >
        <div style={{ flex: "none", padding: "16px 20px", borderBottom: "1px solid #EDEFF3", display: "flex", gap: 12 }}>
          <span style={{ flex: 1, minWidth: 0 }}>
            <span style={{ display: "block", fontSize: 20, fontWeight: 600, color: "#161616" }}>{spec.title}</span>
            {spec.sub ? <span style={{ display: "block", fontSize: 13, color: "#6B7385", marginTop: 2 }}>{spec.sub}</span> : null}
          </span>
          <button onClick={onClose} title="Close (Esc)" style={{ width: 32, height: 32, border: "none", background: "transparent", color: "#6B7385", cursor: "pointer", fontSize: 18, flex: "none" }}>
            ✕
          </button>
        </div>
        <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "16px 20px", display: "grid", gap: 14, alignContent: "start", gridAutoRows: "max-content" }}>
          <Block title={spec.line ? "Header" : ""}>
            {spec.header
              .filter((f) => visible(f))
              .map((f) => (
                <Field
                  key={f.k}
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
                    setH((s) => ({ ...s, [f.k]: v }));
                    setErrs((s) => ({ ...s, [`h.${f.k}`]: "" }));
                  }}
                />
              ))}
          </Block>
          {spec.line
            ? lines.map((l, i) => (
                <Block
                  key={i}
                  title={`${spec.lineLabel ?? "Line"} ${i + 1} of ${lines.length}`}
                  onRemove={lines.length > 1 ? () => setLines((s) => s.filter((_, j) => j !== i)) : undefined}
                >
                  {spec.line!
                    .filter((f) => visible(f, l))
                    .map((f) => (
                      <Field
                        key={f.k}
                        f={f}
                        value={l[f.k] ?? ""}
                        error={errs[`l${i}.${f.k}`]}
                        options={optsFor(f, { ...h, ...l })}
                        derived={f.t === "derived" ? runCalc(f.calc, { h, l, lines, i, data }) : undefined}
                        onChange={(v) => {
                          setLines((s) => s.map((x, j) => (j === i ? { ...x, [f.k]: v } : x)));
                          setErrs((s) => ({ ...s, [`l${i}.${f.k}`]: "" }));
                        }}
                      />
                    ))}
                </Block>
              ))
            : null}
          {spec.line ? (
            <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
              <button
                onClick={() => setLines((s) => [...s, blankLine()])}
                style={{ height: 36, padding: "0 14px", border: "1px dashed #6835FB", background: "#FFFFFF", borderRadius: 4, color: "#5223E0", fontSize: 14, fontWeight: 500, cursor: "pointer" }}
              >
                + Add more {(spec.lineLabel ?? "line").toLowerCase()}
              </button>
              <span style={{ fontSize: 12, color: "#6B7385" }}>
                Each new line keeps the header: {spec.header.filter((f) => f.t !== "derived").slice(0, 3).map((f) => f.l.toLowerCase()).join(", ")}.
              </span>
            </div>
          ) : null}
          {runCalc(`${spec.screen}.summary`, { h, l: {}, lines, i: -1, data }) ? (
            <FormSummary text={runCalc(`${spec.screen}.summary`, { h, l: {}, lines, i: -1, data })} />
          ) : null}
          {topError ? (
            <div style={{ padding: "10px 12px", borderRadius: 6, background: "#FCECEC", color: "#B3261E", fontSize: 14, fontWeight: 500 }}>{topError}</div>
          ) : null}
        </div>
        <div style={{ flex: "none", borderTop: "1px solid #EDEFF3", padding: "12px 20px", display: "flex", gap: 10, justifyContent: "flex-end" }}>
          <button onClick={onClose} style={secondaryBtn()}>
            Cancel
          </button>
          <button onClick={submit} disabled={busy} style={{ ...primaryBtn(), padding: "0 18px", opacity: busy ? 0.7 : 1 }}>
            {busy ? "Saving…" : spec.submit}
          </button>
        </div>
      </div>
    </div>
  );
}

/** A summary line under a form: "ok:…" draws success, "warn:…" draws a warning. */
function FormSummary({ text }: { text: string }) {
  const warn = text.startsWith("warn:");
  const body = text.replace(/^(ok|warn):/, "");
  return (
    <div style={{ padding: "10px 12px", borderRadius: 6, background: warn ? "#FDF6E7" : "#E9F5EE", color: warn ? "#8A5C05" : "#1D7A45", fontSize: 14, fontWeight: 500 }}>
      {body}
    </div>
  );
}

function Block({ title, onRemove, children }: { title: string; onRemove?: () => void; children: React.ReactNode }) {
  return (
    <div style={{ border: "1px solid #EDEFF3", borderRadius: 8, minWidth: 0 }}>
      {title ? (
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "8px 12px", background: "#F7F8FA", borderBottom: "1px solid #EDEFF3", borderRadius: "8px 8px 0 0" }}>
          <span style={{ fontSize: 13, fontWeight: 600, color: "#161616" }}>{title}</span>
          {onRemove ? (
            <button onClick={onRemove} style={{ height: 26, padding: "0 8px", border: "none", background: "transparent", color: "#B3261E", fontSize: 13, cursor: "pointer" }}>
              Remove line
            </button>
          ) : null}
        </div>
      ) : null}
      <div className="erp-field-grid" style={{ padding: "14px 12px" }}>
        {children}
      </div>
    </div>
  );
}
