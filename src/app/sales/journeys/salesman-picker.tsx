"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import type { Salesman } from "@/lib/services/sales-service";

/**
 * Whose days, and which way to read them.
 *
 * One bar above all three views of a salesman, so changing person keeps the
 * view and changing view keeps the person — the calendar and the proposal
 * form used to be reached through two different pickers that each forgot the
 * other's choice.
 */
export function SalesmanPicker({
  team,
  selectedId,
  view,
}: {
  team: Salesman[];
  selectedId: string;
  view: "calendar" | "list" | "propose";
}) {
  const router = useRouter();
  const views = [
    { key: "calendar", label: "Calendar" },
    { key: "list", label: "List" },
    { key: "propose", label: "Propose days" },
  ] as const;
  return (
    <div className="mb-4 flex flex-wrap items-end gap-3 rounded-[6px] border border-line bg-surface px-4 py-3">
      <label className="block">
        <span className="mb-1 block text-[11px] font-medium tracking-[0.04em] text-muted uppercase">
          Salesman
        </span>
        <select
          value={selectedId}
          onChange={(e) =>
            router.push(
              `/sales/journeys?tab=salesman&view=${view}${e.target.value ? `&salesman=${e.target.value}` : ""}`,
            )
          }
          className="h-[34px] min-w-[220px] rounded-[4px] border border-line bg-surface px-2 text-sm text-ink outline-none focus:border-brand"
        >
          <option value="">Choose somebody</option>
          {team.map((t) => (
            <option key={t.id} value={t.id} disabled={!t.active}>
              {t.name}
              {t.active ? "" : " (account closed)"}
            </option>
          ))}
        </select>
      </label>
      <div className="flex-1" />
      {selectedId ? (
        <div className="inline-flex rounded-[4px] border border-line bg-surface p-0.5">
          {views.map((v) => (
            <Link
              key={v.key}
              href={`/sales/journeys?tab=salesman&salesman=${selectedId}&view=${v.key}`}
              className={
                "rounded-[3px] px-3 py-1.5 text-[13px] no-underline hover:no-underline " +
                (view === v.key ? "bg-brand-soft font-medium text-[#5223E0]" : "text-body hover:bg-canvas")
              }
            >
              {v.label}
            </Link>
          ))}
        </div>
      ) : null}
    </div>
  );
}
