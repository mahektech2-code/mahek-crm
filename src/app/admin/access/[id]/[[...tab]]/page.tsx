import { notFound } from "next/navigation";
import { ADMIN, ADMIN_TABS, tabIndexOf } from "@/lib/admin-routes";
import { listPeople } from "@/lib/services/admin-people-service";
import { liveSessions } from "@/lib/services/admin-platform-service";
import { auditFeed } from "@/lib/services/audit-feed-service";
import { listAccess } from "@/lib/services/access-service";
import { personAccessExtras } from "@/lib/services/person-access-extras-service";
import { getConfig } from "@/lib/config/store";
import { definition } from "@/lib/config/registry";
import { settingAddress } from "@/lib/config/settings-schemas";
import { hrmsLink } from "@/lib/hrms/registry";
import { isHeadPosition } from "@/lib/hrms/access";
import { erpLink } from "@/lib/erp/registry";
import { today } from "@/lib/queries";
import { requirePlatformAdmin } from "../../../_shell/context";
import { PersonDetail, type ElsewhereLink } from "../../person-detail";

/** The three lead-verifier settings — a person named in one verifies leads without any grant saying so. */
const VERIFIER_KEYS = ["leads.selfRaisedVerifierEmail", "leads.telecallerVerifierEmail", "leads.fieldVerifierEmail"] as const;

export default async function PersonPage({ params }: { params: Promise<{ id: string; tab?: string[] }> }) {
  await requirePlatformAdmin();
  const { id, tab } = await params;
  /* The grants come from the Access screen's own reading, so the level and
     how far into each app it reaches read the same on both pages. */
  const [people, sessions, audit, day, access, extras, config] = await Promise.all([
    listPeople(),
    liveSessions(id),
    auditFeed({ about: id, size: 50 }),
    today(),
    listAccess(),
    personAccessExtras(id),
    getConfig(),
  ]);
  const person = people.find((p) => p.id === id);
  if (!person) notFound();
  const row = access.find((r) => r.userId === id);

  /* Where a setting is edited is asked of the settings schema rather than
     typed, so moving the verifier settings to another page moves this link. */
  const verifierAt = settingAddress(VERIFIER_KEYS[0]);
  const verifierHref = verifierAt ? ADMIN.settingsFor(verifierAt.page, verifierAt.tab) : ADMIN.settings;
  const email = (person.email ?? "").trim().toLowerCase();
  const verifies = email
    ? VERIFIER_KEYS.filter((k) => String(config[k] ?? "").trim().toLowerCase() === email).map(
        (k) => definition(k)?.label ?? k,
      )
    : [];

  const elsewhere: ElsewhereLink[] = [
    {
      label: "HRMS org chart",
      href: hrmsLink("org"),
      now: extras.employee
        ? extras.orgManagers.length
          ? `Reports to ${extras.orgManagers.join(", ")} on the chart.`
          : "Not placed under anybody on the chart."
        : "No HRMS employee record is linked to this account, so the chart does not include them.",
      why: "HR's answer to who manages whom. HRMS team scope and the CRM's sales-manager seats read it; it is separate from the account's “Reports to” on the Profile tab.",
    },
    {
      label: "ERP godowns",
      href: erpLink("godowns"),
      now: extras.godowns.length ? `On the staff of ${extras.godowns.join(", ")}.` : "On no godown's staff.",
      why: "ERP Masters → Godowns. A godown's staff list decides whose stock and forms a person works on.",
    },
    {
      label: "Lead verifier settings",
      href: verifierHref,
      now: verifies.length ? `Named in: ${verifies.join("; ")}.` : "Not named as a lead verifier.",
      why: "Three settings name, by work email, who verifies leads raised by a Sales Manager, a Telecaller or a Salesman. Being named there routes leads to them without any grant here.",
    },
    {
      label: "Audit trail",
      href: `${ADMIN.audit()}?person=${encodeURIComponent(id)}`,
      now: audit.total ? `${audit.total.toLocaleString("en-IN")} entries.` : "Nothing recorded yet.",
      why: "Everything they did, and everything done to their account — including every change on this page.",
    },
  ];

  return (
    <PersonDetail
      person={person}
      grants={row?.grants ?? []}
      powers={
        row
          ? {
              erpPowers: row.erpPowers,
              hrmsPowers: row.hrmsPowers,
              taskPowers: row.taskPowers,
              hireRole: row.hireRole,
              factoryPlace: row.factoryPlace,
              erpDesignation: row.erpDesignation
                ? { name: row.erpDesignation.name, matches: row.erpDesignation.matches }
                : null,
            }
          : null
      }
      employee={
        extras.employee
          ? {
              code: extras.employee.code,
              name: extras.employee.name,
              position: extras.employee.position,
              /* The same test HRMS applies when it hands a head their two powers. */
              isHead: isHeadPosition(extras.employee.position),
            }
          : null
      }
      people={people.map((p) => ({ id: p.id, name: p.name, active: p.active, role: p.role, reportsToId: p.reportsToId }))}
      elsewhere={elsewhere}
      tab={ADMIN_TABS.person[tabIndexOf(ADMIN_TABS.person, tab?.[0])].slug}
      sessions={sessions}
      audit={audit}
      today={day}
    />
  );
}
