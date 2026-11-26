"use client";

import { useState } from "react";
import Link from "next/link";
import { cx } from "@/components/ui/primitives";
import { discardModuleDraftAction, draftQuestionsAction, publishModuleAction, saveModuleAction } from "@/lib/hire/actions/training";
import { moduleProblems } from "@/lib/training/engine";
import type { ProductFact } from "@/lib/training/service";
import { CATEGORY_LABEL, TRAINING_CATEGORIES, type ContentBlock, type ModuleDefinition } from "@/lib/training/types";
import { AiMark, Btn, Callout, Label, Locked, PageHead, Panel, Pill, fd, inr } from "../../../_ui/kit";
import { QuestionEditor, blankQuestion } from "../../question-editor";
import { areaCls, inputCls, Problems, Seg, Switch, useRun } from "../../_shared";

type Version = { id: string; version: number; status: string; at: string; by: string | null; passMark: number; questions: number };

const BLOCK_LABEL: Record<ContentBlock["kind"], string> = { text: "Text", link: "Link", product_facts: "Product facts · live", directory: "Contact directory" };

const bkey = () => `b_${Math.random().toString(36).slice(2, 9)}`;

export function ModuleEditor({
  module: m,
  editing,
  versions,
  tracks,
  facts,
  pricesLive,
  canAuthor,
  lockedWhy,
}: {
  module: { id: string; key: string; title: string; category: string };
  editing: { id: string; version: number; status: string; definition: ModuleDefinition } | null;
  versions: Version[];
  tracks: string[];
  facts: Record<string, ProductFact[]>;
  pricesLive: boolean;
  canAuthor: boolean;
  lockedWhy: string;
}) {
  const { pending, run } = useRun();
  const [def, setDef] = useState<ModuleDefinition>(() => structuredClone(editing?.definition ?? { content: [], questions: [], passMarkPercent: 80, questionsPerAttempt: null, timerMinutes: 15, shuffleQuestions: true, shuffleOptions: true, feedback: "after_submit", minStudyMinutes: 5 }));
  const [title, setTitle] = useState(m.title);
  const [category, setCategory] = useState(m.category);
  const [dirty, setDirty] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const isDraft = editing?.status === "draft";
  const ro = !canAuthor;
  const published = versions.find((v) => v.status === "published");
  const problems = moduleProblems(def);
  const usable = def.questions.filter((q) => q.active && q.approved).length;

  const edit = (f: (d: ModuleDefinition) => ModuleDefinition) => {
    setDef((d) => f(structuredClone(d)));
    setDirty(true);
  };
  const setBlock = (i: number, b: ContentBlock) => edit((d) => ({ ...d, content: d.content.map((x, j) => (j === i ? b : x)) }));
  const move = (i: number, by: number) =>
    edit((d) => {
      const c = [...d.content];
      const j = i + by;
      if (j < 0 || j >= c.length) return d;
      [c[i], c[j]] = [c[j], c[i]];
      return { ...d, content: c };
    });
  const addBlock = (kind: ContentBlock["kind"]) =>
    edit((d) => ({
      ...d,
      content: [
        ...d.content,
        kind === "text" ? { key: bkey(), kind, title: "", body: "", tone: "normal" } : kind === "link" ? { key: bkey(), kind, title: "", url: "" } : kind === "product_facts" ? { key: bkey(), kind, title: "Price list and packing", match: "" } : { key: bkey(), kind, title: "Who to contact" },
      ],
    }));

  const save = (then?: () => void) => run(() => saveModuleAction(m.id, { title, category, definition: def }), () => {
    setDirty(false);
    then?.();
  });
  const publish = () =>
    dirty
      ? run(
          () => saveModuleAction(m.id, { title, category, definition: def }),
          () => {
            setDirty(false);
            run(() => publishModuleAction(m.id));
          },
        )
      : run(() => publishModuleAction(m.id));

  const nNum = (v: string, lo: number, hi: number) => {
    const n = Math.round(Number(v));
    return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : lo;
  };

  return (
    <>
      <PageHead
        back={{ href: "/hire/train/modules", label: "Modules" }}
        title={
          <span className="flex flex-wrap items-center gap-2">
            {title || m.title}
            {editing ? <Pill tone={isDraft ? "neutral" : "success"}>{isDraft ? "Draft" : "Published"} v{editing.version}</Pill> : null}
            {dirty ? <Pill tone="warn">Unsaved</Pill> : null}
          </span>
        }
        sub={`${CATEGORY_LABEL[category as keyof typeof CATEGORY_LABEL] ?? category} · ${m.key}${tracks.length ? ` · in ${tracks.join(", ")}` : " · in no published track yet"}${published ? ` · v${published.version} is live` : ""}`}
        actions={
          canAuthor ? (
            <>
              {isDraft && published ? (
                <Btn disabled={pending} onClick={() => run(() => discardModuleDraftAction(m.id))}>
                  Discard draft
                </Btn>
              ) : null}
              <Btn disabled={pending || !dirty} title={!dirty ? "Nothing changed" : undefined} onClick={() => save()}>
                {isDraft ? "Save draft" : `Save as draft v${(versions[0]?.version ?? 0) + 1}`}
              </Btn>
              <Btn kind="primary" disabled={pending || problems.length > 0} title={problems[0]} onClick={publish}>
                Publish{isDraft ? ` v${editing?.version}` : ""}
              </Btn>
            </>
          ) : (
            <Locked why={lockedWhy}>Edit</Locked>
          )
        }
      />
      {!isDraft && canAuthor ? <Callout tone="info" className="mb-4">You are looking at the published version. The first change you save becomes draft v{(versions[0]?.version ?? 0) + 1}; learners stay on v{editing?.version} until you publish it.</Callout> : null}
      {pricesLive ? <Callout tone="warn" className="mb-4">Product facts are read live from the catalogue, so the price list here is today’s. A question that quotes a price was frozen when its version was published — check the ones tagged <b>pricing</b> whenever prices move.</Callout> : null}

      <div className="grid grid-cols-[minmax(0,1fr)_360px] items-start gap-4">
        <div className="flex min-w-0 flex-col gap-4">
          <Panel title="Content" sub="What the learner studies, top to bottom" actions={<span className="text-xs text-muted">{def.content.length} blocks</span>}>
            <div className="flex flex-col gap-3">
              {!def.content.length ? <div className="text-[13px] text-muted">No content yet. Add a block below.</div> : null}
              {def.content.map((b, i) => (
                <div key={b.key} className="rounded-[6px] border border-line">
                  <div className="flex items-center gap-2 rounded-t-[6px] border-b border-divider bg-page px-3 py-2">
                    <Pill tone={b.kind === "product_facts" ? "info" : b.kind === "text" && b.tone === "safety" ? "danger" : "neutral"}>{b.kind === "text" && b.tone === "safety" ? "Safety" : BLOCK_LABEL[b.kind]}</Pill>
                    <input disabled={ro} className="h-7 min-w-0 flex-1 border-0 bg-transparent text-[13px] font-medium text-heading outline-none" value={b.title} placeholder="Block title" aria-label="Block title" onChange={(e) => setBlock(i, { ...b, title: e.target.value })} />
                    {!ro ? (
                      <span className="flex gap-1">
                        <Btn size="sm" kind="ghost" disabled={i === 0} title={i === 0 ? "Already first" : "Move up"} onClick={() => move(i, -1)}>
                          ↑
                        </Btn>
                        <Btn size="sm" kind="ghost" disabled={i === def.content.length - 1} title={i === def.content.length - 1 ? "Already last" : "Move down"} onClick={() => move(i, 1)}>
                          ↓
                        </Btn>
                        <Btn size="sm" kind="ghost" onClick={() => edit((d) => ({ ...d, content: d.content.filter((_, j) => j !== i) }))}>
                          Remove
                        </Btn>
                      </span>
                    ) : null}
                  </div>
                  <div className="p-3">
                    {b.kind === "text" ? (
                      <div className="flex flex-col gap-2">
                        <textarea disabled={ro} className={cx(areaCls, "h-28 resize-y")} value={b.body} placeholder="The approved wording" onChange={(e) => setBlock(i, { ...b, body: e.target.value })} />
                        <label className="flex items-center gap-2 text-[13px] text-body">
                          <Switch on={b.tone === "safety"} disabled={ro} label="Safety block" onChange={(v) => setBlock(i, { ...b, tone: v ? "safety" : "normal" })} /> Draw as a safety block
                        </label>
                      </div>
                    ) : b.kind === "link" ? (
                      <div className="grid grid-cols-2 gap-2">
                        <input disabled={ro} className={inputCls} value={b.url} placeholder="https://…" aria-label="Link" onChange={(e) => setBlock(i, { ...b, url: e.target.value })} />
                        <input disabled={ro} className={inputCls} value={b.note ?? ""} placeholder="What it is (optional)" aria-label="Note" onChange={(e) => setBlock(i, { ...b, note: e.target.value })} />
                      </div>
                    ) : b.kind === "product_facts" ? (
                      <div className="flex flex-col gap-2">
                        <label className="flex items-center gap-2 text-[13px]">
                          <span className="text-muted">Products whose name contains</span>
                          <input disabled={ro} className={cx(inputCls, "h-8 w-48")} value={b.match} placeholder="nano" onChange={(e) => setBlock(i, { ...b, match: e.target.value })} />
                        </label>
                        <FactsTable rows={facts[b.match]} />
                      </div>
                    ) : (
                      <div className="text-[13px] text-muted">The desks and people from the “Who to contact” setting, read when the learner opens the module.</div>
                    )}
                  </div>
                </div>
              ))}
              {!ro ? (
                <div className="flex flex-wrap gap-2">
                  <Btn size="sm" onClick={() => addBlock("text")}>+ Text</Btn>
                  <Btn size="sm" onClick={() => addBlock("link")}>+ Link</Btn>
                  <Btn size="sm" onClick={() => addBlock("product_facts")}>+ Product facts</Btn>
                  <Btn size="sm" onClick={() => addBlock("directory")}>+ Contact directory</Btn>
                </div>
              ) : null}
            </div>
          </Panel>

          <Panel
            title="Questions"
            sub={`${def.questions.filter((q) => q.active).length} active · ${usable} usable (active and approved) · ${def.questions.filter((q) => q.ai && !q.approved).length} waiting for approval`}
            actions={
              canAuthor ? (
                <span className="flex gap-2">
                  <Btn size="sm" disabled={pending || dirty} title={dirty ? "Save first — questions are drafted from the saved content" : "Drafts five questions from this module’s content"} onClick={() => run(() => draftQuestionsAction(m.id, 5))}>
                    Draft with AI
                  </Btn>
                  <Btn
                    size="sm"
                    kind="primary"
                    onClick={() => {
                      const q = blankQuestion();
                      edit((d) => ({ ...d, questions: [...d.questions, q] }));
                      setOpen(q.key);
                    }}
                  >
                    + Question
                  </Btn>
                </span>
              ) : null
            }
            pad={false}
          >
            {!def.questions.length ? <div className="px-5 py-4 text-[13px] text-muted">No questions yet.</div> : null}
            {def.questions.map((q, i) => (
              <div key={q.key} className="border-t border-divider first:border-t-0">
                <button type="button" onClick={() => setOpen(open === q.key ? null : q.key)} className="flex w-full cursor-pointer items-center gap-3 border-0 bg-transparent px-5 py-2.5 text-left hover:bg-canvas">
                  <span className="w-6 text-xs text-muted tabular-nums">{i + 1}</span>
                  {q.ai ? <AiMark /> : null}
                  <span className={cx("min-w-0 flex-1 truncate text-sm", q.active ? "text-heading" : "text-muted line-through")}>{q.text || "Untitled question"}</span>
                  <span className="text-xs text-muted capitalize">{q.difficulty}</span>
                  {q.ai && !q.approved ? <Pill tone="ai">Needs approval</Pill> : !q.active ? <Pill tone="muted">Inactive</Pill> : null}
                </button>
                {open === q.key ? (
                  <div className="border-t border-divider bg-page px-5 py-4">
                    <QuestionEditor
                      q={q}
                      ro={ro}
                      onChange={(nq) => edit((d) => ({ ...d, questions: d.questions.map((x) => (x.key === q.key ? nq : x)) }))}
                      onRemove={() => edit((d) => ({ ...d, questions: d.questions.filter((x) => x.key !== q.key) }))}
                    />
                  </div>
                ) : null}
              </div>
            ))}
          </Panel>
        </div>

        <div className="flex flex-col gap-4">
          <Panel title="Module" sub="Shown in every track that uses it">
            <div className="flex flex-col gap-3">
              <label>
                <Label className="mb-1.5">Title</Label>
                <input disabled={ro} className={inputCls} value={title} onChange={(e) => {
                    setTitle(e.target.value);
                    setDirty(true);
                  }} />
              </label>
              <label>
                <Label className="mb-1.5">Category</Label>
                <select disabled={ro} className={inputCls} value={category} onChange={(e) => {
                    setCategory(e.target.value);
                    setDirty(true);
                  }}>
                  {TRAINING_CATEGORIES.map((c) => (
                    <option key={c} value={c}>
                      {CATEGORY_LABEL[c]}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          </Panel>
          <Panel title="Assessment" sub="Frozen when this version is published">
            <div className="flex flex-col">
              <Row label="Pass mark">
                <input disabled={ro} inputMode="numeric" className={cx(inputCls, "h-8 w-16 text-right")} value={def.passMarkPercent} onChange={(e) => edit((d) => ({ ...d, passMarkPercent: nNum(e.target.value, 1, 100) }))} />
                <span className="text-muted">%</span>
              </Row>
              <Row label="Questions per attempt">
                <input disabled={ro} inputMode="numeric" className={cx(inputCls, "h-8 w-16 text-right")} value={def.questionsPerAttempt ?? ""} placeholder="All" onChange={(e) => edit((d) => ({ ...d, questionsPerAttempt: e.target.value.trim() ? nNum(e.target.value, 1, 200) : null }))} />
                <span className="text-xs text-muted">of {usable}</span>
              </Row>
              <Row label="Timer">
                <input disabled={ro || def.timerMinutes == null} inputMode="numeric" className={cx(inputCls, "h-8 w-16 text-right")} value={def.timerMinutes ?? ""} onChange={(e) => edit((d) => ({ ...d, timerMinutes: nNum(e.target.value, 1, 240) }))} />
                <span className="text-muted">min</span>
                <Switch on={def.timerMinutes != null} disabled={ro} label="Timer on" onChange={(v) => edit((d) => ({ ...d, timerMinutes: v ? 15 : null }))} />
              </Row>
              <Row label="Shuffle question order">
                <Switch on={def.shuffleQuestions} disabled={ro} label="Shuffle questions" onChange={(v) => edit((d) => ({ ...d, shuffleQuestions: v }))} />
              </Row>
              <Row label="Shuffle answer options">
                <Switch on={def.shuffleOptions} disabled={ro} label="Shuffle options" onChange={(v) => edit((d) => ({ ...d, shuffleOptions: v }))} />
              </Row>
              <Row label="Study before the test">
                <input disabled={ro} inputMode="numeric" className={cx(inputCls, "h-8 w-16 text-right")} value={def.minStudyMinutes} onChange={(e) => edit((d) => ({ ...d, minStudyMinutes: nNum(e.target.value, 0, 240) }))} />
                <span className="text-muted">min</span>
              </Row>
              <div className="pt-3">
                <Label className="mb-2">Show the right answer</Label>
                <Seg label="Feedback" disabled={ro} value={def.feedback} options={[["none", "Never"], ["after_each", "After each"], ["after_submit", "After submit"]] as const} onChange={(v) => edit((d) => ({ ...d, feedback: v }))} />
              </div>
            </div>
          </Panel>
          <Panel title="Before publishing">
            <Problems items={problems} />
          </Panel>
          <Panel title="Versions" pad={false}>
            <ol className="m-0 flex list-none flex-col gap-2.5 px-5 py-3 text-[13px]">
              {versions.map((v) => (
                <li key={v.id} className="flex items-center justify-between gap-2">
                  <span>
                    <b className="font-medium text-heading">v{v.version}</b> · {fd(v.at)}
                    {v.by ? ` · ${v.by}` : ""} · pass {v.passMark}% · {v.questions} q
                  </span>
                  <Pill tone={v.status === "published" ? "success" : v.status === "draft" ? "neutral" : "muted"}>{v.status === "published" ? "Published" : v.status === "draft" ? "Draft" : "Retired"}</Pill>
                </li>
              ))}
            </ol>
            <div className="px-5 pb-4 text-xs text-muted">Publishing moves new attempts to the new version. Anybody who passed an earlier one keeps the pass.</div>
            <div className="px-5 pb-4">
              <Link href="/hire/train/questions" className="text-[13px]">
                Every module’s questions in the bank
              </Link>
            </div>
          </Panel>
        </div>
      </div>
    </>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-canvas py-2.5 text-sm text-heading">
      <span>{label}</span>
      <span className="flex items-center gap-2">{children}</span>
    </div>
  );
}

function FactsTable({ rows }: { rows: ProductFact[] | undefined }) {
  if (!rows) return <div className="text-xs text-muted">Save to see what the catalogue returns for this match.</div>;
  if (!rows.length) return <div className="text-xs text-warn-ink">No active product matches this — the learner would see an empty table.</div>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-[13px]">
        <thead>
          <tr className="border-b border-divider text-left text-[11px] font-medium tracking-[0.04em] text-muted uppercase">
            <th className="py-1.5 pr-2">Product</th>
            <th className="px-2 py-1.5">Pack</th>
            <th className="px-2 py-1.5 text-right">Per box</th>
            <th className="py-1.5 pl-2 text-right">Price</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={`${r.name}:${r.packing}`} className="border-b border-canvas">
              <td className="py-1.5 pr-2 text-heading">{r.name}</td>
              <td className="px-2 py-1.5">{[r.packSize, r.packing].filter(Boolean).join(" · ") || "—"}</td>
              <td className="px-2 py-1.5 text-right tabular-nums">{r.cansPerBox}</td>
              <td className="py-1.5 pl-2 text-right tabular-nums">{r.pricePaise != null ? inr(r.pricePaise) : "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="mt-1 text-xs text-muted">From the catalogue, today. Nothing here is typed by hand.</div>
    </div>
  );
}
