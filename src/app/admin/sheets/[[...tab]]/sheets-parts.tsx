"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { ADMIN } from "@/lib/admin-routes";
import { shortDate } from "@/lib/format";
import { useToast } from "@/components/ui/toast";
import type { ConflictRow } from "@/lib/services/admin-data-view-service";
import { BtnLink, Card, DataTable, Mono, Pill, TD, btnClass, type Tone } from "../../_shell/kit";
import { reparseOrderSheet, resolveConflicts } from "../actions";

/* The Sheets screen's buttons, and its conflicts list, the canvas's way. */

export function SheetsActions({ canRun }: { canRun: boolean }) {
  const toast = useToast();
  const router = useRouter();
  const [busy, setBusy] = React.useState(false);
  return (
    <>
      <button
        type="button"
        disabled={!canRun || busy}
        title={canRun ? "Read the stored order rows again under today's rules — Google is not asked" : "Needs the sheet import permission."}
        className={`${btnClass("plain")} h-[38px]`}
        onClick={async () => {
          setBusy(true);
          const r = await reparseOrderSheet();
          setBusy(false);
          if (r.ok) {
            toast.push(r.message ?? "Reparse finished.");
            router.refresh();
          } else toast.push(r.error);
        }}
      >
        {busy ? "Reparsing…" : "Reparse"}
      </button>
      <BtnLink href={ADMIN.sheets("sync")} kind="primary">
        Sync now
      </BtnLink>
    </>
  );
}

/** A value the sheet or the app holds, as a pill where it is a status word. */
function Value({ field, value, kept }: { field: string; value: string | null; kept: boolean }) {
  if (value == null || value === "") return <span className="text-muted">—</span>;
  if (!/status/i.test(field)) return <span>{value}</span>;
  const v = value.toLowerCase();
  const tone: Tone = !kept ? "muted" : /declin|reject|cancel|deactiv/.test(v) ? "danger" : /approv|active|confirm/.test(v) ? "ok" : "muted";
  return <Pill tone={tone}>{value.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase())}</Pill>;
}

const HEAD: React.CSSProperties = { fontSize: 12, fontWeight: 600, letterSpacing: 0 };
const head = "bg-ink px-3.5 py-2.5 text-left whitespace-nowrap text-white normal-case";
const CELL = "h-[46px] px-3.5 py-0 text-sm";

export function ConflictsCard({ rows, total, canResolve }: { rows: ConflictRow[]; total: number; canResolve: boolean }) {
  const toast = useToast();
  const router = useRouter();
  const [busy, setBusy] = React.useState<string | null>(null);
  const run = async (key: string, ids: string[] | "all") => {
    setBusy(key);
    const r = await resolveConflicts(ids);
    setBusy(null);
    if (r.ok) {
      toast.push(r.message ?? "Marked as seen.");
      router.refresh();
    } else toast.push(r.error);
  };
  return (
    <Card>
      <div className="flex items-center gap-2.5 border-b border-divider px-[18px] py-3.5">
        <h2 className="m-0 text-base font-bold text-ink">Conflicts</h2>
        <span
          title="A person's decision is kept; the sheet's value is shown beside it"
          className="inline-flex h-5 w-5 items-center justify-center rounded-full border border-line-strong bg-surface text-[11px] font-semibold text-muted"
        >
          i
        </span>
        <span className="flex-1" />
        {total > 0 ? (
          <button type="button" disabled={!canResolve || busy !== null} onClick={() => run("all", "all")} className={`${btnClass("plain", "sm")} h-8`}>
            {busy === "all" ? "Marking…" : "Mark all seen"}
          </button>
        ) : null}
      </div>
      {rows.length === 0 ? (
        <p className="m-0 px-[18px] py-6 text-muted">No conflicts. Nobody has made a decision in MahekOne that the sheet still disagrees with.</p>
      ) : (
        <DataTable>
          <thead>
            <tr>
              {["Order", "Customer", "Column", "Sheet says", "MahekOne keeps", "Decided by", ""].map((h, i) => (
                <th key={i} className={head} style={HEAD}>
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <TD className={CELL}>
                  <Mono className="text-[13px]">{r.ref}</Mono>
                </TD>
                <TD className={CELL}>
                  <b className="font-semibold text-ink">{r.customer ?? "—"}</b>
                </TD>
                <TD className={CELL}>{r.field.replace(/_/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2").replace(/^./, (c) => c.toUpperCase())}</TD>
                <TD className={CELL}>
                  <Value field={r.field} value={r.sheetValue} kept={false} />
                </TD>
                <TD className={CELL}>
                  <Value field={r.field} value={r.appValue} kept />
                </TD>
                <TD className={CELL}>
                  {r.decidedBy ? `${r.decidedBy.split(/\s+/)[0]}${r.decidedAt ? ` · ${shortDate(r.decidedAt)}` : ""}` : <span className="text-muted">Not recorded</span>}
                </TD>
                <TD className={CELL} align="right">
                  <button
                    type="button"
                    disabled={!canResolve || busy !== null}
                    title="Keep MahekOne's value and mark this seen"
                    onClick={() => run(r.id, [r.id])}
                    className={`${btnClass("plain", "sm")} h-8`}
                  >
                    {busy === r.id ? "…" : "Resolve"}
                  </button>
                </TD>
              </tr>
            ))}
          </tbody>
        </DataTable>
      )}
      {total > rows.length ? <p className="m-0 border-t border-divider px-[18px] py-3 text-xs text-muted">Showing the newest {rows.length} of {total}.</p> : null}
    </Card>
  );
}
