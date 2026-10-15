"use client";

import * as React from "react";
import { Button, Field, Input, Select, Textarea } from "@/components/ui/primitives";
import { getAt, setAt, type FieldDef } from "./field-defs";
import { useCmsEnv } from "./cms-env";
import { MediaPicker, MediaThumb } from "./media-picker";

/* ---------------------------------------------------------------------------
 * DRAWS A LIST OF FIELD DEFINITIONS (`field-defs.ts`) AGAINST A RECORD.
 *
 * It changes only the value it is given and reports every change upward; it
 * validates nothing itself. Problems come in from the server's own rules (the
 * same zod schemas, run in the browser before a save and again on the server),
 * keyed by dotted path, and are shown under the field they belong to.
 * ------------------------------------------------------------------------- */

export type Errors = Record<string, string>;

/**
 * One message per field, and the FIRST one: a value can fail several rules at once
 * (a link with a space in it fails "no spaces" and "must start with /"), and the
 * rules are written so the first is the most useful thing to say.
 */
export function firstPerPath(issues: { path: string; message: string }[]): Errors {
  const out: Errors = {};
  for (const i of issues) if (!(i.path in out)) out[i.path] = i.message;
  return out;
}

type Props = {
  fields: FieldDef[];
  value: Record<string, unknown>;
  onChange: (next: Record<string, unknown>) => void;
  errors: Errors;
  /** The record already exists: a field that may not change after creation is shown read-only. */
  existing: boolean;
  /** A path prefix, for fields inside a repeated row. */
  base?: string;
};

const join = (base: string | undefined, path: string) => (base ? `${base}.${path}` : path);

function Counter({ text, limit }: { text: string; limit: number }) {
  const over = text.length > limit;
  return <span className={over ? "text-danger" : "text-muted"}>{text.length}/{limit} characters</span>;
}

/** A label above a custom control. `Field` wraps in a <label>, which would hijack clicks on several inputs. */
function Block({ label, hint, error, children, counter }: { label: string; hint?: string; error?: string; children: React.ReactNode; counter?: React.ReactNode }) {
  return (
    <div className="block">
      <div className="mb-1 text-xs font-medium tracking-[0.04em] text-muted uppercase">{label}</div>
      {children}
      {error ? (
        <div className="mt-1 text-[13px] text-danger">{error}</div>
      ) : hint || counter ? (
        <div className="mt-1 text-[13px] text-muted">
          {hint}
          {counter}
        </div>
      ) : null}
    </div>
  );
}

export function FieldEditor({ fields, value, onChange, errors, existing, base }: Props) {
  const { products } = useCmsEnv();
  const [picker, setPicker] = React.useState<{ path: string } | null>(null);

  const set = (path: string, v: unknown) => onChange(setAt(value, path, v));
  const errOf = (path: string) => errors[join(base, path)];

  const text = (path: string) => {
    const v = getAt(value, path);
    return typeof v === "string" ? v : "";
  };

  return (
    <div className="flex flex-col gap-3.5">
      {fields.map((f, idx) => {
        const key = `${"path" in f ? f.path : f.label}-${idx}`;
        switch (f.type) {
          case "text": {
            const v = text(f.path);
            const readOnly = f.readOnlyWhenExisting && existing;
            return (
              <Field
                key={key}
                label={f.label}
                hint={f.hint}
                error={errOf(f.path)}
              >
                <Input
                  value={v}
                  placeholder={f.placeholder}
                  maxLength={f.maxLength ? f.maxLength + 200 : undefined}
                  disabled={readOnly}
                  invalid={!!errOf(f.path)}
                  onChange={(e) => {
                    const next = e.target.value;
                    set(f.path, next === "" && f.emptyAs ? (f.emptyAs === "null" ? null : undefined) : next);
                  }}
                />
                {f.counter ? <span className="mt-1 block text-[13px]"><Counter text={v} limit={f.counter} /></span> : null}
              </Field>
            );
          }
          case "textarea": {
            const v = text(f.path);
            return (
              <Field key={key} label={f.label} hint={f.hint} error={errOf(f.path)}>
                <Textarea
                  rows={f.rows ?? 3}
                  value={v}
                  invalid={!!errOf(f.path)}
                  onChange={(e) => set(f.path, e.target.value === "" && f.emptyAs ? undefined : e.target.value)}
                />
                {f.counter ? <span className="mt-1 block text-[13px]"><Counter text={v} limit={f.counter} /></span> : null}
              </Field>
            );
          }
          case "number": {
            const v = getAt(value, f.path);
            return (
              <Field key={key} label={f.label} hint={f.hint} error={errOf(f.path)}>
                <Input
                  type="number"
                  step={f.step ?? 1}
                  value={typeof v === "number" && Number.isFinite(v) ? v : ""}
                  invalid={!!errOf(f.path)}
                  onChange={(e) => set(f.path, e.target.value === "" ? undefined : Number(e.target.value))}
                />
              </Field>
            );
          }
          case "select": {
            const v = text(f.path);
            return (
              <Field key={key} label={f.label} hint={f.hint} error={errOf(f.path)}>
                <Select value={v} onChange={(e) => set(f.path, e.target.value === "" && f.emptyAs ? undefined : e.target.value)}>
                  {f.options.map((o) => (
                    <option key={o.value} value={o.value}>{o.label}</option>
                  ))}
                </Select>
              </Field>
            );
          }
          case "bool":
            return (
              <label key={key} className="flex cursor-pointer items-center gap-2 text-sm text-body">
                <input type="checkbox" checked={getAt(value, f.path) === true} onChange={(e) => set(f.path, e.target.checked ? true : undefined)} />
                {f.label}
              </label>
            );
          case "strings": {
            const list = (getAt(value, f.path) as string[] | undefined) ?? [];
            return (
              <Block key={key} label={f.label} hint={f.hint} error={errOf(f.path)}>
                <div className="flex flex-col gap-1.5">
                  {list.map((s, i) => (
                    <div key={i} className="flex items-center gap-1.5">
                      <Input
                        value={s}
                        placeholder={f.placeholder}
                        invalid={!!errors[join(base, `${f.path}.${i}`)]}
                        onChange={(e) => set(`${f.path}.${i}`, e.target.value)}
                        aria-label={`${f.label} ${i + 1}`}
                      />
                      <Button size="sm" variant="secondary" onClick={() => set(f.path, list.filter((_, j) => j !== i))} aria-label={`Remove ${f.label} ${i + 1}`}>×</Button>
                    </div>
                  ))}
                  <div><Button size="sm" variant="secondary" onClick={() => set(f.path, [...list, ""])}>{f.addLabel}</Button></div>
                </div>
              </Block>
            );
          }
          case "paragraphs": {
            const list = (getAt(value, f.path) as string[] | undefined) ?? [];
            return (
              <Block key={key} label={f.label} hint={f.hint} error={errOf(f.path)}>
                <div className="flex flex-col gap-1.5">
                  {list.map((s, i) => (
                    <div key={i} className="flex items-start gap-1.5">
                      <Textarea rows={4} value={s} invalid={!!errors[join(base, `${f.path}.${i}`)]} onChange={(e) => set(`${f.path}.${i}`, e.target.value)} aria-label={`${f.label} ${i + 1}`} />
                      <Button size="sm" variant="secondary" onClick={() => set(f.path, list.filter((_, j) => j !== i))} aria-label={`Remove paragraph ${i + 1}`}>×</Button>
                    </div>
                  ))}
                  <div><Button size="sm" variant="secondary" onClick={() => set(f.path, [...list, ""])}>{f.addLabel}</Button></div>
                </div>
              </Block>
            );
          }
          case "specs": {
            const rec = (getAt(value, f.path) as Record<string, string> | undefined) ?? {};
            const entries = Object.entries(rec);
            const write = (next: [string, string][]) => set(f.path, Object.fromEntries(next));
            return (
              <Block key={key} label={f.label} hint={f.hint} error={errOf(f.path)}>
                <div className="flex flex-col gap-1.5">
                  {entries.map(([k, v], i) => (
                    <div key={i} className="flex items-center gap-1.5">
                      <Input
                        value={k}
                        placeholder="Name"
                        aria-label={`Specification name ${i + 1}`}
                        onChange={(e) => {
                          const nk = e.target.value;
                          // A name already used would silently merge two rows into one.
                          if (nk !== k && entries.some(([ok], j) => j !== i && ok === nk)) return;
                          write(entries.map((en, j) => (j === i ? [nk, v] : en)) as [string, string][]);
                        }}
                      />
                      <Input value={v} placeholder="Value" aria-label={`Specification value ${i + 1}`} onChange={(e) => write(entries.map((en, j) => (j === i ? [k, e.target.value] : en)) as [string, string][])} />
                      <Button size="sm" variant="secondary" onClick={() => write(entries.filter((_, j) => j !== i))} aria-label={`Remove specification ${i + 1}`}>×</Button>
                    </div>
                  ))}
                  <div>
                    <Button size="sm" variant="secondary" onClick={() => write([...entries, [uniqueKey(entries), ""]])}>Add specification</Button>
                  </div>
                </div>
              </Block>
            );
          }
          case "image": {
            const v = text(f.path);
            return (
              <Block key={key} label={f.label} hint={f.hint} error={errOf(f.path)}>
                <div className="flex items-center gap-3">
                  <MediaThumb url={v} />
                  <div className="flex flex-col items-start gap-1.5">
                    <span className="max-w-[260px] truncate text-xs text-muted" title={v}>{v || "No image chosen"}</span>
                    <div className="flex gap-1.5">
                      <Button size="sm" variant="secondary" onClick={() => setPicker({ path: f.path })}>{v ? "Change image" : "Choose image"}</Button>
                      {v && f.optional ? <Button size="sm" variant="secondary" onClick={() => set(f.path, undefined)}>Remove</Button> : null}
                    </div>
                  </div>
                </div>
              </Block>
            );
          }
          case "imageList": {
            const list = (getAt(value, f.path) as { size: string; src: string; scale?: unknown }[] | undefined) ?? [];
            return (
              <Block key={key} label={f.label} hint={f.hint} error={errOf(f.path)}>
                <div className="flex flex-col gap-2">
                  {list.map((it, i) => (
                    <div key={i} className="flex items-center gap-2 rounded-[4px] border border-line p-2">
                      <MediaThumb url={it.src} className="h-10 w-10" />
                      <Input
                        value={it.size}
                        placeholder="Pack size, e.g. 5L"
                        className="max-w-[150px]"
                        invalid={!!errors[join(base, `${f.path}.${i}.size`)]}
                        onChange={(e) => set(`${f.path}.${i}.size`, e.target.value)}
                        aria-label={`Pack size ${i + 1}`}
                      />
                      <Button size="sm" variant="secondary" onClick={() => setPicker({ path: `${f.path}.${i}.src` })}>{it.src ? "Change" : "Choose"}</Button>
                      {errors[join(base, `${f.path}.${i}.src`)] ? <span className="text-[13px] text-danger">{errors[join(base, `${f.path}.${i}.src`)]}</span> : null}
                      <span className="flex-1" />
                      <Button size="sm" variant="secondary" disabled={i === 0} onClick={() => set(f.path, move(list, i, -1))} aria-label={`Move photo ${i + 1} up`}>↑</Button>
                      <Button size="sm" variant="secondary" disabled={i === list.length - 1} onClick={() => set(f.path, move(list, i, 1))} aria-label={`Move photo ${i + 1} down`}>↓</Button>
                      <Button size="sm" variant="secondary" onClick={() => set(f.path, list.filter((_, j) => j !== i))} aria-label={`Remove photo ${i + 1}`}>×</Button>
                    </div>
                  ))}
                  <div><Button size="sm" variant="secondary" onClick={() => set(f.path, [...list, { size: "", src: "" }])}>Add photo</Button></div>
                </div>
              </Block>
            );
          }
          case "productPicker": {
            const chosen = new Set((getAt(value, f.path) as string[] | undefined) ?? []);
            const known = new Set(products.map((p) => p.slug));
            const orphans = [...chosen].filter((s) => !known.has(s));
            const toggle = (slug: string) => {
              const next = new Set(chosen);
              if (next.has(slug)) next.delete(slug);
              else next.add(slug);
              // Keep the catalogue's order, then any slug that is not in it.
              set(f.path, [...products.map((p) => p.slug).filter((s) => next.has(s)), ...orphans.filter((s) => next.has(s))]);
            };
            return (
              <Block key={key} label={f.label} hint={f.hint} error={errOf(f.path)}>
                <div className="grid max-h-56 grid-cols-1 gap-1 overflow-y-auto rounded-[4px] border border-line p-2 sm:grid-cols-2">
                  {products.map((p) => (
                    <label key={p.slug} className="flex cursor-pointer items-center gap-2 text-sm text-body">
                      <input type="checkbox" checked={chosen.has(p.slug)} onChange={() => toggle(p.slug)} />
                      {p.name}
                    </label>
                  ))}
                  {orphans.map((s) => (
                    <label key={s} className="flex cursor-pointer items-center gap-2 text-sm text-danger">
                      <input type="checkbox" checked onChange={() => toggle(s)} />
                      {s} (not in the catalogue)
                    </label>
                  ))}
                  {products.length === 0 && orphans.length === 0 ? <span className="text-sm text-muted">No products yet.</span> : null}
                </div>
              </Block>
            );
          }
          case "rows": {
            const list = (getAt(value, f.path) as Record<string, unknown>[] | undefined) ?? [];
            return (
              <Block key={key} label={f.label} hint={f.hint} error={errOf(f.path)}>
                <div className="flex flex-col gap-2">
                  {list.map((row, i) => (
                    <div key={i} className="rounded-[4px] border border-line p-2.5">
                      <div className="mb-2 flex items-center gap-1.5">
                        <span className="text-xs text-muted">{i + 1}</span>
                        <span className="flex-1" />
                        <Button size="sm" variant="secondary" disabled={i === 0} onClick={() => set(f.path, move(list, i, -1))} aria-label={`Move ${f.label} ${i + 1} up`}>↑</Button>
                        <Button size="sm" variant="secondary" disabled={i === list.length - 1} onClick={() => set(f.path, move(list, i, 1))} aria-label={`Move ${f.label} ${i + 1} down`}>↓</Button>
                        <Button size="sm" variant="secondary" onClick={() => set(f.path, list.filter((_, j) => j !== i))} aria-label={`Remove ${f.label} ${i + 1}`}>Remove</Button>
                      </div>
                      <FieldEditor
                        fields={f.columns}
                        value={row}
                        errors={errors}
                        existing={existing}
                        base={join(base, `${f.path}.${i}`)}
                        onChange={(next) => set(`${f.path}.${i}`, next)}
                      />
                    </div>
                  ))}
                  <div><Button size="sm" variant="secondary" onClick={() => set(f.path, [...list, f.blank()])}>{f.addLabel}</Button></div>
                </div>
              </Block>
            );
          }
          case "group":
            return (
              <details key={key} open={!f.collapsed} className="rounded-[4px] border border-line">
                <summary className="cursor-pointer px-3 py-2 text-sm font-medium text-ink">{f.label}</summary>
                <div className="flex flex-col gap-3.5 border-t border-divider p-3">
                  {f.hint ? <p className="text-[13px] text-muted">{f.hint}</p> : null}
                  <FieldEditor fields={f.fields} value={value} errors={errors} existing={existing} base={base} onChange={onChange} />
                </div>
              </details>
            );
        }
      })}
      {picker ? (
        <MediaPicker
          onClose={() => setPicker(null)}
          onPick={(url) => {
            set(picker.path, url);
            setPicker(null);
          }}
        />
      ) : null}
    </div>
  );
}

function move<T>(list: T[], i: number, by: -1 | 1): T[] {
  const next = [...list];
  const j = i + by;
  if (j < 0 || j >= next.length) return list;
  [next[i], next[j]] = [next[j], next[i]];
  return next;
}

function uniqueKey(entries: [string, string][]): string {
  let n = entries.length + 1;
  while (entries.some(([k]) => k === `New item ${n}`)) n += 1;
  return `New item ${n}`;
}
