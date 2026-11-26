import { eq } from "drizzle-orm";
import { db } from "@/db";
import { trainingTracks } from "@/db/schema";
import { requireHireScreen } from "@/lib/hire/access";
import { isOnboardingFlow, isPostHireStage } from "@/lib/hire/blueprint-types";
import { courierOverall, empDocSigned } from "@/lib/hire/engines/onboarding";
import { BGV_LABEL, currentBgv, employmentDocRows, shipments } from "@/lib/hire/services/onboarding-records";
import { currentOffer, rupees } from "@/lib/hire/services/offers";
import { lockedWhy } from "@/lib/hire/roles";
import { getApplication, stageOutcome } from "@/lib/hire/services/core";
import { onboardItems, onboardList } from "@/lib/hire/services/onboarding";
import { hiredSummary, provisionPlan } from "@/lib/hire/services/provision";
import type { CheckGroup } from "../_onboard/checks";
import { CandidateHead, OnboardFrame } from "../_onboard/frame";
import type { PaneRow } from "../_onboard/list-pane";
import { fd, fdt } from "../_ui/kit";
import { HiredCard, ProvisionNowPanel, ProvisionPanel } from "./provision-panel";

export const dynamic = "force-dynamic";
export const metadata = { title: "Provision" };

export default async function ProvisionPage({ searchParams }: { searchParams: Promise<{ app?: string }> }) {
  const ctx = await requireHireScreen("provision");
  const sp = await searchParams;
  const list = await onboardList(ctx, "provision");
  const rows: PaneRow[] = list.map((r) => ({
    id: r.id,
    name: r.name,
    meta: `${r.blueprintTitle} · ${r.location ?? "—"}${r.status === "hired" ? "" : ` · ${r.stageName}`}`,
    badge:
      r.status === "hired"
        ? r.onboardingCompletedAt
          ? { l: "Hired", tone: "success" }
          : { l: "Hired · onboarding", tone: "info" }
        : r.slaBreach
          ? { l: "Past SLA", tone: "danger" }
          : r.liveStageType === "system_setup"
            ? { l: "At provision", tone: "warn" }
            : { l: "Setting up", tone: "warn" },
  }));
  const selected = sp.app ?? rows[0]?.id ?? null;
  const b = selected ? await getApplication(ctx, selected) : null;

  let panel: React.ReactNode = null;
  if (b) {
    const head = <CandidateHead id={b.app.id} name={b.candidate.fullName} meta={`${b.candidate.code} · ${b.blueprint.title} v${b.blueprint.version} · ${b.candidate.location ?? "—"} · ${b.app.status === "hired" ? `Hired ${fd(b.app.hiredAt)}` : (b.stage?.name ?? "")}`} />;
    const flow = isOnboardingFlow(b.def);
    if (flow && b.app.status !== "hired") {
      const plan = await provisionPlan(b);
      const [offer, bg, emp, ships] = await Promise.all([currentOffer(b.app.id), currentBgv(b.app.id), employmentDocRows(b.app.id), shipments(b.app.id)]);
      const want = (b.def.employmentDocs ?? []).filter((d) => d.required);
      const signed = want.filter((d) => emp.some((e) => e.docKey === d.key && empDocSigned(e.status))).length;
      const courier = courierOverall(emp.some((e) => e.hardCopy), ships);
      const checks: string[] = [];
      if (offer?.status === "accepted") checks.push(`Offer accepted · ${rupees(offer.basicPaise)} a month${offer.approvalStatus === "approved" ? " · approved" : offer.approvalStatus === "not_needed" ? " · no approval needed" : ""}`);
      const docStage = b.def.stages.find((x) => x.type === "document_collection");
      if (docStage && (await stageOutcome({ ...b.app, stageKey: docStage.key }, b.def)).outcome === "pass") checks.push("Required documents verified and the background check settled");
      if (bg && (!bg.required || bg.status === "clear" || bg.status === "not_applicable")) checks.push(`Background check · ${bg.required ? BGV_LABEL[bg.status] : "not required"}${bg.completedOn ? ` · ${fd(bg.completedOn)}` : ""}`);
      if (want.length && signed === want.length) checks.push(`${signed} employment document${signed === 1 ? "" : "s"} signed`);
      if (courier === "completed") checks.push("Hard copies received by the company");
      else if (courier === "not_required") checks.push("No hard copies needed");
      const [track] = b.def.training?.trackKey ? await db.select({ title: trainingTracks.title }).from(trainingTracks).where(eq(trainingTracks.key, b.def.training.trackKey)).limit(1) : [];
      const setupAt = b.def.stages.findIndex((x) => x.type === "system_setup");
      const next = b.def.stages[setupAt + 1]?.name ?? null;
      panel = (
        <>
          {head}
          <ProvisionNowPanel
            key={b.app.id}
            applicationId={b.app.id}
            checks={checks}
            blockers={plan.blockers}
            next={next}
            what={[
              ["Person", b.candidate.fullName],
              ["Signs in with", `${plan.phone}${plan.email && !plan.emailTaken && !plan.existingUser ? ` or ${plan.email}` : ""}`],
              ["Account", plan.existingUser ? `Links to the existing account of ${plan.existingUser.name} — no second account` : "Created new, with no password until one is issued"],
              ["Apps", plan.apps.map((a) => a.name).join(", ") || "None — the blueprint grants nothing"],
              ["Level", plan.level === "manager" ? "Manager" : "Associate"],
              ["Role", plan.roleLabel],
              ["Training", b.def.training?.trackKey ? `${track?.title ?? b.def.training.trackKey} — enrolled on creation, in the Training app` : "No training track named"],
              ...(plan.skipped.length ? ([["Not granted", `${plan.skipped.join(", ")} — not a MahekOne app`]] as [string, string][]) : []),
              ...(plan.emailTaken ? ([["Email", "Already used by another account, so it is not added"]] as [string, string][]) : []),
            ]}
            canProvision={ctx.can("provision")}
            lockedProvision={lockedWhy("provision")}
          />
        </>
      );
    } else if (b.app.status === "hired") {
      const s = await hiredSummary(b);
      const onboarding = flow && !b.app.onboardingCompletedAt && isPostHireStage(b.def, b.app.stageKey);
      panel = (
        <>
          {head}
          <HiredCard
            name={b.candidate.fullName}
            lines={[
              s?.user ? `MahekOne account: ${s.user.name} · signs in with ${s.user.phone ?? "—"}${s.user.email ? ` or ${s.user.email}` : ""}.` : "The account record could not be read.",
              s?.apps.length ? `Apps: ${s.apps.map((a) => `${a.name} (${a.level})`).join(", ")}.` : "No apps are held.",
              `Role: ${b.def.provisioning.roleLabel}.${b.def.provisioning.device ? " The handset binds to them the first time they sign in to MBOS." : ""}`,
              s?.resetIssued ? "A link to set their password was sent to their email." : "Their account has no password yet — issue one from Admin Console → Access → Generate password, and read it to them in person.",
              s?.decision ? `Hired by ${s.decision.by}, ${fdt(s.decision.at)}: “${s.decision.reasoning}”` : "",
              onboarding
                ? `Onboarding continues at ${b.stage?.name ?? "the next stage"} — assets, introductions and training, in their own account.`
                : flow
                  ? `Onboarding completed ${fd(b.app.onboardingCompletedAt)}.`
                  : "Handed off to the Training Portal with their employee account. Hire recorded which topics were taught; the portal records what is learned.",
            ].filter(Boolean)}
            continueHref={onboarding ? `/hire/induction?app=${b.app.id}` : null}
            recordHref={`/hire/c/${b.app.id}`}
          />
        </>
      );
    } else {
      const [plan, get] = await Promise.all([provisionPlan(b), onboardItems(b.app.id)]);
      const groups: CheckGroup[] = b.def.onboarding.setup.map((g) => ({
        key: g.key,
        label: g.system,
        items: g.steps.map((st) => {
          const x = get({ kind: "setup", group: g.key, item: st.key });
          return { kind: "setup" as const, group: g.key, item: st.key, label: st.label, done: Boolean(x?.done), serial: null, needsSerial: false, by: x?.doneByName ?? null, at: x?.doneAt?.toISOString() ?? null };
        }),
      }));
      const atSetup = b.stage?.type === "system_setup";
      panel = (
        <>
          {head}
          <ProvisionPanel
            key={b.app.id}
            applicationId={b.app.id}
            groups={groups}
            editable={atSetup && b.app.status === "in_progress" && ctx.can("onboard")}
            what={[
              ["Person", b.candidate.fullName],
              ["Signs in with", `${plan.phone}${plan.email && !plan.emailTaken && !plan.existingUser ? ` or ${plan.email}` : ""}`],
              ["Account", plan.existingUser ? `Links to the existing account of ${plan.existingUser.name} — no second account` : "Created new, with no password until one is issued"],
              ["Apps", plan.apps.map((a) => a.name).join(", ") || "None — the blueprint grants nothing"],
              ["Level", plan.level === "manager" ? "Manager" : "Associate"],
              ["Role", plan.roleLabel],
              ["Device", plan.device ? "Bound on their first MBOS sign-in" : "No device"],
              ...(plan.skipped.length ? ([["Not granted", `${plan.skipped.join(", ")} — not a MahekOne app`]] as [string, string][]) : []),
              ...(plan.emailTaken ? ([["Email", "Already used by another account, so it is not added"]] as [string, string][]) : []),
            ]}
            blockers={plan.blockers}
            canProvision={ctx.can("provision")}
            lockedProvision={lockedWhy("provision")}
            lockedOnboard={ctx.can("onboard") ? null : lockedWhy("onboard")}
          />
        </>
      );
    }
  }
  return (
    <OnboardFrame
      title="Provision"
      sub="Creating the MahekOne account is what makes somebody hired. In the onboarding flow it comes once the employment documents are back, so the new employee can sign in, acknowledge assets and take their training."
      listLabel={`At provision · ${list.filter((r) => r.status !== "hired").length}`}
      rows={rows}
      selected={selected}
      basePath="/hire/provision"
      emptyList="Nobody has reached provision yet."
    >
      {panel}
    </OnboardFrame>
  );
}
