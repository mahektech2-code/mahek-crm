import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { requireHireScreen } from "@/lib/hire/access";
import { ROLE_CAPS, ROLE_LABEL, HIRE_ROLES } from "@/lib/hire/roles";
import { hireTeam } from "@/lib/hire/services/blueprints";
import { Callout, Empty, PageHead } from "../_ui/kit";
import { RolePicker } from "./role-picker";
import { AddPerson, RemovePerson } from "./team-controls";

export const metadata: Metadata = { title: "Team" };
export const dynamic = "force-dynamic";

const LEVEL_DEFAULT: Record<string, string> = { admin: "admin", manager: "hiring_manager", associate: "interviewer" };

const SENTENCE: Record<string, string> = {
  recruiter: "Moves their own requisitions through; confirms rejections; sees no unmasked PII.",
  interviewer: "Sees only the candidates assigned to them, and only the stage they are conducting — never earlier scores.",
  hiring_manager: "Decides at the gate, overrides an entry rule with a reason, issues offers, proposes blueprints.",
  onboarding: "Documents, offers, induction and provisioning; may unmask PII, and every unmask is logged.",
  hr_head: "Everything, including publishing blueprints, fairness analytics and exports.",
  admin: "Everything.",
};

export default async function TeamPage() {
  const ctx = await requireHireScreen("team");
  if (!ctx.can("team")) redirect("/hire");
  const rows = await hireTeam();
  return (
    <>
      <PageHead title="Team" sub="What each person does inside Hire. The role decides what they see and what they may do; it is checked on every action, not only on the screen." />
      <AddPerson canMakeAdmin={ctx.role === "admin"} />
      <Callout className="mb-5">
        Without a role, the level they hold Hire at decides — an admin is Admin, a manager is a Hiring Manager, an associate is an Interviewer, the narrowest there is. Every platform administrator holds Hire as Admin from the day it is installed.
      </Callout>
      {rows.length ? (
        <div className="overflow-hidden rounded-[6px] border border-line bg-surface">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="text-left text-xs font-medium tracking-[0.04em] text-muted uppercase">
                {["Person", "Granted at", "Role in Hire", "What that means", ""].map((h) => (
                  <th key={h} className="border-b border-divider px-4 py-2.5 font-medium">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const effective = r.role ?? LEVEL_DEFAULT[r.level] ?? "interviewer";
                return (
                  <tr key={r.userId} className="hire-row border-b border-divider">
                    <td className="px-4 py-2">
                      <div className="font-medium text-heading">
                        {r.name}
                        {r.userId === ctx.user.id ? <span className="ml-1.5 text-xs font-normal text-muted">(you)</span> : null}
                      </div>
                      <div className="text-[13px] text-muted">{r.email ?? "—"}{r.active ? "" : " · sign-in disabled"}</div>
                    </td>
                    <td className="px-4 capitalize text-body">{r.level}</td>
                    <td className="px-4">
                      <RolePicker userId={r.userId} role={r.role} fallback={ROLE_LABEL[LEVEL_DEFAULT[r.level] as keyof typeof ROLE_LABEL] ?? "Interviewer"} self={r.userId === ctx.user.id} />
                    </td>
                    <td className="max-w-[420px] px-4 py-2 text-[13px] text-muted">{SENTENCE[effective]}</td>
                    <td className="px-4 text-right">{r.userId === ctx.user.id ? null : <RemovePerson userId={r.userId} name={r.name} />}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <Empty title="Nobody else holds Hire yet">Add somebody above.</Empty>
      )}
      <details className="mt-6 text-[13px] text-muted">
        <summary className="cursor-pointer">What each role may do</summary>
        <div className="mt-3 grid grid-cols-3 gap-3">
          {HIRE_ROLES.map((r) => (
            <div key={r} className="rounded-[6px] border border-line bg-surface p-3">
              <div className="font-medium text-heading">{ROLE_LABEL[r]}</div>
              <div className="mt-1">{ROLE_CAPS[r].join(" · ")}</div>
            </div>
          ))}
        </div>
      </details>
    </>
  );
}
