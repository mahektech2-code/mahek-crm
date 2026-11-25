"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { cx } from "@/components/ui/primitives";
import { createTrackAction, publishTrackAction, saveTrackAction } from "@/lib/hire/actions/training";
import { trackProblems } from "@/lib/training/engine";
import { CATEGORY_LABEL, type TrackDefinition, type TrackItem, type TrainingCategory } from "@/lib/training/types";
import { Btn, Label, Locked, Panel, Pill } from "../../_ui/kit";
import { inputCls, Problems, Switch, useRun } from "../_shared";

type ModOpt = { key: string; title: string; category: string; published: boolean; passMark: number | null };

const CAT_TONE: Record<string, "info" | "brand" | "success" | "warn" | "neutral" | "danger"> = { product: "info", induction: "brand", sales: "success", objection: "warn", commercial: "neutral", final: "danger", other: "neutral" };

export function NewTrack() {
  const router = useRouter();
  const { pending, run } = useRun();
  const [title, setTitle] = useState("");
  const key = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);
  return (
    <div className="rounded-[6px] border border-line bg-surface p-4">
      <Label className="mb-1.5">New track</Label>
      <input className={inputCls} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Refresher — objection handling" />
      <div className="mt-1 mb-3 text-xs text-muted">Key: {key || "—"}</div>
      <Btn kind="primary" size="sm" disabled={pending || !key} title={!key ? "Give it a title first" : undefined} onClick={() => run(() => createTrackAction({ key, title }), (r) => r.ok && router.push(`/hire/train/tracks?track=${r.data.id}`))}>
        Create draft
      </Btn>
    </div>
  );
}

type AfterMode = "previous" | "none" | "pick";
const modeOf = (it: TrackItem): AfterMode => (it.after == null ? "previous" : it.after.length ? "pick" : "none");

export function TrackEditor({
  track,
  editing,
  modules,
  canAuthor,
  lockedWhy,
}: {
  track: { id: string; key: string; title: string; enrolled: number; publishedVersion: number | null };
  editing: { version: number; status: string; definition: TrackDefinition };
  modules: ModOpt[];
  canAuthor: boolean;
  lockedWhy: string;
}) {
  const { pending, run } = useRun();
  const [title, setTitle] = useState(track.title);
  const [def, setDef] = useState<TrackDefinition>(() => structuredClone(editing.definition));
  const [desig, setDesig] = useState("");
  const [add, setAdd] = useState("");
  const [dirty, setDirty] = useState(false);
  const ro = !canAuthor;
  const isDraft = editing.status === "draft";
  const published = new Set(modules.filter((m) => m.published).map((m) => m.key));
  const problems = trackProblems(def, published);
  const mod = (k: string) => modules.find((m) => m.key === k);

  const edit = (f: (d: TrackDefinition) => TrackDefinition) => {
    setDef((d) => f(structuredClone(d)));
    setDirty(true);
  };
  const setItem = (i: number, it: TrackItem) => edit((d) => ({ ...d, items: d.items.map((x, j) => (j === i ? it : x)) }));
  const move = (i: number, by: number) =>
    edit((d) => {
      const items = [...d.items];
      const j = i + by;
      if (j < 0 || j >= items.length) return d;
      [items[i], items[j]] = [items[j], items[i]];
      return { ...d, items };
    });
  const save = () => run(() => saveTrackAction(track.id, { title, definition: def }), () => setDirty(false));
  const publish = () =>
    dirty
      ? run(
          () => saveTrackAction(track.id, { title, definition: def }),
          () => {
            setDirty(false);
            run(() => publishTrackAction(track.id));
          },
        )
      : run(() => publishTrackAction(track.id));

  const unlockText = (it: TrackItem, i: number) => {
    if (it.after == null) return def.sequential ? (i === 0 ? "Start" : (mod(def.items[i - 1].moduleKey)?.title ?? def.items[i - 1].moduleKey)) : "None";
    if (!it.after.length) return "None — runs alongside";
    return it.after.map((k) => mod(k)?.title ?? k).join(", ");
  };

  return (
    <Panel
      title={
        <span className="flex items-center gap-2">
          {title} · v{editing.version}
          <Pill tone={isDraft ? "neutral" : "success"}>{isDraft ? "Draft" : "Published"}</Pill>
          {dirty ? <Pill tone="warn">Unsaved</Pill> : null}
        </span>
      }
      sub={`${track.key} · ${track.enrolled} people enrolled${track.publishedVersion ? ` · v${track.publishedVersion} is live` : ""}`}
      actions={
        canAuthor ? (
          <span className="flex gap-2">
            <Btn size="sm" disabled={pending || !dirty} title={!dirty ? "Nothing changed" : undefined} onClick={save}>
              {isDraft ? "Save draft" : `Save as draft v${editing.version + 1}`}
            </Btn>
            <Btn size="sm" kind="primary" disabled={pending || problems.length > 0} title={problems[0]} onClick={publish}>
              Publish
            </Btn>
          </span>
        ) : (
          <Locked size="sm" why={lockedWhy}>
            Edit
          </Locked>
        )
      }
      pad={false}
    >
      <div className="flex flex-wrap items-center gap-5 border-b border-divider px-5 py-3.5 text-sm text-heading">
        <label className="flex items-center gap-2">
          <Label>Title</Label>
          <input
            disabled={ro}
            className={cx(inputCls, "h-8 w-60")}
            value={title}
            onChange={(e) => {
              setTitle(e.target.value);
              setDirty(true);
            }}
          />
        </label>
        <label className="flex items-center gap-2">
          <Switch on={def.sequential} disabled={ro} label="Sequential unlock" onChange={(v) => edit((d) => ({ ...d, sequential: v }))} /> Sequential unlock
        </label>
        <label className="flex items-center gap-2">
          <span className="text-[13px] text-muted">Complete within</span>
          <input
            disabled={ro}
            inputMode="numeric"
            className={cx(inputCls, "h-8 w-16 text-right")}
            value={def.completeWithinDays ?? ""}
            placeholder="—"
            onChange={(e) => edit((d) => ({ ...d, completeWithinDays: e.target.value.trim() ? Math.max(1, Math.min(365, Math.round(Number(e.target.value)) || 1)) : null }))}
          />
          <span className="text-[13px] text-muted">days</span>
        </label>
      </div>
      <div className="flex flex-wrap items-center gap-2 border-b border-divider px-5 py-3">
        <span className="text-[13px] text-muted">Designations</span>
        {def.designations.map((d) => (
          <span key={d} className="inline-flex h-[26px] items-center gap-1.5 rounded-[13px] border border-line px-2.5 text-xs text-heading">
            {d}
            {!ro ? (
              <button type="button" aria-label={`Remove ${d}`} className="cursor-pointer border-0 bg-transparent p-0 text-muted" onClick={() => edit((x) => ({ ...x, designations: x.designations.filter((y) => y !== d) }))}>
                ×
              </button>
            ) : null}
          </span>
        ))}
        {!ro ? (
          <input
            className="h-[26px] w-44 rounded-[13px] border border-line-strong px-2.5 text-xs outline-none focus:border-brand"
            placeholder="+ designation, Enter"
            value={desig}
            onChange={(e) => setDesig(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && desig.trim()) {
                e.preventDefault();
                edit((x) => ({ ...x, designations: [...new Set([...x.designations, desig.trim()])] }));
                setDesig("");
              }
            }}
          />
        ) : null}
      </div>
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-[13px]">
          <thead>
            <tr className="border-b border-divider text-left text-[11px] font-medium tracking-[0.04em] text-muted uppercase">
              <th className="px-3 py-2.5">#</th>
              <th className="px-3 py-2.5">Module</th>
              <th className="px-3 py-2.5">Category</th>
              <th className="px-3 py-2.5">Unlocks after</th>
              <th className="px-3 py-2.5">Required</th>
              <th className="px-3 py-2.5 text-right">Pass mark</th>
              <th className="px-3 py-2.5" />
            </tr>
          </thead>
          <tbody>
            {def.items.map((it, i) => {
              const m = mod(it.moduleKey);
              const mode = modeOf(it);
              return (
                <tr key={it.moduleKey} className="border-b border-canvas align-top">
                  <td className="px-3 py-2.5 text-muted tabular-nums">{i + 1}</td>
                  <td className="px-3 py-2.5">
                    <div className="font-medium text-heading">{m?.title ?? it.moduleKey}</div>
                    {!m?.published ? <div className="text-xs text-warn-ink">No published version</div> : null}
                  </td>
                  <td className="px-3 py-2.5">{m ? <Pill tone={CAT_TONE[m.category] ?? "neutral"}>{CATEGORY_LABEL[m.category as TrainingCategory] ?? m.category}</Pill> : null}</td>
                  <td className="px-3 py-2.5">
                    {ro ? (
                      <span className="text-body">{unlockText(it, i)}</span>
                    ) : (
                      <div className="flex flex-col gap-1.5">
                        <select className={cx(inputCls, "h-8 w-52")} aria-label="Unlocks after" value={mode} onChange={(e) => setItem(i, { ...it, after: e.target.value === "previous" ? null : e.target.value === "none" ? [] : def.items.slice(0, i).slice(-1).map((x) => x.moduleKey) })}>
                          <option value="previous">{def.sequential ? "The one before" : "Nothing (not sequential)"}</option>
                          <option value="none">None — runs alongside</option>
                          <option value="pick">Specific modules…</option>
                        </select>
                        {mode === "pick" ? (
                          <div className="flex flex-wrap gap-1">
                            {def.items
                              .filter((x) => x.moduleKey !== it.moduleKey)
                              .map((x) => {
                                const on = it.after!.includes(x.moduleKey);
                                return (
                                  <button
                                    key={x.moduleKey}
                                    type="button"
                                    onClick={() => setItem(i, { ...it, after: on ? it.after!.filter((k) => k !== x.moduleKey) : [...it.after!, x.moduleKey] })}
                                    className={cx("h-6 cursor-pointer rounded-[4px] border px-1.5 text-[11px]", on ? "border-brand bg-brand-soft text-brand-hover" : "border-line bg-surface text-body")}
                                  >
                                    {mod(x.moduleKey)?.title ?? x.moduleKey}
                                  </button>
                                );
                              })}
                          </div>
                        ) : (
                          <span className="text-xs text-muted">{unlockText(it, i)}</span>
                        )}
                      </div>
                    )}
                  </td>
                  <td className="px-3 py-2.5">
                    <input type="checkbox" disabled={ro} checked={it.required} aria-label="Required" onChange={(e) => setItem(i, { ...it, required: e.target.checked })} />
                  </td>
                  <td className="px-3 py-2.5 text-right tabular-nums">{m?.passMark != null ? `${m.passMark}%` : "—"}</td>
                  <td className="px-3 py-2.5 whitespace-nowrap">
                    {!ro ? (
                      <span className="flex gap-1">
                        <Btn size="sm" kind="ghost" disabled={i === 0} title={i === 0 ? "Already first" : "Move up"} onClick={() => move(i, -1)}>
                          ↑
                        </Btn>
                        <Btn size="sm" kind="ghost" disabled={i === def.items.length - 1} title={i === def.items.length - 1 ? "Already last" : "Move down"} onClick={() => move(i, 1)}>
                          ↓
                        </Btn>
                        <Btn size="sm" kind="ghost" onClick={() => edit((d) => ({ ...d, items: d.items.filter((_, j) => j !== i).map((x) => ({ ...x, after: x.after?.filter((k) => k !== it.moduleKey) ?? null })) }))}>
                          Remove
                        </Btn>
                      </span>
                    ) : null}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {!ro ? (
        <div className="flex flex-wrap items-center gap-2 border-t border-divider px-5 py-3">
          <select className={cx(inputCls, "h-8 w-72")} aria-label="Add a module" value={add} onChange={(e) => setAdd(e.target.value)}>
            <option value="">Add a module…</option>
            {modules
              .filter((m) => !def.items.some((x) => x.moduleKey === m.key))
              .map((m) => (
                <option key={m.key} value={m.key}>
                  {m.title}
                  {m.published ? "" : " (not published)"}
                </option>
              ))}
          </select>
          <Btn
            size="sm"
            disabled={!add}
            title={!add ? "Pick a module first" : undefined}
            onClick={() => {
              edit((d) => ({ ...d, items: [...d.items, { moduleKey: add, required: true, after: null }] }));
              setAdd("");
            }}
          >
            + Add
          </Btn>
          <span className="text-xs text-muted">Changing the order or the required set makes a new version. The {track.enrolled} people enrolled stay on the version they started.</span>
        </div>
      ) : null}
      <div className="px-5 py-4">
        <Problems items={problems} />
      </div>
    </Panel>
  );
}
