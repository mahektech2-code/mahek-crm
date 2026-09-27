"use client";

import { useState } from "react";
import { Icon } from "./icons";

/* The design's godown picker: a button that opens a searchable list of
   godowns (and, where asked, "All" and regions). Used by the header's working
   location, the dashboard scope and every list's godown filter. */

export type PickItem = { v: string; l: string; sub?: string };

export function GodownPicker({
  value,
  label,
  items,
  onPick,
  tint = false,
  align = "right",
  placeholder,
  noneLine,
}: {
  value: string;
  label: string;
  items: PickItem[];
  onPick: (v: string) => void;
  tint?: boolean;
  align?: "left" | "right";
  placeholder?: string;
  noneLine?: string;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const ql = q.trim().toLowerCase();
  const match = items.filter((it) => !ql || `${it.l} ${it.sub ?? ""}`.toLowerCase().includes(ql));
  const shown = match.slice(0, 9);
  return (
    <span style={{ position: "relative", display: "inline-block", flex: "none" }}>
      <button
        onClick={() => {
          setOpen((o) => !o);
          setQ("");
        }}
        title={label}
        style={{
          height: 34,
          padding: "0 10px",
          display: "inline-flex",
          alignItems: "center",
          gap: 6,
          border: `1px solid ${tint ? "#DDD2FF" : "#DDE1E8"}`,
          background: tint ? "#F1ECFF" : "#FFFFFF",
          borderRadius: 4,
          color: tint ? "#5223E0" : "#3D4453",
          fontSize: 13,
          fontWeight: 500,
          cursor: "pointer",
          whiteSpace: "nowrap",
          maxWidth: 280,
          overflow: "hidden",
          textOverflow: "ellipsis",
        }}
      >
        <Icon n="pin" s={14} />
        <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{label}</span>
        <Icon n="down" s={14} />
      </button>
      {open ? (
        <>
          <div onClick={() => setOpen(false)} style={{ position: "fixed", inset: 0, zIndex: 8 }} />
          <div
            style={{
              position: "absolute",
              [align]: 0,
              top: 40,
              zIndex: 9,
              width: "min(320px,90vw)",
              background: "#FFFFFF",
              border: "1px solid #DDE1E8",
              borderRadius: 6,
              boxShadow: "0 8px 24px rgba(22,22,22,0.12)",
              overflow: "hidden",
              animation: "erp-fade 120ms cubic-bezier(0.2,0,0.2,1)",
            }}
          >
            <div style={{ padding: 8, borderBottom: "1px solid #EDEFF3" }}>
              <input
                autoFocus
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder={placeholder ?? `Search ${items.length} godowns`}
                style={{ width: "100%", height: 34, padding: "0 10px", border: "1px solid #DDE1E8", borderRadius: 4, fontSize: 13 }}
              />
            </div>
            <div style={{ maxHeight: 340, overflowY: "auto" }}>
              {shown.map((it) => (
                <button
                  key={it.v || "_all"}
                  onClick={() => {
                    onPick(it.v);
                    setOpen(false);
                  }}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    gap: 10,
                    width: "100%",
                    minHeight: 36,
                    padding: "6px 12px",
                    border: "none",
                    background: it.v === value ? "#F1ECFF" : "#FFFFFF",
                    color: it.v === value ? "#5223E0" : "#161616",
                    fontSize: 14,
                    cursor: "pointer",
                    textAlign: "left",
                  }}
                >
                  <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{it.l}</span>
                  <span style={{ fontSize: 12, color: "#6B7385", whiteSpace: "nowrap", flex: "none" }}>{it.sub}</span>
                </button>
              ))}
            </div>
            {match.length > shown.length ? (
              <div style={{ padding: "8px 12px", borderTop: "1px solid #EDEFF3", fontSize: 12, color: "#6B7385" }}>
                {match.length - shown.length} more — keep typing to narrow
              </div>
            ) : null}
            {match.length === 0 ? (
              <div style={{ padding: 12, fontSize: 13, color: "#6B7385" }}>{noneLine ?? `No godown matches “${q}”`}</div>
            ) : null}
          </div>
        </>
      ) : null}
    </span>
  );
}
