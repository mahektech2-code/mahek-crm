"use client";

import { useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { LANGUAGE_NAMES } from "@/lib/studio/domain/language";
import {
  canvasById,
  EXTRA_LANGUAGES,
  FONT_LIMITS,
  MAX_MESSAGES,
  MESSAGE_MAX_CHARS,
  PLACEABLE,
  PLACEABLE_KEYS,
  checkPlacement,
  defaultPlacement,
  type ExtraLanguage,
  type LangContent,
  type PlaceableKey,
  type PlacedField,
  type PlacementDraft,
} from "@/lib/studio/domain/template-upload";
import { Button, Card } from "@/components/ui/primitives";
import { useToast } from "@/components/ui/toast";
import { approveDesign, deleteDraft, publishDesign, saveDraftPlacement, sendDesignBack } from "@/lib/actions/studio";

/* ---------------------------------------------------------------------------
 * THE PLACEMENT EDITOR, carried over from the standalone Studio. The uploader
 * drags and resizes boxes over their artwork and sets how the text looks;
 * Preview draws it with the real renderer and sample values, and lists what
 * does not fit. Whoever approves designs sees the same screen, read-only,
 * with Approve and Send back.
 * ------------------------------------------------------------------------- */

const inputClass = "ui-control h-8.5 w-full rounded-control border border-line bg-surface px-2.5 text-sm text-ink disabled:opacity-60";
type Mode = "move" | "resize";
type Issue = { field?: string | null; message: string };
type ServerPreview = { image: string; errors: Issue[]; warnings: Issue[] };

type Props = { draftId: string; initial: PlacementDraft; occasions: { id: string; label: string }[]; approved: boolean; owner: boolean; canApprove: boolean; /** The owner may publish their own draft: the library publishes immediately. */ canPublish?: boolean };

const EMPTY_CONTENT: LangContent = { messages: [], statics: {} };

export function DesignEditor({ draftId, initial, occasions, approved, owner, canApprove, canPublish = false }: Props) {
  const router = useRouter();
  const toast = useToast();
  const [note, setNote] = useState("");
  const [draft, setDraft] = useState<PlacementDraft>(initial);
  const [selected, setSelected] = useState<PlaceableKey | null>(initial.fields[0]?.key ?? null);
  const [preview, setPreview] = useState<ServerPreview | null>(null);
  const [showPreview, setShowPreview] = useState(false);
  const [busy, setBusy] = useState<"save" | "preview" | "approve" | "publish" | "back" | "delete" | null>(null);
  const [status, setStatus] = useState<{ tone: "ok" | "err"; text: string } | null>(null);
  const [dirty, setDirty] = useState(false);
  const stage = useRef<HTMLDivElement>(null);
  const drag = useRef<{ key: PlaceableKey; mode: Mode; px: number; py: number; start: PlacedField } | null>(null);

  const canvas = canvasById(draft.canvas)!;
  const local = useMemo(() => checkPlacement(draft), [draft]);
  const field = draft.fields.find((f) => f.key === selected) ?? null;
  const locked = approved || !owner || busy !== null;

  const change = (next: PlacementDraft) => {
    setDraft(next);
    setDirty(true);
    setPreview(null);
    setShowPreview(false);
    setStatus(null);
  };
  const patch = (key: PlaceableKey, p: Partial<PlacedField>) => change({ ...draft, fields: draft.fields.map((f) => (f.key === key ? { ...f, ...p } : f)) });
  const add = (key: PlaceableKey) => {
    change({ ...draft, fields: [...draft.fields, defaultPlacement(key, canvas, draft.fields)] });
    setSelected(key);
  };
  const remove = (key: PlaceableKey) => {
    change({ ...draft, fields: draft.fields.filter((f) => f.key !== key) });
    setSelected(null);
  };

  // ---- pointer dragging: the pointer moves in screen pixels, the boxes are in canvas pixels -----------------------------------
  const scale = () => (stage.current ? canvas.width / stage.current.getBoundingClientRect().width : 1);
  const clampBox = (b: PlacedField): Partial<PlacedField> => {
    const w = Math.max(40, Math.min(b.w, canvas.width));
    const h = Math.max(20, Math.min(b.h, canvas.height));
    return { w, h, x: Math.max(0, Math.min(b.x, canvas.width - w)), y: Math.max(0, Math.min(b.y, canvas.height - h)) };
  };
  const onDown = (e: React.PointerEvent, f: PlacedField, mode: Mode) => {
    if (locked) return;
    e.preventDefault();
    e.stopPropagation();
    setSelected(f.key);
    drag.current = { key: f.key, mode, px: e.clientX, py: e.clientY, start: f };
    try {
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    } catch {
      // the drag still works while the pointer stays over the stage
    }
  };
  const onMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const k = scale();
    const dx = Math.round((e.clientX - d.px) * k);
    const dy = Math.round((e.clientY - d.py) * k);
    const next = d.mode === "move" ? { ...d.start, x: d.start.x + dx, y: d.start.y + dy } : { ...d.start, w: d.start.w + dx, h: d.start.h + dy };
    setDraft((cur) => ({ ...cur, fields: cur.fields.map((f) => (f.key === d.key ? { ...f, ...clampBox(next) } : f)) }));
    setDirty(true);
    setPreview(null);
    setShowPreview(false);
  };
  const onUp = () => {
    drag.current = null;
  };
  const onKey = (e: React.KeyboardEvent, f: PlacedField) => {
    if (locked) return;
    const step = e.shiftKey ? 10 : 1;
    const move: Record<string, [number, number]> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
    const m = move[e.key];
    if (!m) return;
    e.preventDefault();
    patch(f.key, clampBox(e.altKey ? { ...f, w: f.w + m[0], h: f.h + m[1] } : { ...f, x: f.x + m[0], y: f.y + m[1] }));
  };

  // ---- server calls ------------------------------------------------------------------------------------------------------------
  async function save(): Promise<boolean> {
    if (!owner || approved) return true;
    setBusy("save");
    const r = await saveDraftPlacement(draftId, draft);
    setBusy(null);
    if (!r.ok) {
      setStatus({ tone: "err", text: r.error });
      return false;
    }
    setDirty(false);
    setStatus({ tone: "ok", text: "Draft saved." });
    return true;
  }
  async function runPreview() {
    setBusy("preview");
    try {
      const res = await fetch(`/api/studio/designs/${draftId}/sample`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(draft) });
      const j = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string; data?: { image: string; errors: string[]; warnings: string[] } };
      if (!res.ok || !j.data) return setStatus({ tone: "err", text: j.error ?? "The preview could not be drawn." });
      setPreview({ image: j.data.image, errors: j.data.errors.map((message) => ({ message })), warnings: j.data.warnings.map((message) => ({ message })) });
      setShowPreview(true);
      setStatus(null);
    } catch {
      setStatus({ tone: "err", text: "The server could not be reached. Check your connection and try again." });
    } finally {
      setBusy(null);
    }
  }
  async function approve() {
    if (dirty && !(await save())) return;
    setBusy("approve");
    const r = await toast.run(approveDesign(draftId));
    setBusy(null);
    if (!r.ok) return setStatus({ tone: "err", text: r.error });
    router.push("/studio/designs");
    router.refresh();
  }
  async function publish() {
    if (dirty && !(await save())) return;
    setBusy("publish");
    const r = await toast.run(publishDesign(draftId));
    setBusy(null);
    if (!r.ok) return setStatus({ tone: "err", text: r.error });
    router.push("/studio/designs");
    router.refresh();
  }
  async function sendBack() {
    setBusy("back");
    const r = await toast.run(sendDesignBack(draftId, note));
    setBusy(null);
    if (r.ok) router.push("/studio/approvals");
  }
  async function removeDraft() {
    setBusy("delete");
    const r = await toast.run(deleteDraft(draftId));
    setBusy(null);
    if (r.ok) router.push("/studio/designs");
  }

  const issues = preview ? [...preview.errors, ...preview.warnings.map((w) => ({ ...w, warn: true }))] : [...local.errors, ...local.warnings.map((w) => ({ ...w, warn: true }))];
  const blocking = local.errors.length > 0 || (preview?.errors.length ?? 0) > 0;
  const num = (label: string, value: number, onChange: (n: number) => void, id: string, min?: number, max?: number) => (
    <label className="flex flex-col gap-0.5 text-xs font-medium text-muted" htmlFor={id}>
      {label}
      <input id={id} data-testid={id} type="number" value={value} min={min} max={max} disabled={locked} onChange={(e) => onChange(Math.round(Number(e.target.value)))} className={inputClass} />
    </label>
  );
  const missingMessage = draft.fields.some((f) => f.key === "greeting");
  const extra = EXTRA_LANGUAGES.filter((l) => draft.languages?.includes(l));
  const statics = draft.fields.filter((f) => PLACEABLE[f.key].kind === "static");
  const toggleLanguage = (l: ExtraLanguage, on: boolean) => {
    const languages = EXTRA_LANGUAGES.filter((x) => (x === l ? on : draft.languages?.includes(x)));
    change({ ...draft, languages, i18n: withContent(l, draft.i18n?.[l] ?? EMPTY_CONTENT) });
  };
  const content = (l: ExtraLanguage): LangContent => draft.i18n?.[l] ?? EMPTY_CONTENT;
  const withContent = (l: ExtraLanguage, next: LangContent): NonNullable<PlacementDraft["i18n"]> => {
    const all: NonNullable<PlacementDraft["i18n"]> = { ...draft.i18n };
    all[l] = next;
    return all;
  };
  const setContent = (l: ExtraLanguage, next: LangContent) => change({ ...draft, i18n: withContent(l, next) });

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_360px]" data-testid="template-editor">
      <div className="flex min-w-0 flex-col gap-3 lg:sticky lg:top-4 lg:self-start">
        <Card className="p-4">
          <div
            ref={stage}
            className="relative mx-auto w-full max-w-[640px] select-none overflow-hidden rounded-lg border border-line bg-surface"
            style={{ aspectRatio: `${canvas.width} / ${canvas.height}`, containerType: "inline-size", touchAction: "none" }}
            onPointerMove={onMove}
            onPointerUp={onUp}
            onPointerCancel={onUp}
            onPointerDown={() => setSelected(null)}
            data-testid="editor-stage"
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={showPreview && preview ? preview.image : `/api/studio/designs/${draftId}/background`} alt={showPreview ? "Preview of the poster with sample values" : "The uploaded design"} className="absolute inset-0 h-full w-full" draggable={false} data-testid="editor-image" />
            {showPreview && preview ? (
              <span className="absolute bottom-2 left-2 rounded bg-black/70 px-2 py-1 text-xs font-bold text-white" data-testid="preview-badge">
                PREVIEW ONLY - sample values, not a real poster
              </span>
            ) : (
              draft.fields.map((f) => {
                const def = PLACEABLE[f.key];
                const on = f.key === selected;
                return (
                  <div
                    key={f.key}
                    role="button"
                    tabIndex={0}
                    aria-label={`${def.label}. Arrow keys move it, Alt and arrows resize it.`}
                    data-testid={`box-${f.key}`}
                    onPointerDown={(e) => onDown(e, f, "move")}
                    onKeyDown={(e) => onKey(e, f)}
                    onFocus={() => setSelected(f.key)}
                    className={`absolute cursor-move overflow-hidden ${on ? "z-10 outline outline-2 outline-brand" : "outline outline-1 outline-dashed outline-white/80"}`}
                    style={{
                      left: `${(f.x / canvas.width) * 100}%`,
                      top: `${(f.y / canvas.height) * 100}%`,
                      width: `${(f.w / canvas.width) * 100}%`,
                      height: `${(f.h / canvas.height) * 100}%`,
                      display: "flex",
                      justifyContent: f.align === "left" ? "flex-start" : f.align === "right" ? "flex-end" : "center",
                      alignItems: f.vAlign === "top" ? "flex-start" : f.vAlign === "bottom" ? "flex-end" : "center",
                      textAlign: f.align,
                      color: f.color,
                      fontWeight: f.weight,
                      fontSize: `${(f.size / canvas.width) * 100}cqw`,
                      lineHeight: 1.2,
                      textShadow: "0 0 2px rgba(0,0,0,.6)",
                      background: "rgba(255,255,255,.12)",
                    }}
                  >
                    {def.kind === "logo" ? <span style={{ fontSize: "2.5cqw" }}>Mahek logo</span> : def.kind === "static" ? (f.text ?? def.sample) : def.sample}
                    {on && !locked ? <span onPointerDown={(e) => onDown(e, f, "resize")} data-testid={`resize-${f.key}`} aria-hidden className="absolute bottom-0 right-0 h-4 w-4 cursor-nwse-resize bg-brand" /> : null}
                  </div>
                );
              })
            )}
          </div>
          <p className="mt-2 text-center text-xs text-muted">
            {showPreview ? "This is the renderer's output with made-up sample values." : "Text on the boxes is sample text. Drag a box to move it, drag the corner to resize it."}
          </p>
        </Card>

        <Card className="p-4">
          <h3 className="mb-2 text-sm font-semibold text-ink">Checks before approval</h3>
          {issues.length === 0 ? (
            <p className="text-sm text-success" data-testid="checks-clear">
              No problems found{preview ? " in the preview" : ""}.
            </p>
          ) : (
            <ul className="m-0 flex list-none flex-col gap-1.5 p-0 text-sm" data-testid="checks">
              {issues.map((i, n) => (
                <li key={n} className={"warn" in i ? "text-muted" : "text-danger"}>
                  {"warn" in i ? "Note: " : "Fix: "}
                  {i.message}
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      <div className="flex min-w-0 flex-col gap-3">
        <Card className="p-4">
          <h3 className="mb-2 text-sm font-semibold text-ink">Template</h3>
          <label className="mb-2 flex flex-col gap-0.5 text-xs font-medium text-muted" htmlFor="tpl-name">
            Name
            <input id="tpl-name" data-testid="tpl-name" className={inputClass} value={draft.name} maxLength={60} disabled={locked} onChange={(e) => change({ ...draft, name: e.target.value })} />
          </label>
          <label className="flex flex-col gap-0.5 text-xs font-medium text-muted" htmlFor="tpl-occasion">
            Occasion (where it is listed)
            <select id="tpl-occasion" data-testid="tpl-occasion" className={inputClass} value={draft.occasion} disabled={locked} onChange={(e) => change({ ...draft, occasion: e.target.value })}>
              {occasions.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
          <p className="mt-2 text-xs text-muted">Size: {canvas.label} (from your image). Font: Noto Sans, regular or bold.</p>
        </Card>

        <Card className="p-4">
          <h3 className="mb-1 text-sm font-semibold text-ink">Languages</h3>
          <p className="mb-2 text-xs text-muted">English is always included. Add Hindi or Gujarati and give each its own wording — nothing is translated for you, and a language with anything missing stops the design being published.</p>
          <div className="flex flex-wrap gap-3">
            <label className="flex items-center gap-1.5 text-sm text-ink">
              <input type="checkbox" checked disabled /> English
            </label>
            {EXTRA_LANGUAGES.map((l) => (
              <label key={l} className="flex items-center gap-1.5 text-sm text-ink">
                <input type="checkbox" data-testid={`lang-${l}`} checked={extra.includes(l)} disabled={locked} onChange={(e) => toggleLanguage(l, e.target.checked)} />
                {LANGUAGE_NAMES[l]}
              </label>
            ))}
          </div>
          {extra.map((l) => (
            <div key={l} className="mt-3 border-t border-divider pt-3" data-testid={`lang-panel-${l}`}>
              <h4 className="mb-1 text-xs font-semibold text-ink">{LANGUAGE_NAMES[l]}</h4>
              {statics.map((f) => (
                <label key={f.key} className="mb-2 flex flex-col gap-0.5 text-xs font-medium text-muted">
                  {PLACEABLE[f.key].label} in {LANGUAGE_NAMES[l]}
                  <input
                    className={inputClass}
                    lang={l}
                    data-testid={`static-${l}-${f.key}`}
                    value={content(l).statics[f.key] ?? ""}
                    maxLength={120}
                    disabled={locked}
                    onChange={(e) => setContent(l, { ...content(l), statics: { ...content(l).statics, [f.key]: e.target.value } })}
                  />
                </label>
              ))}
              {missingMessage ? (
                <label className="flex flex-col gap-0.5 text-xs font-medium text-muted">
                  Promotional messages in {LANGUAGE_NAMES[l]} (one per line, up to {MAX_MESSAGES})
                  <textarea
                    className={`${inputClass} h-auto py-2`}
                    lang={l}
                    rows={4}
                    data-testid={`messages-${l}`}
                    disabled={locked}
                    value={content(l).messages.join("\n")}
                    onChange={(e) => setContent(l, { ...content(l), messages: e.target.value.split("\n").slice(0, MAX_MESSAGES + 2) })}
                  />
                </label>
              ) : null}
            </div>
          ))}
        </Card>

        <Card className="p-4">
          <h3 className="mb-2 text-sm font-semibold text-ink">Fields</h3>
          <div className="flex flex-wrap gap-1.5" data-testid="add-fields">
            {PLACEABLE_KEYS.filter((k) => !draft.fields.some((f) => f.key === k)).map((k) => (
              <Button key={k} disabled={locked || draft.fields.length >= 12} onClick={() => add(k)} data-testid={`add-${k}`} size="sm" title={PLACEABLE[k].hint}>
                + {PLACEABLE[k].label}
              </Button>
            ))}
          </div>
          {draft.fields.length > 0 ? (
            <ul className="m-0 mt-2 flex list-none flex-wrap gap-1.5 p-0">
              {draft.fields.map((f) => (
                <li key={f.key}>
                  <Button variant={f.key === selected ? "primary" : "secondary"} onClick={() => setSelected(f.key)} size="sm" data-testid={`select-${f.key}`}>
                    {PLACEABLE[f.key].label}
                  </Button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-2 text-sm text-muted">Add the first field above, for example the company name.</p>
          )}
        </Card>

        {field ? (
          <Card className="p-4">
            <h3 className="mb-1 text-sm font-semibold text-ink">{PLACEABLE[field.key].label}</h3>
            <p className="mb-2 text-xs text-muted">{PLACEABLE[field.key].hint}</p>
            <div className="grid grid-cols-2 gap-2">
              {num("Left (x)", field.x, (n) => patch(field.key, clampBox({ ...field, x: n })), "f-x")}
              {num("Top (y)", field.y, (n) => patch(field.key, clampBox({ ...field, y: n })), "f-y")}
              {num("Width", field.w, (n) => patch(field.key, clampBox({ ...field, w: n })), "f-w")}
              {num("Height", field.h, (n) => patch(field.key, clampBox({ ...field, h: n })), "f-h")}
            </div>
            {PLACEABLE[field.key].kind !== "logo" ? (
              <>
                <div className="mt-2 grid grid-cols-2 gap-2">
                  {num("Font size", field.size, (n) => patch(field.key, { size: n }), "f-size", FONT_LIMITS.min, FONT_LIMITS.max)}
                  {num("Smallest size", field.minSize, (n) => patch(field.key, { minSize: n }), "f-min", FONT_LIMITS.min, FONT_LIMITS.max)}
                  {num("Lines (wrap)", field.maxLines, (n) => patch(field.key, { maxLines: n }), "f-lines", 1, 6)}
                  <label className="flex flex-col gap-0.5 text-xs font-medium text-muted" htmlFor="f-color">
                    Colour
                    <input id="f-color" data-testid="f-color" type="color" value={/^#[0-9a-fA-F]{6}$/.test(field.color) ? field.color : "#ffffff"} disabled={locked} onChange={(e) => patch(field.key, { color: e.target.value.toUpperCase() })} className="h-8.5 w-full rounded-control border border-line bg-surface" />
                  </label>
                  <label className="flex flex-col gap-0.5 text-xs font-medium text-muted" htmlFor="f-align">
                    Align
                    <select id="f-align" data-testid="f-align" className={inputClass} value={field.align} disabled={locked} onChange={(e) => patch(field.key, { align: e.target.value as PlacedField["align"] })}>
                      <option value="left">Left</option>
                      <option value="center">Centre</option>
                      <option value="right">Right</option>
                    </select>
                  </label>
                  <label className="flex flex-col gap-0.5 text-xs font-medium text-muted" htmlFor="f-valign">
                    Vertical
                    <select id="f-valign" data-testid="f-valign" className={inputClass} value={field.vAlign} disabled={locked} onChange={(e) => patch(field.key, { vAlign: e.target.value as PlacedField["vAlign"] })}>
                      <option value="top">Top</option>
                      <option value="middle">Middle</option>
                      <option value="bottom">Bottom</option>
                    </select>
                  </label>
                  <label className="flex flex-col gap-0.5 text-xs font-medium text-muted" htmlFor="f-weight">
                    Weight
                    <select id="f-weight" data-testid="f-weight" className={inputClass} value={field.weight} disabled={locked} onChange={(e) => patch(field.key, { weight: Number(e.target.value) === 700 ? 700 : 400 })}>
                      <option value={400}>Regular</option>
                      <option value={700}>Bold</option>
                    </select>
                  </label>
                </div>
                {PLACEABLE[field.key].kind === "static" ? (
                  <label className="mt-2 flex flex-col gap-0.5 text-xs font-medium text-muted" htmlFor="f-text">
                    Fixed text
                    <input id="f-text" data-testid="f-text" className={inputClass} value={field.text ?? ""} maxLength={120} disabled={locked} onChange={(e) => patch(field.key, { text: e.target.value })} />
                  </label>
                ) : null}
              </>
            ) : (
              <label className="mt-2 flex flex-col gap-0.5 text-xs font-medium text-muted" htmlFor="f-logo">
                Logo version
                <select id="f-logo" className={inputClass} value={field.logoVariant ?? "light"} disabled={locked} onChange={(e) => patch(field.key, { logoVariant: e.target.value === "dark" ? "dark" : "light" })}>
                  <option value="light">Light (for dark designs)</option>
                  <option value="dark">Dark (for light designs)</option>
                </select>
              </label>
            )}
            <Button variant="ghost" size="sm" className="mt-2" disabled={locked} onClick={() => remove(field.key)} data-testid="remove-field">
              Remove this field
            </Button>
          </Card>
        ) : null}

        {missingMessage ? (
          <Card className="p-4">
            <h3 className="mb-1 text-sm font-semibold text-ink">Approved promotional messages</h3>
            <p className="mb-2 text-xs text-muted">One per line, up to {MAX_MESSAGES}, at most {MESSAGE_MAX_CHARS} characters each. No links, prices, offers or phone numbers. Senders can only pick from these or write their own.</p>
            <textarea
              data-testid="tpl-messages"
              rows={4}
              className={inputClass}
              disabled={locked}
              value={draft.messages.join("\n")}
              onChange={(e) => change({ ...draft, messages: e.target.value.split("\n").slice(0, MAX_MESSAGES + 2) })}
            />
          </Card>
        ) : null}

        <Card className="p-4">
          {status ? (
            <p role="status" className={`mb-2 text-sm ${status.tone === "ok" ? "text-success" : "text-danger"}`}>
              {status.text}
            </p>
          ) : null}
          <div className="flex flex-wrap gap-2">
            {owner && !approved ? (
              <Button onClick={save} disabled={locked || !dirty}>
                {busy === "save" ? "Saving…" : "Save draft"}
              </Button>
            ) : null}
            <Button onClick={runPreview} disabled={busy !== null || draft.fields.length === 0}>
              {busy === "preview" ? "Drawing…" : "Preview"}
            </Button>
            {showPreview ? (
              <Button variant="ghost" onClick={() => setShowPreview(false)}>
                Back to the boxes
              </Button>
            ) : null}
            {canPublish && owner && !approved ? (
              <Button variant="primary" onClick={publish} disabled={busy !== null || blocking || (!preview && local.errors.length > 0)} data-testid="publish">
                {busy === "publish" ? "Publishing…" : "Publish to the library"}
              </Button>
            ) : null}
            {canApprove && !approved && !(canPublish && owner) ? (
              <Button variant="primary" onClick={approve} disabled={busy !== null || blocking || (!preview && local.errors.length > 0)}>
                {busy === "approve" ? "Approving…" : "Approve and publish"}
              </Button>
            ) : null}
          </div>
          <p className="mt-2 text-xs text-muted">
            {approved
              ? "A published design never changes, so every poster made from one draws the same for ever. To change it, archive it and upload a revised version."
              : canPublish && owner
                ? "Publishing checks it in every language it declares and offers it to everybody in the Studio at once. Only a design that passes can be published."
                : canApprove
                ? "Approving checks it with sample values and publishes it to everybody in the Studio. It can never be changed afterwards."
                : "This draft is private to you. Save it as you go — Preview does not save. Somebody who approves designs will publish it."}
          </p>
          {canApprove && !approved && !owner ? (
            <div className="mt-3 border-t border-divider pt-3">
              <label className="flex flex-col gap-1 text-xs font-medium text-muted">
                Send it back with a note
                <textarea className={`${inputClass} h-auto py-2`} rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder="The phone number overlaps the logo." />
              </label>
              <Button size="sm" className="mt-2" onClick={sendBack} disabled={busy !== null || !note.trim()}>
                {busy === "back" ? "Sending…" : "Send back"}
              </Button>
            </div>
          ) : null}
          {owner && !approved ? (
            <div className="mt-3 border-t border-divider pt-3">
              <Button size="sm" variant="ghost" onClick={removeDraft} disabled={busy !== null}>
                Delete this draft
              </Button>
            </div>
          ) : null}
        </Card>
      </div>
    </div>
  );
}
