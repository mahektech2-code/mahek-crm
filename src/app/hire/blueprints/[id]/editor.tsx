"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { cx } from "@/components/ui/primitives";
import { useToast } from "@/components/ui/toast";
import { approvalCount, studioIssues, type StudioDefinition } from "@/lib/hire/engines/diff";
import type { CriticFinding } from "@/lib/hire/ai/rubric-critic";
import { newVersion, publishBlueprint, runCritic, saveDraft, type IdentityInput } from "@/lib/hire/actions/blueprints";
import { Btn, Callout, Label, Pill } from "../../_ui/kit";
import { Area, F, Num, Txt } from "./fields";
import { Briefing, Competencies, Documents, Fairness, OfferSec, Onboarding, Provisioning, Questions, Rubrics, Stages, Thresholds, type Mut, type SecProps } from "./sections";

export const SECS = [
  ["identity", "Identity"],
  ["competencies", "Competencies"],
  ["stages", "Stages"],
  ["questions", "Questions"],
  ["rubrics", "Rubrics"],
  ["thresholds", "Thresholds"],
  ["briefing", "Briefing"],
  ["documents", "Documents"],
  ["offer", "Offer"],
  ["onboarding", "Onboarding"],
  ["provisioning", "Provisioning"],
  ["fairness", "Fairness"],
] as const;
type Sec = (typeof SECS)[number][0];

const SUB: Record<Sec, string> = {
  identity: "What the role is, where it is, how many, and how long its records are kept.",
  competencies: "What the role is measured on. Behaviours with anchors, never traits. Weights total 100%.",
  stages: "The order a candidate goes through. Cheapest screening first; a decision gate before any offer.",
  questions: "Every question, mapped to the competencies it tests. Same questions, same order, for every candidate on this version.",
  rubrics: "How each answer is scored. Every reachable answer needs a defined score.",
  thresholds: "Pass marks, auto-reject floors and grace, per scored stage.",
  briefing: "What a candidate must hear and accept before an offer. Blocking points stop progression on a disagreement.",
  documents: "What is collected and verified. Identity and bank numbers are vaulted and masked.",
  offer: "Grades, salary bands, incentive and the growth ladder the briefing and the letter both read.",
  onboarding: "Work kit, training modules with their topics, and system setup.",
  provisioning: "Which MahekOne apps and role the hire receives — the end of the pipeline.",
  fairness: "What is masked during evaluation, what is monitored, and what is never inferred.",
};

export type EditorProps = {
  id: string;
  version: number;
  status: string;
  identity: IdentityInput;
  descriptionSource: string | null;
  aiGenerated: boolean;
  definition: StudioDefinition;
  critic: CriticFinding[];
  canEdit: boolean;
  canPublish: boolean;
  inFlight: number;
  hasPrevious: boolean;
  publishedLine: string;
};

export function Editor(p: EditorProps) {
  const router = useRouter();
  const pathname = usePathname();
  const search = useSearchParams();
  const toast = useToast();
  const sec = (SECS.find(([k]) => k === search.get("s"))?.[0] ?? "identity") as Sec;
  const rubricRef = search.get("q") ?? "";
  const [def, setDef] = useState<StudioDefinition>(p.definition);
  const [identity, setIdentity] = useState<IdentityInput>(p.identity);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const ro = p.status !== "draft" || !p.canEdit;

  const mut: Mut = (fn) => {
    if (ro) return;
    const next = structuredClone(def);
    fn(next);
    for (const s of next.stages) s.maxPoints = s.questions.reduce((n, q) => n + (Number(q.maxPoints) || 0), 0);
    setDef(next);
    setDirty(true);
  };
  const go = (s: Sec, q?: string) => router.replace(`${pathname}?s=${s}${q ? `&q=${encodeURIComponent(q)}` : ""}`, { scroll: false });

  const issues = studioIssues(def);
  const errors = issues.filter((i) => i.level === "error");
  const warnings = issues.filter((i) => i.level === "warning");
  const appr = approvalCount(def);
  const pct = appr.total ? Math.round((appr.approved / appr.total) * 100) : 0;
  const bySection = (k: string) => issues.filter((i) => i.section === k && i.level === "error").length;

  async function save() {
    setBusy("save");
    const r = await saveDraft(p.id, identity, def);
    setBusy(null);
    if (!r.ok) return toast.push(r.error, "error");
    setDirty(false);
    toast.push("Saved.");
    router.refresh();
  }
  async function publish() {
    setBusy("publish");
    const r = await publishBlueprint(p.id);
    setBusy(null);
    if (!r.ok) return toast.push(r.error, "error");
    toast.push(r.message ?? "Published.");
    router.refresh();
  }
  async function draftNext() {
    setBusy("draft");
    const r = await newVersion(p.id);
    setBusy(null);
    if (!r.ok) return toast.push(r.error, "error");
    toast.push(r.message ?? "Drafting.");
    router.push(`/hire/blueprints/${r.data.id}`);
  }
  async function critic() {
    if (dirty) return toast.push("Save first — the critic reads the saved draft.", "error");
    setBusy("critic");
    const r = await runCritic(p.id);
    setBusy(null);
    if (!r.ok) return toast.push(r.error, "error");
    toast.push(r.message ?? "Done.");
    router.refresh();
  }
  const approveAll = () =>
    mut((d) => {
      if (sec === "competencies") d.competenciesApproved = true;
      if (sec === "stages") d.stages.forEach((s) => (s.approved = true));
      if (sec === "questions" || sec === "rubrics") d.stages.forEach((s) => s.questions.forEach((q) => (q.approved = true)));
      if (sec === "briefing") d.stages.forEach((s) => s.briefing?.forEach((b) => (b.approved = true)));
      if (sec === "documents") d.documents.forEach((x) => (x.approved = true));
      if (sec === "offer") d.offer.approved = true;
      if (sec === "onboarding") d.onboarding.approved = true;
      if (sec === "provisioning") d.provisioning.approved = true;
      if (sec === "fairness") d.fairness.approved = true;
    });

  const props: SecProps = { def, mut, ro, critic: p.critic, goRubric: (ref) => go("rubrics", ref), rubricRef };
  const pending = appr.pending.length;

  return (
    <div className="grid grid-cols-[200px_minmax(0,1fr)_300px] items-start gap-6">
      <nav aria-label="Blueprint sections" className="sticky top-0 flex flex-col gap-0.5 rounded-[6px] border border-line bg-surface p-2">
        {SECS.map(([k, l]) => {
          const n = bySection(k);
          return (
            <button
              key={k}
              onClick={() => go(k)}
              className={cx("flex h-9 cursor-pointer items-center rounded-[4px] border-0 px-2.5 text-left text-sm", sec === k ? "bg-brand-soft font-medium text-brand-hover shadow-[inset_3px_0_0_var(--color-brand)]" : "bg-transparent text-body hover:bg-canvas")}
            >
              <span className="flex-1">{l}</span>
              {n ? <span className="h-[18px] min-w-5 rounded-[9px] bg-danger-soft px-1.5 text-center text-[11px] leading-[18px] font-semibold text-danger tabular-nums">{n}</span> : null}
            </button>
          );
        })}
      </nav>

      <div className="flex min-w-0 flex-col gap-4">
        {p.status !== "draft" ? (
          <div className="flex items-center gap-3 rounded-[6px] border border-line bg-canvas px-3.5 py-2.5 text-[13px] text-body">
            <span className="flex-1">
              {p.status === "published" ? `v${p.version} is published and cannot change.` : `v${p.version} is retired.`} Candidates who entered under it are scored under it for their whole journey
              {p.inFlight ? ` — ${p.inFlight} still in flight` : ""}.
            </span>
            {p.canEdit ? <Btn size="sm" kind="primary" disabled={busy !== null} onClick={draftNext}>Edit as a new version</Btn> : null}
          </div>
        ) : !p.canEdit ? (
          <Callout>Read-only — editing a blueprint needs a Hiring Manager, HR Head or Admin.</Callout>
        ) : null}

        <div className="flex items-center gap-2.5">
          <h2 className="m-0 flex-1 text-[22px] leading-7 font-semibold text-heading">{SECS.find(([k]) => k === sec)![1]}</h2>
          {!ro && sec !== "identity" && sec !== "thresholds" ? <Btn size="sm" onClick={approveAll}>Approve all in this section</Btn> : null}
        </div>
        <p className="-mt-2 mb-0 text-[13px] text-muted">{SUB[sec]}</p>

        {sec === "identity" ? (
          <div className="flex flex-col gap-4 rounded-[6px] border border-line bg-surface p-5">
            <div className="grid grid-cols-2 gap-4">
              <F label="Title"><Txt value={identity.title} ro={ro} onChange={(v) => { setIdentity({ ...identity, title: v }); setDirty(true); }} /></F>
              <F label="Role family"><Txt value={identity.family} ro={ro} onChange={(v) => { setIdentity({ ...identity, family: v }); setDirty(true); }} /></F>
              <F label="Department"><Txt value={identity.department} ro={ro} onChange={(v) => { setIdentity({ ...identity, department: v }); setDirty(true); }} /></F>
              <F label="Level"><Txt value={identity.level} ro={ro} onChange={(v) => { setIdentity({ ...identity, level: v }); setDirty(true); }} /></F>
              <F label="Employment type"><Txt value={identity.employmentType} ro={ro} onChange={(v) => { setIdentity({ ...identity, employmentType: v }); setDirty(true); }} /></F>
              <div className="grid grid-cols-2 gap-4">
                <F label="Headcount"><Num value={identity.headcount} ro={ro} onChange={(v) => { setIdentity({ ...identity, headcount: v ?? 1 }); setDirty(true); }} /></F>
                <F label="Keep records (months)"><Num value={identity.retentionMonths} ro={ro} onChange={(v) => { setIdentity({ ...identity, retentionMonths: v ?? 24 }); setDirty(true); }} /></F>
              </div>
            </div>
            <F label="Locations (comma-separated)">
              <Txt value={identity.locations.join(", ")} ro={ro} onChange={(v) => { setIdentity({ ...identity, locations: v.split(",").map((x) => x.trimStart()) }); setDirty(true); }} />
            </F>
            {p.descriptionSource ? (
              <div>
                <Label className="mb-1">{p.aiGenerated ? "◈ Generated from" : "Source"}</Label>
                <div className="max-h-48 overflow-auto rounded-[4px] bg-canvas p-3 text-[13px] whitespace-pre-wrap text-body">{p.descriptionSource}</div>
              </div>
            ) : null}
            {def.openQuestions.length || !ro ? (
              <F label="Open questions for the business (one per line — shown as warnings until answered)">
                <Area rows={Math.max(2, def.openQuestions.length)} value={def.openQuestions.join("\n")} ro={ro} onChange={(v) => mut((d) => void (d.openQuestions = v.split("\n").filter((x, i, a) => x.trim() || i < a.length - 1)))} />
              </F>
            ) : null}
          </div>
        ) : sec === "competencies" ? (
          <Competencies {...props} />
        ) : sec === "stages" ? (
          <Stages {...props} />
        ) : sec === "questions" ? (
          <Questions {...props} />
        ) : sec === "rubrics" ? (
          <Rubrics {...props} />
        ) : sec === "thresholds" ? (
          <Thresholds {...props} />
        ) : sec === "briefing" ? (
          <Briefing {...props} />
        ) : sec === "documents" ? (
          <Documents {...props} />
        ) : sec === "offer" ? (
          <OfferSec {...props} />
        ) : sec === "onboarding" ? (
          <Onboarding {...props} />
        ) : sec === "provisioning" ? (
          <Provisioning {...props} />
        ) : (
          <Fairness {...props} />
        )}
      </div>

      <aside className="sticky top-0 flex flex-col gap-4">
        <div className="rounded-[6px] border border-line bg-surface p-4">
          <div className="text-[15px] font-semibold text-heading">{identity.title}</div>
          <div className="mt-0.5 text-xs text-muted">
            v{p.version} · {p.status}
            {p.publishedLine ? ` · ${p.publishedLine}` : ""}
            {p.hasPrevious ? (
              <>
                {" · "}
                <Link href={`/hire/blueprints/${p.id}/diff`}>what changed</Link>
              </>
            ) : null}
          </div>
          <div className="mt-3 h-1.5 overflow-hidden rounded-[3px] bg-divider">
            <div className={cx("h-full", pct === 100 ? "bg-success" : "bg-brand")} style={{ width: `${pct}%` }} />
          </div>
          <div className="mt-1.5 text-xs text-body tabular-nums">
            {appr.approved} of {appr.total} elements approved{pending ? ` · ${pending} waiting for a person` : ""}
          </div>
          {p.status === "draft" && p.canEdit ? (
            <div className="mt-3 flex flex-wrap gap-2">
              <Btn kind="primary" size="sm" disabled={!dirty || busy !== null} onClick={save}>{busy === "save" ? "Saving…" : dirty ? "Save draft" : "Saved"}</Btn>
              <Btn size="sm" disabled={busy !== null} onClick={critic}>{busy === "critic" ? "Reviewing…" : "Run the rubric critic"}</Btn>
            </div>
          ) : null}
        </div>

        <div className="rounded-[6px] border border-line bg-surface p-4">
          <Label className="mb-2">Validation</Label>
          {!issues.length ? <div className="text-[13px] text-success">No errors and no warnings.</div> : null}
          <div className="flex max-h-[420px] flex-col gap-1 overflow-y-auto">
            {[...errors, ...warnings].slice(0, 60).map((v, i) => (
              <button key={i} onClick={() => go(v.section as Sec)} className="flex cursor-pointer items-start gap-2 rounded-[4px] border-0 bg-transparent px-1 py-1 text-left hover:bg-canvas">
                <span className={cx("mt-1 h-2 w-2 flex-none rounded-full", v.level === "error" ? "bg-danger" : "bg-warn")} />
                <span className="text-[12px] leading-4 text-body">
                  <span className="font-medium text-heading">{v.where}</span> — {v.message}
                </span>
              </button>
            ))}
          </div>
          <div className="mt-2 text-xs text-muted tabular-nums">
            {errors.length} error{errors.length === 1 ? "" : "s"} block publishing · {warnings.length} warning{warnings.length === 1 ? "" : "s"} do not
          </div>
          {p.status === "draft" ? (
            p.canPublish ? (
              <Btn
                kind="primary"
                className="mt-3 w-full"
                disabled={errors.length > 0 || dirty || busy !== null}
                title={errors.length ? "Fix the errors first" : dirty ? "Save the draft first" : undefined}
                onClick={publish}
              >
                {busy === "publish" ? "Publishing…" : `Publish v${p.version}`}
              </Btn>
            ) : (
              <div className="mt-3">
                <Pill tone="muted">Publishing needs an HR Head or Admin</Pill>
              </div>
            )
          ) : null}
        </div>
      </aside>
    </div>
  );
}
