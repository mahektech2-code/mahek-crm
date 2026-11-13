"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { recordExport } from "@/lib/actions/locker-assets";
import { CATEGORIES, CATEGORY } from "@/lib/locker/catalogue";
import { CRIT, STATUS, daysColour, daysLabel } from "@/lib/locker/engine";
import type { AssetLite } from "@/lib/locker/lite";
import { Btn, C, PageHead, Picker, SearchBox, Segmented, StatusPill, Tabs, fd, nf, useDensity, usePager, useToast } from "../_ui/kit";
import { countdown } from "../_ui/register-parts";

/* ---------------------------------------------------------------------------
 * THE REGISTER — All assets, one category, or My assets. The design's views,
 * search, seven filters, sortable columns, Table / Cards and paging; every
 * count is over what this person may see. Sorted by days remaining by
 * default; the left edge is importance, the badge is status.
 * ------------------------------------------------------------------------- */

type View = "all" | "d30" | "d90" | "over" | "unowned" | "unver" | "crit" | "prog" | "mine";
const VIEWS: [View, string][] = [
  ["all", "All"],
  ["d30", "Expiring 30 days"],
  ["d90", "Expiring 90 days"],
  ["over", "Overdue"],
  ["unowned", "Unowned"],
  ["unver", "Not checked"],
  ["crit", "Business critical"],
  ["prog", "Renewal in progress"],
  ["mine", "Mine"],
];
type Filters = { type?: string; ent?: string; loc?: string; crit?: string; st?: string; owner?: string; cat?: string };
type SortKey = "title" | "loc" | "d" | "st" | "owner" | "ver";

const inView = (a: AssetLite, v: View, me: string) => {
  switch (v) {
    case "d30":
      return a.d != null && a.d >= 0 && a.d <= 30;
    case "d90":
      return a.d != null && a.d >= 0 && a.d <= 90;
    case "over":
      return a.d != null && a.d < 0;
    case "unowned":
      return !a.ownerId;
    case "unver":
      return a.unchecked;
    case "crit":
      return a.crit === 4;
    case "prog":
      return ["renewal_in_progress", "renewal_filed", "awaiting_document"].includes(a.status);
    case "mine":
      return a.ownerId === me || a.backupId === me;
    default:
      return true;
  }
};

export function RegisterScreen({
  rows,
  cat,
  me,
  initialView,
  title,
  sub,
  crumb,
  canAdd,
  entities,
  sites,
  catsAllowed,
}: {
  rows: AssetLite[];
  cat: string | null;
  me: string;
  initialView: View;
  title: string;
  sub: string;
  crumb: string;
  canAdd: boolean;
  entities: { id: string; name: string; gstin: string | null }[];
  sites: { id: string; name: string; hazardous: boolean }[];
  catsAllowed: string[];
}) {
  const router = useRouter();
  const toast = useToast();
  const compact = useDensity() === "compact";
  const [view, setView] = useState<View>(initialView);
  const [q, setQ] = useState("");
  const [f, setF] = useState<Filters>({});
  const [sort, setSort] = useState<[SortKey, 1 | -1]>(["d", 1]);
  const [mode, setMode] = useState<"table" | "cards">("table");

  const base = useMemo(() => rows.filter((a) => (!cat || a.category === cat) && (!f.cat || a.category === f.cat)), [rows, cat, f.cat]);
  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return base.filter((a) => {
      if (f.type && a.typeCode !== f.type) return false;
      if (f.ent && a.entityId !== f.ent) return false;
      if (f.loc && a.siteId !== f.loc) return false;
      if (f.crit && a.crit !== Number(f.crit)) return false;
      if (f.st && a.status !== f.st) return false;
      if (f.owner && (a.ownerName ?? "") !== f.owner) return false;
      if (!inView(a, view, me)) return false;
      if (needle && !`${a.title} ${a.code} ${a.docNo} ${a.provider}`.toLowerCase().includes(needle)) return false;
      return true;
    });
  }, [base, f, view, q, me]);

  const key: Record<SortKey, (a: AssetLite) => string | number> = {
    title: (a) => a.title.toLowerCase(),
    loc: (a) => a.siteName ?? "~",
    d: (a) => (a.actionIn == null ? 99999 : a.actionIn),
    st: (a) => a.status,
    owner: (a) => a.ownerName ?? "",
    ver: (a) => -(a.checkedAgo ?? 99999),
  };
  const sorted = useMemo(() => {
    const [k, dir] = sort;
    return filtered.slice().sort((a, b) => {
      const A = key[k](a);
      const B = key[k](b);
      return (A > B ? 1 : A < B ? -1 : 0) * dir || b.crit - a.crit;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- key is a fixed table
  }, [filtered, sort]);
  const pager = usePager(sorted.length);

  const counted = (fn: (a: AssetLite) => string | null) => {
    const m = new Map<string, number>();
    base.forEach((a) => {
      const k = fn(a);
      if (k != null) m.set(k, (m.get(k) ?? 0) + 1);
    });
    return m;
  };
  const tC = counted((a) => a.typeCode);
  const typeNames = new Map(base.map((a) => [a.typeCode, a.typeName]));
  const oC = counted((a) => a.ownerName);
  const lC = counted((a) => a.siteId);
  const sC = counted((a) => a.status);
  const setFilter = (k: keyof Filters, v: string) => {
    setF({ ...f, [k]: v || undefined });
    pager.reset();
  };
  const hasF = Object.values(f).some(Boolean) || !!q;

  const exportCsv = async () => {
    const head = ["Code", "Title", "Type", "Category", "Company", "Site", "End date", "Days", "Status", "Importance", "Owner", "Document number"];
    const esc = (v: string) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const lines = [head.map(esc).join(",")].concat(
      sorted.map((a) => [a.code, a.title, a.typeName, CATEGORY[a.category]?.name ?? a.category, a.entityName ?? "", a.siteName ?? "", a.endDate ?? "", a.d == null ? "" : String(a.d), STATUS[a.status].label, CRIT[a.crit].label, a.ownerName ?? "", a.docNo].map(esc).join(",")),
    );
    const r = await recordExport(sorted.length, `${cat ? CATEGORY[cat]?.name : "All assets"} · ${VIEWS.find((v) => v[0] === view)?.[1]}`);
    if (!r.ok) return toast(r.error);
    const blob = new Blob([lines.join("\n")], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const el = document.createElement("a");
    el.href = url;
    el.download = `locker-register-${cat ?? "all"}.csv`;
    el.click();
    URL.revokeObjectURL(url);
    toast(r.message ?? "Exported");
  };

  const tpl = "minmax(0,2.6fr) minmax(0,1.3fr) minmax(0,1.1fr) minmax(0,1.2fr) minmax(0,1fr) minmax(0,0.75fr)";
  const ths: [SortKey, string][] = [
    ["title", "Asset"],
    ["loc", "Where"],
    ["d", "Days remaining"],
    ["st", "Status"],
    ["owner", "Owner"],
    ["ver", "Checked"],
  ];
  const groups = CATEGORIES.map((c) => ({ c, list: sorted.filter((a) => a.category === c.slug) })).filter((g) => g.list.length);

  return (
    <>
      <PageHead
        crumb={crumb}
        title={title}
        sub={sub}
        actions={
          <>
            <Btn onClick={exportCsv}>Export</Btn>
            {canAdd ? <Btn kind="p" onClick={() => router.push(cat ? `/locker/assets/new?cat=${cat}` : "/locker/assets/new")}>Add asset</Btn> : null}
          </>
        }
      />
      <div style={{ padding: "0 24px 40px 24px", display: "flex", flexDirection: "column", gap: 12 }}>
        <Tabs
          tabs={VIEWS.map(([k, l]) => ({ key: k, label: l, n: nf(base.filter((a) => inView(a, k, me)).length) }))}
          value={view}
          onPick={(k) => {
            setView(k);
            pager.reset();
          }}
        />
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <SearchBox value={q} onChange={setQ} placeholder="Title, code or document number" />
          {!cat ? (
            <Picker
              k="Category"
              label={f.cat ? (CATEGORY[f.cat]?.name ?? f.cat) : "All"}
              value={f.cat ?? ""}
              options={[{ v: "", l: "All categories", m: "" }].concat(CATEGORIES.filter((c) => catsAllowed.includes(c.slug)).map((c) => ({ v: c.slug, l: c.name, m: nf(rows.filter((a) => a.category === c.slug).length) })))}
              onPick={(v) => setFilter("cat", v)}
              ph="Search categories"
            />
          ) : null}
          <Picker
            k="Type"
            label={f.type ? (typeNames.get(f.type) ?? f.type) : "All"}
            value={f.type ?? ""}
            options={[{ v: "", l: "All types", m: "" }].concat([...tC.entries()].sort((a, b) => b[1] - a[1]).map(([k, n]) => ({ v: k, l: typeNames.get(k) ?? k, m: nf(n) })))}
            onPick={(v) => setFilter("type", v)}
            ph={`Search ${tC.size} types`}
          />
          <Picker
            k="Company"
            label={f.ent ? (entities.find((e) => e.id === f.ent)?.name ?? "") : "All"}
            value={f.ent ?? ""}
            options={[{ v: "", l: "All entities", m: "" }].concat(entities.map((e) => ({ v: e.id, l: e.name, m: e.gstin ?? "" })))}
            onPick={(v) => setFilter("ent", v)}
            ph="Search entities"
          />
          <Picker
            k="Location"
            label={f.loc ? (sites.find((s) => s.id === f.loc)?.name ?? "") : "All"}
            value={f.loc ?? ""}
            options={[{ v: "", l: "All locations", m: "" }].concat(sites.map((s) => ({ v: s.id, l: s.name + (s.hazardous ? " · hazardous" : ""), m: nf(lC.get(s.id) ?? 0) })))}
            onPick={(v) => setFilter("loc", v)}
            ph="Search locations"
          />
          <Picker
            k="Importance"
            label={f.crit ? CRIT[Number(f.crit)].label : "All"}
            value={f.crit ?? ""}
            options={[{ v: "", l: "All", m: "" }].concat([4, 3, 2, 1].map((k) => ({ v: String(k), l: CRIT[k].label, m: nf(base.filter((a) => a.crit === k).length) })))}
            onPick={(v) => setFilter("crit", v)}
          />
          <Picker
            k="Status"
            label={f.st ? STATUS[f.st as AssetLite["status"]].label : "All"}
            value={f.st ?? ""}
            options={[{ v: "", l: "All statuses", m: "" }].concat([...sC.entries()].map(([k, n]) => ({ v: k, l: STATUS[k as AssetLite["status"]].label, m: nf(n) })))}
            onPick={(v) => setFilter("st", v)}
            ph="Search statuses"
          />
          <Picker
            k="Owner"
            label={f.owner || "All"}
            value={f.owner ?? ""}
            options={[{ v: "", l: "All owners", m: "" }].concat([...oC.entries()].sort((a, b) => b[1] - a[1]).map(([n, c]) => ({ v: n, l: n, m: nf(c) })))}
            onPick={(v) => setFilter("owner", v)}
            ph={`Search ${oC.size} owners`}
          />
          {hasF ? (
            <button type="button" onClick={() => { setF({}); setQ(""); }} style={{ height: 34, padding: "0 10px", border: "none", background: "transparent", color: C.brandInk, fontSize: 13, fontWeight: 500, cursor: "pointer" }}>
              Clear all
            </button>
          ) : null}
          <span style={{ flex: 1 }} />
          <span style={{ fontSize: 13, color: C.muted }}>
            {nf(sorted.length)} of {nf(base.length)} assets
          </span>
          <Segmented opts={[{ key: "table", label: "Table" }, { key: "cards", label: "Cards" }]} value={mode} onPick={setMode} />
        </div>

        {!sorted.length ? (
          <div style={{ background: "#FFFFFF", border: `1px solid ${C.line}`, borderRadius: 6, padding: "56px 24px", textAlign: "center" }}>
            <div style={{ fontSize: 15, color: C.muted }}>{base.length ? "No assets match these filters." : "Nothing is registered in this category yet. Add the first asset to start tracking it."}</div>
            {hasF ? (
              <button type="button" onClick={() => { setF({}); setQ(""); }} style={{ marginTop: 12, height: 34, padding: "0 14px", border: "1px solid #C2C8D2", background: "#FFFFFF", borderRadius: 4, fontSize: 14, cursor: "pointer" }}>
                Clear filters
              </button>
            ) : null}
          </div>
        ) : mode === "table" ? (
          <div style={{ background: "#FFFFFF", border: `1px solid ${C.line}`, borderRadius: 6, overflow: "hidden" }}>
            <div style={{ display: "grid", gridTemplateColumns: tpl, gap: 12, alignItems: "center", padding: "0 16px 0 19px", height: 36, background: C.canvas, borderBottom: `1px solid ${C.line}` }}>
              {ths.map(([k, l]) => (
                <button
                  key={k}
                  type="button"
                  onClick={() => setSort([k, sort[0] === k ? ((-sort[1]) as 1 | -1) : 1])}
                  style={{ border: "none", background: "transparent", padding: 0, fontSize: 12, fontWeight: 500, textTransform: "uppercase", letterSpacing: "0.04em", color: sort[0] === k ? C.ink : C.muted, cursor: "pointer", textAlign: "left", whiteSpace: "nowrap" }}
                >
                  {l}
                  {sort[0] === k ? (sort[1] > 0 ? " ↑" : " ↓") : ""}
                </button>
              ))}
            </div>
            {pager.slice(sorted).map((a, i) => {
              const { cd, date } = countdown(a);
              return (
                <Link
                  key={a.id}
                  href={`/locker/assets/${a.id}`}
                  className="lk-row"
                  style={{ display: "grid", gridTemplateColumns: tpl, gap: 12, alignItems: "center", padding: "0 16px", minHeight: compact ? 36 : 44, borderTop: `1px solid ${C.line3}`, borderLeft: `3px solid ${CRIT[a.crit].edge}`, background: i % 2 ? C.canvas : "#FFFFFF", fontSize: 14, color: C.body, textDecoration: "none" }}
                >
                  <span style={{ minWidth: 0 }}>
                    <span style={{ display: "block", fontWeight: 500, color: C.ink, lineHeight: "19px", overflowWrap: "anywhere" }}>{a.title}</span>
                    <span style={{ display: "block", fontSize: 12, lineHeight: "16px", color: C.muted, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {a.code} · {a.typeName}
                    </span>
                  </span>
                  <span style={{ minWidth: 0 }}>
                    <span style={{ display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{a.siteName ?? "Company-wide"}</span>
                    <span style={{ display: "block", fontSize: 12, lineHeight: "16px", color: C.muted, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{(a.entityName ?? "").replace(" Pvt Ltd", "").replace(" LLP", "")}</span>
                  </span>
                  <span style={{ minWidth: 0 }}>
                    <span style={{ display: "block", fontWeight: 600, color: daysColour(a.d, a.status), whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{a.model === "term_contract" && a.noticeDays ? cd.replace(" days to notice", "d to notice") : cd}</span>
                    <span style={{ display: "block", fontSize: 12, lineHeight: "16px", color: C.muted, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{a.model === "subscription" ? date : a.model === "term_contract" ? date : fd(a.actionDate)}</span>
                  </span>
                  <span style={{ minWidth: 0, overflow: "hidden" }}>
                    <StatusPill status={a.status} />
                  </span>
                  <span style={{ minWidth: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", ...(a.ownerName ? {} : { color: C.red, fontWeight: 600 }) }}>{a.ownerName ?? "Unassigned"}</span>
                  <span style={{ minWidth: 0, color: a.unchecked ? C.amber : C.muted, fontSize: 13, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{a.unchecked ? (a.checkedAgo == null ? "Never" : "Overdue") : `${nf(a.checkedAgo ?? 0)}d ago`}</span>
                </Link>
              );
            })}
            {pager.footer}
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
            {groups.map(({ c, list }) => (
              <div key={c.slug}>
                <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginBottom: 10 }}>
                  <span style={{ fontSize: 15, fontWeight: 600, color: C.ink }}>{c.name}</span>
                  <span style={{ fontSize: 13, color: C.muted }}>{nf(list.length)}</span>
                  <span style={{ flex: 1 }} />
                  {list.length > 8 ? (
                    <button type="button" onClick={() => { setF({ ...f, cat: c.slug }); setMode("table"); }} style={{ border: "none", background: "transparent", color: C.brandInk, fontSize: 13, fontWeight: 500, cursor: "pointer" }}>
                      View all {nf(list.length)} in the table →
                    </button>
                  ) : null}
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(260px,1fr))", gap: 12 }}>
                  {list.slice(0, 8).map((a) => (
                    <Link key={a.id} href={`/locker/assets/${a.id}`} className="lk-card-hover" style={{ display: "block", background: "#FFFFFF", border: `1px solid ${C.line}`, borderLeft: `3px solid ${CRIT[a.crit].edge}`, borderRadius: 6, padding: "14px 16px", textAlign: "left", textDecoration: "none" }}>
                      <span style={{ display: "block", fontSize: 14, fontWeight: 500, color: C.ink, lineHeight: "19px", minHeight: 38 }}>{a.title}</span>
                      <span style={{ display: "flex", alignItems: "baseline", gap: 8, marginTop: 10 }}>
                        <span style={{ fontSize: 26, lineHeight: "30px", fontWeight: 600, color: a.d != null && a.d < 0 ? C.red : C.ink }}>{daysLabel(a.actionIn)}</span>
                        <span style={{ fontSize: 12, color: C.muted }}>{fd(a.actionDate)}</span>
                      </span>
                      <span style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 8 }}>
                        <StatusPill status={a.status} />
                        <span style={{ fontSize: 12, color: a.ownerName ? C.muted : C.red, fontWeight: a.ownerName ? 400 : 600 }}>{a.ownerName ?? "No owner"}</span>
                      </span>
                    </Link>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  );
}
