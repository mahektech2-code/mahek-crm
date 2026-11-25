import type { Metadata } from "next";
import Link from "next/link";
import { cx } from "@/components/ui/primitives";
import { requireHireScreen } from "@/lib/hire/access";
import { lockedWhy } from "@/lib/hire/roles";
import { listIncentivePlans } from "@/lib/hire/services/onboarding-records";
import { Empty, PageHead, Pill } from "../_ui/kit";
import { PlanEditor } from "./plan-editor";

export const metadata: Metadata = { title: "Incentive plans" };
export const dynamic = "force-dynamic";

/** PRD §6 — incentive slabs by designation, versioned. An offer keeps the version it was made under. */
export default async function IncentivePlansPage({ searchParams }: { searchParams: Promise<{ plan?: string; new?: string }> }) {
  const ctx = await requireHireScreen("incentives");
  const sp = await searchParams;
  const plans = await listIncentivePlans();
  const creating = sp.new === "1";
  const sel = creating ? null : (plans.find((p) => p.key === sp.plan) ?? plans[0] ?? null);
  const editing = sel ? (sel.draft ?? sel.published ?? sel.versions[0]) : null;
  const canEdit = ctx.can("incentivePlans");
  return (
    <>
      <PageHead
        title="Incentive plans"
        sub="Incentive slabs by designation, set by the Sales Head. A plan is versioned: an offer keeps the version it was made under, and changing the slabs is a new version from its own day."
        actions={
          canEdit ? (
            <Link href="/hire/incentive-plans?new=1" className="inline-flex h-9 items-center rounded-[4px] bg-brand px-3.5 text-sm font-medium text-white no-underline hover:bg-brand-hover hover:no-underline">
              + New plan
            </Link>
          ) : null
        }
      />
      <div className="grid grid-cols-[300px_minmax(0,1fr)] items-start gap-5">
        <div className="overflow-hidden rounded-[6px] border border-line bg-surface">
          <div className="border-b border-divider px-3.5 py-2.5 text-xs font-medium tracking-[0.04em] text-muted uppercase">Plans · {plans.length}</div>
          {!plans.length ? <div className="px-3.5 py-4 text-[13px] text-muted">None yet. A role with no plan says “Incentive: Not applicable”.</div> : null}
          {plans.map((p) => {
            const v = p.published ?? p.draft ?? p.versions[0];
            return (
              <Link
                key={p.key}
                href={`/hire/incentive-plans?plan=${p.key}`}
                scroll={false}
                className={cx("flex items-center gap-2.5 border-t border-canvas px-3.5 py-3 no-underline first:border-t-0 hover:bg-canvas hover:no-underline", sel?.key === p.key ? "bg-brand-soft shadow-[inset_3px_0_0_var(--color-brand)]" : "")}
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium text-heading">{v.title}</span>
                  <span className="block truncate text-xs text-muted">
                    {p.published ? `v${p.published.version}` : "not published"} · {p.offers} accepted offer{p.offers === 1 ? "" : "s"}
                  </span>
                </span>
                {p.published ? <Pill tone="success">Published</Pill> : <Pill tone="neutral">Draft</Pill>}
              </Link>
            );
          })}
        </div>
        <div className="min-w-0">
          {creating && canEdit ? (
            <PlanEditor key="new" planKey={null} editing={null} publishedVersion={null} offers={0} canEdit />
          ) : sel && editing ? (
            <PlanEditor
              key={`${editing.id}:${editing.updatedAt.toISOString()}`}
              planKey={sel.key}
              editing={{
                version: editing.version,
                status: editing.status,
                title: editing.title,
                designations: editing.designations,
                basis: editing.basis,
                mode: editing.mode === "marginal" ? "marginal" : "whole",
                slabs: editing.slabs,
                conditions: editing.conditions,
                effectiveFrom: editing.effectiveFrom,
                publishedAt: editing.publishedAt?.toISOString() ?? null,
              }}
              publishedVersion={sel.published?.version ?? null}
              offers={sel.offers}
              canEdit={canEdit}
              lockedWhy={lockedWhy("incentivePlans")}
            />
          ) : (
            <Empty title="No plan picked">{plans.length ? "Choose one on the left." : canEdit ? "Create the first plan." : "The Sales Head or HR Head creates them."}</Empty>
          )}
        </div>
      </div>
    </>
  );
}
