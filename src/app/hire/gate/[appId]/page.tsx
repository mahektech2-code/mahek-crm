import { notFound } from "next/navigation";
import { requireHireScreen, seesScores } from "@/lib/hire/access";
import { lockedWhy } from "@/lib/hire/roles";
import { REJECTION_REASONS } from "@/lib/hire/blueprint-types";
import { aiState } from "@/lib/hire/ai/orchestrator";
import { gateView } from "@/lib/hire/services/decisions";
import { BtnLink, Empty, Icon, Label, Pill, Quote, fd } from "../../_ui/kit";
import { GateClient } from "./gate-client";

export const dynamic = "force-dynamic";
export const metadata = { title: "Decision gate" };

/**
 * The decision gate (design brief §7.5): the screen where a named person
 * commits. The evidence first, the AI recommendation beside it in a
 * supporting role, and then — separated, and the loudest thing on the page —
 * the human decision, which cannot be recorded without reasoning.
 */
export default async function GatePage({ params }: { params: Promise<{ appId: string }> }) {
  const ctx = await requireHireScreen("decisions");
  const { appId } = await params;
  if (!seesScores(ctx))
    return <Empty title="The decision gate shows every stage’s scores">Interviewers do not see earlier scores — it would colour the interview. {lockedWhy("decide")}</Empty>;
  const v = await gateView(ctx, appId);
  if (!v) notFound();
  const { bundle: b, cf } = v;
  const ai = await aiState();

  /* The three strongest quotes across the heaviest competencies. */
  const quotes = [...b.def.competencies]
    .sort((x, y) => y.weight - x.weight)
    .flatMap((c) => (cf.quotes[c.key] ?? []).slice(0, 1).map((q) => ({ ...q, comp: c.name })))
    .filter((q, i, all) => all.findIndex((x) => x.text === q.text) === i)
    .slice(0, 3);

  return (
    <div className="flex justify-center pb-16">
      <div className="flex w-full max-w-[760px] flex-col gap-7">
        <div className="flex items-center gap-3.5">
          <BtnLink href="/hire/decisions" size="sm">
            <Icon n="back" s={14} />
          </BtnLink>
          <div className="min-w-0 flex-1">
            <Label>
              Decision gate · {b.blueprint.title} v{b.blueprint.version}
            </Label>
            <h1 className="m-0 text-[28px] leading-[34px] font-semibold text-heading">{b.candidate.fullName}</h1>
            <div className="text-[13px] text-muted">
              {b.candidate.code} · {b.app.location ?? "—"} · applied {fd(b.app.appliedAt)} · now at {b.app.status === "hired" ? "Hired" : (b.stage?.name ?? b.app.stageKey)}
            </div>
          </div>
          <BtnLink href={`/hire/c/${b.app.id}?tab=evidence`} size="sm">
            Read the full evidence
          </BtnLink>
        </div>

        <section className="rounded-[6px] border border-line bg-surface px-7 py-6">
          <Label>Evidence summary</Label>
          {cf.stages.length ? (
            <div className="mt-3 grid grid-cols-4 gap-3">
              {cf.stages.map((s) => (
                <div key={s.key} className="rounded-[4px] border border-divider px-3 py-2.5">
                  <div className="text-xs text-muted">{s.name}</div>
                  <div className={s.outcome === "fail" ? "text-[22px] font-semibold text-danger tabular-nums" : "text-[22px] font-semibold text-heading tabular-nums"}>{Math.round(s.final ?? 0)}</div>
                  <div className="text-[11px] text-muted">
                    pass {s.pass}
                    {s.grace ? ` · grace ${s.grace > 0 ? "+" : "−"}${Math.abs(s.grace)}` : ""}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <p className="mt-2 mb-0 text-sm text-muted">No stage has a confirmed score yet.</p>
          )}
          <div className="mt-4 flex flex-col gap-1.5">
            {b.def.competencies.map((c) => {
              const v10 = cf.competencies[c.key];
              return (
                <div key={c.key} className="grid grid-cols-[170px_minmax(0,1fr)_40px] items-center gap-3 text-[13px]">
                  <span className="text-body">{c.name}</span>
                  <span className="relative h-1.5 overflow-hidden rounded-[3px] bg-divider" title="The line marks 7 of 10">
                    {v10 != null ? <span className="absolute inset-y-0 left-0 rounded-[3px] bg-heading" style={{ width: `${v10 * 10}%` }} /> : null}
                    <span className="absolute -top-0.5 left-[70%] h-2.5 w-px bg-faint" />
                  </span>
                  <span className="text-right font-semibold text-heading tabular-nums">{v10 ?? "—"}</span>
                </div>
              );
            })}
          </div>
          {quotes.length ? (
            <div className="mt-5 flex flex-col gap-3.5">
              {quotes.map((q, i) => (
                <Quote key={i} caption={`${q.comp} · ${q.source}`}>
                  {q.text}
                </Quote>
              ))}
            </div>
          ) : null}
          {cf.consistency.length ? (
            <div className="mt-5 border-t border-divider pt-4">
              <Label className="mb-2">To ask about — not a conclusion</Label>
              {cf.consistency.map((f, i) => (
                <div key={i} className="mb-3 text-[13px] text-body">
                  <div className="mb-1.5 flex items-center gap-2">
                    <Pill tone="warn">{f.nature}</Pill>
                    <span className="text-muted">{f.severity}</span>
                  </div>
                  <Quote caption={f.a.source}>{f.a.text}</Quote>
                  <Quote className="mt-2" caption={f.b.source}>
                    {f.b.text}
                  </Quote>
                  {f.probe ? <div className="mt-1.5 text-muted">Suggested: {f.probe}</div> : null}
                </div>
              ))}
            </div>
          ) : !cf.consistencyChecked ? (
            <p className="mt-4 mb-0 text-[12px] text-muted">The consistency check has not been run on this candidate.</p>
          ) : null}
        </section>

        <GateClient
          applicationId={b.app.id}
          name={b.candidate.fullName}
          nextStageName={v.nextStageName}
          atGate={v.atGate}
          whereNow={b.app.status === "in_progress" ? `${b.candidate.fullName} is at ${b.stage?.name ?? b.app.stageKey}, not at a decision gate.` : `This application is ${b.app.status.replace("_", " ")}.`}
          canDecide={ctx.can("decide")}
          lockLine={`${lockedWhy("decide")} You are signed in as ${ctx.roleLabel}.`}
          rec={v.rec}
          aiDown={ai.on ? null : ai.reason}
          last={v.last}
          reasons={REJECTION_REASONS.map(([k, l]) => ({ k, l }))}
        />
      </div>
    </div>
  );
}
