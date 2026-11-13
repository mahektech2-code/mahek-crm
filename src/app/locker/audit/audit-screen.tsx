"use client";

import { buttonClass, cx } from "@/components/ui/primitives";
import { useState } from "react";
import { checkAuditChain } from "@/lib/actions/locker-admin";
import { C, Chip, Pill, nf, SearchBox } from "../_ui/kit";
import { Alert, Block, Cell, GTable, when } from "../_ui/vault-parts";

type Row = { seq: number; at: string; actor: string; action: string; entity: string; summary: string; reason: string | null; security: boolean; ip: string | null };

const EVENT: [RegExp, string][] = [
  [/secret\.revealed/, "Login revealed"],
  [/secret\.copied/, "Copied"],
  [/reveal_requested/, "Approval requested"],
  [/reveal_approved/, "Approval granted"],
  [/reveal_declined/, "Reveal refused"],
  [/secret\.changed/, "Password changed"],
  [/breakglass/, "Emergency access"],
  [/credential\./, "Login changed"],
  [/identity\./, "Sign-in account"],
  [/review\./, "Permission change"],
  [/offboard\./, "Offboarding"],
  [/exported/, "Export generated"],
  [/asset\.checked/, "Check recorded"],
  [/owner_set/, "Owner changed"],
  [/renewal\./, "Renewal task moved"],
  [/asset\./, "Asset updated"],
  [/type\.|ladder\.|entity\.|site\.|payment_method/, "Setting changed"],
  [/reminder\./, "Reminders sent"],
];
const eventOf = (a: string) => EVENT.find(([re]) => re.test(a))?.[1] ?? a;

export function AuditScreen({ rows }: { rows: Row[] }) {
  const [sec, setSec] = useState(false);
  const [rev, setRev] = useState(false);
  const [q, setQ] = useState("");
  const [chain, setChain] = useState<{ ok: boolean; line: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const needle = q.trim().toLowerCase();
  const shown = rows.filter((r) => (!sec || r.security) && (!rev || r.action === "locker.secret.revealed") && (!needle || `${r.actor} ${r.entity} ${r.summary} ${r.reason ?? ""}`.toLowerCase().includes(needle)));
  return (
    <div className="flex flex-col gap-5 px-6 pb-12">
      {chain ? <Alert tone={chain.ok ? "green" : "red"} t={chain.ok ? "The audit log is intact" : "The audit log has been tampered with"} m={chain.line} /> : null}
      <div className="flex flex-wrap items-center gap-2">
        <SearchBox value={q} onChange={setQ} placeholder="Person, item or reason" />
        <Chip label="Security events only" on={sec} onFlip={() => setSec(!sec)} />
        <Chip vault label="Reveals only" on={rev} onFlip={() => setRev(!rev)} />
        <span className="flex-1" />
        <span className="text-[13px] text-muted">{nf(shown.length)} events</span>
        <button
          type="button"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            const r = await checkAuditChain();
            setBusy(false);
            setChain(r.ok ? { ok: r.data.ok, line: r.data.line } : { ok: false, line: r.error });
          }}
          className={buttonClass({ variant: "secondary", size: "sm" })}
        >
          {busy ? "Checking…" : "Check for changes"}
        </button>
      </div>
      <Block>
        <GTable
          emptyLine="Nothing recorded yet."
          cols={[
            ["When", "130px"],
            ["Actor", "150px"],
            ["Event", "160px"],
            ["What", "minmax(240px,2fr)"],
            ["Reason", "minmax(200px,1.6fr)"],
          ]}
          rows={shown.map((e) => {
            const isRev = e.action === "locker.secret.revealed";
            return {
              key: String(e.seq),
              edge: e.security ? (isRev ? C.ink : C.red) : null,
              bg: e.security ? (isRev ? "var(--color-page)" : "var(--color-danger-soft)") : null,
              cells: [
                <Cell key="a" t={when(e.at, true)} className="text-[13px] text-muted" />,
                <Cell key="b" t={e.actor || "System"} sub={e.ip ?? undefined} className="font-medium text-ink" />,
                e.security ? <Pill key="c" label={eventOf(e.action)} tone={isRev ? "brand" : "danger"} /> : <Pill key="c" label={eventOf(e.action)} tone="neutral" />,
                <Cell key="d" t={e.summary} sub={e.entity !== e.summary ? e.entity : undefined} />,
                <Cell key="e" t={e.reason ? `“${e.reason}”` : "—"} className={cx("text-[13px]", e.reason ? "text-ink" : "text-faint")} />,
              ],
            };
          })}
        />
      </Block>
    </div>
  );
}
