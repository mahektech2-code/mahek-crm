"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { cx } from "@/components/ui/primitives";
import { draftQuestionsAction, saveModuleAction } from "@/lib/hire/actions/training";
import type { McqQuestion, ModuleDefinition } from "@/lib/training/types";
import { AiMark, Btn, Callout, Empty, Locked, Panel, Pill } from "../../_ui/kit";
import { QuestionEditor, blankQuestion } from "../question-editor";
import { inputCls, useRun } from "../_shared";

type Mod = { id: string; key: string; title: string; version: number; draft: boolean; learners: number; definition: ModuleDefinition };

export function QuestionBank({ modules, rates, canAuthor, lockedWhy }: { modules: Mod[]; rates: Record<string, { right: number; total: number }>; canAuthor: boolean; lockedWhy: string }) {
  const { pending, run } = useRun();
  const [moduleId, setModuleId] = useState<string>(modules[0]?.id ?? "");
  const [difficulty, setDifficulty] = useState("");
  const [tag, setTag] = useState("");
  const [status, setStatus] = useState("live");
  const [q, setQ] = useState("");
  const [sel, setSel] = useState<{ moduleId: string; key: string } | null>(null);
  const [draft, setDraft] = useState<McqQuestion | null>(null);

  const all = useMemo(() => modules.flatMap((m) => m.definition.questions.map((question) => ({ m, question }))), [modules]);
  const tags = useMemo(() => [...new Set(all.flatMap((r) => r.question.tags))].sort(), [all]);
  const t = q.trim().toLowerCase();
  const shown = all.filter(
    ({ m, question }) =>
      (!moduleId || m.id === moduleId) &&
      (!difficulty || question.difficulty === difficulty) &&
      (!tag || question.tags.includes(tag)) &&
      (status === "all" || (status === "live" ? question.active : status === "approval" ? question.ai && !question.approved : !question.active)) &&
      (!t || question.text.toLowerCase().includes(t)),
  );
  const selMod = modules.find((m) => m.id === sel?.moduleId) ?? null;

  const pick = (m: Mod, question: McqQuestion) => {
    setSel({ moduleId: m.id, key: question.key });
    setDraft(structuredClone(question));
  };
  const save = () => {
    if (!selMod || !draft) return;
    const exists = selMod.definition.questions.some((x) => x.key === draft.key);
    const definition = { ...selMod.definition, questions: exists ? selMod.definition.questions.map((x) => (x.key === draft.key ? draft : x)) : [...selMod.definition.questions, draft] };
    run(() => saveModuleAction(selMod.id, { definition }));
  };
  const remove = () => {
    if (!selMod || !draft) return;
    run(() => saveModuleAction(selMod.id, { definition: { ...selMod.definition, questions: selMod.definition.questions.filter((x) => x.key !== draft.key) } }), () => {
      setSel(null);
      setDraft(null);
    });
  };
  const curMod = modules.find((m) => m.id === moduleId) ?? null;

  if (!modules.length) return <Empty title="No modules yet">Create a module first — every question belongs to one.</Empty>;

  return (
    <>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <select className={cx(inputCls, "w-64")} aria-label="Module" value={moduleId} onChange={(e) => setModuleId(e.target.value)}>
          <option value="">All modules</option>
          {modules.map((m) => (
            <option key={m.id} value={m.id}>
              {m.title}
            </option>
          ))}
        </select>
        <select className={cx(inputCls, "w-40")} aria-label="Difficulty" value={difficulty} onChange={(e) => setDifficulty(e.target.value)}>
          <option value="">Any difficulty</option>
          <option value="easy">Easy</option>
          <option value="medium">Medium</option>
          <option value="hard">Hard</option>
        </select>
        <select className={cx(inputCls, "w-40")} aria-label="Tag" value={tag} onChange={(e) => setTag(e.target.value)}>
          <option value="">Any tag</option>
          {tags.map((x) => (
            <option key={x} value={x}>
              {x}
            </option>
          ))}
        </select>
        <select className={cx(inputCls, "w-48")} aria-label="Status" value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="live">Active</option>
          <option value="approval">Waiting for approval</option>
          <option value="inactive">Inactive</option>
          <option value="all">Everything</option>
        </select>
        <input className={cx(inputCls, "w-60")} placeholder="Search question text" aria-label="Search" value={q} onChange={(e) => setQ(e.target.value)} />
        <span className="flex-1" />
        {canAuthor ? (
          <>
            <Btn disabled={pending || !curMod} title={!curMod ? "Pick one module first" : "Drafts five questions from that module’s content"} onClick={() => curMod && run(() => draftQuestionsAction(curMod.id, 5))}>
              Draft questions with AI
            </Btn>
            <Btn
              kind="primary"
              disabled={!curMod}
              title={!curMod ? "Pick one module first" : undefined}
              onClick={() => {
                if (!curMod) return;
                const nq = blankQuestion();
                setSel({ moduleId: curMod.id, key: nq.key });
                setDraft(nq);
              }}
            >
              + Add question
            </Btn>
          </>
        ) : (
          <Locked why={lockedWhy}>Add question</Locked>
        )}
      </div>

      <div className="grid grid-cols-[minmax(0,1fr)_440px] items-start gap-4">
        <Panel pad={false}>
          {!shown.length ? <div className="px-5 py-6 text-[13px] text-muted">No question matches these filters.</div> : null}
          {shown.length ? (
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-[13px]">
                <thead>
                  <tr className="border-b border-divider text-left text-[11px] font-medium tracking-[0.04em] text-muted uppercase">
                    <th className="px-3 py-2.5">#</th>
                    <th className="px-3 py-2.5">Question</th>
                    {!moduleId ? <th className="px-3 py-2.5">Module</th> : null}
                    <th className="px-3 py-2.5">Difficulty</th>
                    <th className="px-3 py-2.5">Tags</th>
                    <th className="px-3 py-2.5 text-right">Answered right</th>
                    <th className="px-3 py-2.5">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {shown.map(({ m, question }, i) => {
                    const r = rates[`${m.key}:${question.key}`];
                    const on = sel?.moduleId === m.id && sel.key === question.key;
                    return (
                      <tr key={`${m.id}:${question.key}`} onClick={() => pick(m, question)} className={cx("cursor-pointer border-b border-canvas", on ? "bg-brand-soft" : "hover:bg-canvas")}>
                        <td className="px-3 py-2.5 align-top text-muted tabular-nums">{i + 1}</td>
                        <td className="max-w-[380px] px-3 py-2.5 align-top text-heading">
                          {question.ai ? <AiMark className="mr-1" /> : null}
                          {question.text || "Untitled question"}
                        </td>
                        {!moduleId ? <td className="px-3 py-2.5 align-top text-muted">{m.title}</td> : null}
                        <td className="px-3 py-2.5 align-top capitalize">{question.difficulty}</td>
                        <td className="px-3 py-2.5 align-top">
                          {question.tags.map((x) => (
                            <span key={x} className="mr-1 mb-1 inline-flex h-5 items-center rounded-[4px] border border-line px-1.5 text-[11px] text-body">
                              {x}
                            </span>
                          ))}
                        </td>
                        <td className="px-3 py-2.5 text-right align-top tabular-nums">{r && r.total ? `${Math.round((r.right / r.total) * 100)}%` : "—"}</td>
                        <td className="px-3 py-2.5 align-top">
                          {question.ai && !question.approved ? <Pill tone="ai">Needs approval</Pill> : question.active ? <Pill tone="success">Active</Pill> : <Pill tone="muted">Inactive</Pill>}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : null}
        </Panel>

        {selMod && draft ? (
          <Panel
            key={`${sel?.moduleId}:${sel?.key}`}
            title={selMod.definition.questions.some((x) => x.key === draft.key) ? "Edit question" : "New question"}
            sub={
              <>
                <Link href={`/hire/train/modules/${selMod.id}`}>{selMod.title}</Link> · editing in {selMod.draft ? `draft v${selMod.version}` : `a new draft v${selMod.version + 1}`}
              </>
            }
          >
            <div className="flex flex-col gap-4">
              <QuestionEditor q={draft} ro={!canAuthor} onChange={setDraft} onRemove={canAuthor && selMod.definition.questions.some((x) => x.key === draft.key) ? remove : undefined} />
              <Callout tone="neutral">Saving changes the draft only.{selMod.learners ? ` The ${selMod.learners} learner${selMod.learners === 1 ? "" : "s"} tested on earlier versions keep the questions they were tested on.` : ""} Publish the module to put it in front of learners.</Callout>
              {canAuthor ? (
                <div className="flex gap-2">
                  <Btn kind="primary" disabled={pending} onClick={save}>
                    Save
                  </Btn>
                  <Btn
                    onClick={() => {
                      setSel(null);
                      setDraft(null);
                    }}
                  >
                    Cancel
                  </Btn>
                </div>
              ) : null}
            </div>
          </Panel>
        ) : (
          <Panel title="Pick a question">
            <div className="text-[13px] text-muted">Choose one on the left to read or edit it.</div>
          </Panel>
        )}
      </div>
    </>
  );
}
