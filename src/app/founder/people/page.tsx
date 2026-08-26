import Link from "next/link";
import { Card, MetricStrip, PageHeader, Th, Td, Tr } from "@/components/ui/primitives";
import { founderPeople } from "@/lib/services/founder-dashboard-service";

export const metadata = { title: "People - Founder Dashboard - MahekOne" };

/**
 * The roster, from `employeeMaster()` — the same mirror of the HR sheet
 * HRMS itself reads, summarised rather than listed row by row.
 *
 * Signing in is not attendance, and this screen says so rather than implying
 * otherwise — see HRMS's own note on `attendance` in AGENTS.md.
 */
export default async function Page() {
  const data = await founderPeople();
  const { summary } = data;

  const byGroup = (key: "officeName" | "department", values: string[]) => {
    const present = data.employees.filter((e) => !e.withdrawn);
    return values.map((v) => ({
      label: v,
      count: present.filter((e) => e[key] === v).length,
    }));
  };

  return (
    <div className="p-6">
      <PageHeader
        title="People"
        subtitle="Headcount, by office and department. Not attendance — a sign-in says somebody opened MahekOne, not that they were at work."
        actions={
          <Link
            href="/hrms/employees"
            className="rounded-[4px] border border-line bg-surface px-2.5 py-1.5 text-[13px] text-body no-underline hover:bg-canvas hover:no-underline"
          >
            Open HRMS
          </Link>
        }
      />

      <MetricStrip
        metrics={[
          { label: "Active", value: String(summary.active), sub: `${summary.total} present on the sheet` },
          { label: "Inactive", value: String(summary.inactive), sub: "present, marked not active" },
          { label: "Withdrawn", value: String(summary.withdrawn), sub: "no longer a row in the sheet" },
          { label: "Offices", value: String(summary.offices.length) },
          { label: "Departments", value: String(summary.departments.length) },
        ]}
      />

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <Card className="overflow-hidden">
          <div className="border-b border-divider px-5 py-3.5 text-lg leading-6 font-semibold text-ink">
            By office
          </div>
          <div className="overflow-auto">
            <table className="w-full">
              <thead>
                <tr>
                  <Th>Office</Th>
                  <Th align="right">Active people</Th>
                </tr>
              </thead>
              <tbody>
                {byGroup("officeName", summary.offices).map((row) => (
                  <Tr key={row.label}>
                    <Td className="font-medium text-ink">{row.label}</Td>
                    <Td align="right">{row.count}</Td>
                  </Tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>

        <Card className="overflow-hidden">
          <div className="border-b border-divider px-5 py-3.5 text-lg leading-6 font-semibold text-ink">
            By department
          </div>
          <div className="overflow-auto">
            <table className="w-full">
              <thead>
                <tr>
                  <Th>Department</Th>
                  <Th align="right">Active people</Th>
                </tr>
              </thead>
              <tbody>
                {byGroup("department", summary.departments).map((row) => (
                  <Tr key={row.label}>
                    <Td className="font-medium text-ink">{row.label}</Td>
                    <Td align="right">{row.count}</Td>
                  </Tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      </div>

      {summary.withIssues > 0 ? (
        <p className="mt-4 max-w-[860px] text-[13px] text-pretty text-muted">
          {summary.withIssues} {summary.withIssues === 1 ? "record needs" : "records need"} a
          look in HRMS — a cell the sync could not read cleanly.
        </p>
      ) : null}
    </div>
  );
}
