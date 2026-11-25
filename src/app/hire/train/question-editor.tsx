"use client";

import { useState } from "react";
import { cx } from "@/components/ui/primitives";
import { questionProblems } from "@/lib/training/engine";
import type { McqQuestion } from "@/lib/training/types";
import { AiMark, Btn, Label, Pill } from "../_ui/kit";
import { areaCls, Seg, Switch } from "./_shared";

/** A question with every field the PRD asks for. Pure editing — the caller saves. */
export function QuestionEditor({ q, onChange, ro, onRemove }: { q: McqQuestion; onChange: (q: McqQuestion) => void; ro: boolean; onRemove?: () => void }) {
  const [tag, setTag] = useState("");
  const set = (patch: Partial<McqQuestion>) => onChange({ ...q, ...patch });
  const problems = questionProblems(q);
  const nextKey = () => {
    for (let i = 0; i < 26; i++) {
      const k = String.fromCharCode(97 + i);
      if (!q.options.some((o) => o.key === k)) return k;
    }
    return `o${q.options.length}`;
  };
  return (
    <div className="flex flex-col gap-3">
      {q.ai ? (
        <div className="flex items-center gap-2 rounded-[4px] border border-ai-line bg-ai-soft px-3 py-2 text-[13px] text-ai">
          <AiMark /> Drafted by AI from the module’s content. {q.approved ? "Approved by a person." : "Read it, correct it, and approve it — it cannot be published until you do."}
        </div>
      ) : null}
      <label>
        <Label className="mb-1.5">Question</Label>
        <textarea disabled={ro} className={cx(areaCls, "h-16 resize-y")} value={q.text} onChange={(e) => set({ text: e.target.value })} />
      </label>
      <div>
        <Label className="mb-2">Options · pick the right one</Label>
        <div className="flex flex-col gap-1.5">
          {q.options.map((o, i) => {
            const right = o.key === q.correctKey;
            return (
              <div key={o.key} className={cx("flex items-center gap-2.5 rounded-[4px] border px-2.5 py-1.5", right ? "border-success bg-success-soft" : "border-line")}>
                <input type="radio" disabled={ro} checked={right} onChange={() => set({ correctKey: o.key })} aria-label={`Option ${o.key.toUpperCase()} is correct`} />
                <span className={cx("w-3.5 text-[13px] font-semibold", right ? "text-success" : "text-muted")}>{o.key.toUpperCase()}</span>
                <input
                  disabled={ro}
                  className="h-7 min-w-0 flex-1 border-0 bg-transparent text-sm text-heading outline-none"
                  value={o.text}
                  aria-label={`Option ${o.key.toUpperCase()}`}
                  onChange={(e) => set({ options: q.options.map((x, j) => (j === i ? { ...x, text: e.target.value } : x)) })}
                />
                {!ro && q.options.length > 2 ? (
                  <button type="button" aria-label="Remove option" className="cursor-pointer border-0 bg-transparent text-muted hover:text-danger" onClick={() => set({ options: q.options.filter((_, j) => j !== i), correctKey: right ? (q.options.find((_, j) => j !== i)?.key ?? "") : q.correctKey })}>
                    ×
                  </button>
                ) : null}
              </div>
            );
          })}
        </div>
        {!ro && q.options.length < 6 ? (
          <Btn kind="ghost" size="sm" className="mt-1" onClick={() => set({ options: [...q.options, { key: nextKey(), text: "" }] })}>
            + Add option
          </Btn>
        ) : null}
      </div>
      <label>
        <Label className="mb-1.5">Explanation · shown after the answer</Label>
        <textarea disabled={ro} className={cx(areaCls, "h-14 resize-y")} value={q.explanation} onChange={(e) => set({ explanation: e.target.value })} />
      </label>
      <div className="flex flex-wrap items-end gap-5">
        <div>
          <Label className="mb-1.5">Difficulty</Label>
          <Seg label="Difficulty" disabled={ro} value={q.difficulty} options={[["easy", "Easy"], ["medium", "Medium"], ["hard", "Hard"]] as const} onChange={(v) => set({ difficulty: v })} />
        </div>
        <label className="flex items-center gap-2 text-sm text-heading">
          <Switch on={q.active} disabled={ro} label="Active" onChange={(v) => set({ active: v })} /> Active
        </label>
        {q.ai ? (
          <label className="flex items-center gap-2 text-sm text-heading">
            <Switch on={q.approved} disabled={ro} label="Approved" onChange={(v) => set({ approved: v })} /> Approved by me
          </label>
        ) : null}
      </div>
      <div>
        <Label className="mb-1.5">Tags</Label>
        <div className="flex flex-wrap items-center gap-1.5">
          {q.tags.map((t) => (
            <span key={t} className="inline-flex h-6 items-center gap-1 rounded-[4px] border border-line px-2 text-xs text-body">
              {t}
              {!ro ? (
                <button type="button" aria-label={`Remove ${t}`} className="cursor-pointer border-0 bg-transparent p-0 text-muted" onClick={() => set({ tags: q.tags.filter((x) => x !== t) })}>
                  ×
                </button>
              ) : null}
            </span>
          ))}
          {!ro ? (
            <input
              className="h-6 w-28 rounded-[4px] border border-line-strong px-2 text-xs outline-none focus:border-brand"
              placeholder="+ tag, Enter"
              value={tag}
              onChange={(e) => setTag(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && tag.trim()) {
                  e.preventDefault();
                  set({ tags: [...new Set([...q.tags, tag.trim().toLowerCase()])] });
                  setTag("");
                }
              }}
            />
          ) : null}
        </div>
      </div>
      <div className="flex items-center gap-2">
        {problems.length ? <Pill tone="warn">{problems[0]}</Pill> : <Pill tone="success">Complete</Pill>}
        <span className="flex-1" />
        {!ro && onRemove ? (
          <Btn kind="ghost" size="sm" onClick={onRemove}>
            Remove question
          </Btn>
        ) : null}
      </div>
    </div>
  );
}

let seq = 0;
export function blankQuestion(): McqQuestion {
  seq += 1;
  return {
    key: `q_${Math.random().toString(36).slice(2, 8)}${seq}`,
    text: "",
    options: [
      { key: "a", text: "" },
      { key: "b", text: "" },
      { key: "c", text: "" },
      { key: "d", text: "" },
    ],
    correctKey: "a",
    explanation: "",
    difficulty: "medium",
    tags: [],
    active: true,
    ai: false,
    approved: true,
  };
}

