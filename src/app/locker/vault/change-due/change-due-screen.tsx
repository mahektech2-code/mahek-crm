"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { recordChange } from "@/lib/actions/locker-vault";
import type { CredRow } from "@/lib/locker/vault-service";
import { TIER } from "@/lib/locker/engine";
import { C, TierPill, btnStyle, nf, useModal, useToast } from "../../_ui/kit";
import { Block, Cell, GTable, LList, Stats } from "../../_ui/vault-parts";

type Row = CredRow & { fields: string[] };

export function ChangeDueScreen({ due, policy }: { due: Row[]; policy: { restricted: number; sensitive: number; standard: number } }) {
  const router = useRouter();
  const modal = useModal();
  const toast = useToast();
  const [selId, setSel] = useState<string | null>(null);
  const [ck, setCk] = useState<Record<string, Record<number, boolean>>>({});
  const sel = due.find((d) => d.id === selId) ?? due[0];
  const mine = sel ? (ck[sel.id] ?? {}) : {};
  const steps = sel ? [`Change it at ${sel.provider || "the provider"}`, "Record the new value in the Locker", "Check it works", `Tell whoever uses it${sel.identityId ? " — and the services that sign in through it" : ""}`] : [];
  const first3 = [0, 2, 3].every((i) => mine[i]);
  return (
    <div style={{ padding: "0 24px 48px 24px", display: "flex", flexDirection: "column", gap: 20 }}>
      <Stats
        items={[
          { l: "Overdue", v: nf(due.length), s: "past policy", red: due.length > 0 },
          { l: "Restricted", v: nf(due.filter((x) => x.tier === "restricted").length), s: `policy ${policy.restricted} days`, red: due.some((x) => x.tier === "restricted") },
          { l: "Sensitive", v: nf(due.filter((x) => x.tier === "sensitive").length), s: `policy ${policy.sensitive} days` },
          { l: "Standard", v: nf(due.filter((x) => x.tier === "standard").length), s: `policy ${policy.standard} days` },
        ]}
      />
      <Block vault title="Past their change date" sub="Ranked by level, then days overdue. A change is recorded only with the new value — the old one is kept, encrypted.">
        <GTable
          vault
          emptyLine="Every password is within its change policy."
          cols={[
            ["Login", "minmax(240px,2fr)"],
            ["Level", "100px"],
            ["Age", "120px"],
            ["Policy", "90px"],
            ["Owner", "140px"],
            ["", "110px"],
          ]}
          rows={due.map((x) => ({
            key: x.id,
            edge: x === sel ? C.v700 : null,
            bg: x === sel ? C.v50 : null,
            onClick: () => setSel(x.id),
            cells: [
              <Cell key="a" t={x.title} sub={x.provider} style={{ color: C.v900, fontWeight: 500 }} />,
              <TierPill key="b" tier={x.tier} />,
              <Cell key="c" t={x.ageDays == null ? "Never set" : `${x.ageDays} days`} sub={`${nf(x.overBy)} over`} style={{ color: C.red, fontWeight: 600 }} />,
              <Cell key="d" t={`${x.policyDays}d`} />,
              <Cell key="e" t={x.ownerName ?? "—"} />,
              <button key="f" type="button" onClick={() => setSel(x.id)} style={{ ...btnStyle("v", true), height: 28, fontSize: 12 }}>
                Checklist
              </button>,
            ],
          }))}
        />
      </Block>
      {sel ? (
        <Block vault title={`Change · ${sel.title}`} sub={`${TIER[sel.tier].label} · ${sel.ageDays ?? 0} days old · policy ${sel.policyDays}`}>
          <LList
            items={[
              ...steps.map((t, i) =>
                i === 1
                  ? { key: String(i), t, sub: "Done when you save the new value below.", check: true, on: false, ro: true }
                  : { key: String(i), t, check: true, on: !!mine[i], flip: () => setCk({ ...ck, [sel.id]: { ...mine, [i]: !mine[i] } }) },
              ),
              {
                key: "finish",
                t: first3 ? "Ready to record the new value" : "Tick each step as you do it",
                sub: "The change is recorded only with the new value, and the steps you ticked go in the record.",
                btn: "Finish the change",
                btnKind: first3 ? "v" : "s",
                off: !first3,
                why: "Finish the checklist first",
                run: () =>
                  modal({
                    title: `Record the change · ${sel.title}`,
                    vault: true,
                    fields: [
                      ...(sel.fields.length > 1 ? [{ k: "f", l: "Which secret", type: "select" as const, req: true, init: sel.fields[0], opts: sel.fields }] : []),
                      { k: "v", l: "New value", type: "password", req: true, hint: "Encrypted the moment you save." },
                      { k: "n", l: "What you changed and checked", type: "area", min: 10, init: `Changed at ${sel.provider || "the provider"}, checked it works, told the people who use it.` },
                    ],
                    okL: "Save the change",
                    done: async (v) => {
                      const r = await recordChange(sel.id, v.f || sel.fields[0] || "Password", v.v, v.n);
                      if (!r.ok) return r.error;
                      toast(`${sel.title} changed`);
                      setSel(null);
                      router.refresh();
                    },
                  }),
              },
            ]}
          />
        </Block>
      ) : null}
    </div>
  );
}
