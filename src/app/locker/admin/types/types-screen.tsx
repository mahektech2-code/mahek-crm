"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { saveType } from "@/lib/actions/locker-admin";
import { CATEGORIES, CATEGORY } from "@/lib/locker/catalogue";
import { MODEL_LABEL } from "@/lib/locker/engine";
import { C, CritPill, Pill, btnStyle, inr, nf, useModal, useToast, type ModalField } from "../../_ui/kit";
import { Block, Cell, GTable, Grid, LList } from "../../_ui/vault-parts";

type T = { code: string; name: string; category: string; model: string; validityMonths: number; leadDays: number; graceDays: number; criticality: number; authority: string; typicalCostPaise: number; steps: string[]; consequence: string | null; fields: { key: string; label: string }[]; system: boolean; active: boolean };

export function TypesScreen({ types }: { types: T[] }) {
  const router = useRouter();
  const modal = useModal();
  const toast = useToast();
  const [selCode, setSel] = useState<string>(types.find((t) => t.code === "peso")?.code ?? types[0]?.code ?? "");
  const sel = types.find((t) => t.code === selCode);
  const edit = (t?: T) => {
    const fields: ModalField[] = [
      { k: "name", l: "Name", req: true, init: t?.name ?? "" },
      { k: "category", l: "Category", type: "select", req: true, init: t?.category ?? "statutory", opts: CATEGORIES.map((c) => ({ v: c.slug, l: c.name })) },
      { k: "model", l: "Time model", type: "select", req: true, init: t?.model ?? "document", opts: Object.entries(MODEL_LABEL).map(([v, l]) => ({ v, l })) },
      { k: "vm", l: "Valid for (months)", type: "number", init: String(t?.validityMonths ?? 12), hint: "0 for a type that never ends." },
      { k: "lead", l: "Time needed to renew (days)", type: "number", init: String(t?.leadDays ?? 60), hint: "When the renewal must START — a filing window, a notice period." },
      { k: "grace", l: "Grace after the end date (days)", type: "number", init: String(t?.graceDays ?? 0) },
      { k: "crit", l: "Default importance", type: "select", init: String(t?.criticality ?? 2), opts: [{ v: "4", l: "Business critical" }, { v: "3", l: "High" }, { v: "2", l: "Medium" }, { v: "1", l: "Low" }] },
      { k: "auth", l: "Issued by", init: t?.authority ?? "" },
      { k: "cost", l: "Typical renewal cost (₹)", type: "number", init: String(Math.round((t?.typicalCostPaise ?? 0) / 100)) },
      { k: "cons", l: "What stops if it runs out", type: "area", init: t?.consequence ?? "", hint: "Required for business critical. Shown on the asset and the dashboard." },
      { k: "steps", l: "Renewal steps, one per line", type: "area", init: (t?.steps ?? []).join("\n") },
      { k: "fields", l: "Extra fields, one label per line", type: "area", init: (t?.fields ?? []).map((f) => f.label).join("\n"), hint: "Each becomes a field on the add-asset form for this type." },
      { k: "active", l: "Offered for new assets", type: "select", init: t?.active === false ? "no" : "yes", opts: [{ v: "yes", l: "Yes" }, { v: "no", l: "No — retired" }] },
    ];
    modal({
      title: t ? `Edit ${t.name}` : "New asset type",
      fields,
      okL: t ? "Save" : "Create type",
      done: async (v) => {
        const keep = new Map((t?.fields ?? []).map((f) => [f.label, f.key]));
        const r = await saveType(t?.code ?? null, {
          name: v.name,
          category: v.category,
          model: v.model,
          validityMonths: Number(v.vm) || 0,
          leadDays: Number(v.lead) || 0,
          graceDays: Number(v.grace) || 0,
          criticality: Number(v.crit),
          authority: v.auth,
          typicalCostPaise: Math.round((Number(v.cost) || 0) * 100),
          consequence: v.cons,
          steps: v.steps.split("\n"),
          fields: v.fields.split("\n").map((l) => ({ key: keep.get(l.trim()) ?? "", label: l })),
          active: v.active === "yes",
        });
        if (!r.ok) return r.error;
        toast("Saved");
        setSel(r.data.code);
        router.refresh();
      },
    });
  };
  return (
    <div style={{ padding: "0 24px 48px 24px" }}>
      <Grid cols={2}>
        <Block
          title="Types"
          sub={`${nf(types.length)} types in ${new Set(types.map((t) => t.category)).size} categories`}
          acts={
            <button type="button" onClick={() => edit()} style={btnStyle("p", true)}>
              New type
            </button>
          }
        >
          <GTable
            cols={[["Type", "minmax(220px,2fr)"], ["Category", "150px"], ["Validity", "80px"], ["Lead", "70px"], ["Grace", "70px"], ["Importance", "140px"]]}
            rows={types.map((y) => ({
              key: y.code,
              edge: y.code === selCode ? C.brand : null,
              bg: y.code === selCode ? "#F7F4FF" : null,
              onClick: () => setSel(y.code),
              cells: [
                <Cell key="a" t={y.name} sub={`${y.authority}${y.active ? "" : " · retired"}`} />,
                <Cell key="b" t={CATEGORY[y.category]?.name ?? y.category} />,
                <Cell key="c" t={y.validityMonths ? (y.validityMonths >= 12 && y.validityMonths % 12 === 0 ? `${y.validityMonths / 12}y` : `${y.validityMonths}m`) : "—"} />,
                <Cell key="d" t={`${y.leadDays}d`} />,
                <Cell key="e" t={y.graceDays ? `${y.graceDays}d` : "—"} />,
                <CritPill key="f" crit={y.criticality} />,
              ],
            }))}
          />
        </Block>
        {sel ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            <Block
              title={sel.name}
              sub={`${MODEL_LABEL[sel.model as keyof typeof MODEL_LABEL] ?? sel.model} · ${sel.system ? "seeded with the Locker" : "added by an admin"}`}
              acts={
                <button type="button" onClick={() => edit(sel)} style={btnStyle("s", true)}>
                  Edit type
                </button>
              }
            >
              <LList
                items={[
                  { key: "v", t: "Validity", sub: sel.validityMonths ? `${sel.validityMonths} months` : "Does not expire" },
                  { key: "l", t: "Time needed to renew", sub: sel.leadDays ? `Start ${sel.leadDays} days before the end date` : "None" },
                  { key: "g", t: "Grace period", sub: sel.graceDays ? `${sel.graceDays} days after the end date` : "None — runs out on the end date" },
                  { key: "c", t: "Typical renewal cost", sub: sel.typicalCostPaise ? inr(sel.typicalCostPaise) : "—" },
                  { key: "s", t: "What stops if it runs out", sub: sel.consequence ?? "Not recorded", red: sel.criticality === 4 && !sel.consequence },
                ]}
              />
            </Block>
            <Block title={`Field schema · ${sel.name}`} sub="Fields beyond the common spine. Never a password here — secrets go in the vault.">
              <LList items={sel.fields.map((f) => ({ key: f.key, t: f.label, sub: `key ${f.key}`, badge: <Pill label="Text" bg="#F7F8FA" fg="#3D4453" /> }))} empty="No extra fields — the common spine covers it." />
            </Block>
            <Block title="Renewal steps" sub="Copied onto each renewal task when it is started, so a later edit never rewrites one under way.">
              <LList items={sel.steps.map((s, i) => ({ key: String(i), t: `${i + 1}. ${s}` }))} empty="No steps of its own — the general ones are used." />
            </Block>
          </div>
        ) : null}
      </Grid>
    </div>
  );
}
