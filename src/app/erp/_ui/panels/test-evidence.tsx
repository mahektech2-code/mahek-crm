"use client";

import { cx, SectionLabel } from "@/components/ui/primitives";
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
    <section className="grid gap-2.5 rounded-[6px] border border-line p-3.5">
      <SectionLabel>Test evidence</SectionLabel>
      <div className="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-2.5">
        {e.tests.map((t) => {
          const photo = e.photos[t] ?? null;
          const reading =
            t === "Smell" ? e.smell : t === "Density" ? (e.density == null ? null : String(e.density)) : t === "PH" && e.phValue != null ? `pH ${e.phValue}` : null;
          const missing = t === "Smell" ? !e.smell : t === "Density" ? e.density == null || !photo : !photo;
          return (
            <div key={t} className={cx("overflow-hidden rounded-[4px] border", missing ? "border-danger-soft bg-danger-soft/50" : "border-divider bg-surface")}>
              {photo ? (
                <a href={`/api/attachments/${photo}`} target="_blank" rel="noreferrer">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={`/api/attachments/${photo}`} alt={`${t} evidence`} className="block h-24 w-full bg-canvas object-cover" />
                </a>
              ) : null}
              <div className="px-2.5 py-2">
                <div className="text-[13px] font-semibold text-ink">{t}</div>
                <div className={cx("mt-0.5 text-xs", missing ? "text-danger" : "text-body")}>
                  {missing ? "Missing" : reading ?? "Photographed"}
                </div>
              </div>
            </div>
          );
        })}
      </div>
      {e.video ? (
        <video src={`/api/attachments/${e.video}`} controls className="w-full rounded-[4px] bg-ink" />
      ) : null}
      {e.registerExists ? (
        <span className="text-xs text-body">A purchase register row exists for this lot.</span>
      ) : null}
    </section>
  );
}

registerPanel("testEvidence", (p) => <TestEvidence {...p} />);
