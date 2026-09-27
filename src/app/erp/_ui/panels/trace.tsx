"use client";

import { erpHref, erpScreen } from "@/lib/erp/registry";
import { inr } from "@/lib/erp/ui";
import { registerPanel, type PanelProps } from "../panels";

/* ---------------------------------------------------------------------------
 * AI-6 on a customer request: the batch trace link by link, a possible batch
 * problem where other requests share its lots, who made what was traced (a
 * suggestion, never an assignment) and the customer's earlier requests.
 * ------------------------------------------------------------------------- */

type Step = { stage: string; label: string; detail: string; screen: string; ids: string[] };
type Assist = {
  steps: Step[];
  missing: string[];
  cluster: { count: number; parties: string[]; lots: string[] } | null;
  people: string[];
  previous: { date: string; type: string | null; status: string; cn: number | null }[];
};

const H = { fontSize: 12, fontWeight: 500, textTransform: "uppercase" as const, letterSpacing: "0.04em", color: "#6B7385" };

function href(s: Step): string | null {
  const screen = erpScreen(s.screen);
  if (!screen || !s.ids.length) return null;
  return `${erpHref(screen)}?f=${encodeURIComponent(s.ids.join(","))}&fl=${encodeURIComponent(s.stage)}`;
}

function TracePanel({ data }: PanelProps) {
  const a = data as Assist;
  return (
    <section style={{ display: "grid", gap: 12 }}>
      {a.cluster ? (
        <div role="alert" style={{ border: "1px solid #F5C2C0", background: "#FFF7F6", borderRadius: 8, padding: "10px 12px", fontSize: 13, color: "#8A1C14" }}>
          <strong>Possible batch problem.</strong> {a.cluster.count} requests in the window share{" "}
          {a.cluster.lots.map((l) => l.replace(/^(fg|sfg|rm):/, "")).join(", ") || "a lot"}
          {a.cluster.parties.length ? ` — also from ${a.cluster.parties.join(", ")}` : ""}.
        </div>
      ) : null}
      <div style={{ border: "1px solid #EDEFF3", borderRadius: 8, padding: 14 }}>
        <span style={H}>Batch trace</span>
        {a.steps.length ? (
          <ol style={{ listStyle: "none", margin: "10px 0 0", padding: 0, display: "grid", gap: 8 }}>
            {a.steps.map((s, i) => {
              const link = href(s);
              return (
                <li key={`${s.stage}-${i}`} style={{ display: "grid", gridTemplateColumns: "20px 1fr", gap: 8 }}>
                  <span style={{ width: 20, height: 20, borderRadius: 10, background: "#F1ECFF", color: "#5223E0", fontSize: 11, fontWeight: 600, display: "flex", alignItems: "center", justifyContent: "center" }}>{i + 1}</span>
                  <span style={{ minWidth: 0 }}>
                    <span style={{ display: "block", fontSize: 13, fontWeight: 600, color: "#161616" }}>
                      {s.stage} · {link ? <a href={link} style={{ color: "#5223E0" }}>{s.label}</a> : s.label}
                    </span>
                    <span style={{ display: "block", fontSize: 12, color: "#3D4453", marginTop: 2, overflowWrap: "anywhere" }}>{s.detail}</span>
                  </span>
                </li>
              );
            })}
          </ol>
        ) : null}
        {a.missing.map((m) => (
          <p key={m} style={{ margin: "8px 0 0", fontSize: 12, color: "#8A5C05" }}>
            {m}
          </p>
        ))}
      </div>
      {a.people.length ? (
        <div style={{ fontSize: 13, color: "#3D4453" }}>
          <span style={H}>Handled the traced steps</span>
          <div style={{ marginTop: 4 }}>{a.people.join(", ")} — a suggestion for the responsible employee, not an assignment.</div>
        </div>
      ) : null}
      {a.previous.length ? (
        <div style={{ fontSize: 13, color: "#3D4453" }}>
          <span style={H}>This customer&apos;s earlier requests</span>
          <ul style={{ margin: "4px 0 0", paddingLeft: 18 }}>
            {a.previous.map((p, i) => (
              <li key={i}>
                {p.date} · {p.type ?? "Request"} · {p.status}
                {p.cn != null ? ` · CN ${inr(p.cn)}` : ""}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}

registerPanel("trace", (p) => <TracePanel {...p} />);
