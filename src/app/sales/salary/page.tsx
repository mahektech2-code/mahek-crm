import Link from "next/link";
import { MonthNav } from "@/components/ui/month-nav";
import { money, shortDate } from "@/lib/format";
import { endOfMonth } from "@/lib/business-date";
import { today } from "@/lib/recompute";
import { payForPeriod } from "@/lib/services/sales-service";
import {
  Banner,
  Cell,
  Empty,
  HeadCell,
  MetricRow,
  Pill,
  Row,
  ScreenHeader,
  Table,
} from "../parts";
import { plural } from "../words";

export const metadata = { title: "Salary — Sales Dashboard — MahekOne" };

/**
 * What each salesman is paid.
 *
 * **Read-only, and read from payroll.** `DECISIONS.md` settled this before MBOS
 * shipped: no MBOS table holds pay, and this reads what payroll publishes —
 * which turns out to exist. HR maintains the employee workbook, HRMS mirrors it
 * hash-for-hash, and the salary columns are already in it. Nothing here writes
 * a figure, and a correction is made in the workbook rather than on this screen.
 *
 * Days worked and reimbursements sit beside the pay without being added to it.
 * An expense reimbursement is money owed back, not earnings; combining them
 * produces a number that is neither, on the one screen where a wrong number is
 * least forgivable.
 *
 * There is still no incentive column. Incentive is achievement against a
 * target, and MahekOne sets no target for a field salesman — so the figure has
 * nothing to be computed from. Performance shows what each person actually did.
 */
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ month?: string }>;
}) {
  const params = await searchParams;
  const now = await today();

  const month = /^\d{4}-\d{2}$/.test(params.month ?? "") ? params.month! : now.slice(0, 7);
  const from = `${month}-01`;
  const to = endOfMonth(month);

  const rows = await payForPeriod(from, to);

  const known = rows.filter((r) => r.netSalaryPaise != null);
  const unknown = rows.filter((r) => r.netSalaryPaise == null);
  const monthly = known.reduce(
    (n, r) =>
      n +
      Number(r.netSalaryPaise ?? 0) +
      Number(r.conveyancePaise ?? 0) +
      Number(r.otherSalaryPaise ?? 0),
    0,
  );
  const reimbursed = rows.reduce((n, r) => n + Number(r.reimbursedPaise), 0);

  return (
    <div className="p-6">
      <ScreenHeader
        title="Salary"
        subtitle="What each salesman is paid, read from the employee master that HR maintains. Nothing here writes a figure — a correction is made in the HR workbook, and the next sync brings it."
        actions={
          <div className="flex items-center gap-1 text-[13px]">
            <MonthNav month={month} basePath="/sales/salary" />
          </div>
        }
      />

      {unknown.length ? (
        <Banner
          tone="warn"
          title={`${plural(unknown.length, "salesman", "salesmen")} ${unknown.length === 1 ? "has" : "have"} no employee record`}
          body={`${unknown.map((u) => u.salesmanName).join(", ")}. Their MahekOne account is matched to the employee master by email, then by company mobile — if neither matches, there is no payroll row to read. Fixing it means correcting the workbook, not this screen.`}
        />
      ) : null}

      <Banner
        tone="info"
        title="There is no incentive column"
        body="Incentive is achievement against a target, and MahekOne sets no monthly target for a field salesman — so there is nothing to compute it from. Performance shows what each person actually did in the month."
      />

      <MetricRow
        metrics={[
          { label: "On the payroll", value: `${known.length} of ${rows.length}` },
          { label: "Monthly pay", value: monthly ? money(monthly) : "—", sub: "gross, from HR" },
          {
            label: "Reimbursed",
            value: reimbursed ? money(reimbursed) : "—",
            sub: "approved expenses, not earnings",
          },
        ]}
      />

      {rows.length === 0 ? (
        <Empty
          title="Nobody in the field"
          body="The field team is whoever holds the Salesman App."
        />
      ) : (
        <>
          <Table
            minWidth={1180}
            head={
              <>
                <HeadCell width={210}>Salesman</HeadCell>
                <HeadCell width={150}>Employee</HeadCell>
                <HeadCell align="right" width={140}>Net</HeadCell>
                <HeadCell align="right" width={140}>Conveyance</HeadCell>
                <HeadCell align="right" width={130}>Other</HeadCell>
                <HeadCell width={170}>Days</HeadCell>
                <HeadCell align="right" width={150}>Reimbursed</HeadCell>
                <HeadCell width={130}>PF / ESIC</HeadCell>
              </>
            }
          >
            {rows.map((r, i) => (
              <Row key={r.salesmanId} striped={i % 2 === 1}>
                <Cell truncate={210}>
                  <Link
                    href={`/sales/people/${r.salesmanId}`}
                    className="font-medium text-ink no-underline hover:underline"
                  >
                    {r.salesmanName}
                  </Link>
                  {r.dateOfJoining ? (
                    <span className="block text-[12px] text-muted">
                      since {shortDate(r.dateOfJoining)}
                    </span>
                  ) : null}
                </Cell>
                <Cell truncate={150}>
                  {r.employeeCode ?? (
                    <span className="text-warn-ink" title="No employee record matched this account.">
                      Not matched
                    </span>
                  )}
                </Cell>
                <Cell align="right">
                  {r.netSalaryPaise != null ? (
                    money(r.netSalaryPaise)
                  ) : (
                    <span className="text-muted">—</span>
                  )}
                </Cell>
                <Cell align="right">
                  {r.conveyancePaise != null ? (
                    money(r.conveyancePaise)
                  ) : (
                    <span className="text-muted">—</span>
                  )}
                </Cell>
                <Cell align="right">
                  {r.otherSalaryPaise != null ? (
                    money(r.otherSalaryPaise)
                  ) : (
                    <span className="text-muted">—</span>
                  )}
                </Cell>
                <Cell>
                  <span className="tabular-nums">{r.daysWorked} worked</span>
                  {r.daysOnLeave ? (
                    <span className="block text-[12px] text-muted">
                      {plural(r.daysOnLeave, "day")} on leave
                    </span>
                  ) : null}
                </Cell>
                <Cell align="right">
                  {Number(r.reimbursedPaise) ? (
                    money(r.reimbursedPaise)
                  ) : (
                    <span className="text-muted">—</span>
                  )}
                </Cell>
                <Cell>
                  {r.pfEsicApplicable == null ? (
                    <span className="text-muted">—</span>
                  ) : r.pfEsicApplicable ? (
                    <Pill tone="brand">Applicable</Pill>
                  ) : (
                    <Pill>No</Pill>
                  )}
                </Cell>
              </Row>
            ))}
          </Table>

          <p className="mt-3 max-w-[820px] text-[13px] text-pretty text-muted">
            Reimbursed is approved expense claims for the month. It is money owed back rather than
            earnings, and it is deliberately not added to the pay — a single figure combining them
            would be neither one nor the other.
          </p>
        </>
      )}
    </div>
  );
}


