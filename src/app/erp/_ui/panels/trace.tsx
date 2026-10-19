"use client";

import { erpLink, erpScreen } from "@/lib/erp/registry";
import { inr } from "@/lib/erp/ui";
import { Callout, SectionLabel } from "@/components/ui/primitives";
import { insetClass, linkClass } from "../look";
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

function href(s: Step): string | null {
  const screen = erpScreen(s.screen);
  if (!screen || !s.ids.length) return null;
  return erpLink(s.screen, { f: s.ids.join(","), fl: s.stage });
}

function TracePanel({ data }: PanelProps) {
  const a = data as Assist;
  return (
    <section className="grid gap-3">
      {a.cluster ? (
        <div role="alert">
          <Callout tone="danger" className="mb-0 block text-meta text-danger">
            <strong>Possible batch problem.</strong> {a.cluster.count} requests in the window share{" "}
            {a.cluster.lots.map((l) => l.replace(/^(fg|sfg|rm):/, "")).join(", ") || "a lot"}
            {a.cluster.parties.length ? ` — also from ${a.cluster.parties.join(", ")}` : ""}.
          </Callout>
        </div>
      ) : null}
      <div className={insetClass}>
        <SectionLabel>Batch trace</SectionLabel>
        {a.steps.length ? (
          <ol className="mt-2.5 grid list-none gap-2 p-0">
            {a.steps.map((s, i) => {
              const link = href(s);
              return (
                <li key={`${s.stage}-${i}`} className="grid grid-cols-[20px_1fr] gap-2">
                  <span className="flex h-5 w-5 items-center justify-center rounded-full bg-brand-soft text-2xs font-semibold text-brand-hover">{i + 1}</span>
                  <span className="min-w-0">
                    <span className="block text-meta font-semibold text-ink">
                      {s.stage} · {link ? <a href={link} className={linkClass("brand")}>{s.label}</a> : s.label}
                    </span>
                    <span className="mt-0.5 block text-xs [overflow-wrap:anywhere] text-body">{s.detail}</span>
                  </span>
                </li>
              );
            })}
          </ol>
        ) : null}
        {a.missing.map((m) => (
          <p key={m} className="mt-2 text-meta text-warn-ink">
            {m}
          </p>
        ))}
      </div>
      {a.people.length ? (
        <div className="text-meta text-body">
          <SectionLabel>Handled the traced steps</SectionLabel>
          <div className="mt-1">{a.people.join(", ")} — a suggestion for the responsible employee, not an assignment.</div>
        </div>
      ) : null}
      {a.previous.length ? (
        <div className="text-meta text-body">
          <SectionLabel>This customer&apos;s earlier requests</SectionLabel>
          <ul className="mt-1 list-disc pl-[18px]">
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
