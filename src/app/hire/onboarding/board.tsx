"use client";

import { CardGrid } from "@/components/ui/card-grid";
import { useState } from "react";
import Link from "next/link";
import { cx } from "@/components/ui/primitives";
import { BOARD_COLUMNS, ONBOARDING_LABEL, type OnboardingStatus } from "@/lib/hire/engines/onboarding";
import { Empty, Label, Pill, Stat, type Tone } from "../_ui/kit";

export type BoardCard = {
  id: string;
  name: string;
  role: string;
  location: string | null;
  status: OnboardingStatus;
  statusLabel: string;
  line: string;
  late: boolean;
  days: number;
  href: string;
  recordHref: string;
  owner: string | null;
  completedThisMonth: boolean;
  approvalPending: boolean;
  retraining: number;
};

const TONE: Partial<Record<OnboardingStatus, Tone>> = {
  compensation_discussion: "neutral",
  awaiting_acceptance: "info",
  document_collection: "warn",
  verification: "info",
  employment_documents: "warn",
  courier_pending: "warn",
  ready_to_provision: "brand",
  assets_pending: "success",
  training: "info",
  training_completed: "success",
  onboarding_completed: "success",
  on_hold: "warn",
};

const selectCls = "h-9 rounded-[4px] border border-line-strong bg-surface px-2.5 text-sm text-heading outline-none focus:border-brand";

const initials = (n: string | null) =>
  n
    ? n
        .split(/\s+/)
        .map((w) => w[0])
        .join("")
        .slice(0, 2)
        .toUpperCase()
    : "—";

export function OnboardingBoard({ cards }: { cards: BoardCard[] }) {
  const [view, setView] = useState<"board" | "table">("board");
  const [role, setRole] = useState("");
  const [place, setPlace] = useState("");
  const roles = [...new Set(cards.map((c) => c.role))].sort();
  const places = [...new Set(cards.map((c) => c.location).filter((x): x is string => Boolean(x)))].sort();
  const shown = cards.filter((c) => (!role || c.role === role) && (!place || c.location === place));
  const n = (f: (c: BoardCard) => boolean) => shown.filter(f).length;
  const docs = n((c) => c.status === "document_collection" || c.status === "verification");
  const emp = n((c) => c.status === "employment_documents" || c.status === "courier_pending");
  const training = shown.filter((c) => c.status === "training");

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-end gap-2">
        <label className="flex flex-col gap-1">
          <Label>Role</Label>
          <select value={role} onChange={(e) => setRole(e.target.value)} className={selectCls}>
            <option value="">All roles</option>
            {roles.map((r) => (
              <option key={r}>{r}</option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <Label>Location</Label>
          <select value={place} onChange={(e) => setPlace(e.target.value)} className={selectCls}>
            <option value="">All locations</option>
            {places.map((p) => (
              <option key={p}>{p}</option>
            ))}
          </select>
        </label>
        <span className="flex-1" />
        <span role="group" aria-label="View" className="inline-flex gap-0.5 rounded-[6px] border border-line bg-surface p-[3px]">
          {(["board", "table"] as const).map((v) => (
            <button key={v} onClick={() => setView(v)} className={cx("h-7 cursor-pointer rounded-[4px] border-0 px-3 text-xs font-medium capitalize", view === v ? "bg-heading text-white" : "bg-transparent text-body")}>
              {v}
            </button>
          ))}
        </span>
      </div>

      <CardGrid min={170} gap="gap-3">
        <Stat label="Awaiting acceptance" value={n((c) => c.status === "awaiting_acceptance")} sub={`${n((c) => c.approvalPending)} approval pending`} />
        <Stat label="Documents & verification" value={docs} sub={`${n((c) => (c.status === "document_collection" || c.status === "verification") && c.late)} chased`} tone={n((c) => (c.status === "document_collection" || c.status === "verification") && c.late) ? "warn" : undefined} />
        <Stat label="Employment docs & courier" value={emp} sub={`${n((c) => (c.status === "employment_documents" || c.status === "courier_pending") && c.late)} late`} tone={n((c) => c.status === "courier_pending" && c.late) ? "danger" : undefined} />
        <Stat label="Assets pending" value={n((c) => c.status === "assets_pending")} />
        <Stat label="In training" value={training.length} sub={`${training.filter((c) => c.retraining > 0).length} retraining`} tone={training.some((c) => c.retraining > 0) ? "warn" : undefined} />
        <Stat label="Completed this month" value={n((c) => c.completedThisMonth)} tone="success" />
      </CardGrid>

      {!shown.length ? (
        <Empty title="Nobody is onboarding">People appear here once a decision gate advances them.</Empty>
      ) : view === "board" ? (
        <div className="overflow-x-auto pb-2">
          <div className="flex min-w-max items-start gap-3">
            {BOARD_COLUMNS.map((col) => {
              const list = shown.filter((c) => c.status === col).sort((a, b) => Number(b.late) - Number(a.late) || b.days - a.days);
              return (
                <section key={col} className="w-[248px] flex-none rounded-[6px] border border-divider bg-canvas">
                  <header className="flex items-center gap-2 border-b border-divider px-3 py-2.5">
                    <span className="flex-1 text-[13px] font-semibold text-heading">{ONBOARDING_LABEL[col]}</span>
                    <Pill>{list.length}</Pill>
                  </header>
                  <div className="flex flex-col gap-2 p-2">
                    {list.map((c) => (
                      <Link key={c.id} href={c.href} className="block rounded-[6px] border border-line bg-surface px-3 py-2.5 no-underline hover:border-line-strong hover:no-underline">
                        <div className="flex items-center gap-2">
                          <span className="flex-1 truncate text-sm font-medium text-heading">{c.name}</span>
                          <span className={cx("text-xs tabular-nums", c.late ? "font-semibold text-danger" : "text-muted")} title={c.late ? "Past its window" : "Days at this point"}>
                            {c.days}d
                          </span>
                        </div>
                        <div className="truncate text-xs text-muted">
                          {c.role} · {c.location ?? "—"}
                        </div>
                        <div className="mt-2 text-xs leading-[17px] text-body">{c.line}</div>
                        <div className="mt-2 flex items-center justify-between">
                          <Pill tone={c.late ? "danger" : (TONE[c.status] ?? "neutral")}>{c.late ? "Late" : c.statusLabel}</Pill>
                          <span title={c.owner ? `Recruiter: ${c.owner}` : "No recruiter"} className="flex h-[22px] w-[22px] items-center justify-center rounded-full bg-divider text-[10px] font-semibold text-body">
                            {initials(c.owner)}
                          </span>
                        </div>
                      </Link>
                    ))}
                    {!list.length ? <div className="px-1 py-2 text-xs text-muted">Nobody here.</div> : null}
                  </div>
                </section>
              );
            })}
          </div>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-[6px] border border-line bg-surface">
          <table className="w-full border-collapse text-[13px]">
            <thead>
              <tr className="border-b border-divider text-left text-[11px] tracking-[0.04em] text-muted uppercase">
                <th className="px-3 py-2.5 font-medium">Name</th>
                <th className="px-3 py-2.5 font-medium">Role · location</th>
                <th className="px-3 py-2.5 font-medium">Status</th>
                <th className="px-3 py-2.5 font-medium">Where it is</th>
                <th className="px-3 py-2.5 text-right font-medium">Days</th>
                <th className="px-3 py-2.5 font-medium">Recruiter</th>
              </tr>
            </thead>
            <tbody>
              {shown
                .slice()
                .sort((a, b) => BOARD_COLUMNS.indexOf(a.status) - BOARD_COLUMNS.indexOf(b.status))
                .map((c) => (
                  <tr key={c.id} className="border-b border-canvas last:border-b-0">
                    <td className="px-3 py-2.5">
                      <Link href={c.recordHref} className="font-medium text-heading">
                        {c.name}
                      </Link>
                    </td>
                    <td className="px-3 py-2.5 text-muted">
                      {c.role} · {c.location ?? "—"}
                    </td>
                    <td className="px-3 py-2.5">
                      <Pill tone={c.late ? "danger" : (TONE[c.status] ?? "neutral")}>{c.statusLabel}</Pill>
                    </td>
                    <td className="px-3 py-2.5">
                      <Link href={c.href}>{c.line}</Link>
                    </td>
                    <td className={cx("px-3 py-2.5 text-right tabular-nums", c.late ? "font-semibold text-danger" : "text-body")}>{c.days}</td>
                    <td className="px-3 py-2.5 text-body">{c.owner ?? "—"}</td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
