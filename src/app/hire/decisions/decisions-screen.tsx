"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { cx } from "@/components/ui/primitives";
import { useToast } from "@/components/ui/toast";
import type { GateRow, ProposalRow } from "@/lib/hire/services/decisions";
import { confirmProposedRejection, dismissProposal } from "@/lib/hire/actions/decisions";
import { AiMark, Btn, BtnLink, Callout, Empty, Icon, Locked, Pill, fd, fdt, hs } from "../_ui/kit";
import { ReasonDialog, RejectionMessageDialog } from "./dialogs";

export type RecentDecision = {
  id: string;
  applicationId: string;
  name: string;
  roleTitle: string;
  decision: string;
  reasoning: string;
  point: string;
  at: string;
  by: string;
  agreed: boolean | null;
};

type Tab = "gate" | "reject" | "recent";

const DECISION_LABEL: Record<string, string> = { advance: "Advanced", reject: "Rejected", hold: "Held", hire: "Hired", revise_offer: "Offer revised", resume: "Resumed", withdraw: "Withdrawn" };

export function DecisionsScreen({
  initialTab,
  gates,
  proposals,
  recent,
  languages,
  canDecide,
  canConfirm,
  decideWhy,
  confirmWhy,
}: {
  initialTab: Tab;
  gates: GateRow[];
  proposals: ProposalRow[];
  recent: RecentDecision[];
  languages: string[];
  canDecide: boolean;
  canConfirm: boolean;
  decideWhy: string;
  confirmWhy: string;
}) {
  const router = useRouter();
  const toast = useToast();
  const [tab, setTab] = useState<Tab>(initialTab);
  const [q, setQ] = useState("");
  const [dialog, setDialog] = useState<{ kind: "confirm" | "dismiss"; p: ProposalRow } | null>(null);
  const [compose, setCompose] = useState<{ applicationId: string; name: string } | null>(null);

  const term = q.trim().toLowerCase();
  const match = (name: string, role: string) => !term || name.toLowerCase().includes(term) || role.toLowerCase().includes(term);
  const g = gates.filter((r) => match(r.name, r.roleTitle));
  const p = proposals.filter((r) => match(r.name, r.roleTitle));
  const rc = recent.filter((r) => match(r.name, r.roleTitle));

  const tabs: [Tab, string, number][] = [
    ["gate", "At a decision gate", gates.length],
    ["reject", "Proposed rejections", proposals.length],
    ["recent", "Recorded", recent.length],
  ];
  const shown = tab === "gate" ? g.length : tab === "reject" ? p.length : rc.length;
  const total = tab === "gate" ? gates.length : tab === "reject" ? proposals.length : recent.length;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex gap-6 border-b border-line" role="tablist">
        {tabs.map(([k, l, n]) => (
          <button
            key={k}
            role="tab"
            aria-selected={tab === k}
            onClick={() => setTab(k)}
            className={cx("-mb-px flex h-10 cursor-pointer items-center gap-2 border-0 border-b-2 bg-transparent px-0 text-sm", tab === k ? "border-brand font-medium text-heading" : "border-transparent text-muted hover:text-body")}
          >
            {l}
            {n ? <span className={cx("rounded-[9px] px-1.5 text-[11px] leading-[18px] font-semibold tabular-nums", k === "reject" && proposals.some((x) => x.overdue) ? "bg-danger-soft text-danger" : "bg-warn-soft text-warn-ink")}>{n}</span> : null}
          </button>
        ))}
      </div>

      <div className="flex items-center gap-2">
        <span className="relative w-[260px] flex-none">
          <Icon n="search" s={16} className="pointer-events-none absolute top-[9px] left-2.5 text-muted" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search by name or role" className="h-[34px] w-full rounded-[4px] border border-line-strong bg-surface pr-2.5 pl-8 text-sm outline-none focus:border-brand" />
        </span>
        <span className="text-[13px] text-muted">{term ? `${shown} of ${total}` : `${total} ${tab === "recent" ? "recorded recently" : "waiting"}`}</span>
      </div>

      {tab === "gate" ? (
        g.length ? (
          g.map((r) => (
            <div key={r.id} className={cx("flex items-center gap-5 rounded-[6px] border border-line bg-surface px-5 py-4", r.hoursWaiting > r.slaHours ? "shadow-[inset_3px_0_0_var(--color-warn)]" : "")}>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <Link href={`/hire/c/${r.id}`} className="text-[15px] font-semibold text-heading no-underline hover:underline">
                    {r.name}
                  </Link>
                  <Pill tone="brand">At the gate</Pill>
                  {r.flags ? <Pill tone="warn">{r.flags} to ask about</Pill> : null}
                </div>
                <div className="mt-0.5 text-[13px] text-muted">
                  {r.code} · {r.roleTitle} v{r.version}
                  {r.location ? ` · ${r.location}` : ""} · waiting {hs(r.hoursWaiting)}
                  {r.hoursWaiting > r.slaHours ? <span className="text-warn-ink"> · past the {r.slaHours}h target</span> : null}
                </div>
                {r.scores.length ? <div className="mt-1.5 text-[13px] text-body tabular-nums">{r.scores.map((s) => `${s.name} ${s.final}`).join(" · ")}</div> : null}
                {r.rec ? (
                  <div className="mt-1.5 text-[13px] text-ai">
                    <AiMark /> Recommends {r.rec.action.toLowerCase()} · {r.rec.confidence} confidence
                  </div>
                ) : null}
              </div>
              {r.overall != null ? (
                <div className="flex-none text-right">
                  <div className="text-2xl leading-[30px] font-semibold text-heading tabular-nums">{r.overall}</div>
                  <div className="text-xs text-muted">average stage score</div>
                </div>
              ) : null}
              <div className="flex flex-none gap-2">
                {canDecide ? (
                  <BtnLink href={`/hire/gate/${r.id}`} kind="primary" size="sm">
                    Open the decision gate
                  </BtnLink>
                ) : (
                  <>
                    <BtnLink href={`/hire/gate/${r.id}`} size="sm">
                      Read the case
                    </BtnLink>
                    <Locked size="sm" why={decideWhy}>
                      Decide
                    </Locked>
                  </>
                )}
              </div>
            </div>
          ))
        ) : (
          <Empty title={term ? "Nobody at a gate matches that." : "Nobody is waiting at a decision gate."}>Candidates arrive here when they pass the stage before a gate.</Empty>
        )
      ) : null}

      {tab === "reject" ? (
        p.length ? (
          p.map((r) => (
            <div key={r.id} className={cx("flex items-start gap-5 rounded-[6px] border border-line bg-surface px-5 py-4", r.overdue ? "shadow-[inset_3px_0_0_var(--color-danger)]" : "shadow-[inset_3px_0_0_var(--color-warn)]")}>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <Link href={`/hire/c/${r.applicationId}`} className="text-[15px] font-semibold text-heading no-underline hover:underline">
                    {r.name}
                  </Link>
                  <Pill tone="warn">Rejection proposed</Pill>
                  <Pill tone={r.overdue ? "danger" : "warn"}>{r.overdue ? `Window closed ${fd(r.windowEndsAt)}` : `Confirm by ${fd(r.windowEndsAt)}`}</Pill>
                </div>
                <div className="mt-0.5 text-[13px] text-muted">
                  {r.code} · {r.roleTitle} · {r.stageName} · {r.reasonLabel} · proposed by {r.proposedBy}, {fdt(r.proposedAt)}
                </div>
                {r.note ? <div className="mt-2 max-w-[760px] text-[13px] leading-[19px] text-body">{r.note}</div> : null}
                <div className="mt-2 text-[12px] text-muted">Nothing is rejected until a named person confirms it. Until then the candidate stays where they are.</div>
              </div>
              {r.score != null ? (
                <div className="flex-none text-right">
                  <div className="text-2xl leading-[30px] font-semibold text-heading tabular-nums">{Math.round(r.score)}</div>
                  <div className="text-xs text-muted">against a pass mark of {r.pass ?? "—"}</div>
                </div>
              ) : null}
              <div className="flex flex-none gap-2">
                {canConfirm ? (
                  <>
                    <Btn size="sm" onClick={() => setDialog({ kind: "dismiss", p: r })}>
                      Keep them in
                    </Btn>
                    <Btn size="sm" kind="danger" onClick={() => setDialog({ kind: "confirm", p: r })}>
                      Confirm rejection
                    </Btn>
                  </>
                ) : (
                  <Locked size="sm" why={confirmWhy}>
                    Confirm rejection
                  </Locked>
                )}
              </div>
            </div>
          ))
        ) : (
          <Empty title={term ? "No proposed rejection matches that." : "No rejections are waiting for a decision."}>A score below a stage’s floor proposes a rejection here. It waits for a named person.</Empty>
        )
      ) : null}

      {tab === "recent" ? (
        rc.length ? (
          <div className="overflow-hidden rounded-[6px] border border-line bg-surface">
            {rc.map((r) => (
              <div key={r.id} className="flex items-start gap-4 border-t border-divider px-5 py-3 first:border-t-0">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <Link href={`/hire/c/${r.applicationId}`} className="text-sm font-medium text-heading no-underline hover:underline">
                      {r.name}
                    </Link>
                    <Pill tone={r.decision === "reject" ? "muted" : r.decision === "hold" ? "warn" : "success"}>{DECISION_LABEL[r.decision] ?? r.decision}</Pill>
                    {r.agreed === false ? <Pill tone="neutral">Disagreed with the AI</Pill> : null}
                  </div>
                  <div className="mt-0.5 text-[13px] text-body">“{r.reasoning}”</div>
                  <div className="mt-0.5 text-[12px] text-muted">
                    {r.roleTitle} · {r.point === "decision_gate" ? "Decision gate" : "Rejection queue"} · {r.by} · {fdt(r.at)}
                  </div>
                </div>
                {r.decision === "reject" && canConfirm ? (
                  <Btn size="sm" onClick={() => setCompose({ applicationId: r.applicationId, name: r.name })}>
                    Write to them
                  </Btn>
                ) : null}
              </div>
            ))}
          </div>
        ) : (
          <Empty title="No decisions recorded yet." />
        )
      ) : null}

      {dialog ? (
        <ReasonDialog
          key={dialog.p.id + dialog.kind}
          title={dialog.kind === "confirm" ? `Confirm the rejection of ${dialog.p.name}` : `Keep ${dialog.p.name} in the pipeline`}
          sub={
            dialog.kind === "confirm"
              ? `${dialog.p.stageName}${dialog.p.score != null ? ` · ${Math.round(dialog.p.score)} against ${dialog.p.pass}` : ""} · ${dialog.p.reasonLabel}. Your name and reasoning go on the record.`
              : "The proposal is dismissed and the candidate stays at their stage. Say why — it is kept with the proposal."
          }
          danger={dialog.kind === "confirm"}
          okLabel={dialog.kind === "confirm" ? "Confirm rejection" : "Keep them in"}
          placeholder={dialog.kind === "confirm" ? "What in the evidence decides this. It stays on the record." : "Why this candidate should continue despite the score."}
          onClose={() => setDialog(null)}
          onSubmit={async (reasoning) => {
            const d = dialog;
            const res = d.kind === "confirm" ? await confirmProposedRejection(d.p.id, reasoning) : await dismissProposal(d.p.id, reasoning);
            if (!res.ok) return res.error;
            toast.push(res.message ?? "Done.");
            setDialog(null);
            if (d.kind === "confirm") setCompose({ applicationId: d.p.applicationId, name: d.p.name });
            router.refresh();
            return null;
          }}
        />
      ) : null}
      {compose ? <RejectionMessageDialog key={compose.applicationId} applicationId={compose.applicationId} name={compose.name} languages={languages} onClose={() => setCompose(null)} /> : null}
      {!canConfirm && tab === "reject" && proposals.length ? <Callout tone="muted">{confirmWhy}</Callout> : null}
    </div>
  );
}
