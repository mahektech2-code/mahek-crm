"use client";

import type { ListRow, ListSpec } from "@/lib/erp/ui";
import { cellText } from "@/lib/erp/ui";
import { FlagBadge, StatusBadge } from "./badge";
import { Icon } from "./icons";
import { useErpUi } from "./erp-ui";
import { renderPanel } from "./panels";
import "./panels/index";

/* ---------------------------------------------------------------------------
 * A record, opened from its row: the design's right-hand drawer. Every column
 * the person may see, then the record's extra fields, calculated ones marked;
 * the contact shortcuts; anything a screen draws of its own (allocation,
 * evidence); and the actions — available ones as buttons, unavailable ones
 * disabled with the reason said under them.
 * ------------------------------------------------------------------------- */

export function RecordDrawer({ screen, kind, row, onClose }: { screen: ListSpec; kind: string; row: ListRow; onClose: () => void }) {
  const ui = useErpUi();
  const titleCol = screen.cols.find((c) => c.t === "b") ?? screen.cols[0];
  const title = row.title ?? (titleCol ? cellText(titleCol, row.v[titleCol.k]) : "");
  const fields = [
    ...screen.cols
      .filter((c) => c.t !== "f" && c.k !== titleCol?.k)
      .map((c) => ({ l: c.l, v: c.t === "s" ? String(row.v[c.k] ?? "—") : cellText(c, row.v[c.k]), der: false, status: c.t === "s" })),
    ...(row.fields ?? []).map((f) => ({ ...f, der: !!f.der, status: false })),
  ];
  const acts = row.actions ?? [];
  const blocked = acts.filter((a) => a.why);

  return (
    <div
      onClick={onClose}
      style={{ position: "fixed", inset: 0, zIndex: 20, background: "rgba(22,22,22,0.35)", display: "flex", justifyContent: "flex-end", animation: "erp-fade 150ms cubic-bezier(0.2,0,0.2,1)" }}
    >
      <div
        role="dialog"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
        style={{ width: "min(600px,100vw)", height: "100%", background: "#FFFFFF", boxShadow: "0 8px 24px rgba(22,22,22,0.12)", display: "flex", flexDirection: "column", animation: "erp-drawer 200ms cubic-bezier(0.2,0,0.2,1)" }}
      >
        <div style={{ flex: "none", padding: "16px 20px", borderBottom: "1px solid #EDEFF3", display: "flex", gap: 12, alignItems: "flex-start" }}>
          <span style={{ flex: 1, minWidth: 0 }}>
            <span style={{ display: "block", fontSize: 12, fontWeight: 500, textTransform: "uppercase", letterSpacing: "0.04em", color: "#6B7385" }}>{kind}</span>
            <span style={{ display: "block", fontSize: 20, lineHeight: "26px", fontWeight: 600, color: "#161616", marginTop: 2 }}>{title}</span>
            {row.header ? <span style={{ display: "block", fontSize: 13, color: "#3D4453", marginTop: 3 }}>{row.header}</span> : null}
            {row.flags.length ? (
              <span style={{ display: "flex", gap: 4, flexWrap: "wrap", marginTop: 8 }}>
                {row.flags.map((f) => (
                  <FlagBadge key={f} flag={f} />
                ))}
              </span>
            ) : null}
          </span>
          <button onClick={onClose} title="Close (Esc)" style={{ width: 32, height: 32, border: "none", background: "transparent", color: "#6B7385", cursor: "pointer", fontSize: 18, flex: "none" }}>
            ✕
          </button>
        </div>
        <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "16px 20px", display: "grid", gap: 16, alignContent: "start", gridAutoRows: "max-content" }}>
          {row.panel ? renderPanel(row.panel.kind, { data: row.panel.data, row, screen: screen.screen }) : null}
          {row.contacts?.length ? (
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              {row.contacts.map((k) => (
                <a
                  key={k.href}
                  href={k.href}
                  target="_blank"
                  rel="noopener"
                  style={{ display: "inline-flex", alignItems: "center", height: 32, padding: "0 12px", border: "1px solid #DDE1E8", borderRadius: 16, fontSize: 13, color: "#5223E0", textDecoration: "none" }}
                >
                  {k.l}
                </a>
              ))}
            </div>
          ) : null}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(170px,1fr))", gap: 8 }}>
            {fields.map((f, i) => (
              <div
                key={`${f.l}:${i}`}
                style={{
                  padding: "9px 12px",
                  borderRadius: 6,
                  background: f.der ? "#F7F8FA" : "#FFFFFF",
                  border: `1px ${f.der ? "dashed #DDE1E8" : "solid #EDEFF3"}`,
                }}
              >
                <span style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11, fontWeight: 500, textTransform: "uppercase", letterSpacing: "0.04em", color: "#6B7385" }}>
                  {f.l}
                  {f.der ? (
                    <span style={{ fontSize: 10, textTransform: "none", letterSpacing: 0, padding: "0 5px", borderRadius: 6, background: "#EDEFF3", color: "#6B7385" }}>Calculated</span>
                  ) : null}
                </span>
                {f.status && f.v !== "—" ? (
                  <span style={{ display: "block", marginTop: 4 }}>
                    <StatusBadge value={f.v} />
                  </span>
                ) : (
                  <span style={{ display: "block", fontSize: 14, color: f.v === "—" ? "#C2C8D2" : "#161616", fontWeight: f.v === "—" ? 400 : 500, marginTop: 2, wordBreak: "break-word", fontVariantNumeric: "tabular-nums" }}>
                    {f.v}
                  </span>
                )}
              </div>
            ))}
          </div>
          {screen.hidden.length || row.hiddenFields ? (
            <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, color: "#6B7385" }}>
              <Icon n="lock" s={14} />
              {(screen.hidden.length + (row.hiddenFields ?? 0))} field{screen.hidden.length + (row.hiddenFields ?? 0) > 1 ? "s are" : " is"} not shown on your account.
            </div>
          ) : null}
          {blocked.length ? (
            <div style={{ padding: "10px 12px", background: "#F7F8FA", borderRadius: 6 }}>
              <div style={{ fontSize: 12, fontWeight: 500, textTransform: "uppercase", letterSpacing: "0.04em", color: "#6B7385", marginBottom: 4 }}>Not available yet</div>
              {blocked.map((b) => (
                <div key={b.id} style={{ fontSize: 13, color: "#3D4453", padding: "2px 0" }}>
                  <span style={{ fontWeight: 500, color: "#161616" }}>{b.l}</span> — {b.why}
                </div>
              ))}
            </div>
          ) : null}
          {!acts.length && screen.readOnly ? (
            <div style={{ fontSize: 13, color: "#6B7385" }}>Read-only. These entries are written by their source records, never by hand.</div>
          ) : null}
          {row.by ? <div style={{ fontSize: 12, color: "#6B7385" }}>{row.by}</div> : null}
        </div>
        {acts.length ? (
          <div style={{ flex: "none", borderTop: "1px solid #EDEFF3", padding: "12px 20px", display: "flex", gap: 8, flexWrap: "wrap", justifyContent: "flex-end" }}>
            {acts.map((a) => {
              const okA = !a.why;
              const primary = !!a.primary && okA;
              return (
                <button
                  key={a.id}
                  onClick={() => okA && ui.act(screen.screen, a, row.id, onClose)}
                  title={a.why || a.l}
                  disabled={!okA}
                  style={{
                    height: 36,
                    padding: "0 14px",
                    borderRadius: 4,
                    fontSize: 14,
                    fontWeight: 500,
                    cursor: okA ? "pointer" : "not-allowed",
                    whiteSpace: "nowrap",
                    border: `1px solid ${primary ? "#6835FB" : a.ai && okA ? "#6835FB" : "#DDE1E8"}`,
                    background: primary ? "#6835FB" : "#FFFFFF",
                    color: okA ? (primary ? "#FFFFFF" : a.ai ? "#5223E0" : "#3D4453") : "#C2C8D2",
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 6,
                  }}
                >
                  {a.ai ? <Icon n="spark" /> : null}
                  {a.l}
                </button>
              );
            })}
          </div>
        ) : null}
      </div>
    </div>
  );
}
