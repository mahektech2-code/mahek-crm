"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Cell, Empty, HeadCell, Row, Table } from "@/components/console/parts";
import { cx } from "@/components/ui/primitives";

/**
 * Today's table, and the day a row opens.
 *
 * The arithmetic stays on the server in `today-tab.tsx` — it reads the trail,
 * which does not cross to a browser — and this draws the rows it worked out.
 * A row opens the whole of that salesman over this list, on today's day: his
 * route stop by stop against the visits that answered it, the rest of his
 * month, proposing days and his visit log — the same panel the Team tab opens.
 */

export type TodayRow = {
  id: string;
  name: string;
  initials: string;
  planned: number;
  done: number;
  offPlan: number;
  km: string;
  adherencePct: number | null;
  note: string;
  hasFixes: boolean;
  city: string | null;
};

export function TodayTable({ rows, today }: { rows: TodayRow[]; today: string }) {
  const router = useRouter();
  const openPerson = (id: string) =>
    router.push(
      `/sales/journeys?tab=salesman&salesman=${id}&month=${today.slice(0, 7)}&open=${today}&in=today`,
      { scroll: false },
    );

  if (rows.length === 0) {
    return <Empty title="Nobody in the field" body="No active salesman holds the Salesman App yet." />;
  }

  return (
    <>
      <Table
        minWidth={840}
        head={
          <>
            <HeadCell width={210}>Salesman</HeadCell>
            <HeadCell width={150}>City</HeadCell>
            <HeadCell width={90}>Stops</HeadCell>
            <HeadCell align="right" width={80}>
              Off plan
            </HeadCell>
            <HeadCell align="right" width={90}>
              Distance
            </HeadCell>
            <HeadCell width={110}>Adherence</HeadCell>
            <HeadCell width={110}>Note</HeadCell>
          </>
        }
      >
        {rows.map((r, i) => (
          <Row key={r.id} striped={i % 2 === 1} onClick={() => openPerson(r.id)}>
            <Cell>
              <span className="flex items-center gap-2.5">
                <span className="flex size-7 flex-none items-center justify-center rounded-full bg-brand-soft text-[11px] font-semibold text-[#5223E0]">
                  {r.initials}
                </span>
                <span className="truncate font-medium text-ink">{r.name}</span>
              </span>
            </Cell>
            <Cell>
              <span className="block truncate">{r.city ?? <span className="text-muted">—</span>}</span>
            </Cell>
            <Cell>
              <span className="tabular-nums">
                {r.done}/{r.planned || "—"}
              </span>
            </Cell>
            <Cell align="right">{r.offPlan || <span className="text-muted">—</span>}</Cell>
            <Cell align="right">{r.km}</Cell>
            <Cell>
              {r.adherencePct === null ? (
                <span className="text-muted">—</span>
              ) : (
                <span className="flex items-center gap-1.5">
                  <span className="block h-1.5 w-[44px] overflow-hidden rounded-[3px] bg-divider">
                    <span
                      className={cx(
                        "block h-full",
                        r.adherencePct >= 80 ? "bg-success" : r.adherencePct >= 50 ? "bg-warn" : "bg-danger",
                      )}
                      style={{ width: `${Math.min(100, r.adherencePct)}%` }}
                    />
                  </span>
                  <span className="text-[12px] text-ink tabular-nums">{r.adherencePct}%</span>
                </span>
              )}
            </Cell>
            <Cell title={r.note}>
              <span className={cx("block truncate text-[12px]", r.note === "—" ? "text-muted" : "text-body")}>
                {r.note}
              </span>
            </Cell>
          </Row>
        ))}
      </Table>

    </>
  );
}
