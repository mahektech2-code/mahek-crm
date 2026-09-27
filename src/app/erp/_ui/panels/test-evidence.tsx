"use client";

import { registerPanel, type PanelProps } from "../panels";

/* ---------------------------------------------------------------------------
 * A purchase test's evidence, in the drawer the verifier decides from: one
 * tile per required test, the photograph or the reading, and what is missing
 * said in words — a verifier cannot pass what they cannot see.
 * ------------------------------------------------------------------------- */

type Evidence = {
  status: string;
  tests: string[];
  smell: string | null;
  density: number | null;
  phValue: number | null;
  photos: Record<string, string | null>;
  video: string | null;
  registerExists: boolean;
};

function TestEvidence({ data }: PanelProps) {
  const e = data as Evidence;
  if (!e.tests.length) return null;
  return (
    <section style={{ border: "1px solid #EDEFF3", borderRadius: 8, padding: 14, display: "grid", gap: 10 }}>
      <span style={{ fontSize: 12, fontWeight: 500, textTransform: "uppercase", letterSpacing: "0.04em", color: "#6B7385" }}>Test evidence</span>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(150px,1fr))", gap: 10 }}>
        {e.tests.map((t) => {
          const photo = e.photos[t] ?? null;
          const reading =
            t === "Smell" ? e.smell : t === "Density" ? (e.density == null ? null : String(e.density)) : t === "PH" && e.phValue != null ? `pH ${e.phValue}` : null;
          const missing = t === "Smell" ? !e.smell : t === "Density" ? e.density == null || !photo : !photo;
          return (
            <div key={t} style={{ border: `1px solid ${missing ? "#F5C2C0" : "#EDEFF3"}`, borderRadius: 6, overflow: "hidden", background: missing ? "#FFF7F6" : "#FFFFFF" }}>
              {photo ? (
                <a href={`/api/attachments/${photo}`} target="_blank" rel="noreferrer">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={`/api/attachments/${photo}`} alt={`${t} evidence`} style={{ display: "block", width: "100%", height: 96, objectFit: "cover", background: "#F4F5F8" }} />
                </a>
              ) : null}
              <div style={{ padding: "8px 10px" }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: "#161616" }}>{t}</div>
                <div style={{ fontSize: 12, color: missing ? "#B42318" : "#3D4453", marginTop: 2 }}>
                  {missing ? "Missing" : reading ?? "Photographed"}
                </div>
              </div>
            </div>
          );
        })}
      </div>
      {e.video ? (
        <video src={`/api/attachments/${e.video}`} controls style={{ width: "100%", borderRadius: 6, background: "#161616" }} />
      ) : null}
      {e.registerExists ? (
        <span style={{ fontSize: 12, color: "#3D4453" }}>A purchase register row exists for this lot.</span>
      ) : null}
    </section>
  );
}

registerPanel("testEvidence", (p) => <TestEvidence {...p} />);
