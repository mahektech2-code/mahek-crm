"use client";

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
    <div style={{ padding: "0 24px 48px 24px", display: "flex", flexDirection: "column", gap: 20 }}>
      {chain ? <Alert tone={chain.ok ? "green" : "red"} t={chain.ok ? "The audit log is intact" : "The audit log has been tampered with"} m={chain.line} /> : null}
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <SearchBox value={q} onChange={setQ} placeholder="Person, item or reason" />
        <Chip label="Security events only" on={sec} onFlip={() => setSec(!sec)} />
        <Chip vault label="Reveals only" on={rev} onFlip={() => setRev(!rev)} />
        <span style={{ flex: 1 }} />
        <span style={{ fontSize: 13, color: C.muted }}>{nf(shown.length)} events</span>
        <button
          type="button"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            const r = await checkAuditChain();
            setBusy(false);
            setChain(r.ok ? { ok: r.data.ok, line: r.data.line } : { ok: false, line: r.error });
          }}
          style={{ height: 30, padding: "0 12px", border: "1px solid #C2C8D2", background: "#FFFFFF", borderRadius: 4, fontSize: 13, cursor: "pointer" }}
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
              edge: e.security ? (isRev ? C.v700 : C.red) : null,
              bg: e.security ? (isRev ? "#FAF9FC" : "#FFFAFA") : null,
              cells: [
                <Cell key="a" t={when(e.at, true)} style={{ fontSize: 13, color: C.muted }} />,
                <Cell key="b" t={e.actor || "System"} sub={e.ip ?? undefined} style={{ fontWeight: 500, color: C.ink }} />,
                e.security ? <Pill key="c" label={eventOf(e.action)} bg={isRev ? C.v100 : "#FCECEC"} fg={isRev ? C.v900 : C.red} /> : <Pill key="c" label={eventOf(e.action)} bg="#F7F8FA" fg="#3D4453" />,
                <Cell key="d" t={e.summary} sub={e.entity !== e.summary ? e.entity : undefined} />,
                <Cell key="e" t={e.reason ? `“${e.reason}”` : "—"} style={{ fontSize: 13, color: e.reason ? C.ink : C.faint }} />,
              ],
            };
          })}
        />
      </Block>
    </div>
  );
}
