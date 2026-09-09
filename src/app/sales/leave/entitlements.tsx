"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Modal } from "@/components/ui/overlays";
import { useToast } from "@/components/ui/toast";
import { setLeaveEntitlement } from "@/lib/actions/sales";
import type { EntitlementRow } from "@/lib/services/sales-service";
import { Button, Cell, HeadCell, Row, Table } from "../parts";
import { LEAVE_LABEL, label } from "../words";

/**
 * How many days of leave each salesman gets, and the one place it can be set.
 *
 * `mbos.leave.annualEntitlementDays` is what everybody gets, and a row in
 * `mbos_leave_balances` overrides it for one person. The override already
 * worked and there was NO DOOR TO IT — nothing in MahekOne wrote such a row —
 * so a salesman hired on different terms could not be given them from any
 * screen at all.
 *
 * The figures shown are what the salesman sees on his own phone, through the
 * same engine, so this screen and that one cannot disagree.
 *
 * BLANK IS NOT ZERO. Blank clears the override and puts the person back on the
 * company figure; zero is a decision — a probationer with no earned leave yet
 * — and is kept as one. Presenting them as the same thing is how somebody gets
 * granted exactly what was withheld.
 */
export function Entitlements({
  year,
  rows,
  defaults,
}: {
  year: number;
  rows: EntitlementRow[];
  /** The company figures, so the dialog can say what blank falls back to. */
  defaults: Record<string, number>;
}) {
  const router = useRouter();
  const toast = useToast();
  const [editing, setEditing] = React.useState<EntitlementRow | null>(null);

  const kinds = React.useMemo(() => {
    const seen = new Set<string>(Object.keys(defaults));
    for (const r of rows) for (const b of r.balances) seen.add(b.kind);
    return [...seen];
  }, [rows, defaults]);

  if (!rows.length) return null;

  return (
    <>
      <Table
        minWidth={880}
        head={
          <>
            <HeadCell width={220}>Salesman</HeadCell>
            {kinds.map((k) => (
              <HeadCell key={k} align="right" width={150}>
                {label(LEAVE_LABEL, k)}
              </HeadCell>
            ))}
            <HeadCell align="right" width={130} />
          </>
        }
      >
        {rows.map((r, i) => (
          <Row key={r.userId} striped={i % 2 === 1}>
            <Cell truncate={220}>
              <span className="font-medium text-ink">{r.name}</span>
            </Cell>
            {kinds.map((k) => {
              const b = r.balances.find((x) => x.kind === k);
              if (!b) {
                return (
                  <Cell key={k} align="right">
                    <span className="text-muted">—</span>
                  </Cell>
                );
              }
              return (
                <Cell key={k} align="right">
                  {/* Never clamped at zero — somebody granted more than they
                      had left is genuinely overdrawn, and this is where that
                      gets noticed rather than on the payslip. */}
                  <span className={b.available < 0 ? "font-medium text-warn-ink" : "font-medium text-ink"}>
                    {b.available}
                  </span>
                  <span className="text-muted"> of {b.entitled}</span>
                  <span className="block text-[12px] text-muted">
                    {r.overridden.includes(k) ? "set for them" : "company default"}
                  </span>
                </Cell>
              );
            })}
            <Cell align="right">
              <Button size="sm" tone="default" onClick={() => setEditing(r)}>
                Set days
              </Button>
            </Cell>
          </Row>
        ))}
      </Table>

      {editing ? (
        <EditDialog
          key={editing.userId}
          year={year}
          row={editing}
          defaults={defaults}
          onClose={() => setEditing(null)}
          onDone={(res) => {
            toast.push(res.ok ? (res.message ?? "Saved.") : (res.error ?? "That did not work."));
            if (res.ok) {
              setEditing(null);
              router.refresh();
            }
          }}
        />
      ) : null}
    </>
  );
}

/** Keyed on the person, so the draft is initial state rather than an effect. */
function EditDialog({
  year,
  row,
  defaults,
  onClose,
  onDone,
}: {
  year: number;
  row: EntitlementRow;
  defaults: Record<string, number>;
  onClose: () => void;
  onDone: (r: { ok: boolean; message?: string; error?: string }) => void;
}) {
  const [draft, setDraft] = React.useState<Record<string, string>>(() =>
    Object.fromEntries(
      row.balances.map((b) => [b.kind, row.overridden.includes(b.kind) ? String(b.entitled) : ""]),
    ),
  );
  const [saving, setSaving] = React.useState(false);

  const save = () => {
    const days: Record<string, number | null> = {};
    for (const [kind, raw] of Object.entries(draft)) {
      const text = raw.trim();
      days[kind] = text === "" ? null : Number(text);
    }
    if (Object.values(days).some((v) => v !== null && !Number.isFinite(v))) {
      onDone({ ok: false, error: "Every figure has to be a number of days, or blank." });
      return;
    }
    setSaving(true);
    void setLeaveEntitlement({ userId: row.userId, year, days }).then((r) => {
      setSaving(false);
      onDone(r);
    });
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={`${row.name}'s leave for ${year}`}
      footer={
        <>
          <Button tone="default" onClick={onClose}>
            Cancel
          </Button>
          <Button tone="primary" disabled={saving} onClick={save}>
            {saving ? "Saving…" : "Save"}
          </Button>
        </>
      }
    >
      <div className="text-sm leading-[21px] text-body">
        <p>
          Days a year, before anything is taken. Leave a box blank to put them
          back on the company figure; a zero is a decision and is kept as one.
        </p>
        <p className="mt-2 text-muted">
          Days already taken are not touched here — those are counted from
          approved requests, and this is what they are counted against.
        </p>

        <div className="mt-3 flex flex-col gap-2">
          {row.balances.map((b) => (
            <label key={b.kind} className="flex items-center gap-3">
              <span className="w-40 shrink-0 text-[13px] text-ink">
                {label(LEAVE_LABEL, b.kind)}
              </span>
              <input
                inputMode="decimal"
                value={draft[b.kind] ?? ""}
                onChange={(e) => setDraft((d) => ({ ...d, [b.kind]: e.target.value }))}
                placeholder={
                  defaults[b.kind] != null ? `${defaults[b.kind]} (company)` : "not set"
                }
                className="h-9 w-28 rounded-[4px] border border-line bg-canvas px-2.5 text-[13px] text-ink"
              />
              <span className="text-[12px] text-muted">
                {b.used ? `${b.used} taken` : "none taken"}
              </span>
            </label>
          ))}
        </div>
      </div>
    </Modal>
  );
}
