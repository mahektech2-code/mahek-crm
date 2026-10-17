import * as React from "react";
import { getTableColumns, getTableName, isTable, type Table } from "drizzle-orm";
import * as schema from "@/db/schema";
import { APPS, type AppId } from "@/lib/apps";
import { CAPABILITIES, can, type Capability } from "@/lib/capability-matrix";
import { CAPABILITY_LABELS } from "@/lib/capability-labels";
import { getModule } from "@/lib/modules";
import { cx } from "@/components/ui/primitives";

/* ---------------------------------------------------------------------------
 * REFERENCE BLOCKS that read the code they describe.
 *
 * A table's columns, an enum's values, who holds a capability and what a
 * module is called are all compiled INTO the app — the schema, the matrix and
 * the module registry are imported here exactly as the screens import them.
 * So a column added, a value renamed or a capability moved changes the docs
 * on the next deploy without anybody remembering to, and a name that no longer
 * exists renders as a red mistake on the page rather than a confident fiction.
 * ------------------------------------------------------------------------- */

const TABLES = new Map<string, Table>();
const ENUMS = new Map<string, readonly string[]>();
for (const value of Object.values(schema)) {
  if (isTable(value)) TABLES.set(getTableName(value), value);
  else if (typeof value === "function" && "enumName" in value && "enumValues" in value) {
    ENUMS.set((value as { enumName: string }).enumName, (value as { enumValues: readonly string[] }).enumValues);
  }
}

function Missing({ what }: { what: string }) {
  return (
    <div className="my-4 rounded-[6px] border border-danger/30 bg-danger-soft px-4 py-2 text-[13px] text-danger">
      {what} does not exist in the code any more — this page needs correcting.
    </div>
  );
}

/**
 * <DbTable name="calls" only={["next_step_kind", …]} note={{ next_step_kind: "…" }} />
 *
 * `only` narrows a wide table to the columns the page is about; `note` adds a
 * sentence per column, because a column's type says what it holds and never
 * what it means.
 */
export function DbTable({
  name,
  only,
  note,
}: {
  name: string;
  only?: string[];
  note?: Record<string, string>;
}) {
  const table = TABLES.get(name);
  if (!table) return <Missing what={`The table "${name}"`} />;
  const columns = Object.values(getTableColumns(table));
  const shown = only ? columns.filter((c) => only.includes(c.name)) : columns;
  const unknown = only?.filter((n) => !columns.some((c) => c.name === n)) ?? [];
  return (
    <div className="my-5 overflow-hidden rounded-[6px] border border-line">
      <div className="flex items-center gap-2 border-b border-line bg-canvas px-3 py-2">
        <span className="rounded-[3px] bg-ink px-1.5 py-0.5 font-mono text-[11px] text-white">table</span>
        <span className="font-mono text-[13px] font-semibold text-ink">{name}</span>
        <span className="text-[12px] text-muted">
          {only ? `${shown.length} of ${columns.length} columns` : `${columns.length} columns`} · read from src/db/schema.ts
        </span>
      </div>
      <table className="w-full border-collapse text-left text-[13px]">
        <tbody>
          {shown.map((c) => (
            <tr key={c.name} className="border-b border-divider align-top last:border-0">
              <td className="w-[28%] px-3 py-2 font-mono text-[12px] text-ink">
                {c.name}
                {c.primary ? <span className="ml-1.5 rounded-[3px] bg-brand-soft px-1 text-[10px] text-brand-hover">PK</span> : null}
              </td>
              <td className="w-[20%] px-3 py-2 font-mono text-[12px] text-muted">
                {c.getSQLType()}
                {c.notNull ? "" : " · null"}
              </td>
              <td className="px-3 py-2 leading-[19px] text-body">{note?.[c.name] ?? ""}</td>
            </tr>
          ))}
          {unknown.map((n) => (
            <tr key={n}>
              <td colSpan={3} className="px-3 py-2 text-[12px] text-danger">
                No column <code className="font-mono">{n}</code> on {name}.
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** <DbEnum name="call_outcome" /> — every value, in the order Postgres holds them. */
export function DbEnum({ name }: { name: string }) {
  const values = ENUMS.get(name);
  if (!values) return <Missing what={`The enum "${name}"`} />;
  return (
    <div className="my-4 rounded-[6px] border border-line bg-surface px-3 py-2.5">
      <div className="mb-2 font-mono text-[12px] text-muted">
        enum <span className="font-semibold text-ink">{name}</span> · {values.length} values
      </div>
      <div className="flex flex-wrap gap-1.5">
        {values.map((v) => (
          <span key={v} className="rounded-[3px] border border-line bg-canvas px-1.5 py-0.5 font-mono text-[12px] text-body">
            {v}
          </span>
        ))}
      </div>
    </div>
  );
}

const LEVELS = ["associate", "manager", "admin"] as const;

/**
 * <Capability name="call.log" /> — what it lets somebody do, and which app and
 * level carries it, straight off the matrix `requireCapability` checks.
 */
export function CapabilityGrid({ names }: { names: string[] }) {
  const apps = APPS.filter((a) => !a.retiredInto && !a.mobileOnly && a.id !== "docs");
  const bad = names.filter((n) => !(CAPABILITIES as readonly string[]).includes(n));
  const good = names.filter((n) => !bad.includes(n)) as Capability[];
  const relevant = apps.filter((a) => good.some((c) => LEVELS.some((role) => role !== "admin" && can({ app: a.id, role }, c))));
  return (
    <div className="my-5 overflow-x-auto rounded-[6px] border border-line">
      <table className="w-full border-collapse text-left text-[13px]">
        <thead>
          <tr className="border-b border-line bg-canvas text-[11px] tracking-[0.04em] text-muted uppercase">
            <th className="px-3 py-2 font-medium">Capability</th>
            {relevant.map((a) => (
              <th key={a.id} className="px-3 py-2 font-medium whitespace-nowrap">
                {a.name}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {good.map((c) => (
            <tr key={c} className="border-b border-divider last:border-0">
              <td className="px-3 py-2">
                <div className="text-ink">{CAPABILITY_LABELS[c]}</div>
                <div className="font-mono text-[11px] text-muted">{c}</div>
              </td>
              {relevant.map((a) => {
                const lowest = LEVELS.find((role) => can({ app: a.id as AppId, role }, c));
                return (
                  <td key={a.id} className="px-3 py-2 whitespace-nowrap">
                    {lowest && lowest !== "admin" ? (
                      <span
                        className={cx(
                          "rounded-[3px] px-1.5 py-0.5 text-[11px] font-medium",
                          lowest === "associate" ? "bg-success-soft text-success" : "bg-brand-soft text-brand-hover",
                        )}
                      >
                        {lowest === "associate" ? "Everyone" : "Manager+"}
                      </span>
                    ) : (
                      <span className="text-[11px] text-faint">Admin only</span>
                    )}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      {bad.length ? (
        <div className="border-t border-line px-3 py-2 text-[12px] text-danger">
          Unknown capability: {bad.join(", ")} — this page needs correcting.
        </div>
      ) : null}
    </div>
  );
}

/** <ModuleRef k="crm.call-log" /> — the module's name, key and route, from the registry. */
export function ModuleRef({ k }: { k: string }) {
  const m = getModule(k);
  if (!m) return <Missing what={`The module "${k}"`} />;
  return (
    <span className="inline-flex items-center gap-1.5 rounded-[3px] border border-line bg-canvas px-1.5 align-baseline text-[0.92em]">
      <span className="font-medium text-ink">{m.label}</span>
      <span className="font-mono text-[11px] text-muted">{m.key}</span>
    </span>
  );
}
