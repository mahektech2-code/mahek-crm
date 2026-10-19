"use client";

import { useContext, useId, useState } from "react";
import type { FieldSpec } from "@/lib/erp/ui";
import { Badge, Button, controlClass, cx, type Tone } from "@/components/ui/primitives";
import { nf } from "@/lib/erp/ui";
import { labelClass, popoverClass } from "./look";
import { DictateButton, joinDictation } from "@/components/ui/dictate";
import { Icon } from "./icons";
import { ErpVoice } from "./voice";
import { useKit } from "./kit";
import { PinField } from "./pin-field";
import { matchOptions, nearEnd, PAGE } from "./option-match";

/* ---------------------------------------------------------------------------
 * One form field, drawn as the CRM draws every field: an uppercase label (with
 * the ERP's tag — Calculated / AI suggestion / Optional — beside it), the
 * control at the CRM's height and border, then the error under it or else the
 * hint.
 * ------------------------------------------------------------------------- */

function control(err: boolean, extra?: string) {
  return controlClass({ invalid: err, className: cx("h-8.5", extra) });
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
  const tag = f.conf ? (f.conf === "high" ? "AI · read" : f.conf === "check" ? "AI · check this" : "AI · not found") : f.t === "derived" ? "Calculated" : f.t === "suggest" ? "AI suggestion" : !f.req && !f.untagged ? "Optional" : "";
  const tagTone: Tone =
    f.conf === "check" || f.conf === "not found" ? "warn" : f.conf || f.t === "suggest" ? "brand" : f.t === "derived" ? "neutral" : "muted";
  /* A control with several buttons inside cannot sit in a <label>: every
     button would take the whole label as its name, and a click on the label
     text would press the first one. Those fields are a named group instead. */
  const grouped = f.t === "multi" || f.t === "pick" || f.t === "photo" || f.t === "video" || f.t === "suggest" || f.t === "pin";
  const Wrap = grouped ? "div" : "label";
  return (
    <Wrap className={cx("block min-w-0", f.wide && "col-span-full")} {...(grouped ? { role: "group", "aria-label": f.l } : {})}>
      <span className={cx("mb-1 flex items-center gap-1.5", labelClass)}>
        {f.l}
        {tag ? (
          <Badge tone={tagTone} className="tracking-normal normal-case">
            {tag}
          </Badge>
        ) : null}
      </span>
      <Control f={f} value={value} error={!!error} opts={opts} derived={derived} onChange={onChange} onMic={onMic} onUseSuggestion={onUseSuggestion} />
      {error ? (
        <span className="mt-1 block text-meta text-danger">{error}</span>
      ) : f.hint ? (
        <span className="mt-1 block text-meta text-muted">{f.hint}</span>
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
  if (f.t === "pin") return <PinField value={value} error={error} onChange={onChange} />;
  if (f.t === "derived") {
    return (
      <span
        className={cx(
          /* pre-line: a calculation may list several lines, one per lot. */
          "flex min-h-8.5 items-center whitespace-pre-line rounded-control border border-dashed bg-canvas px-2.5 py-1.5 text-sm tabular-nums",
          error ? "border-danger" : "border-line",
          derived ? "text-ink" : "text-line-strong",
        )}
      >
        {derived || "—"}
      </span>
    );
  }
  if (f.t === "scan") return <ScanField value={value} opts={opts} error={error} onChange={onChange} />;
  if (f.t === "suggest") {
    const has = !!derived;
    return (
      <span className={cx("flex min-h-8.5 items-center gap-2 rounded-control border border-dashed border-brand-softer bg-brand-soft/50 py-1 pr-1 pl-2.5 text-sm", has ? "text-brand-deep" : "text-muted")}>
        <span className="min-w-0 flex-1">{has ? derived : "Keep typing the description for a suggestion"}</span>
        {has ? (
          <Button type="button" size="sm" onClick={() => onUseSuggestion?.(derived!)} className="h-7 flex-none">
            Use it
          </Button>
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
          className={controlClass({ invalid: !!error, className: "h-[72px] resize-y py-2 pr-9 leading-[21px]" })}
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
            aria-label="Dictate — speak in any language"
            className="absolute right-2 bottom-3 flex h-7 w-7 cursor-pointer items-center justify-center rounded-full border border-brand-softer bg-brand-soft text-brand-hover"
          >
            <Icon n="mic" />
          </button>
        ) : null}
      </span>
    );
  }
  if (f.t === "select") {
    if ((opts.length > 12 || f.typed) && !f.readOnly) return <Combo value={value} opts={opts} error={error} onChange={onChange} placeholder={f.typed} />;
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
  if (f.t === "pick") {
    return (
      <span className={cx("flex min-h-8.5 flex-wrap gap-1.5", error && "rounded-control outline outline-1 outline-danger")}>
        {opts.map((o) => {
          const on = value === o;
          return (
            <button
              type="button"
              key={o}
              aria-pressed={on}
              disabled={f.readOnly}
              onClick={() => onChange(on ? "" : o)}
              className={cx(
                "h-8.5 cursor-pointer rounded-control border px-3 text-meta",
                on ? "border-brand bg-brand-soft font-medium text-brand-hover" : "border-line bg-surface text-body hover:bg-canvas",
              )}
            >
              {o}
            </button>
          );
        })}
      </span>
    );
  }
  if (f.t === "multi") {
    const chosen = value ? value.split("|").filter(Boolean) : [];
    const toggle = (o: string) => {
      const next = chosen.includes(o) ? chosen.filter((x) => x !== o) : [...chosen, o];
      onChange(next.join("|"));
    };
    return (
      <span className={cx("flex min-h-8.5 flex-wrap gap-1.5 rounded-control border bg-surface p-1.5", error ? "border-danger" : "border-line")}>
        {opts.length === 0 ? <span className="p-1 text-meta text-muted">Nothing available</span> : null}
        {opts.map((o) => {
          const on = chosen.includes(o);
          return (
            <button
              type="button"
              key={o}
              onClick={() => toggle(o)}
              className={cx(
                "h-7 cursor-pointer rounded-control border px-2.5 text-meta",
                on ? "border-brand bg-brand-soft font-medium text-brand-hover" : "border-line bg-surface text-body hover:bg-canvas",
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
  if (f.t === "csv") return <CsvPicker value={value} error={error} onChange={onChange} />;
  if (f.t === "time")
    return <input type="time" value={value} onChange={(e) => onChange(e.target.value)} className={control(error)} />;
  if (f.t === "photo" || f.t === "video") {
    return <PhotoPicker kind={f.t} upload={f.upload} value={value} error={error} onChange={onChange} />;
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
function Combo({ value, opts, error, onChange, placeholder }: { value: string; opts: string[]; error: boolean; onChange: (v: string) => void; placeholder?: string }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [limit, setLimit] = useState(PAGE);
  const m = matchOptions(opts, q);
  return (
    <span className="relative block">
      <input
        value={open ? q : value}
        placeholder={value || placeholder || `Search ${nf(opts.length)} options`}
        onFocus={() => {
          setOpen(true);
          setQ("");
          setLimit(PAGE);
        }}
        onChange={(e) => {
          setOpen(true);
          setQ(e.target.value);
          setLimit(PAGE);
        }}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        className={control(error, "pr-8")}
      />
      <span className="pointer-events-none absolute top-2 right-2.5 flex text-muted">
        <Icon n="search" />
      </span>
      {open ? (
        <span
          onScroll={(e) => {
            if (limit < m.length && nearEnd(e.currentTarget)) setLimit((n) => n + PAGE);
          }}
          className={cx(popoverClass, "absolute top-10 right-0 left-0 z-50 block max-h-[300px] overflow-y-auto py-1")}
        >
          {m.slice(0, limit).map((x) => (
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
          {m.length > limit ? <span className="block border-t border-divider px-3 py-2 text-xs text-muted">Showing {nf(limit)} of {nf(m.length)} — scroll for more</span> : null}
          {m.length === 0 ? <span className="block px-3 py-2.5 text-meta text-muted">Nothing matches “{q}”</span> : null}
        </span>
      ) : null}
    </span>
  );
}

/**
 * A lot label, scanned or typed. A USB or Bluetooth scanner types the label and
 * presses Enter, so this is a plain input first — Enter never submits the form
 * — and the lots with stock are a list drawn UNDER the field, at its width, in
 * the form's own type. It used to be a native `<datalist>`, which the browser
 * draws itself: a narrow floating box, offset from the field and covering the
 * hint beneath it. Free text is kept; the list is a shortcut, not a rule.
 */
function ScanField({ value, opts, error, onChange }: { value: string; opts: string[]; error: boolean; onChange: (v: string) => void }) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const listId = useId();
  const [limit, setLimit] = useState(PAGE);
  const ql = value.trim().toLowerCase();
  const m = ql && !opts.some((x) => x.toLowerCase() === ql) ? matchOptions(opts, value) : opts;
  const shown = m.slice(0, limit);
  const pick = (x: string) => {
    onChange(x);
    setOpen(false);
    setActive(-1);
  };
  return (
    <span className="relative block">
      <input
        value={value}
        autoComplete="off"
        spellCheck={false}
        role="combobox"
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        placeholder="Scan or type the lot label"
        onFocus={() => setOpen(true)}
        onClick={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        onChange={(e) => {
          onChange(e.target.value.trim());
          setOpen(true);
          setActive(-1);
          setLimit(PAGE);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            if (open && active >= 0 && shown[active]) pick(shown[active]);
            else setOpen(false);
          } else if (e.key === "Escape") {
            if (open) {
              e.preventDefault();
              setOpen(false);
            }
          } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            if (!open) return setOpen(true);
            if (!shown.length) return;
            const step = e.key === "ArrowDown" ? 1 : -1;
            setActive((i) => (i + step + shown.length) % shown.length);
          }
        }}
        className={control(error, cx("pr-8", value ? "font-mono" : ""))}
      />
      <span className="pointer-events-none absolute top-2 right-2.5 flex text-muted">
        <Icon n="scan" />
      </span>
      {open && opts.length ? (
        <span
          id={listId}
          role="listbox"
          onScroll={(e) => {
            if (limit < m.length && nearEnd(e.currentTarget)) setLimit((n) => n + PAGE);
          }}
          className={cx(popoverClass, "absolute top-10 right-0 left-0 z-50 block max-h-[300px] overflow-y-auto py-1")}
        >
          {shown.map((x, i) => (
            <button
              type="button"
              role="option"
              aria-selected={x === value}
              key={x}
              onMouseEnter={() => setActive(i)}
              onMouseDown={(e) => {
                e.preventDefault();
                pick(x);
              }}
              className={cx("block min-h-8.5 w-full cursor-pointer px-3 py-[7px] text-left font-mono text-sm text-ink", x === value ? "bg-brand-soft" : i === active ? "bg-canvas" : "hover:bg-canvas")}
            >
              {x}
            </button>
          ))}
          {m.length > limit ? <span className="block border-t border-divider px-3 py-2 text-xs text-muted">Showing {nf(limit)} of {nf(m.length)} — scroll for more</span> : null}
          {m.length === 0 ? <span className="block px-3 py-2.5 text-meta text-muted">No lot with stock here matches — what you scanned is still kept</span> : null}
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
/** Sends one picked file to the upload route and hands back the attachment id. */
function useUpload(kind: "photo" | "video", upload: FieldSpec["upload"], onChange: (v: string) => void) {
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState("");
  const [upErr, setUpErr] = useState("");
  const { uploadUrl } = useKit();
  const pick = async (file: File | undefined) => {
    if (!file) return;
    setBusy(true);
    setUpErr("");
    try {
      const body = new FormData();
      body.set("file", file);
      body.set("kind", kind);
      if (upload) body.set("upload", upload);
      const res = await fetch(uploadUrl, { method: "POST", body });
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
  return { busy, name, setName, upErr, pick };
}

function PhotoPicker({
  kind,
  upload,
  value,
  error,
  onChange,
}: {
  kind: "photo" | "video";
  upload?: FieldSpec["upload"];
  value: string;
  error: boolean;
  onChange: (v: string) => void;
}) {
  const { busy, name, setName, upErr, pick } = useUpload(kind, upload, onChange);
  const done = !!value;
  return (
    <span className="block">
      <span
        className={cx(
          "relative flex h-10 w-full cursor-pointer items-center gap-2 rounded-control border px-3 text-sm",
          done ? "border-success bg-success-soft text-success" : cx("border-dashed bg-surface text-body hover:bg-canvas", error ? "border-danger" : "border-line-strong"),
        )}
      >
        {done && kind === "photo" ? (
          /* A photo already attached shows itself, so a form reopened on a record says WHICH
             picture it holds; a PDF has no picture and the thumbnail simply hides. */
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={`/api/attachments/${value}`}
            alt=""
            className="h-7 w-7 shrink-0 rounded-control border border-success/30 bg-surface object-cover"
            onError={(e) => {
              e.currentTarget.style.display = "none";
            }}
          />
        ) : null}
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
            className="relative z-1 ml-auto cursor-pointer text-meta text-success hover:underline"
          >
            Remove
          </button>
        ) : null}
      </span>
      {upErr ? <span className="mt-1 block text-meta text-danger">{upErr}</span> : null}
    </span>
  );
}

/** A CSV chosen from the device and read here: the value is its text, so nothing is uploaded until the form is sent. */
function CsvPicker({ value, error, onChange }: { value: string; error: boolean; onChange: (v: string) => void }) {
  const [name, setName] = useState("");
  const rows = value ? value.split(/\r?\n/).filter((l) => l.trim()).length : 0;
  return (
    <span
      className={cx(
        "relative flex h-10 w-full cursor-pointer items-center gap-2 rounded-control border px-3 text-sm",
        value ? "border-success bg-success-soft text-success" : cx("border-dashed bg-surface text-body hover:bg-canvas", error ? "border-danger" : "border-line-strong"),
      )}
    >
      {value ? `✓ ${name || "CSV"} · ${rows} lines` : "Choose a CSV file"}
      <input
        type="file"
        accept=".csv,text/csv"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (!file) return;
          setName(file.name);
          void file.text().then(onChange);
        }}
        className="absolute inset-0 cursor-pointer opacity-0"
      />
    </span>
  );
}

/**
 * A photo or video as a square tile: its name and a camera inside while
 * empty, the picture itself once taken, with × to take it off. Several sit
 * side by side, so a dialog asking for eight pictures reads as one glance.
 */
export function PhotoTile({ f, value, error, onChange }: { f: FieldSpec; value: string; error?: string; onChange: (v: string) => void }) {
  const kind = f.t === "video" ? "video" : "photo";
  const { busy, name, setName, upErr, pick } = useUpload(kind, f.upload, onChange);
  const [noPreview, setNoPreview] = useState(false);
  const done = !!value;
  const message = error || upErr;
  return (
    <div className="min-w-0" role="group" aria-label={f.l}>
      <div
        className={cx(
          "relative flex aspect-[4/3] w-full flex-col items-center justify-center gap-1.5 overflow-hidden rounded-card border text-center",
          done ? "border-success bg-success-soft text-success" : cx("border-dashed bg-surface text-muted hover:border-brand hover:bg-brand-soft hover:text-brand-hover", message ? "border-danger" : "border-line-strong"),
        )}
      >
        {done && kind === "photo" && !noPreview ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={`/api/attachments/${value}`} alt="" className="absolute inset-0 h-full w-full object-cover" onError={() => setNoPreview(true)} />
        ) : (
          <>
            <Icon n={done ? "file" : kind === "video" ? "video" : "camera"} s={22} />
            <span className="px-2 text-meta font-medium text-body">{busy ? "Uploading…" : done ? (kind === "video" ? "Video added" : "Attached") : f.l}</span>
          </>
        )}
        {done && kind === "photo" && !noPreview ? (
          <span className="absolute inset-x-0 bottom-0 truncate bg-ink/60 px-2 py-1 text-left text-meta font-medium text-white">{f.l}</span>
        ) : null}
        <input
          type="file"
          aria-label={done ? `Replace ${f.l}` : f.l}
          accept={kind === "video" ? "video/*" : "image/*,application/pdf"}
          capture={kind === "photo" ? "environment" : undefined}
          onChange={(e) => {
            setNoPreview(false);
            pick(e.target.files?.[0]);
          }}
          className="absolute inset-0 cursor-pointer opacity-0"
        />
        {done ? (
          <button
            type="button"
            aria-label={`Remove ${f.l}`}
            title={name ? `Remove ${name}` : "Remove"}
            onClick={() => {
              onChange("");
              setName("");
            }}
            className="absolute top-1.5 right-1.5 z-1 flex h-6 w-6 cursor-pointer items-center justify-center rounded-full bg-ink/60 text-white hover:bg-ink/80"
          >
            <Icon n="x" s={12} />
          </button>
        ) : null}
      </div>
      {message ? <span className="mt-1 block text-meta text-danger">{message}</span> : null}
    </div>
  );
}
