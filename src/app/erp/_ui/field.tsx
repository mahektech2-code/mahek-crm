"use client";

import { useState } from "react";
import type { FieldSpec } from "@/lib/erp/ui";
import { Icon } from "./icons";

/* ---------------------------------------------------------------------------
 * One form field, drawn as the design draws every field in every form and
 * prompt: an uppercase label with its tag (Calculated / AI suggestion /
 * Optional), the control, then the error under it or else the hint.
 * ------------------------------------------------------------------------- */

const LABEL: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 6,
  fontSize: 12,
  fontWeight: 500,
  textTransform: "uppercase",
  letterSpacing: "0.04em",
  color: "#6B7385",
  marginBottom: 5,
};

function base(err: boolean): React.CSSProperties {
  return {
    width: "100%",
    height: 38,
    padding: "0 10px",
    border: `1px solid ${err ? "#B3261E" : "#C2C8D2"}`,
    borderRadius: 4,
    fontSize: 14,
    background: "#FFFFFF",
    color: "#161616",
  };
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
  const tag = f.t === "derived" ? "Calculated" : f.t === "suggest" ? "AI suggestion" : !f.req ? "Optional" : "";
  /* A control with several buttons inside cannot sit in a <label>: every
     button would take the whole label as its name, and a click on the label
     text would press the first one. Those fields are a named group instead. */
  const grouped = f.t === "multi" || f.t === "photo" || f.t === "video" || f.t === "suggest";
  const Wrap = grouped ? "div" : "label";
  return (
    <Wrap style={{ display: "block", minWidth: 0 }} {...(grouped ? { role: "group", "aria-label": f.l } : {})}>
      <span style={LABEL}>
        {f.l}
        {tag ? (
          <span
            style={{
              fontSize: 11,
              fontWeight: 500,
              padding: "1px 6px",
              borderRadius: 8,
              background: f.t === "derived" ? "#EDEFF3" : f.t === "suggest" ? "#F1ECFF" : "transparent",
              color: f.t === "suggest" ? "#5223E0" : "#6B7385",
              textTransform: "none",
              letterSpacing: 0,
            }}
          >
            {tag}
          </span>
        ) : null}
      </span>
      <Control f={f} value={value} error={!!error} opts={opts} derived={derived} onChange={onChange} onMic={onMic} onUseSuggestion={onUseSuggestion} />
      {error ? (
        <span style={{ display: "block", fontSize: 13, fontWeight: 500, color: "#B3261E", marginTop: 4 }}>{error}</span>
      ) : f.hint ? (
        <span style={{ display: "block", fontSize: 12, color: "#6B7385", marginTop: 4 }}>{f.hint}</span>
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
  if (f.t === "derived") {
    return (
      <span
        style={{
          minHeight: 38,
          display: "flex",
          alignItems: "center",
          padding: "0 10px",
          borderRadius: 4,
          background: "#F7F8FA",
          border: `1px dashed ${error ? "#B3261E" : "#DDE1E8"}`,
          fontSize: 14,
          color: derived ? "#161616" : "#C2C8D2",
          fontVariantNumeric: "tabular-nums",
        }}
      >
        {derived || "—"}
      </span>
    );
  }
  if (f.t === "suggest") {
    const has = !!derived;
    return (
      <span
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          minHeight: 38,
          padding: "6px 8px 6px 10px",
          borderRadius: 4,
          border: "1px dashed #B9A5FF",
          background: "#F7F4FF",
          fontSize: 14,
          color: has ? "#3D14A8" : "#6B7385",
        }}
      >
        <span style={{ flex: 1, minWidth: 0 }}>{has ? derived : "Keep typing the description for a suggestion"}</span>
        {has ? (
          <button
            type="button"
            onClick={() => onUseSuggestion?.(derived!)}
            style={{ height: 28, padding: "0 10px", border: "1px solid #6835FB", background: "#FFFFFF", borderRadius: 4, color: "#5223E0", fontSize: 13, fontWeight: 500, cursor: "pointer", flex: "none" }}
          >
            Use it
          </button>
        ) : null}
      </span>
    );
  }
  if (f.t === "area") {
    return (
      <span style={{ position: "relative", display: "block" }}>
        <textarea
          value={value}
          readOnly={f.readOnly}
          onChange={(e) => onChange(e.target.value)}
          style={{ ...base(error), height: 72, padding: "8px 10px", resize: "vertical" }}
        />
        {onMic && f.mic ? (
          <button
            type="button"
            onClick={onMic}
            title="Dictate — speak in any language"
            style={{ position: "absolute", right: 6, bottom: 8, width: 30, height: 30, border: "1px solid #DDD2FF", background: "#F1ECFF", borderRadius: 15, color: "#5223E0", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" }}
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
      <select value={value} disabled={f.readOnly} onChange={(e) => onChange(e.target.value)} style={base(error)}>
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
      <span
        style={{
          display: "flex",
          flexWrap: "wrap",
          gap: 6,
          padding: 6,
          border: `1px solid ${error ? "#B3261E" : "#C2C8D2"}`,
          borderRadius: 4,
          minHeight: 38,
          background: "#FFFFFF",
        }}
      >
        {opts.length === 0 ? <span style={{ fontSize: 13, color: "#6B7385", padding: "4px" }}>Nothing available</span> : null}
        {opts.map((o) => {
          const on = chosen.includes(o);
          return (
            <button
              type="button"
              key={o}
              onClick={() => toggle(o)}
              style={{
                height: 28,
                padding: "0 10px",
                borderRadius: 14,
                border: `1px solid ${on ? "#6835FB" : "#DDE1E8"}`,
                background: on ? "#F1ECFF" : "#FFFFFF",
                color: on ? "#5223E0" : "#3D4453",
                fontSize: 13,
                fontWeight: on ? 500 : 400,
                cursor: "pointer",
              }}
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
      style={base(error)}
    />
  );
}

/** A select with more than twelve options becomes a search box, as in the design. */
function Combo({ value, opts, error, onChange }: { value: string; opts: string[]; error: boolean; onChange: (v: string) => void }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const ql = q.trim().toLowerCase();
  const m = ql ? opts.filter((x) => x.toLowerCase().includes(ql)) : opts;
  return (
    <span style={{ position: "relative", display: "block" }}>
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
        style={{ ...base(error), padding: "0 30px 0 10px" }}
      />
      <span style={{ position: "absolute", right: 10, top: 11, color: "#6B7385", display: "flex", pointerEvents: "none" }}>
        <Icon n="search" />
      </span>
      {open ? (
        <span
          style={{
            position: "absolute",
            left: 0,
            right: 0,
            top: 42,
            zIndex: 12,
            display: "block",
            background: "#FFFFFF",
            border: "1px solid #DDE1E8",
            borderRadius: 6,
            boxShadow: "0 8px 24px rgba(22,22,22,0.12)",
            maxHeight: 300,
            overflowY: "auto",
          }}
        >
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
              style={{
                display: "block",
                width: "100%",
                minHeight: 34,
                padding: "7px 12px",
                border: "none",
                background: x === value ? "#F1ECFF" : "#FFFFFF",
                color: "#161616",
                fontSize: 14,
                cursor: "pointer",
                textAlign: "left",
              }}
            >
              {x}
            </button>
          ))}
          {m.length > 8 ? (
            <span style={{ display: "block", padding: "8px 12px", borderTop: "1px solid #EDEFF3", fontSize: 12, color: "#6B7385" }}>
              {(m.length - 8).toLocaleString("en-IN")} more — keep typing
            </span>
          ) : null}
          {m.length === 0 ? (
            <span style={{ display: "block", padding: "10px 12px", fontSize: 13, color: "#6B7385" }}>Nothing matches “{q}”</span>
          ) : null}
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
    <span style={{ display: "block" }}>
      <span
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          width: "100%",
          height: 44,
          padding: "0 12px",
          border: `1px ${done ? "solid #1D7A45" : `dashed ${error ? "#B3261E" : "#C2C8D2"}`}`,
          borderRadius: 4,
          background: done ? "#E9F5EE" : "#FFFFFF",
          color: done ? "#1D7A45" : "#3D4453",
          fontSize: 14,
          cursor: "pointer",
          position: "relative",
        }}
      >
        {busy ? "Uploading…" : done ? `✓ ${name || "Attached"}` : kind === "video" ? "Record or upload a video" : "Take or upload a photo"}
        <input
          type="file"
          accept={kind === "video" ? "video/*" : "image/*,application/pdf"}
          capture={kind === "photo" ? "environment" : undefined}
          onChange={(e) => pick(e.target.files?.[0])}
          style={{ position: "absolute", inset: 0, opacity: 0, cursor: "pointer" }}
        />
        {done ? (
          <button
            type="button"
            onClick={(e) => {
              e.preventDefault();
              onChange("");
              setName("");
            }}
            style={{ marginLeft: "auto", position: "relative", zIndex: 1, border: "none", background: "transparent", color: "#1D7A45", cursor: "pointer", fontSize: 13 }}
          >
            Remove
          </button>
        ) : null}
      </span>
      {upErr ? <span style={{ display: "block", fontSize: 13, color: "#B3261E", marginTop: 4 }}>{upErr}</span> : null}
    </span>
  );
}
