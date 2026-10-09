import "server-only";
import * as React from "react";
import { inArray, eq } from "drizzle-orm";
import { db } from "@/db";
import { appSettings, users } from "@/db/schema";
import { getConfig } from "@/lib/config/store";
import { definition, SETTINGS, type SettingDefinition } from "@/lib/config/registry";
import { stampDate } from "@/lib/format";
import { cx } from "@/components/ui/primitives";

/* ---------------------------------------------------------------------------
 * SETTINGS, READ LIVE from the database this deployment is connected to.
 *
 * A number typed into a docs page is a second copy of a setting, and the day
 * a manager changes it on the Settings screen the page becomes wrong with
 * nothing anywhere saying so. So no page states a threshold: it names the key,
 * and this reads the value in force — on prod, prod's value; on a laptop, the
 * laptop's. Beside it is the shipped default and, where somebody has changed
 * it, who and when, because "15 days, changed from 7 by Vikram on 3 Sep" is
 * the sentence that answers "why does the Call Log do that".
 *
 * Read through `getConfig()`, the same cached read every engine uses, so the
 * page and the rule cannot be looking at two different numbers.
 * ------------------------------------------------------------------------- */

function show(def: SettingDefinition, value: unknown): string {
  if (value === null || value === undefined) return "not set";
  if (def.type === "boolean") return value ? "On" : "Off";
  if (def.type === "structured") {
    if (Array.isArray(value) && value.length <= 8 && value.every((v) => typeof v !== "object")) return value.join(", ");
    if (Array.isArray(value)) return `${value.length} item${value.length === 1 ? "" : "s"}`;
    if (typeof value === "object") return `${Object.keys(value as object).length} entries`;
  }
  return String(value);
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Inline: the value in force, with the setting's name and meaning on hover. */
export async function Setting({ k }: { k: string }) {
  const def = definition(k);
  if (!def) return <UnknownSetting k={k} />;
  const value = (await getConfig())[k as keyof Awaited<ReturnType<typeof getConfig>>];
  const changed = !same(value, def.default);
  return (
    <span
      title={`${def.label} — ${def.description}${changed ? `\n\nShipped default: ${show(def, def.default)}` : ""}`}
      className={cx(
        "inline-flex items-baseline gap-1 rounded-[3px] border px-1.5 align-baseline text-[0.92em] font-semibold whitespace-nowrap",
        changed ? "border-warn-line bg-warn-soft text-warn-ink" : "border-ai-line bg-ai-soft text-ai",
      )}
    >
      {show(def, value)}
    </span>
  );
}

function UnknownSetting({ k }: { k: string }) {
  return (
    <span className="rounded-[3px] bg-danger-soft px-1 font-mono text-[12px] text-danger" title="No such setting in the registry">
      {k}?
    </span>
  );
}

/**
 * A table of settings: every key named, or every key under a prefix. What it
 * does, the value in force, the default, and who last changed it.
 */
export async function SettingsTable({ keys, prefix }: { keys?: string[]; prefix?: string }) {
  const defs: SettingDefinition[] = keys
    ? keys.map((k) => definition(k)).filter((d): d is SettingDefinition => !!d)
    : SETTINGS.filter((s) => prefix && s.key.startsWith(prefix));
  const missing = keys?.filter((k) => !definition(k)) ?? [];
  const config = (await getConfig()) as Record<string, unknown>;
  const rows = defs.length
    ? await db
        .select({ key: appSettings.key, updatedAt: appSettings.updatedAt, by: users.name })
        .from(appSettings)
        .leftJoin(users, eq(users.id, appSettings.updatedById))
        .where(inArray(appSettings.key, defs.map((d) => d.key)))
    : [];
  const meta = new Map(rows.map((r) => [r.key, r]));

  return (
    <div className="my-5 overflow-hidden rounded-[6px] border border-line">
      <div className="flex items-center gap-2 border-b border-ai-line bg-ai-soft px-3 py-1.5 text-[11px] text-ai">
        <span className="h-1.5 w-1.5 rounded-full bg-ai-mid" />
        Read live from this deployment&apos;s settings. Amber means somebody has changed it from the shipped default.
      </div>
      <table className="w-full border-collapse text-left text-[13px]">
        <thead>
          <tr className="border-b border-line bg-canvas text-[11px] tracking-[0.04em] text-muted uppercase">
            <th className="px-3 py-2 font-medium">Setting</th>
            <th className="px-3 py-2 font-medium">What it does</th>
            <th className="px-3 py-2 font-medium whitespace-nowrap">In force</th>
            <th className="px-3 py-2 font-medium whitespace-nowrap">Default</th>
          </tr>
        </thead>
        <tbody>
          {defs.map((def) => {
            const value = config[def.key];
            const changed = !same(value, def.default);
            const m = meta.get(def.key);
            return (
              <tr key={def.key} className="border-b border-divider align-top last:border-0">
                <td className="w-[26%] px-3 py-2.5">
                  <div className="font-medium text-ink">{def.label}</div>
                  <div className="mt-0.5 font-mono text-[11px] break-all text-muted">{def.key}</div>
                </td>
                <td className="px-3 py-2.5 leading-[19px] text-body">{def.description}</td>
                <td className="px-3 py-2.5 whitespace-nowrap">
                  <span
                    className={cx(
                      "rounded-[3px] border px-1.5 py-0.5 font-semibold",
                      changed ? "border-warn-line bg-warn-soft text-warn-ink" : "border-ai-line bg-ai-soft text-ai",
                    )}
                  >
                    {show(def, value)}
                  </span>
                  {changed && m?.by ? (
                    <div className="mt-1 text-[11px] text-muted">
                      {m.by}, {stampDate(m.updatedAt)}
                    </div>
                  ) : null}
                </td>
                <td className="px-3 py-2.5 whitespace-nowrap text-muted">
                  {show(def, def.default)}
                  {def.min !== undefined || def.max !== undefined ? (
                    <div className="mt-1 text-[11px]">
                      {def.min ?? "…"}–{def.max ?? "…"}
                    </div>
                  ) : null}
                </td>
              </tr>
            );
          })}
          {missing.map((k) => (
            <tr key={k}>
              <td colSpan={4} className="px-3 py-2 text-[12px] text-danger">
                No setting named <code className="font-mono">{k}</code> — this page needs correcting.
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * A structured setting drawn as a table — the tier weights, the cooldown per
 * outcome. `labels` turns stored keys into words; `order` fixes the row order
 * (default: highest value first, which is what a weight table wants).
 */
export async function SettingMap({
  k,
  labels,
  unit,
  keyHeading = "Key",
  valueHeading = "Value",
}: {
  k: string;
  labels?: Record<string, string>;
  unit?: string;
  keyHeading?: string;
  valueHeading?: string;
}) {
  const def = definition(k);
  if (!def) return <UnknownSetting k={k} />;
  const value = ((await getConfig()) as Record<string, unknown>)[k];
  const map = (value && typeof value === "object" && !Array.isArray(value) ? value : {}) as Record<string, unknown>;
  const shipped = (def.default && typeof def.default === "object" ? def.default : {}) as Record<string, unknown>;
  const keys = [...new Set([...Object.keys(shipped), ...Object.keys(map)])].sort(
    (a, b) => Number(map[b] ?? shipped[b] ?? 0) - Number(map[a] ?? shipped[a] ?? 0),
  );
  return (
    <div className="my-5 overflow-hidden rounded-[6px] border border-line">
      <div className="flex items-center gap-2 border-b border-ai-line bg-ai-soft px-3 py-1.5 text-[11px] text-ai">
        <span className="h-1.5 w-1.5 rounded-full bg-ai-mid" />
        <span className="font-medium">{def.label}</span>
        <span className="font-mono">{k}</span>
        <span className="flex-1" />
        Read live
      </div>
      <table className="w-full border-collapse text-left text-[13px]">
        <thead>
          <tr className="border-b border-line bg-canvas text-[11px] tracking-[0.04em] text-muted uppercase">
            <th className="px-3 py-2 font-medium">{keyHeading}</th>
            <th className="px-3 py-2 font-medium">{valueHeading}</th>
            <th className="px-3 py-2 font-medium">Default</th>
          </tr>
        </thead>
        <tbody>
          {keys.map((key) => {
            const now = key in map ? map[key] : undefined;
            const changed = !same(now, shipped[key]);
            return (
              <tr key={key} className="border-b border-divider last:border-0">
                <td className="px-3 py-2">
                  <div className="text-ink">{labels?.[key] ?? key}</div>
                  {labels?.[key] ? <div className="font-mono text-[11px] text-muted">{key}</div> : null}
                </td>
                <td className="px-3 py-2">
                  <span
                    className={cx(
                      "rounded-[3px] border px-1.5 py-0.5 font-semibold",
                      changed ? "border-warn-line bg-warn-soft text-warn-ink" : "border-ai-line bg-ai-soft text-ai",
                    )}
                  >
                    {now === undefined ? "not set" : `${String(now)}${unit ? ` ${unit}` : ""}`}
                  </span>
                </td>
                <td className="px-3 py-2 text-muted">{shipped[key] === undefined ? "—" : String(shipped[key])}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
