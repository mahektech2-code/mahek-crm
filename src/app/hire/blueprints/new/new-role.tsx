"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { cx } from "@/components/ui/primitives";
import { useToast } from "@/components/ui/toast";
import { copyToNewRole, createBlank, generateBlueprintStep, saveGenerated } from "@/lib/hire/actions/blueprints";
import type { GenParts, GenStep, Intake } from "@/lib/hire/ai/generate-blueprint";
import { Btn, Callout, Label, Panel } from "../../_ui/kit";

const SIX: { k: keyof NonNullable<Intake["six"]>; l: string; ph: string }[] = [
  { k: "title", l: "Role title", ph: "Warehouse Supervisor" },
  { k: "what", l: "What the job is", ph: "Runs the loading crew and the stock counts at the Taloja godown" },
  { k: "where", l: "Where they work", ph: "Ambernath Plant and Taloja Godown" },
  { k: "reportsTo", l: "Who they report to", ph: "Operations Manager" },
  { k: "greatMonth", l: "What a great month looks like", ph: "Every truck out on time, counts match, nobody hurt" },
  { k: "dealBreakers", l: "Deal-breakers", ph: "Will not work night shifts in dispatch season" },
];

/** The six generation calls, and the twelve sections each one drafts. */
const GEN_STEPS: { key: GenStep; sections: string[] }[] = [
  { key: "identity", sections: ["Role identity", "Competency model"] },
  { key: "stages", sections: ["Stage pipeline", "Thresholds"] },
  { key: "questions", sections: ["Question bank", "Scoring rubrics"] },
  { key: "expectation", sections: ["Expectation set", "Document set"] },
  { key: "offer", sections: ["Offer model", "Onboarding plan", "Provisioning"] },
  { key: "fairness", sections: ["Fairness configuration"] },
];

type StepState = "waiting" | "drafting" | "done" | "failed";

export function NewRole({ published, aiDown }: { published: { id: string; title: string; family: string; version: number }[]; aiDown: string | null }) {
  const router = useRouter();
  const toast = useToast();
  const [mode, setMode] = useState<"jd" | "six" | "copy">(aiDown ? "copy" : "jd");
  const [jd, setJd] = useState("");
  const [six, setSix] = useState<NonNullable<Intake["six"]>>({ title: "", what: "", where: "", reportsTo: "", greatMonth: "", dealBreakers: "" });
  const [phase, setPhase] = useState<"describe" | "generating" | "failed">("describe");
  const [states, setStates] = useState<StepState[]>(GEN_STEPS.map(() => "waiting"));
  const [failure, setFailure] = useState<string | null>(null);
  const [from, setFrom] = useState(published[0]?.id ?? "");
  const [title, setTitle] = useState("");
  const [family, setFamily] = useState("");
  const [busy, setBusy] = useState(false);

  const intake: Intake = mode === "jd" ? { jd } : { six };
  const ready = mode === "jd" ? jd.trim().length >= 80 : six.title.trim().length > 1 && six.what.trim().length > 10;

  async function generate() {
    setPhase("generating");
    setFailure(null);
    let parts: GenParts = {};
    const next = GEN_STEPS.map(() => "waiting" as StepState);
    for (let i = 0; i < GEN_STEPS.length; i++) {
      next[i] = "drafting";
      setStates([...next]);
      const r = await generateBlueprintStep(GEN_STEPS[i].key, intake, parts);
      if (!r.ok) {
        next[i] = "failed";
        setStates([...next]);
        setFailure(r.error);
        setPhase("failed");
        return;
      }
      parts = r.data;
      next[i] = "done";
      setStates([...next]);
    }
    const saved = await saveGenerated(intake, parts);
    if (!saved.ok) {
      setFailure(saved.error);
      setPhase("failed");
      return;
    }
    toast.push(saved.message ?? "Drafted.");
    router.push(`/hire/blueprints/${saved.data.id}`);
  }

  async function manual(kind: "copy" | "blank") {
    setBusy(true);
    const r = kind === "copy" ? await copyToNewRole(from, title) : await createBlank(title, family, "");
    setBusy(false);
    if (!r.ok) return toast.push(r.error, "error");
    toast.push(r.message ?? "Started.");
    router.push(`/hire/blueprints/${r.data.id}`);
  }

  const stepper = ["Describe the role", "AI generates", "Review and refine", "Publish"];
  const at = phase === "describe" ? 0 : 1;

  return (
    <div className="max-w-[860px]">
      <ol className="mb-6 flex flex-wrap gap-5 p-0 text-sm">
        {stepper.map((s, i) => (
          <li key={s} className={cx("flex list-none items-center gap-2", i === at ? "font-medium text-heading" : "text-muted")}>
            <span className={cx("flex h-6 w-6 items-center justify-center rounded-full text-xs font-semibold tabular-nums", i === at ? "bg-brand text-white" : i < at ? "bg-brand-soft text-brand-hover" : "bg-divider text-muted")}>{i + 1}</span>
            {s}
          </li>
        ))}
      </ol>

      {phase === "describe" ? (
        <Panel>
          <div className="mb-4 inline-flex gap-0.5 rounded-[6px] border border-line p-[3px]">
            {(
              [
                ["jd", "Paste a job description"],
                ["six", "Answer six questions"],
                ["copy", "Start without AI"],
              ] as const
            ).map(([k, l]) => (
              <button key={k} onClick={() => setMode(k)} className={cx("h-8 cursor-pointer rounded-[4px] border-0 px-3 text-[13px] font-medium", mode === k ? "bg-heading text-white" : "bg-transparent text-body")}>
                {l}
              </button>
            ))}
          </div>

          {aiDown && mode !== "copy" ? <Callout tone="warn" className="mb-4">{aiDown} Use “Start without AI” to begin from an existing blueprint or a blank skeleton.</Callout> : null}

          {mode === "jd" ? (
            <textarea
              value={jd}
              onChange={(e) => setJd(e.target.value)}
              rows={12}
              placeholder="Paste the job description — duties, where the person works, who they report to, what they must be able to do on day one."
              className="w-full rounded-[4px] border border-line-strong p-3 text-sm leading-5 outline-none focus:border-brand"
            />
          ) : null}
          {mode === "six" ? (
            <div className="grid grid-cols-1 gap-4">
              {SIX.map((q) => (
                <label key={q.k} className="block">
                  <Label className="mb-1">{q.l}</Label>
                  <input value={six[q.k]} onChange={(e) => setSix({ ...six, [q.k]: e.target.value })} placeholder={q.ph} className="h-9 w-full rounded-[4px] border border-line-strong px-2.5 text-sm outline-none focus:border-brand" />
                </label>
              ))}
            </div>
          ) : null}
          {mode === "copy" ? (
            <div className="grid gap-5">
              <div>
                <Label className="mb-1">New role title</Label>
                <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Senior Sales Executive — Nagpur" className="h-9 w-full rounded-[4px] border border-line-strong px-2.5 text-sm outline-none focus:border-brand" />
              </div>
              <div className="rounded-[6px] border border-line p-4">
                <div className="text-[15px] font-semibold text-heading">Start from the closest blueprint</div>
                <p className="mt-1 mb-3 text-[13px] text-muted">Copies its competencies, stages, questions, rubrics, offer and onboarding into a new draft. Nothing about the original changes.</p>
                <div className="flex flex-wrap items-center gap-2">
                  <select value={from} onChange={(e) => setFrom(e.target.value)} className="h-9 min-w-[280px] rounded-[4px] border border-line-strong bg-surface px-2.5 text-sm">
                    {published.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.title} · v{p.version} · {p.family}
                      </option>
                    ))}
                  </select>
                  <Btn kind="primary" disabled={busy || !from} onClick={() => manual("copy")}>Start from this</Btn>
                </div>
              </div>
              <div className="rounded-[6px] border border-line p-4">
                <div className="text-[15px] font-semibold text-heading">Or a blank skeleton</div>
                <p className="mt-1 mb-3 text-[13px] text-muted">Application, one interview, a decision gate, documents, induction and setup — every section to fill in by hand.</p>
                <div className="flex flex-wrap items-center gap-2">
                  <input value={family} onChange={(e) => setFamily(e.target.value)} placeholder="Role family, e.g. Operations" className="h-9 w-[260px] rounded-[4px] border border-line-strong px-2.5 text-sm outline-none focus:border-brand" />
                  <Btn disabled={busy || !title.trim()} title={title.trim() ? undefined : "Give the role a title first"} onClick={() => manual("blank")}>Start blank</Btn>
                </div>
              </div>
            </div>
          ) : (
            <>
              <p className="mt-4 mb-0 text-[13px] text-muted">The AI drafts every section. Nothing is published until a person approves each element.</p>
              <div className="mt-4 flex justify-end">
                <Btn kind="primary" disabled={!ready || Boolean(aiDown)} title={aiDown ?? (ready ? undefined : mode === "jd" ? "Paste at least a few lines of the job description" : "Give at least the title and what the job is")} onClick={generate}>
                  Generate the blueprint
                </Btn>
              </div>
            </>
          )}
        </Panel>
      ) : (
        <div className="overflow-hidden rounded-[6px] border border-ai-line bg-surface">
          <div className="bg-ai-soft px-5 py-2.5 text-[13px] font-medium text-ai">
            ◈ Drafting {mode === "jd" ? "the role" : six.title || "the role"} · {states.filter((s) => s === "done").length} of {GEN_STEPS.length} steps
          </div>
          <div className="px-5 py-2">
            {GEN_STEPS.flatMap((g, i) =>
              g.sections.map((sec) => (
                <div key={sec} className="flex items-center gap-3 border-b border-divider py-2.5 last:border-0">
                  <span className={cx("h-2 w-2 flex-none rounded-full", states[i] === "done" ? "bg-success" : states[i] === "drafting" ? "animate-pulse bg-ai-mid" : states[i] === "failed" ? "bg-danger" : "bg-divider")} />
                  <span className="flex-1 text-sm text-heading">{sec}</span>
                  <span className="text-[13px] text-muted">{states[i] === "done" ? "Drafted" : states[i] === "drafting" ? "Drafting…" : states[i] === "failed" ? "Failed" : "Waiting"}</span>
                </div>
              )),
            )}
          </div>
          {phase === "failed" ? (
            <div className="border-t border-divider px-5 py-4">
              <Callout tone="warn">{failure}</Callout>
              <div className="mt-3 flex gap-2">
                <Btn kind="primary" onClick={generate}>Try again</Btn>
                <Btn onClick={() => { setPhase("describe"); setMode("copy"); }}>Start without AI</Btn>
              </div>
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}
