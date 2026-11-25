import type { Metadata } from "next";
import { nowMs } from "@/lib/format";
import { requireHireScreen } from "@/lib/hire/access";
import { ONBOARDING_LABEL, type OnboardingStatus } from "@/lib/hire/engines/onboarding";
import { onboardingRows } from "@/lib/hire/services/onboarding-board";
import { PageHead } from "../_ui/kit";
import { OnboardingBoard, type BoardCard } from "./board";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Onboarding" };

/** Where each status's work is done. */
const WHERE: Partial<Record<OnboardingStatus, string>> = {
  selected: "/hire/offers",
  compensation_discussion: "/hire/offers",
  awaiting_acceptance: "/hire/offers",
  accepted: "/hire/offers",
  document_collection: "/hire/documents",
  verification: "/hire/documents",
  employment_documents: "/hire/employment-docs",
  courier_pending: "/hire/employment-docs",
  ready_to_provision: "/hire/provision",
  assets_pending: "/hire/induction",
  training: "/hire/induction",
  training_completed: "/hire/induction",
  onboarding_completed: "/hire/induction",
};

/**
 * PRD §19, the HR dashboard: everybody between an advanced gate and a
 * finished onboarding, by the status their records say. The tiles count the
 * same rows the columns hold.
 */
export default async function OnboardingPage() {
  const ctx = await requireHireScreen("onboarding");
  const now = nowMs();
  const rows = await onboardingRows(ctx, now);
  const month = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit" }).format(new Date(now));
  const cards: BoardCard[] = rows.map((r) => ({
    id: r.id,
    name: r.name,
    role: r.blueprintTitle,
    location: r.location,
    status: r.ob,
    statusLabel: ONBOARDING_LABEL[r.ob],
    line: r.line,
    late: r.late,
    days: Math.floor(r.hoursInStage / 24),
    href: `${WHERE[r.ob] ?? `/hire/c/${r.id}`}?app=${r.id}`,
    recordHref: `/hire/c/${r.id}`,
    owner: r.recruiterName,
    completedThisMonth: Boolean(r.onboardingCompletedAt && new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit" }).format(new Date(r.onboardingCompletedAt)) === month),
    approvalPending: r.ob === "compensation_discussion" && r.line.startsWith("Negotiated"),
    retraining: r.training?.retraining ?? 0,
  }));
  return (
    <>
      <PageHead
        title="Onboarding"
        sub="Everyone from an advanced decision gate to a finished training track. Each card’s status is read from its records — offer, documents, verification, employment documents, courier, assets and training. Nobody types it."
      />
      <OnboardingBoard cards={cards} />
    </>
  );
}
