"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { cx } from "@/components/ui/primitives";
import { savePlanAction } from "@/lib/hire/actions/onboarding";
import { cleanDecimal, parseRupees, rupeesFromPaise } from "@/lib/format";
import { slabLines } from "../_onboard/letter";
import { Btn, Callout, Label, Locked, Panel, Pill, fd } from "../_ui/kit";
import { areaCls, inputCls, Seg, useRun } from "../train/_shared";

type Slab = { fromPaise: number; toPaise: number | null; kind: "percent" | "fixed"; value: number };
type Editing = { version: number; status: string; title: string; designations: string[]; basis: string; mode: "whole" | "marginal"; slabs: Slab[]; conditions: string; effectiveFrom: string | null; publishedAt: string | null };
type Row = { from: string; to: string; kind: "percent" | "fixed"; value: string };

const toRows = (slabs: Slab[]): Row[] => slabs.map((s) => ({ from: rupeesFromPaise(s.fromPaise), to: s.toPaise == null ? "" : rupeesFromPaise(s.toPaise), kind: s.kind, value: s.kind === "fixed" ? rupeesFromPaise(s.value) : String(s.value) }));

export function PlanEditor({ planKey, editing, publishedVersion, offers, canEdit, lockedWhy }: { planKey: string | null; editing: Editing | null; publishedVersion: number | null; offers: number; canEdit: boolean; lockedWhy?: string }) {
  const router = useRouter();
  const { pending, run } = useRun();
  const [title, setTitle] = useState(editing?.title ?? "");
  const [key, setKey] = useState(planKey ?? "");
  const [desigs, setDesigs] = useState<string[]>(editing?.designations ?? []);
  const [desig, setDesig] = useState("");
  const [basis, setBasis] = useState(editing?.basis ?? "Monthly invoiced sales, net of returns");
  const [mode, setMode] = useState<"whole" | "marginal">(editing?.mode ?? "whole");
  const [rows, setRows] = useState<Row[]>(() => (editing?.slabs.length ? toRows(editing.slabs) : [{ from: "0", to: "", kind: "percent", value: "0" }]));
  const [conditions, setConditions] = useState(editing?.conditions ?? "");
  const [effective, setEffective] = useState(editing?.effectiveFrom ?? "");
  const ro = !canEdit;
  const isDraft = !editing || editing.status === "draft";
  const slug = planKey ?? (key || title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60));

  /* Rupees typed, paise sent. A blank "to" is the open-ended top slab. */
  const slabs: Slab[] = rows.map((r) => ({ fromPaise: parseRupees(r.from || "0") ?? 0, toPaise: r.to.trim() ? parseRupees(r.to) : null, kind: r.kind, value: r.kind === "fixed" ? (parseRupees(r.value || "0") ?? 0) : Number(r.value || 0) }));
  const setRow = (i: number, patch: Partial<Row>) => setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const input = { title, designations: desigs, basis, mode, slabs, conditions, effectiveFrom: effective || null };
  const save = (publish: boolean) => run(() => savePlanAction(slug, input, publish), () => !planKey && router.push(`/hire/incentive-plans?plan=${slug}`));

  return (
    <Panel
      title={editing ? <span className="flex items-center gap-2">{title || editing.title}<Pill tone={isDraft ? "neutral" : "success"}>{isDraft ? `Draft v${editing.version}` : `Published v${editing.version}`}</Pill></span> : "New plan"}
      sub={editing ? (isDraft ? `${publishedVersion ? `v${publishedVersion} is live · ` : ""}editing the draft` : `Published ${fd(editing.publishedAt)} · the first change saves as draft v${editing.version + 1}`) : "Starts as a draft"}
      actions={
        canEdit ? (
          <span className="flex gap-2">
            <Btn size="sm" disabled={pending || !slug || !title.trim()} title={!title.trim() ? "Give it a title" : undefined} onClick={() => save(false)}>
              Save draft
            </Btn>
            <Btn size="sm" kind="primary" disabled={pending || !slug || !title.trim()} title={!title.trim() ? "Give it a title" : undefined} onClick={() => save(true)}>
              Publish
            </Btn>
          </span>
        ) : (
          <Locked size="sm" why={lockedWhy ?? ""}>
            Edit
          </Locked>
        )
      }
    >
      <div className="flex flex-col gap-5">
        <div className="grid grid-cols-2 gap-3.5">
          <label>
            <Label className="mb-1.5">Title</Label>
            <input disabled={ro} className={inputCls} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Sales Executive · monthly slabs" />
          </label>
          <label>
            <Label className="mb-1.5">Key</Label>
            <input disabled={ro || Boolean(planKey)} className={inputCls} value={slug} onChange={(e) => setKey(e.target.value.toLowerCase())} />
            <span className="mt-1 block text-xs text-muted">Blueprints name a plan by this.</span>
          </label>
          <div className="col-span-2">
            <Label className="mb-1.5">Designations</Label>
            <div className="flex flex-wrap items-center gap-1.5">
              {desigs.map((d) => (
                <span key={d} className="inline-flex h-[26px] items-center gap-1.5 rounded-[13px] border border-line px-2.5 text-xs text-heading">
                  {d}
                  {!ro ? (
                    <button type="button" aria-label={`Remove ${d}`} className="cursor-pointer border-0 bg-transparent p-0 text-muted" onClick={() => setDesigs((x) => x.filter((y) => y !== d))}>
                      ×
                    </button>
                  ) : null}
                </span>
              ))}
              {!ro ? (
                <input
                  className="h-[26px] w-48 rounded-[13px] border border-line-strong px-2.5 text-xs outline-none focus:border-brand"
                  placeholder="+ designation, Enter"
                  value={desig}
                  onChange={(e) => setDesig(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && desig.trim()) {
                      e.preventDefault();
                      setDesigs((x) => [...new Set([...x, desig.trim()])]);
                      setDesig("");
                    }
                  }}
                />
              ) : null}
            </div>
          </div>
          <label>
            <Label className="mb-1.5">Measured on</Label>
            <input disabled={ro} className={inputCls} value={basis} onChange={(e) => setBasis(e.target.value)} />
          </label>
          <label>
            <Label className="mb-1.5">Effective from</Label>
            <input disabled={ro} type="date" className={inputCls} value={effective} onChange={(e) => setEffective(e.target.value)} />
          </label>
          <div className="col-span-2">
            <Label className="mb-1.5">How slabs apply</Label>
            <Seg label="How slabs apply" disabled={ro} value={mode} options={[["whole", "Whole month at the slab reached"], ["marginal", "Each slab on the sales within it"]] as const} onChange={setMode} />
          </div>
        </div>

        <div>
          <div className="mb-2 flex items-center justify-between">
            <Label>Slabs</Label>
            {!ro ? (
              <Btn
                size="sm"
                kind="ghost"
                onClick={() => setRows((rs) => [...rs, { from: rs[rs.length - 1]?.to ?? "", to: "", kind: "percent", value: "" }])}
              >
                + Add slab
              </Btn>
            ) : null}
          </div>
          <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_130px_130px_30px] items-center gap-2">
            <span className="text-xs text-muted">From · ₹</span>
            <span className="text-xs text-muted">To · ₹ (blank: and above)</span>
            <span className="text-xs text-muted">Incentive</span>
            <span className="text-xs text-muted">Kind</span>
            <span />
            {rows.map((r, i) => (
              <Slab key={i} r={r} ro={ro} onChange={(p) => setRow(i, p)} onRemove={rows.length > 1 ? () => setRows((rs) => rs.filter((_, j) => j !== i)) : undefined} />
            ))}
          </div>
          <div className="mt-2 rounded-[4px] bg-page px-3 py-2 text-[13px] leading-5 text-body">
            <span className="text-xs font-medium tracking-[0.04em] text-muted uppercase">The offer letter prints</span>
            {slabLines({ slabs }).map((l) => (
              <div key={l}>· {l}</div>
            ))}
          </div>
        </div>

        <label>
          <Label className="mb-1.5">Conditions · printed on the offer</Label>
          <textarea disabled={ro} className={cx(areaCls, "h-[72px] resize-y")} value={conditions} onChange={(e) => setConditions(e.target.value)} placeholder="When it is paid, and what disqualifies a month." />
        </label>
        {offers ? <Callout tone="warn">{offers} accepted offer{offers === 1 ? " is" : "s are"} on this plan’s published version and stay on it. Offers made after you publish use the new version.</Callout> : null}
      </div>
    </Panel>
  );
}

function Slab({ r, ro, onChange, onRemove }: { r: Row; ro: boolean; onChange: (p: Partial<Row>) => void; onRemove?: () => void }) {
  return (
    <>
      <input disabled={ro} inputMode="decimal" className={cx(inputCls, "tabular-nums")} value={r.from} aria-label="From" onChange={(e) => onChange({ from: cleanDecimal(e.target.value) })} />
      <input disabled={ro} inputMode="decimal" className={cx(inputCls, "tabular-nums")} value={r.to} placeholder="and above" aria-label="To" onChange={(e) => onChange({ to: cleanDecimal(e.target.value) })} />
      <input disabled={ro} inputMode="decimal" className={cx(inputCls, "tabular-nums")} value={r.value} aria-label="Incentive" onChange={(e) => onChange({ value: cleanDecimal(e.target.value) })} />
      <select disabled={ro} className={inputCls} value={r.kind} aria-label="Kind" onChange={(e) => onChange({ kind: e.target.value === "fixed" ? "fixed" : "percent" })}>
        <option value="percent">% of sales</option>
        <option value="fixed">Fixed ₹</option>
      </select>
      {onRemove && !ro ? (
        <button type="button" aria-label="Remove slab" className="h-[30px] w-[30px] cursor-pointer rounded-[4px] border-0 bg-transparent text-muted hover:text-danger" onClick={onRemove}>
          ×
        </button>
      ) : (
        <span />
      )}
    </>
  );
}
