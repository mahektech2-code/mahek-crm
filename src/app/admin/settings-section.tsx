"use client";

import * as React from "react";
import {
  Badge,
  Button,
  Card,
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
import { useAdmin } from "./store";

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
}: {
  tab: SchemaTab;
  values: Values;
  drafts: Values;
  errors: CrossError[];
  onDraft: (key: string, value: unknown) => void;
  isPlatformAdmin: boolean;
  collections: Record<string, Collection>;
}) {
  return (
    <div>
      {errors.length ? (
        <div className="mt-5 rounded-[4px] border border-danger-soft border-l-[3px] border-l-danger bg-danger-soft px-4 py-3">
          <div className="text-sm font-medium text-danger">
            This section cannot be saved yet
          </div>
          <div className="mt-1.5 flex flex-col gap-1">
            {errors.map((e) => (
              <div key={e.key} className="text-sm leading-[21px] text-ink">
                {e.text}
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {tab.groups.map((group) => (
        <Card key={group.label} className="mt-5 shadow-[0_1px_2px_rgba(22,22,22,0.06)]">
          <div className="border-b border-divider px-5 py-4">
            <div className="text-lg leading-6 font-semibold text-ink">{group.label}</div>
            {group.note ? (
              <div className="mt-0.5 text-[13px] text-muted">{group.note}</div>
            ) : null}
          </div>
          {group.fields.map((field, i) => (
            <FieldRow
              key={field.key}
              field={field}
              first={i === 0}
              values={values}
              drafts={drafts}
              error={errors.find((e) => e.key === field.key) ?? null}
              onDraft={onDraft}
              locked={!!field.adminOnly && !isPlatformAdmin}
              collection={collections[field.key]}
            />
          ))}
        </Card>
      ))}
    </div>
  );
}

function FieldRow({
  field,
  first,
  values,
  drafts,
  error,
  onDraft,
  locked,
  collection,
}: {
  field: SchemaField;
  first: boolean;
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
  const set = (v: unknown) => {
    if (!locked) onDraft(field.key, v);
  };

  return (
    <div
      className={cx(
        "flex items-start gap-5 px-5 py-4",
        first ? "" : "border-t border-canvas",
        error ? "bg-danger-soft" : "bg-surface",
      )}
    >
      <div className="w-[320px] min-w-0 flex-none">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-ink">{field.label}</span>
          {locked ? (
            <Badge
              tone="neutral"
              className="gap-1"
              // Visible but not editable — a manager should know the setting
              // exists and who to ask, not find a control that silently does
              // nothing.
            >
              🔒 Platform admin
            </Badge>
          ) : null}
          {dirty ? <span className="block h-1.5 w-1.5 flex-none rounded-full bg-brand" /> : null}
        </div>
        {field.help ? (
          <div className="mt-0.5 text-[13px] leading-[19px] text-muted">{field.help}</div>
        ) : null}
        {field.control === "entity" ? null : (
        <div className="mt-1.5 flex flex-wrap items-baseline gap-x-2 text-[11px] text-muted">
          <span>
            {dirty
              ? `Unsaved — was ${readable(savedValue(values, field))}`
              : atDefault
                ? "Default · never changed"
                : `Changed from the default of ${readable(field.def)}`}
          </span>
        </div>
        )}
      </div>

      <div className="min-w-0 flex-1">
        <Control field={field} value={value} error={error} locked={locked} set={set} collection={collection} />
        {error && field.control !== "threshold" ? (
          <div className="mt-1.5 text-[13px] text-danger">{error.text}</div>
        ) : null}
      </div>

      <div className="w-[120px] flex-none text-right">
        {field.control === "entity" ? null : dirty ? (
          <Button size="sm" variant="ghost" onClick={() => onDraft(field.key, savedValue(values, field))}>
            Reset
          </Button>
        ) : atDefault ? (
          <span className="text-xs whitespace-nowrap text-muted">Default</span>
        ) : null}
      </div>
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
        <span className="flex items-center gap-2">
          {/* The width lives on a wrapper: Input is w-full, and a competing
              width utility on the control itself does not reliably win. */}
          <span className="block w-[110px] flex-none">
            <Input
              value={String(value ?? "")}
              invalid={!!error}
              disabled={locked}
              onChange={(e) => set(e.target.value.replace(/[^0-9.\-]/g, ""))}
              className="text-right"
            />
          </span>
          {field.unit ? <span className="text-sm whitespace-nowrap text-muted">{field.unit}</span> : null}
          {field.min !== undefined ? (
            <span className="text-[13px] whitespace-nowrap text-muted">
              {field.min}–{field.max}
            </span>
          ) : null}
        </span>
      );

    case "currency":
      return (
        <span className="flex h-8.5 w-40 items-center rounded-[4px] border border-line bg-surface px-2.5">
          <span className="mr-1 text-muted">₹</span>
          <input
            value={String(value ?? "")}
            disabled={locked}
            onChange={(e) => set(e.target.value.replace(/[^0-9]/g, ""))}
            className="min-w-0 flex-1 border-none bg-transparent text-sm outline-none"
          />
        </span>
      );

    case "bool":
      return <Toggle on={!!value} locked={locked} onToggle={() => set(!value)} />;

    case "text":
      return (
        <Input
          value={String(value ?? "")}
          invalid={!!error}
          disabled={locked}
          onChange={(e) => set(e.target.value)}
          className="max-w-[360px]"
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
        <span className="flex flex-wrap gap-2">
          {(field.options ?? []).map((opt) => (
            <Pill key={opt} on={value === opt} onClick={() => set(opt)}>
              {opt}
            </Pill>
          ))}
        </span>
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
            "h-8.5 w-[130px] rounded-[4px] border bg-surface px-2.5 text-sm text-ink outline-none focus:border-brand",
            error ? "border-danger" : "border-line",
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
                  onChange={(e) => set({ ...v, [p.k]: e.target.value.replace(/[^0-9]/g, "") })}
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
  const { notify } = useAdmin();
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
  const { notify } = useAdmin();

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
 * A collection the app owns. The console lists it and opens its editor, and
 * knows nothing about what the rows are.
 */
function EntityList({ field, collection }: { field: SchemaField; collection?: Collection }) {
  const { openDrawer } = useAdmin();
  const meta = field.entity;
  if (!meta) return null;

  if (!meta.built) {
    return (
      <span className="block rounded-[4px] border border-dashed border-line-strong bg-canvas px-3.5 py-3">
        <span className="block text-sm font-medium text-ink">Declared, not yet stored</span>
        <span className="mt-0.5 block text-[13px] leading-[19px] text-muted">
          The CRM declares this collection but nothing stores it yet, so there is nothing to list. It appears here so
          the gap is visible rather than silently missing.
        </span>
      </span>
    );
  }

  const rows = collection?.rows ?? [];
  const total = collection?.total ?? 0;

  return (
    <span className="block">
      <span className="mb-2 flex items-center justify-between gap-3">
        <span className="text-[13px] text-muted">
          {total} {meta.noun}
          {total > rows.length ? ` · showing ${rows.length}` : ""}
        </span>
        {/* A collection managed on its own screen links there. One that has
            no write path at all says so on a disabled button, rather than
            offering an editor that would not save. */}
        {meta.href ? (
          <Button size="sm" variant="secondary" onClick={() => (window.location.href = meta.href!)}>
            {meta.cta}
          </Button>
        ) : (
          <Button
            size="sm"
            variant="primary"
            disabled={!meta.editable}
            title={meta.editable ? undefined : "Authoring this collection is not wired into the console yet"}
            onClick={() => openDrawer({ kind: field.key as never, id: null })}
          >
            {meta.cta}
          </Button>
        )}
      </span>
      <span className="block overflow-hidden rounded-[4px] border border-line">
        {rows.map((r, i) => {
          const inner = (
            <>
              <span className="min-w-0 flex-1 truncate text-sm font-medium text-ink">{r.name}</span>
              <span className="truncate text-[13px] whitespace-nowrap text-muted">{r.meta}</span>
              <Badge tone={r.active ? "success" : "neutral"}>{r.active ? "Active" : "Archived"}</Badge>
            </>
          );
          const shared = cx(
            "flex w-full items-center gap-3 bg-surface px-2.5 py-2 text-left",
            i ? "border-t border-canvas" : "",
          );
          // A row only opens where there is something to open it with.
          return meta.editable ? (
            <button
              key={r.id}
              type="button"
              onClick={() => openDrawer({ kind: field.key as never, id: r.id })}
              className={cx(shared, "cursor-pointer hover:bg-canvas")}
            >
              {inner}
            </button>
          ) : (
            <span key={r.id} className={shared}>
              {inner}
            </span>
          );
        })}
        {rows.length === 0 ? (
          <span className="block px-3 py-5 text-center text-sm text-muted">Nothing here yet.</span>
        ) : null}
      </span>
      {meta.editable || meta.href ? null : (
        <span className="mt-2 block text-[13px] text-muted">
          Read-only here. Authoring this collection is not wired into the console yet, so nothing offers an editor that
          would not save.
        </span>
      )}
    </span>
  );
}
