"use client";

import * as React from "react";
import { Button, Textarea, Th, Td, Tr, checkboxClass, cx } from "@/components/ui/primitives";
import { fd } from "@/lib/erp/ui";
import type { HoldBoardRow } from "@/lib/erp/screens/order-hub";
import type { HoldDepartment } from "@/lib/erp/engines/order-hub";
import { stamp } from "@/lib/format";
import { ActionMenu, BoardFoot, BoardHeader, BoardTable, BoardTabs, FigureCards, Pill } from "../_ui/board";
import { DialogBody, DialogFooter, DialogHeader, DialogTitle, ErpDialog } from "../_ui/dialog";
import { useErpUi } from "../_ui/erp-ui";
import { useKit } from "../_ui/kit";

/* ---------------------------------------------------------------------------
 * TO HOLD: one list for every desk's holds, and the Release dialog — the
 * hold's history, where releasing sends it, what changed, and whether the
 * customer is told. Release and Edit hold are the list's own actions.
 * ------------------------------------------------------------------------- */

type Tab = "all" | HoldDepartment | "released";
const SCREEN = "toHold";

const DEPT_TONE: Record<HoldDepartment, "info" | "warn" | "success" | "muted"> = { verification: "info", accounts: "warn", production: "success", office: "muted" };
const DEPT_SHORT: Record<HoldDepartment, string> = { verification: "Order verification", accounts: "Accounts", production: "Production", office: "Office" };
const RELEASE_LABEL: Record<HoldDepartment, string> = { verification: "Release to the Order Hub", accounts: "Release to Accounts", production: "Release to the MRP check", office: "Release" };

function lookAgain(r: HoldBoardRow, today: string): { text: string; late: boolean } {
  if (!r.nextUpdateOn) return { text: "—", late: false };
  if (r.nextUpdateOn === today) return { text: "Today", late: true };
  if (r.nextUpdateOn < today) {
    const days = Math.round((Date.parse(today) - Date.parse(r.nextUpdateOn)) / 86400000);
    return { text: `${days} day${days === 1 ? "" : "s"} late`, late: true };
  }
  return { text: fd(r.nextUpdateOn), late: false };
}

export function HoldBoard({ rows, releasedThisWeek, today, now, readOnly }: { rows: HoldBoardRow[]; releasedThisWeek: number; today: string; now: number; readOnly: boolean }) {
  const [tab, setTab] = React.useState<Tab>("all");
  const [releasing, setReleasing] = React.useState<HoldBoardRow | null>(null);
  const count = (d: HoldDepartment) => rows.filter((r) => r.department === d).length;
  const shown = tab === "all" ? rows : tab === "released" ? [] : rows.filter((r) => r.department === tab);
  const office = count("office");
  return (
    <div className="px-6 pt-6 pb-10">
      <BoardHeader title="To Hold" danger sub="Every held order from all three departments" />
      <FigureCards
        figures={[
          { label: "On hold", value: rows.length, onClick: () => setTab("all"), on: tab === "all" },
          { label: "Order verification", value: count("verification"), onClick: () => setTab("verification"), on: tab === "verification" },
          { label: "Accounts", value: count("accounts"), onClick: () => setTab("accounts"), on: tab === "accounts" },
          { label: "Production (MRP)", value: count("production"), onClick: () => setTab("production"), on: tab === "production" },
        ]}
      />
      <BoardTabs<Tab>
        value={tab}
        onChange={setTab}
        tabs={[
          { key: "all", label: "All", count: rows.length },
          { key: "verification", label: "Order verification", count: count("verification") },
          { key: "accounts", label: "Accounts", count: count("accounts") },
          { key: "production", label: "Production", count: count("production") },
          ...(office ? [{ key: "office" as Tab, label: "Office", count: office }] : []),
          { key: "released", label: "Released this week", count: releasedThisWeek },
        ]}
      />
      {shown.length ? (
        <BoardTable>
          <colgroup>
            <col style={{ width: 150 }} />
            <col style={{ width: 180 }} />
            <col style={{ width: 160 }} />
            <col />
            <col style={{ width: 130 }} />
            <col style={{ width: 110 }} />
            <col style={{ width: 130 }} />
          </colgroup>
          <thead>
            <tr>
              <Th>Number</Th>
              <Th>Party</Th>
              <Th>Department</Th>
              <Th>Reason · remarks</Th>
              <Th>Held by</Th>
              <Th>Look again</Th>
              <Th />
            </tr>
          </thead>
          <tbody>
            {shown.map((r) => {
              const release = r.actions.find((a) => a.prompt && a.l === "Release");
              const again = lookAgain(r, today);
              return (
                <Tr key={r.id}>
                  <Td className="py-3 whitespace-normal">
                    <span className="block font-semibold text-ink">{r.number}</span>
                    <span className="block text-meta text-muted">{r.sub}</span>
                  </Td>
                  <Td className="py-3 whitespace-normal text-ink">{r.party}</Td>
                  <Td className="py-3">
                    <Pill tone={DEPT_TONE[r.department]}>{DEPT_SHORT[r.department]}</Pill>
                  </Td>
                  <Td className="py-3 whitespace-normal">
                    <span className="block font-semibold text-ink">{r.reason}</span>
                    {r.note ? <span className="block text-meta text-body">{r.note}</span> : null}
                  </Td>
                  <Td className="py-3 whitespace-normal">
                    <span className="block text-ink">{r.by ?? "—"}</span>
                    <span className="block text-meta text-muted">{stamp(r.at)}</span>
                  </Td>
                  <Td className={cx("py-3", again.late ? "font-medium text-danger" : "text-ink")}>{again.text}</Td>
                  <Td className="py-3">
                    <span className="flex items-center justify-end gap-2">
                      {release && !readOnly ? (
                        <Button size="sm" disabled={!!release.why} title={release.why || undefined} onClick={() => setReleasing(r)}>
                          Release
                        </Button>
                      ) : null}
                      {readOnly ? null : <ActionMenu screen={SCREEN} recordId={r.id} actions={r.actions} skip={[release?.id ?? ""]} />}
                    </span>
                  </Td>
                </Tr>
              );
            })}
          </tbody>
        </BoardTable>
      ) : (
        <div className="rounded-card border border-line bg-surface px-5 py-10 text-center text-sm text-muted">
          {tab === "released" ? `${releasedThisWeek} released in the last seven days. A released hold goes back to the desk that held it.` : "Nothing on hold. A hold from any desk lands here."}
        </div>
      )}
      <BoardFoot>Only the department that held it (or an administrator) releases it. Release sends it back to that department to be checked again. Accounts see the same list in their app.</BoardFoot>
      {releasing ? <ReleaseDialog key={releasing.id} row={releasing} now={now} onClose={() => setReleasing(null)} /> : null}
    </div>
  );
}

function ReleaseDialog({ row, now, onClose }: { row: HoldBoardRow; now: number; onClose: () => void }) {
  const ui = useErpUi();
  const kit = useKit();
  const release = row.actions.find((a) => a.prompt && a.l === "Release")!;
  const edit = row.actions.find((a) => a.id === "editHold");
  const [what, setWhat] = React.useState("");
  const [notify, setNotify] = React.useState(row.kind === "order");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const days = Math.max(0, Math.round((now - new Date(row.at).getTime()) / 86400000));

  async function go() {
    setBusy(true);
    setError(null);
    try {
      const res = await kit.runAction(SCREEN, release.id, row.id, { resolution: what, ...(row.kind === "order" ? { notify: notify ? "Yes" : "No" } : {}) });
      if (res.ok) {
        ui.toast(res.message ?? "Released");
        onClose();
      } else setError(res.fieldErrors?.[0]?.message ?? res.error);
    } finally {
      setBusy(false);
    }
  }

  return (
    <ErpDialog onClose={onClose} label={`Release ${row.number}`} width={640} tall={false}>
      <DialogHeader onClose={onClose}>
        <DialogTitle className="flex items-center gap-2">
          Release {row.number.toLowerCase().startsWith("order") ? row.number.replace(/^Order/, "order") : row.number}
          <Pill tone="brand">New</Pill>
        </DialogTitle>
        <div className="mt-1 text-meta text-body">
          {row.party} · held by {DEPT_SHORT[row.department]} for {days} day{days === 1 ? "" : "s"}
        </div>
      </DialogHeader>
      <DialogBody>
        <ol className="flex flex-col">
          {row.history.map((h, i) => (
            <li key={i} className="grid grid-cols-[120px_minmax(0,1fr)] gap-3 border-b border-divider py-2 text-sm last:border-0">
              <span className="text-muted">{stamp(h.at)}</span>
              <span className="whitespace-pre-line text-ink">
                {h.bold ? <b className="font-semibold">{h.bold}</b> : null}
                {h.text}
              </span>
            </li>
          ))}
        </ol>
        <div className="rounded-card bg-warn-soft px-4 py-3 text-sm text-warn-ink">Goes {row.releaseTo} to be checked again. It does not skip ahead.</div>
        <label className="flex flex-col gap-1.5">
          <span className="text-sm font-medium text-ink">What changed</span>
          <Textarea rows={3} value={what} onChange={(e) => setWhat(e.target.value)} />
        </label>
        {row.kind === "order" ? (
          <label className="flex cursor-pointer items-center gap-2.5 text-sm text-ink">
            <input type="checkbox" className={checkboxClass} checked={notify} onChange={(e) => setNotify(e.target.checked)} />
            Tell the customer the hold is over
          </label>
        ) : null}
        {error ? <p className="text-sm text-danger">{error}</p> : null}
      </DialogBody>
      <DialogFooter
        left={
          edit ? (
            <Button
              disabled={!!edit.why}
              title={edit.why || undefined}
              onClick={() => {
                onClose();
                ui.act(SCREEN, edit, row.id);
              }}
            >
              Edit hold
            </Button>
          ) : undefined
        }
      >
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="primary" disabled={busy || !!release.why} onClick={go}>
          {busy ? "Releasing…" : RELEASE_LABEL[row.department]}
        </Button>
      </DialogFooter>
    </ErpDialog>
  );
}
