"use client";

import { useContext, useState } from "react";
import type { FieldSpec } from "@/lib/erp/ui";
import { cx } from "@/components/ui/primitives";
import { DictateButton, joinDictation } from "@/components/ui/dictate";
import { Icon } from "./icons";
import { ErpVoice } from "./voice";

/* ---------------------------------------------------------------------------
 * One form field, drawn as the CRM draws every field: an uppercase label (with
 * the ERP's tag — Calculated / AI suggestion / Optional — beside it), the
 * control at the CRM's height and border, then the error under it or else the
 * hint.
 * ------------------------------------------------------------------------- */

const CONTROL = "w-full rounded-[4px] border bg-surface px-2.5 text-sm text-ink outline-none focus:border-brand";

function control(err: boolean, extra?: string) {
  return cx(CONTROL, "h-8.5", err ? "border-danger" : "border-line", extra);
}

export function Field({
  f,
  value,
  error,
  options,
  derived,
  onChange,
  onMic,
  onUseSuggestion,
}: {
  f: FieldSpec;
  value: string;
  error?: string;
  options?: string[];
  derived?: string;
  onChange: (v: string) => void;
  /** Present when dictation is available (AI-3). */
  onMic?: () => void;
  onUseSuggestion?: (v: string) => void;
}) {
  const opts = options ?? f.opts ?? [];
  const tag = f.conf ? (f.conf === "high" ? "AI · read" : f.conf === "check" ? "AI · check this" : "AI · not found") : f.t === "derived" ? "Calculated" : f.t === "suggest" ? "AI suggestion" : !f.req ? "Optional" : "";
  const tagTone =
    f.conf === "check" || f.conf === "not found"
      ? "bg-warn-soft text-warn-ink"
      : f.conf || f.t === "suggest"
        ? "bg-brand-soft text-[#5223E0]"
        : f.t === "derived"
          ? "bg-divider text-muted"
          : "text-muted";
  /* A control with several buttons inside cannot sit in a <label>: every
     button would take the whole label as its name, and a click on the label
     text would press the first one. Those fields are a named group instead. */
  const grouped = f.t === "multi" || f.t === "photo" || f.t === "video" || f.t === "suggest";
  const Wrap = grouped ? "div" : "label";
  return (
    <Wrap className="block min-w-0" {...(grouped ? { role: "group", "aria-label": f.l } : {})}>
      <span className="mb-1 flex items-center gap-1.5 text-xs font-medium tracking-[0.04em] text-muted uppercase">
        {f.l}
        {tag ? <span className={cx("rounded-[3px] px-1.5 text-[11px] font-medium tracking-normal normal-case", tagTone)}>{tag}</span> : null}
      </span>
      <Control f={f} value={value} error={!!error} opts={opts} derived={derived} onChange={onChange} onMic={onMic} onUseSuggestion={onUseSuggestion} />
      {error ? (
        <span className="mt-1 block text-[13px] text-danger">{error}</span>
      ) : f.hint ? (
        <span className="mt-1 block text-[13px] text-muted">{f.hint}</span>
      ) : null}
    </Wrap>
  );
}

function Control({
  f,
  value,
  error,
  opts,
  derived,
  onChange,
  onMic,
  onUseSuggestion,
}: {
  f: FieldSpec;
  value: string;
  error: boolean;
  opts: string[];
  derived?: string;
  onChange: (v: string) => void;
  onMic?: () => void;
  onUseSuggestion?: (v: string) => void;
}) {
  const voice = useContext(ErpVoice);
  if (f.t === "derived") {
    return (
      <span
        className={cx(
          "flex min-h-8.5 items-center rounded-[4px] border border-dashed bg-canvas px-2.5 text-sm tabular-nums",
          error ? "border-danger" : "border-line",
          derived ? "text-ink" : "text-line-strong",
        )}
      >
        {derived || "—"}
      </span>
    );
  }
  if (f.t === "scan") {
    /* A USB or Bluetooth scanner types the label and presses Enter, so this is
       a plain input — never a list that has to be opened first. */
    const listId = `scan-${f.k}`;
    return (
      <span className="relative block">
        <input
          value={value}
          list={listId}
          autoComplete="off"
          placeholder="Scan or type the lot label"
          onChange={(e) => onChange(e.target.value.trim())}
          onKeyDown={(e) => {
            if (e.key === "Enter") e.preventDefault();
          }}
          className={control(error, "pr-8 font-mono")}
        />
        <span className="pointer-events-none absolute top-2 right-2.5 flex text-muted">
          <Icon n="scan" />
        </span>
        <datalist id={listId}>
          {opts.map((o) => (
            <option key={o} value={o} />
          ))}
        </datalist>
      </span>
    );
  }
  if (f.t === "suggest") {
    const has = !!derived;
    return (
      <span className={cx("flex min-h-8.5 items-center gap-2 rounded-[4px] border border-dashed border-brand-softer bg-brand-soft/50 py-1 pr-1 pl-2.5 text-sm", has ? "text-[#3D14A8]" : "text-muted")}>
        <span className="min-w-0 flex-1">{has ? derived : "Keep typing the description for a suggestion"}</span>
        {has ? (
          <button
            type="button"
            onClick={() => onUseSuggestion?.(derived!)}
            className="h-7 flex-none cursor-pointer rounded-[4px] border border-brand bg-surface px-2.5 text-[13px] font-medium text-[#5223E0] hover:bg-brand-soft"
          >
            Use it
          </button>
        ) : null}
      </span>
    );
  }
  if (f.t === "area") {
    return (
      <span className="relative block">
        <textarea
          value={value}
          readOnly={f.readOnly}
          onChange={(e) => onChange(e.target.value)}
          className={cx(CONTROL, "h-[72px] resize-y py-2 pr-9 leading-[21px]", error ? "border-danger" : "border-line")}
        />
        {f.mic && voice && !f.readOnly ? (
          /* AI-3: the CRM's own dictation — same providers, same modal, same
             tinted microphone, and it draws nothing when dictation is off or
             has no key. The words are shown before anything reaches the box,
             and Add is the default. */
          <DictateButton
            hasExistingText={value.trim().length > 0}
            onImport={(text, replace) => onChange(replace ? text : joinDictation(value, text))}
            className="absolute right-2 bottom-3"
          />
        ) : onMic && f.mic ? (
          <button
            type="button"
            onClick={onMic}
            title="Dictate — speak in any language"
            className="absolute right-2 bottom-3 flex h-7 w-7 cursor-pointer items-center justify-center rounded-full border border-brand-softer bg-brand-soft text-[#5223E0]"
          >
            <Icon n="mic" />
          </button>
        ) : null}
      </span>
    );
  }
  if (f.t === "select") {
    if (opts.length > 12) return <Combo value={value} opts={opts} error={error} onChange={onChange} />;
    return (
      <select value={value} disabled={f.readOnly} onChange={(e) => onChange(e.target.value)} className={control(error, "cursor-pointer")}>
        <option value="">{opts.length ? "Choose…" : "Nothing available"}</option>
        {opts.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
    );
  }
  if (f.t === "multi") {
    const chosen = value ? value.split("|").filter(Boolean) : [];
    const toggle = (o: string) => {
      const next = chosen.includes(o) ? chosen.filter((x) => x !== o) : [...chosen, o];
      onChange(next.join("|"));
    };
    return (
      <span className={cx("flex min-h-8.5 flex-wrap gap-1.5 rounded-[4px] border bg-surface p-1.5", error ? "border-danger" : "border-line")}>
        {opts.length === 0 ? <span className="p-1 text-[13px] text-muted">Nothing available</span> : null}
        {opts.map((o) => {
          const on = chosen.includes(o);
          return (
            <button
              type="button"
              key={o}
              onClick={() => toggle(o)}
              className={cx(
                "h-7 cursor-pointer rounded-[4px] border px-2.5 text-[13px]",
                on ? "border-brand bg-brand-soft font-medium text-[#5223E0]" : "border-line bg-surface text-body hover:bg-canvas",
              )}
            >
              {on ? "✓ " : ""}
              {o}
            </button>
          );
        })}
      </span>
    );
  }
  if (f.t === "photo" || f.t === "video") {
    return <PhotoPicker kind={f.t} value={value} error={error} onChange={onChange} />;
  }
  return (
    <input
      type={f.t === "num" ? "number" : f.t === "date" ? "date" : "text"}
      value={value}
      readOnly={f.readOnly}
      min={f.min}
      max={f.max}
      step={f.t === "num" ? "any" : undefined}
      onChange={(e) => onChange(e.target.value)}
      className={control(error, f.readOnly ? "bg-canvas text-muted" : undefined)}
    />
  );
}

/** A select with more than twelve options becomes a search box. */
function Combo({ value, opts, error, onChange }: { value: string; opts: string[]; error: boolean; onChange: (v: string) => void }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const ql = q.trim().toLowerCase();
  const m = ql ? opts.filter((x) => x.toLowerCase().includes(ql)) : opts;
  return (
    <span className="relative block">
      <input
        value={open ? q : value}
        placeholder={value || `Search ${opts.length.toLocaleString("en-IN")} options`}
        onFocus={() => {
          setOpen(true);
          setQ("");
        }}
        onChange={(e) => {
          setOpen(true);
          setQ(e.target.value);
        }}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        className={control(error, "pr-8")}
      />
      <span className="pointer-events-none absolute top-2 right-2.5 flex text-muted">
        <Icon n="search" />
      </span>
      {open ? (
        <span className="absolute top-10 right-0 left-0 z-50 block max-h-[300px] overflow-y-auto rounded-[6px] border border-line bg-surface py-1 shadow-[0_8px_24px_rgba(22,22,22,0.12)]">
          {m.slice(0, 8).map((x) => (
            <button
              type="button"
              key={x}
              onMouseDown={(e) => {
                e.preventDefault();
                onChange(x);
                setOpen(false);
                setQ("");
              }}
              className={cx("block min-h-8.5 w-full cursor-pointer px-3 py-[7px] text-left text-sm text-ink", x === value ? "bg-brand-soft" : "hover:bg-canvas")}
            >
              {x}
            </button>
          ))}
          {m.length > 8 ? (
            <span className="block border-t border-divider px-3 py-2 text-xs text-muted">{(m.length - 8).toLocaleString("en-IN")} more — keep typing</span>
          ) : null}
          {m.length === 0 ? <span className="block px-3 py-2.5 text-[13px] text-muted">Nothing matches “{q}”</span> : null}
        </span>
      ) : null}
    </span>
  );
}

/**
 * A photo or video field. The file is uploaded as it is chosen and the value
 * is the attachment's id, bound to its record when the record saves — the
 * house rule for attachments, so a save is never blocked by a slow upload.
 */
function PhotoPicker({
  kind,
  value,
  error,
  onChange,
}: {
  kind: "photo" | "video";
  value: string;
  error: boolean;
  onChange: (v: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState("");
  const [upErr, setUpErr] = useState("");
  const pick = async (file: File | undefined) => {
    if (!file) return;
    setBusy(true);
    setUpErr("");
    try {
      const body = new FormData();
      body.set("file", file);
      body.set("kind", kind);
      const res = await fetch("/api/erp/attachments", { method: "POST", body });
      const j = (await res.json()) as { id?: string; error?: string };
      if (!res.ok || !j.id) throw new Error(j.error || "Upload failed");
      setName(file.name);
      onChange(j.id);
    } catch (e) {
      setUpErr(e instanceof Error ? e.message : "Upload failed");
    } finally {
      setBusy(false);
    }
  };
  const done = !!value;
  return (
    <span className="block">
      <span
        className={cx(
          "relative flex h-10 w-full cursor-pointer items-center gap-2 rounded-[4px] border px-3 text-sm",
          done ? "border-success bg-success-soft text-success" : cx("border-dashed bg-surface text-body hover:bg-canvas", error ? "border-danger" : "border-line-strong"),
        )}
      >
        {busy ? "Uploading…" : done ? `✓ ${name || "Attached"}` : kind === "video" ? "Record or upload a video" : "Take or upload a photo"}
        <input
          type="file"
          accept={kind === "video" ? "video/*" : "image/*,application/pdf"}
          capture={kind === "photo" ? "environment" : undefined}
          onChange={(e) => pick(e.target.files?.[0])}
          className="absolute inset-0 cursor-pointer opacity-0"
        />
        {done ? (
          <button
            type="button"
            onClick={(e) => {
              e.preventDefault();
              onChange("");
              setName("");
            }}
            className="relative z-1 ml-auto cursor-pointer text-[13px] text-success hover:underline"
          >
            Remove
          </button>
        ) : null}
      </span>
      {upErr ? <span className="mt-1 block text-[13px] text-danger">{upErr}</span> : null}
    </span>
  );
}
