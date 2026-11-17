"use client";

import * as React from "react";
import {
  Badge,
  Button,
  Input,
  Textarea,
  cx,
} from "@/components/ui/primitives";
import type { Collection } from "@/lib/config/entity-collections";
import type { SchemaField, SchemaTab } from "@/lib/config/schema-contract";
import {
  currentValue,
  isAtDefault,
  isDirty,
  readable,
  savedValue,
  type CrossError,
  type Values,
} from "./settings-model";
import { RichTextEditor } from "./rich-text";
import { HintTip } from "@/components/ui/hint-tip";
import Link from "next/link";
import { useToast } from "@/components/ui/toast";
import { cleanDecimal, cleanWhole } from "@/lib/format";
import { ADMIN } from "@/lib/admin-routes";

/* ---------------------------------------------------------------------------
 * One renderer per declared control type, and nothing else.
 *
 * The console has never heard of an escalation stage or a buying cycle. It
 * knows fourteen control types, and an app that publishes a schema using them
 * gets a working settings screen without a line of code here changing.
 * ------------------------------------------------------------------------- */

export function SettingsSection({
  tab,
  values,
  drafts,
  errors,
  onDraft,
  isPlatformAdmin,
  collections,
  changedOnly = false,
  find = "",
}: {
  tab: SchemaTab;
  values: Values;
  drafts: Values;
  errors: CrossError[];
  onDraft: (key: string, value: unknown) => void;
  isPlatformAdmin: boolean;
  collections: Record<string, Collection>;
  /** Only the settings that differ from their default, or carry a draft. */
  changedOnly?: boolean;
  /** Only the settings whose name or key holds this. */
  find?: string;
}) {
  const needle = find.trim().toLowerCase();
  const shown = (f: SchemaField) =>
    (!changedOnly || (f.control !== "entity" && (isDirty(values, drafts, f) || !isAtDefault(values, drafts, f)))) &&
    (!needle || f.label.toLowerCase().includes(needle) || f.key.toLowerCase().includes(needle));
  const groups = tab.groups
    .map((g) => ({ ...g, fields: g.fields.filter(shown) }))
    .filter((g) => g.fields.length > 0);
  return (
    <div className="flex flex-col gap-4">
      {errors.length ? (
        <div className="rounded-card border border-danger/25 bg-danger-soft px-4 py-3">
          <div className="text-sm font-semibold text-danger">This section cannot be saved yet</div>
          <div className="mt-1.5 flex flex-col gap-1">
            {errors.map((e) => (
              <div key={e.key} className="text-sm leading-[21px] text-ink">
                {e.text}
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {groups.length === 0 ? (
        <section className="rounded-card border border-line bg-surface px-[18px] py-6 text-sm text-muted">
          {needle ? "No setting on this tab is called that." : "Every setting on this tab is at its default."}
        </section>
      ) : (
        <section className="overflow-hidden rounded-card border border-line bg-surface text-sm leading-[1.5]">
          {groups.map((group) => (
            <div key={group.label}>
              <div
                style={{ textTransform: "uppercase", letterSpacing: ".05em" }}
                className="flex items-center gap-2 border-b border-divider bg-[#f7f9fc] px-[18px] py-3 text-xs font-semibold text-muted"
              >
                {group.label}
                {group.note ? <InfoDot text={group.note} /> : null}
              </div>
              {group.fields.map((field) => (
                <FieldRow
                  key={field.key}
                  field={field}
                  values={values}
                  drafts={drafts}
                  error={errors.find((e) => e.key === field.key) ?? null}
                  onDraft={onDraft}
                  locked={!!field.adminOnly && !isPlatformAdmin}
                  collection={collections[field.key]}
                />
              ))}
            </div>
          ))}
        </section>
      )}
    </div>
  );
}

/** The canvas's round "i": the field's help on hover, focus or a tap. */
function InfoDot({ text }: { text: string }) {
  return (
    <span className="normal-case" style={{ letterSpacing: 0 }}>
      <HintTip text={text} />
    </span>
  );
}

/** Controls that need the row's width rather than the 190px column. */
const WIDE = new Set(["longtext", "richtext", "multi", "dayset", "threshold", "keyvalue", "ordered", "entity"]);

function FieldRow({
  field,
  values,
  drafts,
  error,
  onDraft,
  locked,
  collection,
}: {
  field: SchemaField;
  values: Values;
  drafts: Values;
  error: CrossError | null;
  onDraft: (key: string, value: unknown) => void;
  locked: boolean;
  collection?: Collection;
}) {
  const value = currentValue(values, drafts, field);
  const dirty = isDirty(values, drafts, field);
  const atDefault = isAtDefault(values, drafts, field);
  const changed = field.control !== "entity" && (dirty || !atDefault);
  const wide = WIDE.has(field.control);
  const set = (v: unknown) => {
    if (!locked) onDraft(field.key, v);
  };

  const control = (
    <div className="min-w-0">
      <Control field={field} value={value} error={error} locked={locked} set={set} collection={collection} />
      {error && field.control !== "threshold" ? <div className="mt-1.5 text-[13px] text-danger">{error.text}</div> : null}
    </div>
  );

  return (
    <div
      /* The search in the header lands on a setting by its key. */
      id={field.key}
      className={cx(
        "grid scroll-mt-6 items-center gap-4 border-b border-divider px-[18px] py-3.5 last:border-b-0 target:ring-2 target:ring-brand target:ring-inset",
        wide ? "grid-cols-[minmax(0,1fr)_120px]" : "grid-cols-[minmax(0,1fr)_190px_120px]",
        error ? "bg-danger-soft" : changed ? "bg-[#fbfaff] shadow-[inset_3px_0_0_var(--color-brand)]" : "bg-surface",
      )}
    >
      <div className="min-w-0">
        <div className="flex items-center gap-2 font-semibold text-ink">
          {changed ? <span title={dirty ? "Unsaved" : "Changed from the default"} className="block h-[7px] w-[7px] flex-none rounded-full bg-brand" /> : null}
          <span className="min-w-0">{field.label}</span>
          {locked ? (
            <Badge tone="neutral" className="gap-1">
              Platform admin
            </Badge>
          ) : null}
          {field.help ? <HintTip text={field.help} /> : null}
        </div>
        {field.control === "entity" ? null : <div className="mt-0.5 font-mono text-xs text-muted">{field.key}</div>}
        {dirty ? <div className="mt-0.5 text-xs text-brand">Unsaved · was {readable(savedValue(values, field))}</div> : null}
      </div>

      {wide ? null : control}

      <div className="flex items-center justify-end gap-1.5">
        {field.control === "entity" ? null : dirty ? (
          <button
            type="button"
            onClick={() => onDraft(field.key, savedValue(values, field))}
            className="h-[30px] cursor-pointer rounded-control border border-line bg-surface px-2.5 text-xs font-semibold text-ink hover:bg-[#f7f9fc]"
          >
            Reset
          </button>
        ) : atDefault ? null : (
          <span
            title="The default"
            className="inline-flex h-[22px] max-w-[80px] items-center truncate rounded-full bg-[#eef1f6] px-2 text-xs font-semibold text-[#4a5670]"
          >
            {readable(field.def)}
          </span>
        )}
        {field.control === "entity" ? null : (
          <Link
            href={`${ADMIN.changes}?q=${encodeURIComponent(field.key)}`}
            aria-label={`History of ${field.label}`}
            title="History"
            className="inline-flex h-[30px] w-[30px] flex-none items-center justify-center rounded-control border border-line bg-surface text-ink hover:bg-[#f7f9fc]"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
              <path d="M3 12a9 9 0 1 0 3-6.7M3 4v4h4M12 7v5l3 2" />
            </svg>
          </Link>
        )}
      </div>

      {wide ? <div className="col-span-2">{control}</div> : null}
    </div>
  );
}

/* --------------------------------------------------------------- the controls */

function Control({
  field,
  value,
  error,
  locked,
  set,
  collection,
}: {
  field: SchemaField;
  value: unknown;
  error: CrossError | null;
  locked: boolean;
  set: (v: unknown) => void;
  collection?: Collection;
}) {
  switch (field.control) {
    case "int":
    case "decimal":
      return (
        <span
          title={field.min !== undefined ? `${field.min}–${field.max}` : undefined}
          className={cx(
            "flex h-[38px] items-center overflow-hidden rounded-control border bg-surface",
            error ? "border-danger" : "border-line-strong",
          )}
        >
          <input
            value={String(value ?? "")}
            disabled={locked}
            aria-label={field.label}
            inputMode="decimal"
            onChange={(e) => set(e.target.value.replace(/[^0-9.\-]/g, ""))}
            className="h-full min-w-0 flex-1 border-0 bg-transparent px-2.5 text-right text-sm font-semibold text-ink outline-none"
          />
          {field.unit ? (
            <span className="flex h-full flex-none items-center border-l border-divider bg-[#f7f9fc] px-2.5 text-[13px] whitespace-nowrap text-muted">
              {field.unit}
            </span>
          ) : null}
        </span>
      );

    case "currency":
      return (
        <span className="flex h-[38px] items-center overflow-hidden rounded-control border border-line-strong bg-surface">
          <span className="flex h-full flex-none items-center border-r border-divider bg-[#f7f9fc] px-2.5 text-[13px] text-muted">₹</span>
          <input
            value={String(value ?? "")}
            disabled={locked}
            aria-label={field.label}
            inputMode="decimal"
            onChange={(e) => set(cleanDecimal(e.target.value))}
            className="h-full min-w-0 flex-1 border-0 bg-transparent px-2.5 text-right text-sm font-semibold text-ink outline-none"
          />
        </span>
      );

    case "bool":
      return <Toggle on={!!value} locked={locked} onToggle={() => set(!value)} />;

    case "text":
      return (
        <input
          value={String(value ?? "")}
          disabled={locked}
          aria-label={field.label}
          onChange={(e) => set(e.target.value)}
          className={cx(
            "h-[38px] w-full rounded-control border bg-surface px-3 text-sm text-ink outline-none focus:border-brand",
            error ? "border-danger" : "border-line-strong",
          )}
        />
      );

    case "longtext":
      return (
        <Textarea
          value={String(value ?? "")}
          disabled={locked}
          onChange={(e) => set(e.target.value)}
          className="h-[120px] font-mono text-[13px]"
        />
      );

    case "richtext":
      return (
        <RichTextEditor value={String(value ?? "")} onChange={(next) => set(next)} />
      );

    case "choice":
      return (
        <select
          value={String(value ?? "")}
          disabled={locked}
          aria-label={field.label}
          onChange={(e) => set(e.target.value)}
          className="h-[38px] w-full rounded-control border border-line-strong bg-surface px-3 text-sm text-ink outline-none focus:border-brand"
        >
          {(field.options ?? []).map((opt) => (
            <option key={opt} value={opt}>
              {opt}
            </option>
          ))}
        </select>
      );

    case "multi": {
      const arr = Array.isArray(value) ? (value as string[]) : [];
      return (
        <span className="flex flex-wrap gap-2">
          {(field.options ?? []).map((opt) => (
            <Pill
              key={opt}
              on={arr.includes(opt)}
              onClick={() => set(arr.includes(opt) ? arr.filter((x) => x !== opt) : [...arr, opt])}
            >
              {opt}
            </Pill>
          ))}
        </span>
      );
    }

    case "time":
      return (
        <input
          type="time"
          value={String(value ?? "")}
          disabled={locked}
          onChange={(e) => set(e.target.value)}
          className={cx(
            "h-[38px] w-full rounded-control border bg-surface px-3 text-sm text-ink outline-none focus:border-brand",
            error ? "border-danger" : "border-line-strong",
          )}
        />
      );

    case "dayset": {
      const arr = Array.isArray(value) ? (value as string[]) : [];
      return (
        <span className="flex gap-1.5">
          {["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((d) => (
            <Pill
              key={d}
              on={arr.includes(d)}
              onClick={() => set(arr.includes(d) ? arr.filter((x) => x !== d) : [...arr, d])}
            >
              {d}
            </Pill>
          ))}
        </span>
      );
    }

    case "threshold": {
      const v = (value ?? {}) as Record<string, string | number>;
      return (
        <span className="block">
          <span className="flex flex-wrap gap-2.5">
            {(field.parts ?? []).map((p) => (
              <span key={p.k} className="block">
                <span className="block text-[11px] font-medium tracking-[0.04em] whitespace-nowrap text-muted uppercase">
                  {p.l}
                </span>
                <span className="block w-[110px]">
                  <Input
                    value={String(v[p.k] ?? "")}
                    invalid={!!error}
                    disabled={locked}
                    onChange={(e) => set({ ...v, [p.k]: e.target.value.replace(/[^0-9.]/g, "") })}
                    className="text-right"
                  />
                </span>
              </span>
            ))}
          </span>
          {error ? <span className="mt-1.5 block text-[13px] text-danger">{error.text}</span> : null}
        </span>
      );
    }

    case "keyvalue": {
      const v = (value ?? {}) as Record<string, string | number>;
      return (
        <span className="block overflow-hidden rounded-[4px] border border-line">
          {(field.parts ?? []).map((p, i) => (
            <span
              key={p.k}
              className={cx("flex items-center gap-3 px-2.5 py-1.5", i ? "border-t border-canvas" : "")}
            >
              <span className="min-w-0 flex-1 text-sm text-ink">{p.l}</span>
              <span className="block w-[110px] flex-none">
                <Input
                  value={String(v[p.k] ?? "")}
                  disabled={locked}
                  onChange={(e) => set({ ...v, [p.k]: cleanWhole(e.target.value) })}
                  className="text-right"
                />
              </span>
              <span className="w-11 text-[13px] whitespace-nowrap text-muted">{field.unit}</span>
            </span>
          ))}
        </span>
      );
    }

    case "ordered":
      return <OrderedList value={(value as string[]) ?? []} locked={locked} set={set} />;

    case "entity":
      return <EntityList field={field} collection={collection} />;

    default:
      return null;
  }
}

function Toggle({ on, locked, onToggle }: { on: boolean; locked: boolean; onToggle: () => void }) {
  const notify = useToast().push;
  return (
    <button
      type="button"
      title={locked ? "Platform admin only — you can see this setting but not change it" : undefined}
      onClick={() => (locked ? notify("Platform admin only") : onToggle())}
      className={cx(
        "relative h-[22px] w-[38px] flex-none rounded-full border-none p-0",
        on ? "bg-brand" : "bg-line",
        locked ? "cursor-not-allowed opacity-50" : "cursor-pointer",
      )}
      aria-pressed={on}
    >
      <span
        className={cx(
          "absolute top-[3px] block h-4 w-4 rounded-full bg-white transition-[left] duration-100 ease-swift",
          on ? "left-[19px]" : "left-[3px]",
        )}
      />
    </button>
  );
}

function Pill({
  on,
  onClick,
  children,
}: {
  on: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cx(
        "h-[30px] cursor-pointer rounded-[4px] border px-3 text-[13px] whitespace-nowrap",
        on
          ? "border-brand bg-brand-soft font-medium text-[#5223E0]"
          : "border-line bg-surface text-body hover:bg-canvas",
      )}
    >
      {children}
    </button>
  );
}

/**
 * Order is meaning here — the tie-breaker list decides which of two equal
 * customers is called first, so moving a row is a real edit, not decoration.
 */
function OrderedList({
  value,
  locked,
  set,
}: {
  value: string[];
  locked: boolean;
  set: (v: unknown) => void;
}) {
  const [draft, setDraft] = React.useState("");
  const notify = useToast().push;

  const move = (i: number, dir: -1 | 1) => {
    const j = i + dir;
    if (locked || j < 0 || j >= value.length) return;
    const next = value.slice();
    [next[i], next[j]] = [next[j], next[i]];
    set(next);
  };

  return (
    <span className="block overflow-hidden rounded-[4px] border border-line">
      {value.map((label, i) => (
        <span
          key={label}
          className={cx("flex items-center gap-2.5 bg-surface px-2.5 py-1.5", i ? "border-t border-canvas" : "")}
        >
          <span className="w-[18px] flex-none text-[11px] text-muted">{i + 1}</span>
          <span className="min-w-0 flex-1 truncate text-sm text-ink">{label}</span>
          <IconButton title="Move up" onClick={() => move(i, -1)}>
            ↑
          </IconButton>
          <IconButton title="Move down" onClick={() => move(i, 1)}>
            ↓
          </IconButton>
          <button
            type="button"
            onClick={() => !locked && set(value.filter((x) => x !== label))}
            className="h-[22px] flex-none cursor-pointer rounded-full border border-success-soft bg-success-soft px-2 text-[11px] font-medium text-success"
            title="Remove from the list"
          >
            Active
          </button>
        </span>
      ))}
      <span className="flex gap-2 border-t border-divider bg-canvas px-2.5 py-2">
        <Input
          value={draft}
          placeholder="Add an item"
          disabled={locked}
          onChange={(e) => setDraft(e.target.value)}
          className="flex-1"
        />
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            const v = draft.trim();
            if (!v) return notify("Type the item first");
            set([...value, v]);
            setDraft("");
          }}
        >
          Add
        </Button>
      </span>
    </span>
  );
}

function IconButton({
  title,
  onClick,
  children,
}: {
  title: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      className="h-6 w-6 flex-none cursor-pointer rounded-[4px] border border-line bg-surface p-0 text-xs text-muted hover:bg-canvas"
    >
      {children}
    </button>
  );
}

/**
 * A collection the app owns, listed as it stands.
 *
 * The console edits none of these. A collection with its own screen — the
 * catalogue, the WhatsApp templates — links there; the rest are read-only
 * lists. It used to open a drawer editor here too, and the one collection it
 * claimed to save looked its rows up in a list of samples, so every real
 * template opened blank.
 */
function EntityList({ field, collection }: { field: SchemaField; collection?: Collection }) {
  const meta = field.entity;
  if (!meta) return null;

  const rows = collection?.rows ?? [];
  const total = collection?.total ?? 0;

  return (
    <span className="block">
      <span className="mb-2 flex items-center justify-between gap-3">
        <span className="text-[13px] text-muted">
          {total} {meta.noun}
          {total > rows.length ? ` · showing ${rows.length}` : ""}
        </span>
        {meta.href ? (
          <Link
            href={meta.href}
            className="rounded-[4px] border border-line bg-surface px-3 py-1.5 text-[13px] font-medium text-body no-underline hover:bg-canvas hover:no-underline"
          >
            {meta.cta}
          </Link>
        ) : null}
      </span>
      <span className="block overflow-hidden rounded-[4px] border border-line">
        {rows.map((r, i) => (
          <span
            key={r.id}
            className={cx("flex w-full items-center gap-3 bg-surface px-2.5 py-2 text-left", i ? "border-t border-canvas" : "")}
          >
            <span className="min-w-0 flex-1 truncate text-sm font-medium text-ink">{r.name}</span>
            <span className="truncate text-[13px] whitespace-nowrap text-muted">{r.meta}</span>
            <Badge tone={r.active ? "success" : "neutral"}>{r.active ? "Active" : "Archived"}</Badge>
          </span>
        ))}
        {rows.length === 0 ? (
          <span className="block px-3 py-5 text-center text-sm text-muted">Nothing here yet.</span>
        ) : null}
      </span>
    </span>
  );
}
