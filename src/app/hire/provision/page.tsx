import { requireHireScreen } from "@/lib/hire/access";
import { lockedWhy } from "@/lib/hire/roles";
import { getApplication } from "@/lib/hire/services/core";
import { onboardItems, onboardList } from "@/lib/hire/services/onboarding";
import { hiredSummary, provisionPlan } from "@/lib/hire/services/provision";
import type { CheckGroup } from "../_onboard/checks";
import { CandidateHead, OnboardFrame } from "../_onboard/frame";
import type { PaneRow } from "../_onboard/list-pane";
import { fd, fdt } from "../_ui/kit";
import { HiredCard, ProvisionPanel } from "./provision-panel";

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
    badge: r.status === "hired" ? { l: "Hired", tone: "success" } : r.slaBreach ? { l: "Past SLA", tone: "danger" } : { l: "Setting up", tone: "warn" },
  }));
  const selected = sp.app ?? rows[0]?.id ?? null;
  const b = selected ? await getApplication(ctx, selected) : null;

  let panel: React.ReactNode = null;
  if (b) {
    const head = <CandidateHead id={b.app.id} name={b.candidate.fullName} meta={`${b.candidate.code} · ${b.blueprint.title} v${b.blueprint.version} · ${b.candidate.location ?? "—"} · ${b.app.status === "hired" ? `Hired ${fd(b.app.hiredAt)}` : (b.stage?.name ?? "")}`} />;
    if (b.app.status === "hired") {
      const s = await hiredSummary(b);
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
              "Handed off to the Training Portal with their employee account. Hire recorded which topics were taught; the portal records what is learned.",
            ].filter(Boolean)}
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
      sub="Field setup, then the MahekOne account. Provisioning is what makes a candidate hired."
      listLabel={`At field setup · ${rows.filter((r) => r.badge.l !== "Hired").length}`}
      rows={rows}
      selected={selected}
      basePath="/hire/provision"
      emptyList="Nobody has reached field setup yet."
    >
      {panel}
    </OnboardFrame>
  );
}
