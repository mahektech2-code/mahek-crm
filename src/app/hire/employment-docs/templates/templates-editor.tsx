"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { cx } from "@/components/ui/primitives";
import { useToast } from "@/components/ui/toast";
import { saveTemplateAction } from "@/lib/hire/actions/onboarding";
import { Btn, Empty, Label, Locked, Panel, Pill } from "../../_ui/kit";

export type TemplateGroup = { key: string; title: string; body: string; editingVersion: number | null; publishedVersion: number | null; versions: number };

const inputCls = "w-full rounded-[4px] border border-line-strong bg-surface px-2.5 text-sm text-heading outline-none focus:border-brand";

function Editor({ g, fields, canEdit, editWhy }: { g: TemplateGroup; fields: { key: string; label: string }[]; canEdit: boolean; editWhy: string }) {
  const router = useRouter();
  const toast = useToast();
  const [pending, start] = useTransition();
  const [title, setTitle] = useState(g.title);
  const [body, setBody] = useState(g.body);
  const save = (publish: boolean) =>
    start(async () => {
      const r = await saveTemplateAction(g.key, { title, body }, publish);
      toast.push(r.ok ? (r.message ?? "Saved.") : r.error, r.ok ? "info" : "error");
      if (r.ok) router.refresh();
    });
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_260px] items-start gap-4">
      <Panel
        title={g.title}
        sub={g.editingVersion ? `Editing draft v${g.editingVersion}${g.publishedVersion ? ` · v${g.publishedVersion} is published` : ""}` : g.publishedVersion ? `v${g.publishedVersion} is published — saving makes v${g.versions + 1}` : "Not published yet"}
        actions={canEdit ? (
          <>
            <Btn size="sm" disabled={pending} onClick={() => save(false)}>
              Save draft
            </Btn>
            <Btn size="sm" kind="primary" disabled={pending} onClick={() => save(true)}>
              Publish
            </Btn>
          </>
        ) : (
          <Locked size="sm" why={editWhy}>
            Edit
          </Locked>
        )}
      >
        <label className="mb-3 block">
          <Label className="mb-1.5">Title</Label>
          <input disabled={!canEdit} value={title} onChange={(e) => setTitle(e.target.value)} className={cx(inputCls, "h-9")} />
        </label>
        <label className="block">
          <Label className="mb-1.5">Body</Label>
          <textarea disabled={!canEdit} value={body} onChange={(e) => setBody(e.target.value)} rows={22} className={cx(inputCls, "py-2 font-[family-name:var(--font-evidence)] text-[14px] leading-6")} />
        </label>
        <div className="mt-2 text-xs text-muted">Anything in [square brackets] is wording the owner of the document still has to supply. An unknown placeholder is refused on save.</div>
      </Panel>
      <Panel title="Placeholders" sub="Filled from the accepted offer">
        <ul className="m-0 flex list-none flex-col gap-2 p-0">
          {fields.map((f) => (
            <li key={f.key} className="text-[13px]">
              <code className="rounded-[3px] bg-canvas px-1 py-0.5 text-[12px] text-heading">{`{{${f.key}}}`}</code>
              <span className="block text-xs text-muted">{f.label}</span>
            </li>
          ))}
        </ul>
      </Panel>
    </div>
  );
}

export function TemplatesEditor({ groups, fields, initialKey, canEdit, editWhy }: { groups: TemplateGroup[]; fields: { key: string; label: string }[]; initialKey: string | null; canEdit: boolean; editWhy: string }) {
  const [key, setKey] = useState(initialKey);
  const g = groups.find((x) => x.key === key) ?? null;
  if (!groups.length) return <Empty title="No templates yet">Templates are put in when Hire is installed. Run the install step (`npm run hire:deploy`).</Empty>;
  return (
    <div className="grid grid-cols-[240px_minmax(0,1fr)] items-start gap-5">
      <div className="overflow-hidden rounded-[6px] border border-line bg-surface">
        <div className="border-b border-divider px-3.5 py-2.5 text-xs font-medium tracking-[0.04em] text-muted uppercase">Templates · {groups.length}</div>
        {groups.map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => setKey(t.key)}
            className={cx("flex w-full cursor-pointer items-center gap-2 border-0 border-t border-canvas bg-transparent px-3.5 py-2.5 text-left first:border-t-0 hover:bg-canvas", key === t.key ? "bg-brand-soft shadow-[inset_3px_0_0_var(--color-brand)]" : "")}
          >
            <span className="min-w-0 flex-1 truncate text-sm font-medium text-heading">{t.title}</span>
            <Pill tone={t.publishedVersion ? "success" : "neutral"}>{t.publishedVersion ? `v${t.publishedVersion}` : "Draft"}</Pill>
          </button>
        ))}
      </div>
      {g ? <Editor key={`${g.key}:${g.editingVersion ?? ""}:${g.publishedVersion ?? ""}`} g={g} fields={fields} canEdit={canEdit} editWhy={editWhy} /> : null}
    </div>
  );
}
