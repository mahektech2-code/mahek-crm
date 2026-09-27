"use client";

import { useMemo, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import type { ColSpec, ListRow, ListSpec } from "@/lib/erp/ui";
import { cellText, FLAG, inr, nf, TONES } from "@/lib/erp/ui";
import { FlagBadge, rowTone, StatusBadge } from "./badge";
import { GodownPicker, type PickItem } from "./godown-picker";
import { Icon } from "./icons";
import { useErpUi } from "./erp-ui";
import { RecordDrawer } from "./record-drawer";

/* ---------------------------------------------------------------------------
 * The generic ERP list, ported from the design: search, godown filter, group
 * toggle, "from dashboard" filter, status chips, the hidden-columns line, the
 * bulk bar, a grouped table with group aggregates and group-select, the empty
 * states, the pager, and the record drawer a row opens.
 *
 * Rules are the server's: this only filters, sorts and pages what it was sent.
 * ------------------------------------------------------------------------- */

const WIDTH: Record<string, number> = { b: 210, t: 140, n: 104, m: 124, d: 92, s: 150, f: 230, ph: 130, em: 170, map: 220, mono: 150 };

export function ListScreen({
  spec,
  rows,
  label,
  crumb,
  sub,
  initialOpen,
  godowns,
  filter,
}: {
  spec: ListSpec;
  rows: ListRow[];
  /** The screen's name: the page title and the record drawer's kind line. */
  label: string;
  crumb: string;
  sub?: string;
  /** A record to open on arrival (`?open=` from search or a link). */
  initialOpen?: string | null;
  /** Godown picker items for the list's godown filter. */
  godowns: PickItem[];
  /** A dashboard pre-filter: the ids it counted, and what to call it. */
  filter?: { label: string; ids: string[] } | null;
}) {
  const ui = useErpUi();
  const router = useRouter();
  const path = usePathname();
  const params = useSearchParams();
  const [q, setQ] = useState("");
  const [chip, setChip] = useState("");
  const [gf, setGf] = useState("");
  const [groupOn, setGroupOn] = useState(true);
  const [sort, setSort] = useState<{ k: string; d: 1 | -1 } | null>(null);
  const [page, setPage] = useState(0);
  const [size, setSize] = useState(25);
  const [sel, setSel] = useState<Record<string, boolean>>({});
  const [openId, setOpenId] = useState<string | null>(initialOpen ?? null);

  const cols = spec.cols;
  const colOf = (k: string): ColSpec => cols.find((c) => c.k === k) ?? { k, l: k, t: "t" };

  const filtered = useMemo(() => {
    let all = rows;
    if (filter) {
      const ids = new Set(filter.ids);
      all = all.filter((r) => ids.has(r.id));
    }
    if (spec.godownKey && gf) all = all.filter((r) => String(r.v[spec.godownKey!] ?? "") === gf);
    return all;
  }, [rows, filter, gf, spec.godownKey]);

  const chips = useMemo(() => {
    if (!spec.chips) return [];
    const vals = Array.from(new Set(filtered.map((r) => String(r.v[spec.chips!] ?? "")).filter(Boolean)));
    return [{ v: "", l: "All", n: filtered.length }, ...vals.map((v) => ({ v, l: v, n: filtered.filter((r) => String(r.v[spec.chips!]) === v).length }))];
  }, [filtered, spec.chips]);

  const view = useMemo(() => {
    let all = filtered;
    if (spec.chips && chip) all = all.filter((r) => String(r.v[spec.chips!] ?? "") === chip);
    const ql = q.trim().toLowerCase();
    if (ql) {
      all = all.filter((r) =>
        cols
          .map((c) => (c.t === "f" ? r.flags.map((f) => FLAG[f]?.[0] ?? f).join(" ") : cellText(c, r.v[c.k])))
          .join(" ")
          .toLowerCase()
          .includes(ql),
      );
    }
    const srt = sort ?? (spec.sortDefault ? { k: spec.sortDefault[0], d: spec.sortDefault[1] } : null);
    if (srt) {
      all = all.slice().sort((a, b) => {
        const x = a.v[srt.k];
        const y = b.v[srt.k];
        const c = typeof x === "number" && typeof y === "number" ? x - y : String(x ?? "").localeCompare(String(y ?? ""));
        return c * srt.d;
      });
    }
    return { all, srt };
  }, [filtered, chip, q, sort, cols, spec.chips, spec.sortDefault]);

  const gk = spec.groups && groupOn ? spec.groups : null;
  const gOf = (r: ListRow) => (gk ?? []).map((k) => cellText(colOf(k), r.v[k])).join(" · ");
  /* Grouping reorders the rows so each group is contiguous, in the order its
     first row appears — cheap enough to do every render at list sizes. */
  const grouped = (() => {
    if (!gk) return { list: view.all, by: null as Map<string, ListRow[]> | null };
    const by = new Map<string, ListRow[]>();
    view.all.forEach((r) => {
      const g = gOf(r);
      by.set(g, [...(by.get(g) ?? []), r]);
    });
    return { list: Array.from(by.values()).flat(), by };
  })();

  const total = grouped.list.length;
  const pages = Math.max(1, Math.ceil(total / size));
  const pg = Math.min(page, pages - 1);
  const pageRows = grouped.list.slice(pg * size, pg * size + size);
  const selIds = Object.keys(sel).filter((k) => sel[k]);
  const inView = new Set(rows.map((r) => r.id));
  const chosen = selIds.filter((id) => inView.has(id));
  const allOnPage = pageRows.length > 0 && pageRows.every((r) => sel[r.id]);

  const tmpl = `40px ${cols.map((c) => `minmax(${c.w ?? WIDTH[c.t] ?? 140}px,${c.t === "b" || c.t === "f" ? "1.6fr" : "1fr"})`).join(" ")} 28px`;
  const minW = 68 + cols.reduce((t, c) => t + (c.w ?? WIDTH[c.t] ?? 140), 0);

  const exportCsv = () => {
    const head = cols.map((c) => c.l).join(",");
    const body = grouped.list
      .map((r) =>
        cols
          .map((c) => `"${(c.t === "f" ? r.flags.map((f) => FLAG[f]?.[0] ?? f).join("; ") : cellText(c, r.v[c.k])).replace(/"/g, '""')}"`)
          .join(","),
      )
      .join("\n");
    const url = URL.createObjectURL(new Blob([`${head}\n${body}`], { type: "text/csv" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `${spec.screen}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    ui.toast(`Exported ${nf(grouped.list.length)} rows as shown`);
  };

  const open = rows.find((r) => r.id === openId) ?? null;
  const closeRec = () => {
    setOpenId(null);
    if (params.get("open")) router.replace(path);
  };
  const noMatchBits = [q ? `“${q}”` : "", chip, filter ? filter.label.toLowerCase() : "", gf].filter(Boolean).join(" · ");

  return (
    <div>
      <PageHeadClient crumb={crumb} title={label} sub={sub}>
        <HeaderButtons spec={spec} onExport={exportCsv} onNew={() => spec.newForm && ui.openForm(spec.newForm)} />
      </PageHeadClient>
      <div style={{ padding: "0 24px 48px 24px" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginBottom: 10 }}>
        <span style={{ position: "relative", flex: "1 1 260px", maxWidth: 380 }}>
          <span style={{ position: "absolute", left: 10, top: 10, color: "#6B7385", display: "flex" }}>
            <Icon n="search" />
          </span>
          <input
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              setPage(0);
            }}
            placeholder="Search this list"
            style={{ width: "100%", height: 36, padding: "0 30px 0 32px", border: "1px solid #DDE1E8", borderRadius: 4, background: "#FFFFFF", fontSize: 14 }}
          />
          {q ? (
            <button onClick={() => setQ("")} title="Clear search" style={{ position: "absolute", right: 6, top: 6, width: 24, height: 24, border: "none", background: "transparent", color: "#6B7385", cursor: "pointer" }}>
              ✕
            </button>
          ) : null}
        </span>
        {spec.godownKey ? (
          <GodownPicker
            value={gf}
            label={gf || "All godowns"}
            align="left"
            items={[{ v: "", l: "All godowns", sub: `${godowns.length} godowns` }, ...godowns]}
            onPick={(v) => {
              setGf(v);
              setPage(0);
            }}
          />
        ) : null}
        {spec.groups ? (
          <button
            onClick={() => {
              setGroupOn((g) => !g);
              setPage(0);
            }}
            style={{
              height: 34,
              padding: "0 12px",
              border: `1px solid ${gk ? "#DDD2FF" : "#DDE1E8"}`,
              background: gk ? "#F1ECFF" : "#FFFFFF",
              color: gk ? "#5223E0" : "#3D4453",
              borderRadius: 4,
              fontSize: 13,
              fontWeight: 500,
              cursor: "pointer",
              whiteSpace: "nowrap",
            }}
          >
            Grouped by {spec.groups.map((k) => colOf(k).l.toLowerCase()).join(" · ")}
          </button>
        ) : null}
        {filter ? (
          <span style={{ display: "inline-flex", alignItems: "center", gap: 6, height: 30, padding: "0 6px 0 12px", borderRadius: 15, background: "#F1ECFF", color: "#5223E0", fontSize: 13, fontWeight: 500 }}>
            From dashboard · {filter.label}
            <button onClick={() => router.replace(path)} title="Remove filter" style={{ width: 20, height: 20, border: "none", background: "transparent", color: "#5223E0", cursor: "pointer" }}>
              ✕
            </button>
          </span>
        ) : null}
      </div>
      {chips.length ? (
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 10 }}>
          {chips.map((x) => (
            <button
              key={x.v || "_all"}
              onClick={() => {
                setChip(x.v);
                setPage(0);
              }}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
                height: 30,
                padding: "0 12px",
                borderRadius: 15,
                border: `1px solid ${chip === x.v ? "#6835FB" : "#DDE1E8"}`,
                background: chip === x.v ? "#F1ECFF" : "#FFFFFF",
                color: chip === x.v ? "#5223E0" : "#3D4453",
                fontSize: 13,
                fontWeight: chip === x.v ? 500 : 400,
                cursor: "pointer",
                whiteSpace: "nowrap",
              }}
            >
              {x.l}
              <span style={{ fontSize: 12, color: "#6B7385" }}>{nf(x.n)}</span>
            </button>
          ))}
        </div>
      ) : null}
      {spec.scopedLine ? <div style={{ fontSize: 13, color: "#5223E0", marginBottom: 8 }}>{spec.scopedLine}</div> : null}
      {spec.hidden.length ? (
        <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, color: "#6B7385", marginBottom: 8 }}>
          <Icon n="lock" s={14} />
          {spec.hidden.length} column{spec.hidden.length > 1 ? "s" : ""} hidden · {spec.hidden.map((x) => x.l).join(", ")} — not on your account
        </div>
      ) : null}
      {chosen.length && spec.bulk?.length ? (
        <div style={{ position: "sticky", top: 8, zIndex: 3, display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", padding: "8px 12px", marginBottom: 10, background: "#3D14A8", color: "#FFFFFF", borderRadius: 8, boxShadow: "0 8px 24px rgba(22,22,22,0.18)" }}>
          <span style={{ fontSize: 14, fontWeight: 500 }}>{chosen.length} selected</span>
          {spec.bulk.map((b) => (
            <button
              key={b.id}
              onClick={() => ui.bulk(spec.screen, b, chosen, () => setSel({}))}
              style={{ height: 30, padding: "0 12px", border: "1px solid rgba(255,255,255,0.35)", background: "rgba(255,255,255,0.08)", borderRadius: 4, color: "#FFFFFF", fontSize: 13, fontWeight: 500, cursor: "pointer" }}
            >
              {b.l}
            </button>
          ))}
          <span style={{ flex: 1 }} />
          <button onClick={() => setSel({})} style={{ height: 30, padding: "0 10px", border: "none", background: "transparent", color: "#FFFFFF", fontSize: 13, cursor: "pointer" }}>
            Clear selection
          </button>
        </div>
      ) : null}
      <div style={{ background: "#FFFFFF", border: "1px solid #DDE1E8", borderRadius: 8, overflow: "hidden" }}>
        <div style={{ overflowX: "auto" }}>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: tmpl,
              minWidth: minW,
              alignItems: "center",
              height: 38,
              padding: "0 8px",
              background: "#F7F8FA",
              borderBottom: "1px solid #DDE1E8",
              fontSize: 12,
              fontWeight: 500,
              textTransform: "uppercase",
              letterSpacing: "0.04em",
              color: "#6B7385",
            }}
          >
            <span style={{ display: "flex", alignItems: "center", justifyContent: "center" }}>
              <input
                type="checkbox"
                checked={allOnPage}
                onChange={() => {
                  const n = { ...sel };
                  pageRows.forEach((r) => (n[r.id] = !allOnPage));
                  setSel(n);
                }}
                title="Select this page"
                style={{ width: 16, height: 16, accentColor: "#6835FB" }}
              />
            </span>
            {cols.map((c) => {
              const on = view.srt && view.srt.k === c.k;
              return (
                <button
                  key={c.k}
                  onClick={() => setSort({ k: c.k, d: on && view.srt!.d > 0 ? -1 : 1 })}
                  style={{
                    border: "none",
                    background: "transparent",
                    padding: "0 8px",
                    font: "inherit",
                    color: on ? "#5223E0" : "#6B7385",
                    textTransform: "uppercase",
                    letterSpacing: "0.04em",
                    cursor: "pointer",
                    textAlign: c.t === "n" || c.t === "m" ? "right" : "left",
                    whiteSpace: "nowrap",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                  }}
                >
                  {c.l}
                  {on ? (view.srt!.d > 0 ? " ↑" : " ↓") : ""}
                </button>
              );
            })}
            <span />
          </div>
          {total > 0
            ? (() => {
                let lastG: string | null = null;
                const out: React.ReactNode[] = [];
                pageRows.forEach((r) => {
                  if (gk && grouped.by) {
                    const g = gOf(r);
                    if (g !== lastG) {
                      const rs = grouped.by.get(g) ?? [];
                      let aggText = `${nf(rs.length)} ${rs.length === 1 ? "row" : "rows"}`;
                      if (spec.agg && cols.some((c) => c.k === spec.agg!.k)) {
                        const s = rs.reduce((t, x) => t + (Number(x.v[spec.agg!.k]) || 0), 0);
                        const v = spec.agg.t === "avg" ? s / (rs.length || 1) : s;
                        aggText += ` · ${colOf(spec.agg.k).t === "m" ? inr(v) : nf(v)} ${spec.agg.l}`;
                      }
                      const allSel = rs.every((x) => sel[x.id]);
                      out.push(
                        <div key={`g:${g}`} style={{ display: "flex", alignItems: "center", gap: 10, padding: "9px 16px", background: "#F7F8FA", borderBottom: "1px solid #EDEFF3", position: "sticky", left: 0 }}>
                          <span style={{ fontSize: 13, fontWeight: 600, color: "#161616" }}>{g || "—"}</span>
                          <span style={{ fontSize: 12, color: "#6B7385" }}>{aggText}</span>
                          {spec.groupSel ? (
                            <button
                              onClick={() => {
                                const n = { ...sel };
                                rs.forEach((x) => (n[x.id] = !allSel));
                                setSel(n);
                              }}
                              style={{ height: 24, padding: "0 8px", border: "1px solid #DDE1E8", background: "#FFFFFF", borderRadius: 4, fontSize: 12, color: "#5223E0", cursor: "pointer" }}
                            >
                              {allSel ? "Clear" : `Select all ${rs.length}`}
                            </button>
                          ) : null}
                        </div>,
                      );
                      lastG = g;
                    }
                  }
                  const tone = rowTone(r.flags);
                  out.push(
                    <div
                      key={r.id}
                      onClick={() => setOpenId(r.id)}
                      className="erp-row"
                      style={{
                        display: "grid",
                        gridTemplateColumns: tmpl,
                        minWidth: minW,
                        alignItems: "center",
                        minHeight: 44,
                        padding: "4px 8px",
                        borderBottom: "1px solid #EDEFF3",
                        background: sel[r.id] ? "#F1ECFF" : undefined,
                        boxShadow: tone ? `inset 3px 0 0 ${TONES[tone][1]}` : "none",
                        cursor: "pointer",
                      }}
                    >
                      <span onClick={(e) => e.stopPropagation()} style={{ display: "flex", alignItems: "center", justifyContent: "center" }}>
                        <input
                          type="checkbox"
                          checked={!!sel[r.id]}
                          onChange={() => setSel((s) => ({ ...s, [r.id]: !s[r.id] }))}
                          style={{ width: 16, height: 16, accentColor: "#6835FB" }}
                        />
                      </span>
                      {cols.map((c) => (
                        <Cell key={c.k} c={c} r={r} />
                      ))}
                      <span style={{ display: "flex", color: "#C2C8D2" }}>
                        <Icon n="chev" s={14} />
                      </span>
                    </div>,
                  );
                });
                return out;
              })()
            : null}
        </div>
        {rows.length === 0 ? (
          <div style={{ padding: "48px 24px", textAlign: "center" }}>
            <div style={{ fontSize: 15, color: "#6B7385" }}>{spec.noDataLine ?? `Nothing here yet.`}</div>
            {spec.newForm && !spec.readOnly ? (
              <button onClick={() => ui.openForm(spec.newForm!)} style={{ marginTop: 14, height: 36, padding: "0 14px", border: "none", background: "#6835FB", borderRadius: 4, color: "#FFFFFF", fontSize: 14, fontWeight: 500, cursor: "pointer" }}>
                {spec.newLabel ?? "New"}
              </button>
            ) : null}
          </div>
        ) : total === 0 ? (
          <div style={{ padding: "48px 24px", textAlign: "center" }}>
            <div style={{ fontSize: 15, color: "#6B7385" }}>Nothing matches {noMatchBits}.</div>
            <button
              onClick={() => {
                setQ("");
                setChip("");
                setGf("");
                setPage(0);
                if (filter) router.replace(path);
              }}
              style={{ marginTop: 14, height: 36, padding: "0 14px", border: "1px solid #DDE1E8", background: "#FFFFFF", borderRadius: 4, color: "#3D4453", fontSize: 14, fontWeight: 500, cursor: "pointer" }}
            >
              Clear filters
            </button>
          </div>
        ) : (
          <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap", padding: "10px 16px", borderTop: "1px solid #EDEFF3" }}>
            <span style={{ fontSize: 13, color: "#6B7385" }}>
              Showing {nf(pg * size + 1)}–{nf(pg * size + pageRows.length)} of {nf(total)}
            </span>
            <span style={{ flex: 1 }} />
            <span style={{ display: "flex", alignItems: "center", gap: 2, fontSize: 12, color: "#6B7385" }}>
              Rows
              {[25, 50, 100].map((n) => (
                <button
                  key={n}
                  onClick={() => {
                    setSize(n);
                    setPage(0);
                  }}
                  style={{ height: 28, minWidth: 36, padding: "0 8px", border: "none", borderRadius: 4, background: size === n ? "#6835FB" : "transparent", color: size === n ? "#FFFFFF" : "#3D4453", fontSize: 13, cursor: "pointer" }}
                >
                  {n}
                </button>
              ))}
            </span>
            <PagerBtn on={pg > 0} onClick={() => setPage(0)} title="First page">
              «
            </PagerBtn>
            <PagerBtn on={pg > 0} onClick={() => setPage(pg - 1)}>
              Previous
            </PagerBtn>
            <span style={{ fontSize: 13, color: "#3D4453", whiteSpace: "nowrap" }}>
              Page {nf(pg + 1)} of {nf(pages)}
            </span>
            <PagerBtn on={pg < pages - 1} onClick={() => setPage(pg + 1)}>
              Next
            </PagerBtn>
            <PagerBtn on={pg < pages - 1} onClick={() => setPage(pages - 1)} title="Last page">
              »
            </PagerBtn>
          </div>
        )}
      </div>
      </div>
      {open ? <RecordDrawer key={open.id} screen={spec} kind={label} row={open} onClose={closeRec} /> : null}
    </div>
  );
}

function PagerBtn({ on, onClick, title, children }: { on: boolean; onClick: () => void; title?: string; children: React.ReactNode }) {
  return (
    <button
      onClick={() => on && onClick()}
      title={title}
      style={{ height: 30, padding: "0 10px", border: "1px solid #DDE1E8", background: "#FFFFFF", borderRadius: 4, fontSize: 13, color: on ? "#3D4453" : "#C2C8D2", cursor: on ? "pointer" : "default" }}
    >
      {children}
    </button>
  );
}

function Cell({ c, r }: { c: ColSpec; r: ListRow }) {
  if (c.t === "f") {
    return (
      <span style={{ padding: "0 8px", display: "flex", flexWrap: "wrap", gap: 4 }}>
        {r.flags.map((f) => (
          <FlagBadge key={f} flag={f} />
        ))}
      </span>
    );
  }
  if (c.t === "s") {
    return (
      <span style={{ padding: "0 8px", display: "flex" }}>
        <StatusBadge value={r.v[c.k]} />
      </span>
    );
  }
  const txt = cellText(c, r.v[c.k]);
  const num = c.t === "n" || c.t === "m";
  return (
    <span
      style={{
        padding: "0 8px",
        fontSize: 14,
        lineHeight: "20px",
        color: c.t === "b" ? "#161616" : txt === "—" ? "#C2C8D2" : c.t === "ph" || c.t === "em" || c.t === "map" ? "#6835FB" : "#3D4453",
        fontWeight: c.t === "b" ? 500 : 400,
        textAlign: num ? "right" : "left",
        whiteSpace: c.t === "b" ? "normal" : "nowrap",
        overflow: "hidden",
        textOverflow: "ellipsis",
        fontVariantNumeric: "tabular-nums",
        fontFamily: c.t === "mono" ? "var(--font-mono)" : undefined,
      }}
    >
      {txt}
    </span>
  );
}

/** The page header, drawn by the list because only the list knows what "as shown" means for Export. */
function PageHeadClient({ crumb, title, sub, children }: { crumb: string; title: string; sub?: string; children: React.ReactNode }) {
  return (
    <div style={{ padding: "18px 24px 14px 24px", display: "flex", alignItems: "flex-end", justifyContent: "space-between", gap: 16, flexWrap: "wrap" }}>
      <div style={{ minWidth: 0, flex: "1 1 360px" }}>
        <div style={{ fontSize: 12, fontWeight: 500, textTransform: "uppercase", letterSpacing: "0.04em", color: "#6B7385" }}>{crumb}</div>
        <h1 style={{ fontSize: 24, lineHeight: "30px", fontWeight: 600, color: "#161616", marginTop: 2 }}>{title}</h1>
        {sub ? <div style={{ fontSize: 14, color: "#6B7385", marginTop: 2, maxWidth: 760, textWrap: "pretty" }}>{sub}</div> : null}
      </div>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>{children}</div>
    </div>
  );
}

function HeaderButtons({ spec, onExport, onNew }: { spec: ListSpec; onExport: () => void; onNew: () => void }) {
  const btn: React.CSSProperties = { height: 36, padding: "0 14px", border: "1px solid #DDE1E8", background: "#FFFFFF", borderRadius: 4, fontSize: 14, fontWeight: 500, color: "#3D4453", cursor: "pointer", display: "inline-flex", alignItems: "center", gap: 6 };
  return (
    <>
      <button onClick={onExport} style={btn}>
        Export CSV
      </button>
      {spec.download ? (
        <button onClick={onExport} style={btn}>
          <Icon n="dl" />
          Download
        </button>
      ) : null}
      {spec.newForm && !spec.readOnly ? (
        <button onClick={onNew} style={{ ...btn, border: "none", background: "#6835FB", color: "#FFFFFF" }}>
          <Icon n="plus" />
          {spec.newLabel ?? "New"}
        </button>
      ) : null}
    </>
  );
}
