"use client";

import { SectionLabel } from "@/components/ui/primitives";
import { registerPanel, type PanelProps } from "../panels";

/* ---------------------------------------------------------------------------
 * Small tables inside a petty-cash record: an expense's payments, its
 * adjustments and the history of its approval — the record's whole life on
 * one drawer, each row as it was written.
 * ------------------------------------------------------------------------- */

type Table = { t: string; head: string[]; rows: string[][]; empty?: string };

function PettyTables({ data }: PanelProps) {
  const tables = data as Table[];
  return (
    <section className="grid gap-4">
      {tables.map((t) => (
        <div key={t.t}>
          <SectionLabel>{t.t}</SectionLabel>
          {t.rows.length ? (
            <div className="overflow-x-auto rounded-[4px] border border-line">
              <table className="w-full text-[13px]">
                <thead>
                  <tr className="bg-canvas text-left text-xs tracking-[0.04em] text-muted uppercase">
                    {t.head.map((h) => (
                      <th key={h} className="px-2.5 py-1.5 font-medium whitespace-nowrap">
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {t.rows.map((r, i) => (
                    <tr key={i} className="border-t border-divider align-top">
                      {r.map((c, j) => (
                        <td key={j} className="px-2.5 py-1.5 text-ink tabular-nums">
                          {c}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="text-[13px] text-muted">{t.empty ?? "Nothing yet."}</div>
          )}
        </div>
      ))}
    </section>
  );
}

registerPanel("pettyTables", PettyTables);
