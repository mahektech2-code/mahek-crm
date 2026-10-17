import Link from "next/link";
import { notFound } from "next/navigation";
import { cx } from "@/components/ui/primitives";
import { requireHire, type HireContext } from "@/lib/hire/access";
import { aiState } from "@/lib/hire/ai/orchestrator";
import { PROFILE_FIELDS } from "@/lib/hire/ai/parse-cv";
import { isScored, REJECTION_LABEL } from "@/lib/hire/blueprint-types";
import { confidenceWord } from "@/lib/hire/engines/scoring";
import { displayPhone } from "@/lib/hire/engines/identity";
import { lockedWhy } from "@/lib/hire/roles";
import { candidateRecord, type CandidateRecord, type RecordAnswer, type RecordExecution } from "@/lib/hire/services/candidate";
import { CandidateDocuments } from "../../documents/candidate-documents";
import { AiCard, BtnLink, Callout, EvidenceList, Label, Locked, Panel, Pill, Quote, StatusPill, fd, fdt, fmtScore, type ConfWord } from "../../_ui/kit";
import {
  AiRunButton,
  Composer,
  CvPanel,
  DncButton,
  DuplicateDecide,
  EvidenceGroup,
  LogReplyButton,
  OpenInterviewButton,
  ProfileField,
  ScreenInButton,
  StatusButtons,
} from "./client";

export const dynamic = "force-dynamic";

const TABS = [
  ["overview", "Overview"],
  ["evidence", "Evidence"],
  ["stages", "Stages"],
  ["profile", "Profile"],
  ["documents", "Documents"],
  ["communication", "Communication"],
  ["activity", "Activity"],
] as const;
type Tab = (typeof TABS)[number][0];

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  void params;
  return { title: "Candidate" };
}

/**
 * THE CANDIDATE RECORD (design brief §7.2) — one record, one status, one view
 * (fixes D9). Everything on it is read through `candidateRecord`, which has
 * already narrowed it to what this person may see: an interviewer is handed
 * the stage they are conducting and nothing else.
 */
export default async function CandidatePage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ tab?: string }> }) {
  const ctx = await requireHire();
  const { id } = await params;
  const rec = await candidateRecord(ctx, id);
  if (!rec) notFound();
  const sp = await searchParams;
  const allowed: Tab[] = rec.canSeeScores ? TABS.map((t) => t[0]) : ["overview", "stages", "profile"];
  const tab: Tab = (allowed as string[]).includes(sp.tab ?? "") ? (sp.tab as Tab) : "overview";
  const ai = await aiState();

  return (
    <div>
      <Header ctx={ctx} rec={rec} />
      <Banners ctx={ctx} rec={rec} />
      <div className="mt-6 grid grid-cols-[256px_minmax(0,1fr)] gap-6">
        <Journey rec={rec} />
        <div className="min-w-0">
          <nav className="mb-5 flex gap-1 border-b border-line" aria-label="Candidate record">
            {TABS.filter(([k]) => allowed.includes(k)).map(([k, l]) => (
              <Link
                key={k}
                href={`/hire/c/${id}?tab=${k}`}
                className={cx("-mb-px border-b-2 px-3 py-2.5 text-sm no-underline hover:no-underline", tab === k ? "border-brand font-medium text-brand-hover" : "border-transparent text-body hover:text-heading")}
              >
                {l}
              </Link>
            ))}
          </nav>
          {tab === "overview" ? <Overview ctx={ctx} rec={rec} /> : null}
          {tab === "evidence" ? <Evidence rec={rec} /> : null}
          {tab === "stages" ? <Stages rec={rec} /> : null}
          {tab === "profile" ? <Profile ctx={ctx} rec={rec} /> : null}
          {tab === "documents" ? <CandidateDocuments ctx={ctx} applicationId={id} /> : null}
          {tab === "communication" ? <Communication ctx={ctx} rec={rec} aiOn={ai.on} /> : null}
          {tab === "activity" ? <Activity rec={rec} /> : null}
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ header */

function Header({ ctx, rec }: { ctx: HireContext; rec: CandidateRecord }) {
  const { app, candidate, blueprint, stage } = rec.bundle;
  const initials = candidate.fullName.split(" ").map((w) => w[0]).join("").slice(0, 2);
  const pipeline = ctx.can("addCandidate") || ctx.can("decide");
  const open = app.status === "in_progress";
  const scoredStage = stage && isScored(stage);
  const reviewWaiting = rec.executions.find((e) => !e.superseded && e.stageKey === app.stageKey)?.pendingReview ?? 0;

  const actions: React.ReactNode[] = [];
  if (open && stage?.type === "application") actions.push(pipeline ? <ScreenInButton key="si" applicationId={app.id} /> : <Locked key="si" why={lockedWhy("addCandidate")}>Screen in</Locked>);
  if (open && scoredStage) {
    if (reviewWaiting && rec.currentExecId)
      actions.push(
        ctx.can("score") ? (
          <BtnLink key="rv" kind="primary" href={`/hire/scoring/${rec.currentExecId}`}>
            Review {reviewWaiting} AI score{reviewWaiting === 1 ? "" : "s"}
          </BtnLink>
        ) : (
          <Locked key="rv" why={lockedWhy("score")}>Review scores</Locked>
        ),
      );
    else actions.push(ctx.can("interview") ? <OpenInterviewButton key="iv" applicationId={app.id} label={rec.currentExecStatus === "in_progress" ? "Resume interview" : "Open interview"} /> : <Locked key="iv" why={lockedWhy("interview")}>Open interview</Locked>);
  }
  if (open && stage?.type === "decision_gate")
    actions.push(
      ctx.can("decide") ? (
        <BtnLink key="gate" kind="primary" href={`/hire/gate/${app.id}`}>
          Open decision gate
        </BtnLink>
      ) : (
        <Locked key="gate" why={lockedWhy("decide")}>Decision gate</Locked>
      ),
    );
  if (open && stage?.type === "document_collection")
    actions.push(
      <BtnLink key="off" href={`/hire/offers?app=${app.id}`}>
        Offer
      </BtnLink>,
      <BtnLink key="doc" href={`/hire/documents?app=${app.id}`}>
        Documents
      </BtnLink>,
    );
  if (open && stage?.type === "checklist") actions.push(<BtnLink key="ind" href={`/hire/induction?app=${app.id}`}>Induction</BtnLink>);
  if (open && stage?.type === "system_setup") actions.push(<BtnLink key="pro" kind="primary" href={`/hire/provision?app=${app.id}`}>Provision</BtnLink>);
  if (rec.canSeeScores && ctx.can("message") && !candidate.doNotContact)
    actions.push(
      <BtnLink key="msg" href={`/hire/c/${app.id}?tab=communication`}>
        Message
      </BtnLink>,
    );
  if (pipeline && rec.canSeeScores) actions.push(<StatusButtons key="st" applicationId={app.id} status={app.status} />);

  const markers: { l: string; tone: "warn" | "info" | "danger" | "muted" }[] = [];
  if (app.override) markers.push({ l: "Gate override", tone: "warn" });
  if (app.reapplicationOfId) markers.push({ l: "Reapplication", tone: "info" });
  if (candidate.doNotContact) markers.push({ l: "Do not contact", tone: "danger" });
  if (candidate.preMigration) markers.push({ l: "Pre-migration", tone: "muted" });

  const meta = [
    candidate.code,
    displayPhone(candidate.primaryPhone),
    `${blueprint.title} v${blueprint.version}`,
    app.location,
    app.status === "hired" ? "Hired" : (stage?.name ?? app.stageKey),
    `Applied ${fd(app.appliedAt)}`,
    rec.people.recruiter ? `Recruiter ${rec.people.recruiter}` : "No recruiter assigned",
  ].filter(Boolean);

  return (
    <div className="sticky -top-6 z-10 -mx-6 -mt-6 flex items-center gap-4 border-b border-line bg-surface px-6 py-4">
      <Link href="/hire/candidates" title="Back to candidates" className="flex h-8 w-8 flex-none items-center justify-center rounded-[4px] border border-line text-body no-underline hover:no-underline">
        ‹
      </Link>
      <span title="Photo masked during evaluation" className="flex h-12 w-12 flex-none items-center justify-center rounded-full bg-divider text-[15px] font-semibold text-body">
        {initials}
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-center gap-2">
          <span className="text-[22px] leading-7 font-semibold text-heading">{candidate.fullName}</span>
          <StatusPill status={app.status} duplicate={app.duplicate?.status === "open"} />
          {markers.map((m) => (
            <Pill key={m.l} tone={m.tone}>
              {m.l}
            </Pill>
          ))}
        </span>
        <span className="mt-0.5 block truncate text-[13px] text-muted">{meta.join(" · ")}</span>
      </span>
      {rec.canSeeScores ? (
        <span className="flex flex-none flex-col items-end">
          <span className="text-[44px] leading-[48px] font-semibold tabular-nums text-heading">{rec.overall ?? "—"}</span>
          <span className="text-xs text-muted">{rec.overall != null ? "Average of confirmed stage scores" : "No confirmed score yet"}</span>
        </span>
      ) : null}
      <span className="flex flex-none flex-wrap items-center justify-end gap-2">{actions}</span>
    </div>
  );
}

function Banners({ ctx, rec }: { ctx: HireContext; rec: CandidateRecord }) {
  const { app } = rec.bundle;
  const dup = app.duplicate;
  const out: React.ReactNode[] = [];
  if (dup?.status === "open")
    out.push(
      <div key="dup" className="flex items-start gap-4 rounded-[6px] border border-warn-line bg-warn-soft px-5 py-4">
        <div className="min-w-0 flex-1 text-sm text-warn-ink">
          <div className="font-semibold">Possible duplicate · {dup.confidence} confidence</div>
          <div className="mt-1">{dup.why}</div>
          {dup.outcome ? <div className="mt-1">Earlier application: {dup.outcome}.</div> : null}
          {dup.coolingEnds ? <div className="mt-1">Inside the cooling-off period until {fd(dup.coolingEnds)} — continuing needs an override with a reason.</div> : null}
          <div className="mt-1 text-[13px]">Nothing is merged automatically. A person decides.</div>
        </div>
        {ctx.can("addCandidate") || ctx.can("decide") ? <DuplicateDecide applicationId={app.id} /> : <Locked why={lockedWhy("addCandidate")}>Decide</Locked>}
      </div>,
    );
  if (app.override && rec.canSeeScores)
    out.push(
      <Callout key="ov" tone="warn">
        Entered {app.override.into} by gate override — {app.override.byName}, {fd(app.override.at)}: “{app.override.reason}”
      </Callout>,
    );
  if (app.status === "on_hold" && app.holdReason)
    out.push(
      <Callout key="hold" tone="warn">
        On hold: {app.holdReason}
      </Callout>,
    );
  if (app.status === "rejected" && rec.canSeeScores)
    out.push(
      <Callout key="rej" tone="muted">
        Rejected{app.rejectionReasonCode ? ` · ${REJECTION_LABEL[app.rejectionReasonCode] ?? app.rejectionReasonCode}` : ""}
        {app.decisionReason ? ` — “${app.decisionReason}”` : ""}
      </Callout>,
    );
  if (!out.length) return null;
  return <div className="mt-4 flex flex-col gap-3">{out}</div>;
}

/* ----------------------------------------------------------------- journey */

function Journey({ rec }: { rec: CandidateRecord }) {
  const { blueprint, app } = rec.bundle;
  return (
    <aside className="self-start rounded-[6px] border border-line bg-surface p-4">
      <Label className="mb-3">Journey · {blueprint.title} v{blueprint.version}</Label>
      <ol className="m-0 list-none p-0">
        {rec.journey.map((j, i) => {
          const last = i === rec.journey.length - 1;
          const dot =
            j.state === "done" ? "bg-success border-success" : j.state === "current" ? "bg-brand border-brand" : j.state === "failed" ? "bg-danger border-danger" : "bg-surface border-line-strong";
          return (
            <li key={j.key}>
              <Link href={`/hire/c/${app.id}?tab=stages#stage-${j.key}`} className={cx("flex gap-3 rounded-[4px] px-1.5 no-underline hover:bg-canvas hover:no-underline", j.state === "current" ? "bg-brand-soft" : "")}>
                <span className="flex w-3 flex-none flex-col items-center pt-2">
                  <span className={cx("h-2.5 w-2.5 rounded-full border-2", dot)} />
                  {!last ? <span className="mt-1 w-px flex-1 bg-line" /> : null}
                </span>
                <span className="min-w-0 flex-1 pt-1 pb-3">
                  <span className="flex items-baseline gap-2">
                    <span className={cx("flex-1 truncate text-sm", j.state === "current" ? "font-semibold text-brand-hover" : j.state === "future" ? "text-muted" : "text-heading")}>{j.name}</span>
                    {j.score != null ? <span className="text-sm font-semibold tabular-nums text-heading">{j.score}</span> : null}
                  </span>
                  <span className="block truncate text-xs text-muted">
                    {j.state === "future"
                      ? j.type
                      : [j.state === "current" ? (j.outcome === "pass" ? "Ready to move on" : j.outcome === "fail" ? "Not passed" : "In progress") : j.outcome === "fail" ? "Failed" : "Passed", j.who, j.when ? fd(j.when) : null].filter(Boolean).join(" · ")}
                  </span>
                </span>
              </Link>
            </li>
          );
        })}
      </ol>
      {app.status === "hired" ? <div className="mt-2 text-xs text-success">Hired {fd(app.hiredAt)} · MahekOne account provisioned</div> : null}
      {rec.history.length ? (
        <div className="mt-4 border-t border-divider pt-3">
          <Label className="mb-2">Earlier applications</Label>
          {rec.history.map((h) => (
            <Link key={h.id} href={`/hire/c/${h.id}`} className="block py-1 text-[13px]">
              {h.title} v{h.version} · {h.status.replace("_", " ")}
              {h.rejectionReason ? ` · ${REJECTION_LABEL[h.rejectionReason] ?? h.rejectionReason}` : ""} · {fd(h.appliedAt)}
            </Link>
          ))}
        </div>
      ) : null}
    </aside>
  );
}

/* ---------------------------------------------------------------- overview */

const asConf = (c: string | undefined | null): ConfWord => (c === "High" || c === "Moderate" || c === "Low" ? c : "Moderate");

function Overview({ ctx, rec }: { ctx: HireContext; rec: CandidateRecord }) {
  const { app, def } = rec.bundle;
  if (!rec.canSeeScores) {
    return (
      <div className="flex flex-col gap-4">
        <Panel title={`You are conducting ${rec.bundle.stage?.name ?? "this stage"}`}>
          <p className="m-0 text-sm text-body">
            Earlier stages’ scores and the AI’s view of the candidate are not shown to an interviewer. That is deliberate: knowing them changes how an interview is heard. Score what you hear in this conversation.
          </p>
          <div className="mt-4 flex gap-2">
            <OpenInterviewButton applicationId={app.id} label={rec.currentExecStatus === "in_progress" ? "Resume interview" : "Open interview"} />
          </div>
        </Panel>
        <ConsistencyPanel ctx={ctx} rec={rec} />
      </div>
    );
  }
  const s = rec.summary?.content;
  const rec2 = s?.recommendation ?? app.aiRecommendation;
  return (
    <div className="flex flex-col gap-5">
      {s ? (
        <AiCard title="AI summary" confidence={asConf(s.recommendation?.confidence)} footer={<><span className="text-xs text-muted">Generated {fdt(rec.summary!.at)} from confirmed answers.</span><span className="flex-1" /><AiRunButton applicationId={app.id} what="summary" label="Refresh summary" /></>}>
          <p className="m-0 text-[15px] leading-6 text-body">{s.summary}</p>
        </AiCard>
      ) : (
        <AiCard title="AI summary" footer={<AiRunButton applicationId={app.id} what="summary" label="Generate summary" />}>
          <p className="m-0 text-sm text-muted">No summary yet. It reads only what the candidate has said in confirmed answers and quotes them; it never sees their name or demographics.</p>
        </AiCard>
      )}

      <div className="grid grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)] gap-5">
        <Panel title="Competencies" sub="Confirmed scores against what the role needs · solid line is the candidate, dashed is the pass mark (7 of 10) on every competency">
          <Radar rec={rec} />
          <div className="mt-3 flex flex-col">
            {def.competencies.map((c) => {
              const v = rec.rollup.scores[c.key];
              return (
                <div key={c.key} className="flex items-center justify-between border-b border-divider py-1.5 text-sm last:border-0">
                  <span className="text-body">
                    {c.name} <span className="text-xs text-muted">· {Math.round(c.weight * 100)}%</span>
                  </span>
                  <span className={cx("font-semibold tabular-nums", v == null ? "text-faint" : v < 7 ? "text-warn-ink" : "text-heading")}>{v == null ? "Not yet evidenced" : v.toFixed(1)}</span>
                </div>
              );
            })}
          </div>
        </Panel>
        <div className="flex flex-col gap-5">
          {rec2 ? (
            <AiCard title="Current recommendation" confidence={asConf(rec2.confidence)}>
              <div className="text-[15px] font-semibold text-heading">{rec2.action}</div>
              <p className="mt-1 mb-0 text-sm leading-5 text-body">{rec2.why}</p>
              <p className="mt-3 mb-0 text-xs text-muted">A recommendation, not a decision. A {rec.bundle.def.stages.find((x) => x.type === "decision_gate")?.gateRole ?? "Hiring Manager"} decides at the gate, with their own reasoning.</p>
            </AiCard>
          ) : (
            <Panel title="Recommendation">
              <p className="m-0 text-sm text-muted">No recommendation yet — generate the summary once there are confirmed answers.</p>
            </Panel>
          )}
          <ConsistencyPanel ctx={ctx} rec={rec} />
        </div>
      </div>

      {s && (s.strengths?.length || s.concerns?.length) ? (
        <div className="grid grid-cols-2 gap-5">
          {([
            ["Strengths", s.strengths ?? []],
            ["Concerns", s.concerns ?? []],
          ] as const).map(([l, items]) => (
            <Panel key={l} title={<span>{l} <span className="ml-1 text-xs font-medium text-ai">◈ AI-identified</span></span>}>
              <div className="flex flex-col gap-5">
                {items.length ? (
                  items.map((it, i) => (
                    <div key={i}>
                      <div className="mb-2 text-sm font-medium text-heading">{it.title}</div>
                      <Quote caption={it.source}>{it.quote}</Quote>
                    </div>
                  ))
                ) : (
                  <div className="text-[13px] text-muted">None identified.</div>
                )}
              </div>
            </Panel>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function ConsistencyPanel({ ctx, rec }: { ctx: HireContext; rec: CandidateRecord }) {
  const c = rec.consistency?.content;
  const flags = c?.inconsistencies ?? [];
  const canRun = rec.canSeeScores;
  void ctx;
  return (
    <Panel title="Consistency" sub={rec.consistency ? `Checked ${fdt(rec.consistency.at)} across the CV and every stage` : "Claims compared across the CV and every stage"} actions={canRun ? <AiRunButton applicationId={rec.bundle.app.id} what="consistency" label={rec.consistency ? "Check again" : "Run check"} /> : null}>
      {!rec.consistency ? (
        <div className="text-[13px] text-muted">Not checked yet.</div>
      ) : c?.skipped ? (
        <Callout tone="warn">Not performed — {c.reason}</Callout>
      ) : !flags.length ? (
        <div className="text-[13px] text-muted">Nothing contradicts across the sources checked.</div>
      ) : (
        <div className="flex flex-col gap-4">
          {flags.map((f, i) => (
            <div key={i} className="rounded-[6px] border border-warn-line">
              <div className="flex items-center gap-2 border-b border-warn-line bg-warn-soft px-3 py-2 text-[13px] font-medium text-warn-ink">
                Worth asking about · {f.nature}
                <span className="flex-1" />
                {f.severity}
              </div>
              <div className="grid grid-cols-2 gap-4 p-3">
                <div>
                  <Label className="mb-1.5">{f.a.source}</Label>
                  <Quote>{f.a.text}</Quote>
                </div>
                <div>
                  <Label className="mb-1.5">{f.b.source}</Label>
                  <Quote>{f.b.text}</Quote>
                </div>
              </div>
              <div className="border-t border-divider px-3 py-2 text-[13px] text-ai">◈ Suggested probe: {f.probe}</div>
            </div>
          ))}
          {c?.unverified?.length ? <div className="text-xs text-muted">Said once, not corroborated: {c.unverified.join("; ")}.</div> : null}
        </div>
      )}
    </Panel>
  );
}

function Radar({ rec }: { rec: CandidateRecord }) {
  const comps = rec.bundle.def.competencies;
  const n = comps.length;
  const cx0 = 160;
  const cy0 = 140;
  const R = 96;
  const pt = (i: number, v: number) => {
    const a = -Math.PI / 2 + (i * 2 * Math.PI) / n;
    return [cx0 + Math.cos(a) * R * (v / 10), cy0 + Math.sin(a) * R * (v / 10)] as const;
  };
  const poly = (f: (i: number) => number) =>
    comps
      .map((_, i) => pt(i, f(i)))
      .map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`)
      .join(" ");
  return (
    <svg viewBox="0 0 320 280" className="block w-full max-w-[420px]" role="img" aria-label="Competency scores against the pass mark">
      {[2.5, 5, 7.5, 10].map((r) => (
        <polygon key={r} points={poly(() => r)} fill="none" stroke="#EDEFF3" strokeWidth={1} />
      ))}
      {comps.map((_, i) => {
        const [x, y] = pt(i, 10);
        return <line key={i} x1={cx0} y1={cy0} x2={x} y2={y} stroke="#EDEFF3" strokeWidth={1} />;
      })}
      <polygon points={poly(() => 7)} fill="none" stroke="#9BA3B2" strokeWidth={1.5} strokeDasharray="4 4" />
      <polygon points={poly((i) => rec.rollup.scores[comps[i].key] ?? 0)} fill="rgba(26,30,40,0.06)" stroke="#1A1E28" strokeWidth={1.5} />
      {comps.map((c, i) => {
        const [x, y] = pt(i, 12.4);
        return (
          <text key={c.key} x={x} y={y + 3} textAnchor={Math.abs(x - cx0) < 8 ? "middle" : x > cx0 ? "start" : "end"} fontSize={10.5} fill="#3D4453">
            {c.name}
          </text>
        );
      })}
    </svg>
  );
}

/* ---------------------------------------------------------------- evidence */

function Evidence({ rec }: { rec: CandidateRecord }) {
  const { def } = rec.bundle;
  const total = Object.values(rec.evidenceByComp).reduce((n, q) => n + q.length, 0);
  return (
    <article className="rounded-[6px] border border-line bg-surface px-10 py-8">
      <h2 className="m-0 text-[22px] leading-7 font-semibold text-heading">The case for and against</h2>
      <p className="mt-1.5 mb-2 text-sm text-muted">
        {total} quote{total === 1 ? "" : "s"} from confirmed answers, organised by competency. Every one is the candidate’s own words, verbatim, with the stage and the rubric criterion it was scored against. Read this before deciding.
      </p>
      {[...def.competencies]
        .sort((a, b) => b.weight - a.weight)
        .map((c, i) => {
          const v = rec.rollup.scores[c.key];
          return <EvidenceGroup key={c.key} name={c.name} weight={`${Math.round(c.weight * 100)}%`} score={v == null ? "—" : v.toFixed(1)} def={c.definition} quotes={rec.evidenceByComp[c.key] ?? []} defaultOpen={i < 3} />;
        })}
    </article>
  );
}

/* ------------------------------------------------------------------ stages */

function Stages({ rec }: { rec: CandidateRecord }) {
  const order = new Map(rec.bundle.def.stages.map((s, i) => [s.key, i]));
  const list = [...rec.executions].sort((a, b) => (order.get(a.stageKey) ?? 99) - (order.get(b.stageKey) ?? 99));
  if (!list.length) return <Callout tone="muted">No stage has been run yet.</Callout>;
  return (
    <div className="flex flex-col gap-5">
      {!rec.canSeeScores ? <Callout tone="muted">Only the stage you are conducting is shown.</Callout> : null}
      {list.map((e) => (
        <StageCard key={e.id} e={e} />
      ))}
    </div>
  );
}

const OUTCOME: Record<string, [string, "success" | "danger" | "warn" | "muted"]> = {
  pass: ["Pass", "success"],
  fail: ["Fail", "danger"],
  pending: ["Pending", "warn"],
  not_applicable: ["Not applicable", "muted"],
};

function StageCard({ e }: { e: RecordExecution }) {
  const [ol, ot] = OUTCOME[e.outcome] ?? [e.outcome, "muted"];
  const meta = [e.stageType, e.conductedBy, e.completedAt ? `completed ${fdt(e.completedAt)}` : e.scheduledAt ? `scheduled ${fdt(e.scheduledAt)}` : e.status.replace("_", " ")].filter(Boolean).join(" · ");
  return (
    <section id={`stage-${e.stageKey}`} className={cx("scroll-mt-28 rounded-[6px] border bg-surface", e.superseded ? "border-dashed border-line opacity-70" : "border-line")}>
      <header className="flex items-center gap-4 border-b border-divider px-5 py-3.5">
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2 text-[15px] font-semibold text-heading">
            {e.stageName}
            {e.superseded ? <Pill tone="muted">Superseded</Pill> : null}
            {e.aiReviewPending ? <Pill tone="warn">Scored by hand · AI review pending</Pill> : null}
          </span>
          <span className="block text-[13px] text-muted">{meta}</span>
        </span>
        {e.normalised != null ? (
          <span className="flex flex-none flex-col items-end">
            <span className="text-[32px] leading-9 font-semibold tabular-nums text-heading">{fmtScore(e.finalScore ?? e.normalised)}</span>
            <span className="text-xs text-muted">
              {e.earned != null ? `${fmtScore(e.earned)} of ${e.maxPoints} · ` : ""}rubric {fmtScore(e.normalised)}
              {e.grace ? ` · grace ${e.grace > 0 ? "+" : "−"}${Math.abs(e.grace)}` : ""}
              {e.passThreshold != null ? ` · pass ${e.passThreshold}` : ""}
            </span>
          </span>
        ) : null}
        <Pill tone={ot}>{ol}</Pill>
      </header>
      {e.grace ? (
        <div className="border-b border-divider bg-warn-soft px-5 py-2 text-[13px] text-warn-ink">
          Grace {e.grace > 0 ? "+" : "−"}
          {Math.abs(e.grace)}, shown separately from the rubric score: “{e.graceReason}”
        </div>
      ) : null}
      {e.gateOverrideReason ? <div className="border-b border-divider bg-warn-soft px-5 py-2 text-[13px] text-warn-ink">Entered by gate override: “{e.gateOverrideReason}”</div> : null}
      {e.answers.length ? (
        <div className="flex flex-col gap-4 p-5">
          {e.answers.map((a) => (
            <AnswerView key={a.id} a={a} />
          ))}
        </div>
      ) : (
        <div className="px-5 py-4 text-[13px] text-muted">{e.status === "completed" ? "Completed — this stage has no questions." : "No answers recorded yet."}</div>
      )}
    </section>
  );
}

const ACTION: Record<string, string> = {
  accepted: "Accepted the AI score",
  adjusted: "Adjusted the AI score",
  scored_myself: "Scored it themselves",
  manual: "Scored by hand",
  calculated: "Calculated",
  selected: "Selected",
};

function AnswerView({ a }: { a: RecordAnswer }) {
  const human = a.confirmedAt ? `${ACTION[a.humanAction ?? ""] ?? "Confirmed"} · ${a.confirmedBy ?? "—"}, ${fdt(a.confirmedAt)}${a.overrideReason ? ` — “${a.overrideReason}”` : ""}` : "Awaiting a person to confirm — this does not count yet.";
  const wrap = (node: React.ReactNode) => <div className={a.superseded ? "opacity-60" : ""}>{a.superseded ? <Pill tone="muted" className="mb-1.5">Superseded</Pill> : null}{node}</div>;
  if (a.aiScore != null || a.aiFlags.includes("insufficient_response")) {
    const insufficient = a.aiFlags.includes("insufficient_response") && a.aiScore == null;
    return wrap(
      <div>
        <div className="mb-2 text-sm font-medium text-heading">{a.questionText}</div>
        <AiCard
          confidence={confidenceWord(a.aiConfidence)}
          insufficient={insufficient}
          score={a.aiScore}
          max={a.maxPoints}
          reasoning={insufficient ? <>The response was too brief to assess against this rubric.{a.probe ? <> Suggested probe: “{a.probe}”</> : null}</> : a.aiReasoning}
          footer={
            <span className="text-[13px] text-body">
              {a.score != null ? <span className="mr-2 font-semibold tabular-nums text-heading">Counts: {fmtScore(a.score)} / {a.maxPoints}</span> : null}
              {human}
            </span>
          }
        >
          {a.responseText && !a.evidence.length ? (
            <div className="mt-3">
              <Quote caption="The full answer">{a.responseText}</Quote>
            </div>
          ) : null}
          <EvidenceList spans={a.evidence} />
        </AiCard>
      </div>,
    );
  }
  return wrap(
    <div className="flex items-start gap-4 border-b border-divider pb-3 last:border-0">
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-medium text-heading">{a.questionText}</span>
        <span className="block text-[13px] text-body">{a.responseText ?? "—"}</span>
        <span className="block text-xs text-muted">
          {a.mode === "fixed_choice" ? "Fixed choice" : a.mode === "calculated" ? "Calculated" : "Scored by a person"} · {human}
        </span>
      </span>
      <span className="flex-none text-[15px] font-semibold tabular-nums text-heading">
        {a.score != null ? fmtScore(a.score) : "—"}
        <span className="text-xs font-normal text-muted"> / {a.maxPoints}</span>
      </span>
    </div>,
  );
}

/* ----------------------------------------------------------------- profile */

function Profile({ ctx, rec }: { ctx: HireContext; rec: CandidateRecord }) {
  const p = rec.profile;
  const editable = ctx.can("addCandidate") || ctx.can("documents") || ctx.can("decide");
  const fields = PROFILE_FIELDS.map((l) => ({ l, f: p?.data.fields[l] }));
  return (
    <div className="grid grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)] gap-5">
      <Panel
        pad={false}
        title={p?.extractedAt ? "Parsed from CV" : "Profile"}
        sub={
          p?.extractedAt
            ? `◈ Extracted by AI ${fdt(p.extractedAt)}${p.confidence != null ? ` · overall ${confidenceWord(p.confidence).toLowerCase()} confidence` : ""} · amber fields need a look`
            : "No CV has been parsed. Upload one, or enter the fields by hand — a person’s entry is never overwritten by a later parse."
        }
      >
        {fields.map(({ l, f }) => (
          <ProfileField key={l} applicationId={rec.bundle.app.id} label={l} value={f?.value ?? "—"} source={f?.source ?? "human"} confidence={f?.confidence ?? null} editable={editable} />
        ))}
      </Panel>
      <div className="flex flex-col gap-5">
        <Panel title="CV">
          <CvPanel applicationId={rec.bundle.app.id} files={rec.cvFiles} editable={editable} />
        </Panel>
        <Panel title="Employment">
          {p?.data.employers.length ? (
            <div className="flex flex-col gap-3">
              {p.data.employers.map((e, i) => (
                <div key={i}>
                  <div className="text-sm font-medium text-heading">
                    {e.name} · {e.title}
                  </div>
                  <div className="text-[13px] text-muted">
                    {e.from} – {e.to}
                    {e.months != null ? ` · ${e.months} months` : ""}
                  </div>
                </div>
              ))}
              {p.data.gaps.length ? <Callout tone="warn">Gaps: {p.data.gaps.map((g) => `${g.period} (${g.months} months)`).join("; ")}</Callout> : null}
            </div>
          ) : (
            <div className="text-[13px] text-muted">No employment history extracted.</div>
          )}
        </Panel>
        {p?.corrections.length ? (
          <Panel title="Corrections" sub="Kept, never overwritten">
            <div className="flex flex-col gap-2">
              {p.corrections.map((c, i) => (
                <div key={i} className="text-[13px] text-body">
                  {c.field}: {c.from} → <span className="font-medium text-heading">{c.to}</span>
                  <span className="text-muted">
                    {" "}
                    · {c.byName}, {fdt(c.at)}
                  </span>
                </div>
              ))}
            </div>
          </Panel>
        ) : null}
      </div>
    </div>
  );
}

/* ----------------------------------------------------------- communication */

const CHANNEL: Record<string, string> = { whatsapp: "WhatsApp", sms: "SMS", email: "Email", portal: "Portal", phone: "Phone" };
const MSG_STATUS: Record<string, string> = { sent: "Sent", delivered: "Delivered", read: "Read", logged: "Sent from a phone · confirmed", not_sent: "Not sent — no mail provider", failed: "Failed", draft: "Draft" };

function Communication({ ctx, rec, aiOn }: { ctx: HireContext; rec: CandidateRecord; aiOn: boolean }) {
  const { candidate, app } = rec.bundle;
  const canMsg = ctx.can("message");
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-5">
      <div className="flex flex-col gap-4">
        {candidate.doNotContact ? (
          <Callout tone="danger">Do not contact: {candidate.dncReason ?? "the candidate asked not to be contacted"}. Nothing can be composed to them while this stands.</Callout>
        ) : canMsg ? (
          <Composer applicationId={app.id} languages={rec.languages} defaultLanguage={candidate.preferredLanguage} phone={candidate.primaryPhone} email={candidate.email} aiOn={aiOn} />
        ) : (
          <Locked why={lockedWhy("message")}>Write to the candidate</Locked>
        )}
        {canMsg ? (
          <div className="flex gap-2">
            <LogReplyButton applicationId={app.id} languages={rec.languages} />
            <DncButton applicationId={app.id} on={candidate.doNotContact} />
          </div>
        ) : null}
      </div>
      <Panel title="Messages" sub={`${rec.messages.length} on record · newest first`} pad={false}>
        {rec.messages.length ? (
          rec.messages.map((m) => (
            <div key={m.id} className={cx("border-b border-divider px-5 py-3.5 last:border-0", m.direction === "in" ? "bg-page" : "")}>
              <div className="mb-1 flex flex-wrap items-center gap-2 text-xs text-muted">
                <span className="font-medium text-body">{m.direction === "in" ? `From ${candidate.fullName.split(" ")[0]}` : `To ${candidate.fullName.split(" ")[0]}${m.by ? ` · ${m.by}` : ""}`}</span>
                <span>· {CHANNEL[m.channel] ?? m.channel}</span>
                <span>· {m.language}</span>
                {m.aiDrafted ? <Pill tone="ai">◈ AI-drafted</Pill> : null}
                <span className="flex-1" />
                <span>{fdt(m.at)}</span>
              </div>
              {m.subject ? <div className="text-sm font-medium text-heading">{m.subject}</div> : null}
              <div className="text-sm whitespace-pre-wrap text-body">{m.body}</div>
              {m.direction === "out" ? <div className="mt-1 text-xs text-muted">{MSG_STATUS[m.status] ?? m.status}</div> : null}
            </div>
          ))
        ) : (
          <div className="px-5 py-6 text-[13px] text-muted">Nothing sent or received yet.</div>
        )}
      </Panel>
    </div>
  );
}

/* ---------------------------------------------------------------- activity */

const DECISION: Record<string, string> = { advance: "Advance", reject: "Reject", hold: "Hold", hire: "Hire", revise_offer: "Revise offer", resume: "Resume", withdraw: "Withdraw" };

function Activity({ rec }: { rec: CandidateRecord }) {
  return (
    <div className="flex flex-col gap-5">
      {rec.decisions.length ? (
        <Panel title="Decisions" sub="Every decision a named person recorded, with their reasoning" pad={false}>
          {rec.decisions.map((d) => (
            <div key={d.id} className={cx("border-b border-divider px-5 py-3 last:border-0", d.superseded ? "opacity-60" : "")}>
              <div className="flex items-center gap-2 text-sm">
                <span className="font-semibold text-heading">{DECISION[d.decision] ?? d.decision}</span>
                <span className="text-muted">
                  · {d.by}, {d.role} · {fdt(d.at)}
                </span>
                {d.agreedWithAi === false ? <Pill tone="warn">Disagreed with the AI</Pill> : d.agreedWithAi ? <Pill tone="neutral">Agreed with the AI</Pill> : null}
                {d.superseded ? <Pill tone="muted">Superseded</Pill> : null}
              </div>
              <div className="mt-0.5 text-sm text-body">“{d.reasoning}”</div>
            </div>
          ))}
        </Panel>
      ) : null}
      <Panel title="Activity" sub="The full audit trail — append-only, newest first" pad={false}>
        {rec.audit.length ? (
          rec.audit.map((a) => (
            <div key={a.id} className="hire-row flex items-center gap-4 border-b border-divider px-5 text-sm last:border-0">
              <span className="w-[110px] flex-none text-xs text-muted tabular-nums">{fdt(a.at)}</span>
              <span className="w-[160px] flex-none truncate text-body" title={a.role ?? undefined}>
                {a.actor}
              </span>
              <span className="min-w-0 flex-1 truncate text-heading" title={a.summary}>
                {a.summary}
              </span>
              {a.pii ? <Pill tone="warn">PII access</Pill> : null}
            </div>
          ))
        ) : (
          <div className="px-5 py-6 text-[13px] text-muted">Nothing recorded yet.</div>
        )}
      </Panel>
    </div>
  );
}
