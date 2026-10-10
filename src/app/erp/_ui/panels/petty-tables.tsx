"use client";

import { SectionLabel } from "@/components/ui/primitives";
import { registerPanel, type PanelProps } from "../panels";

/* ---------------------------------------------------------------------------
 * Small tables inside a petty-cash record: an expense's payments, its
 * adjustments and the history of its approval — the record's whole life on
 * one drawer, each row as it was written.
 * ------------------------------------------------------------------------- */

type Table = { t: string; head: string[]; rows: string[][]; empty?: string };

/**
 * A drawer is 600px wide, so a table of more than four columns cannot be
 * drawn as one without scrolling sideways or folding every date onto three
 * lines. Up to four it is a table; past that each row is a card, its first
 * two cells as the heading and the rest as labelled figures beneath.
 */
const TABLE_MAX = 4;

function PettyTables({ data }: PanelProps) {
  const tables = data as Table[];
  return (
    <section className="grid gap-4">
      {tables.map((t) => (
        <div key={t.t} className="min-w-0">
          <SectionLabel>{t.t}</SectionLabel>
          {!t.rows.length ? (
            <div className="text-[13px] text-muted">{t.empty ?? "Nothing yet."}</div>
          ) : t.head.length <= TABLE_MAX ? (
            <div className="overflow-hidden rounded-[4px] border border-line">
              <table className="w-full table-fixed text-[13px]">
                <thead>
                  <tr className="bg-canvas text-left text-xs tracking-[0.04em] text-muted uppercase">
                    {t.head.map((h) => (
                      <th key={h} className="truncate px-2.5 py-1.5 font-medium">
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {t.rows.map((r, i) => (
                    <tr key={i} className="border-t border-divider align-top">
                      {r.map((c, j) => (
                        <td key={j} className="px-2.5 py-1.5 break-words text-ink tabular-nums">
                          {c}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="grid gap-2">
              {t.rows.map((r, i) => (
                <div key={i} className="rounded-[4px] border border-line px-3 py-2">
                  <div className="flex items-baseline justify-between gap-3 text-[13px]">
                    <span className="min-w-0 truncate font-medium text-ink">{r[0]}</span>
                    <span className="flex-none text-muted">{r[1]}</span>
                  </div>
                  <dl className="mt-1.5 grid grid-cols-3 gap-x-3 gap-y-1.5">
                    {t.head.slice(2).map((h, j) => (
                      <div key={h} className="min-w-0">
                        <dt className="text-[11px] tracking-[0.04em] text-muted uppercase">{h}</dt>
                        <dd className="text-[13px] break-words text-ink tabular-nums">{r[j + 2] || "—"}</dd>
                      </div>
                    ))}
                  </dl>
                </div>
              ))}
            </div>
          )}
        </div>
      ))}
    </section>
  );
}

registerPanel("pettyTables", PettyTables);
