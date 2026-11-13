"use client";

import { useRouter } from "next/navigation";
import { saveEntity, saveSite } from "@/lib/actions/locker-admin";
import { C, MONO, Pill, btnStyle, nf, useModal, useToast } from "../../_ui/kit";
import { Block, Cell, GTable } from "../../_ui/vault-parts";

type Ent = { id: string; name: string; gstin: string | null; isPrimary: boolean; active: boolean; n: number };
type Site = { id: string; name: string; kind: string; state: string; hazardous: boolean; entityId: string | null; active: boolean; n: number };

const STATES = ["Maharashtra", "Madhya Pradesh", "Chhattisgarh", "Gujarat", "Telangana", "Rajasthan", "Karnataka", "Tamil Nadu", "Delhi", "Uttar Pradesh", "West Bengal", "Goa", "Other"];

export function CompaniesScreen({ ents, sites }: { ents: Ent[]; sites: Site[] }) {
  const router = useRouter();
  const modal = useModal();
  const toast = useToast();
  const editEnt = (e?: Ent) =>
    modal({
      title: e ? `Edit ${e.name}` : "Add a company",
      fields: [
        { k: "n", l: "Company", req: true, init: e?.name ?? "" },
        { k: "g", l: "GSTIN", init: e?.gstin ?? "" },
        { k: "p", l: "Primary company", type: "select", init: e?.isPrimary ? "yes" : "no", opts: [{ v: "no", l: "No" }, { v: "yes", l: "Yes" }] },
        { k: "a", l: "Active", type: "select", init: e?.active === false ? "no" : "yes", opts: [{ v: "yes", l: "Yes" }, { v: "no", l: "No" }] },
      ],
      okL: "Save",
      done: async (v) => {
        const r = await saveEntity(e?.id ?? null, { name: v.n, gstin: v.g, isPrimary: v.p === "yes", active: v.a === "yes" });
        if (!r.ok) return r.error;
        toast("Saved");
        router.refresh();
      },
    });
  const editSite = (s?: Site) =>
    modal({
      title: s ? `Edit ${s.name}` : "Add a site",
      fields: [
        { k: "n", l: "Site", req: true, init: s?.name ?? "", ph: "Ambernath Plant" },
        { k: "k", l: "Kind", type: "select", init: s?.kind ?? "office", opts: [{ v: "office", l: "Office" }, { v: "factory", l: "Factory / plant" }, { v: "godown", l: "Godown" }, { v: "depot", l: "Depot" }] },
        { k: "st", l: "State", type: "select", init: s?.state || "Maharashtra", opts: STATES },
        { k: "h", l: "Stores flammable solvents?", type: "select", init: s?.hazardous ? "yes" : "no", opts: [{ v: "no", l: "No" }, { v: "yes", l: "Yes — hazardous storage" }], hint: "A hazardous site must hold PESO, Pollution Board and fire licences." },
        { k: "e", l: "Company", type: "select", init: s?.entityId ?? "", opts: [{ v: "", l: "Not set" }, ...ents.map((x) => ({ v: x.id, l: x.name }))] },
        { k: "a", l: "Active", type: "select", init: s?.active === false ? "no" : "yes", opts: [{ v: "yes", l: "Yes" }, { v: "no", l: "No" }] },
      ],
      okL: "Save",
      done: async (v) => {
        const r = await saveSite(s?.id ?? null, { name: v.n, kind: v.k, state: v.st, hazardous: v.h === "yes", entityId: v.e || null, active: v.a === "yes" });
        if (!r.ok) return r.error;
        toast("Saved");
        router.refresh();
      },
    });
  const editBtn = (run: () => void) => (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        run();
      }}
      style={{ ...btnStyle("s", true), height: 28, fontSize: 12 }}
    >
      Edit
    </button>
  );
  return (
    <div style={{ padding: "0 24px 48px 24px", display: "flex", flexDirection: "column", gap: 16 }}>
      <Block
        title="Companies"
        acts={
          <button type="button" onClick={() => editEnt()} style={btnStyle("p", true)}>
            Add company
          </button>
        }
      >
        <GTable
          emptyLine="No companies yet. Add the group's legal entities — every asset belongs to one."
          cols={[["Company", "minmax(240px,2fr)"], ["GSTIN", "200px"], ["Assets", "90px"], ["", "100px"]]}
          rows={ents.map((e) => ({ key: e.id, cells: [<Cell key="a" t={e.name} sub={[e.isPrimary ? "Primary" : "", e.active ? "" : "Inactive"].filter(Boolean).join(" · ") || undefined} />, <Cell key="b" t={e.gstin ?? "—"} style={{ fontFamily: MONO, fontSize: 13 }} />, <Cell key="c" t={nf(e.n)} />, editBtn(() => editEnt(e))] }))}
        />
      </Block>
      <Block
        title="Locations"
        sub={`${nf(sites.length)} premises`}
        acts={
          <button type="button" onClick={() => editSite()} style={btnStyle("p", true)}>
            Add site
          </button>
        }
      >
        <GTable
          emptyLine="No sites yet."
          cols={[["Location", "minmax(200px,1.6fr)"], ["Type", "100px"], ["State", "150px"], ["Hazardous storage", "150px"], ["Assets", "80px"], ["", "100px"]]}
          rows={sites.map((s) => ({
            key: s.id,
            edge: s.hazardous ? C.red : null,
            cells: [<Cell key="a" t={s.name} sub={s.active ? undefined : "Inactive"} />, <Cell key="b" t={s.kind} />, <Cell key="c" t={s.state || "—"} />, s.hazardous ? <Pill key="d" label="⚠ Hazardous" bg="#FCECEC" fg="#B3261E" /> : <Pill key="d" label="No" bg="#F7F8FA" fg="#6B7385" />, <Cell key="e" t={nf(s.n)} />, editBtn(() => editSite(s))],
          }))}
        />
      </Block>
    </div>
  );
}
