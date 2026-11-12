"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Badge, Button, Card, Field, Select, checkboxClass, cx } from "@/components/ui/primitives";
import { useToast } from "@/components/ui/toast";
import { makeBatch } from "@/lib/actions/studio";
import type { RecipientList } from "@/lib/studio/recipients";

/* ---------------------------------------------------------------------------
 * BULK: one design, one language, one greeting, up to fifty people. Anything
 * a recipient's record cannot fill is skipped with its reason on the result,
 * never silently left out. The posters are stored as recipes; drawing them is
 * what the ZIP and the poster pages do.
 * ------------------------------------------------------------------------- */

export type BulkDesignOption = {
  id: string;
  name: string;
  occasionLabel: string;
  preview: string;
  languages: { code: string; label: string }[];
  wordings: Record<string, { id: string; label: string; text: string }[]>;
  requiresProduct: boolean;
};

export type BulkRecipient = { id: string; company: string; contact: string | null; place: string; doNotContact: boolean };

export function BulkForm(props: { list: RecipientList; designs: BulkDesignOption[]; recipients: BulkRecipient[]; max: number; initialDesign: string | null }) {
  const router = useRouter();
  const toast = useToast();
  const [designId, setDesignId] = useState(props.initialDesign ?? props.designs[0]?.id ?? "");
  const design = props.designs.find((d) => d.id === designId) ?? null;
  const [language, setLanguage] = useState(design?.languages[0]?.code ?? "en");
  const wordings = design?.wordings[language] ?? [];
  const [variant, setVariant] = useState(wordings[0]?.id ?? "");
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const allOnPage = useMemo(() => props.recipients.slice(0, props.max).map((r) => r.id), [props.recipients, props.max]);

  const toggle = (id: string) =>
    setPicked((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else if (next.size < props.max) next.add(id);
      return next;
    });

  async function run() {
    if (!design) return;
    setBusy(true);
    const res = await toast.run(makeBatch({ list: props.list, templateId: design.id, language, variantId: variant || null, showProduct: true, customerIds: [...picked] }));
    setBusy(false);
    if (res.ok) router.push(`/studio/bulk/${res.data.id}`);
  }

  if (!props.designs.length) return <p className="text-sm text-muted">No approved designs for this list yet.</p>;

  return (
    <div className="grid gap-4 lg:grid-cols-[360px_minmax(0,1fr)]">
      <Card className="flex flex-col gap-3 p-4 lg:sticky lg:top-4 lg:self-start">
        <Field label="Design">
          <Select
            value={designId}
            onChange={(e) => {
              const d = props.designs.find((x) => x.id === e.target.value);
              setDesignId(e.target.value);
              const l = d?.languages[0]?.code ?? "en";
              setLanguage(l);
              setVariant(d?.wordings[l]?.[0]?.id ?? "");
            }}
          >
            {props.designs.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name} — {d.occasionLabel}
              </option>
            ))}
          </Select>
        </Field>
        {design ? (
          // eslint-disable-next-line @next/next/no-img-element -- the design's stored preview
          <img src={design.preview} alt={`Preview of ${design.name}`} className="w-full rounded-control border border-line" />
        ) : null}
        {design && design.languages.length > 1 ? (
          <Field label="Language">
            <Select
              value={language}
              onChange={(e) => {
                setLanguage(e.target.value);
                setVariant(design.wordings[e.target.value]?.[0]?.id ?? "");
              }}
            >
              {design.languages.map((l) => (
                <option key={l.code} value={l.code}>
                  {l.label}
                </option>
              ))}
            </Select>
          </Field>
        ) : null}
        {wordings.length ? (
          <Field label="Greeting" hint="The same approved greeting on every poster, with each one's own name filled in.">
            <Select value={variant} onChange={(e) => setVariant(e.target.value)}>
              {wordings.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.label}
                </option>
              ))}
            </Select>
          </Field>
        ) : null}
        {wordings.find((w) => w.id === variant) ? <p className="text-[13px] text-muted">{wordings.find((w) => w.id === variant)!.text}</p> : null}
        {design?.requiresProduct ? <p className="text-[13px] text-warn-ink">This design needs a product picture, which bulk posters cannot supply — every recipient would be skipped.</p> : null}
        <Button variant="primary" onClick={run} disabled={busy || !picked.size || !design}>
          {busy ? "Making…" : picked.size ? `Make ${picked.size} poster${picked.size === 1 ? "" : "s"}` : "Make posters"}
        </Button>
        <p className="text-[12.5px] text-muted">At most {props.max} at a time. They are drawn when you open or download them.</p>
      </Card>

      <Card>
        <div className="flex items-center justify-between border-b border-divider px-4 py-2.5">
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              className={checkboxClass}
              checked={picked.size > 0 && allOnPage.every((id) => picked.has(id))}
              onChange={(e) => setPicked(e.target.checked ? new Set(allOnPage) : new Set())}
            />
            Tick the first {Math.min(props.max, props.recipients.length)}
          </label>
          <span className="text-sm text-muted">{picked.size} ticked</span>
        </div>
        <ul className="max-h-[70vh] divide-y divide-divider overflow-y-auto">
          {props.recipients.map((r) => (
            <li key={r.id}>
              <label className={cx("flex cursor-pointer items-center gap-3 px-4 py-2", picked.has(r.id) ? "bg-brand-soft" : null)}>
                <input type="checkbox" className={checkboxClass} checked={picked.has(r.id)} onChange={() => toggle(r.id)} disabled={!picked.has(r.id) && picked.size >= props.max} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium text-ink">{r.company}</span>
                  <span className="block truncate text-[12.5px] text-muted">{[r.contact, r.place].filter(Boolean).join(" · ") || "—"}</span>
                </span>
                {r.doNotContact ? <Badge tone="danger">Do not contact</Badge> : null}
              </label>
            </li>
          ))}
        </ul>
        {!props.recipients.length ? <p className="px-4 py-6 text-sm text-muted">Nobody to list. Try a different search.</p> : null}
      </Card>
    </div>
  );
}
