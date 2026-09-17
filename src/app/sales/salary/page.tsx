import { MonthNav } from "@/components/ui/month-nav";
import { money, shortDate } from "@/lib/format";
import { endOfMonth } from "@/lib/business-date";
import { today } from "@/lib/recompute";
import { payForPeriod } from "@/lib/services/sales-service";
import {
  Banner,
  Cell,
  Empty,
  EntityLink,
  HeadCell,
  MetricRow,
  Pill,
  Row,
  ScreenHeader,
  SortHead,
  Table,
} from "@/components/console/parts";
import { plural } from "@/components/console/words";
import { readSort, sortHref, sortRows, type SortColumns } from "@/components/console/sort";

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
  searchParams: Promise<{ month?: string; sort?: string; dir?: string }>;
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

  /* Sorting is DISPLAY ONLY: the figures above the table are counted over the
     whole payroll and never over the sorted copy, because re-ordering a list
     changes nothing about what is in it and a total that moved when somebody
     clicked a column would be the screen disagreeing with itself.

     The month has to be carried through the link or sorting silently throws
     somebody back into the current month — and on a screen about pay, a figure
     that quietly changed the period it describes is the worst kind of wrong. */
  const sort = readSort(params, COLUMNS);
  const sorted = sortRows(rows, sort, COLUMNS);
  const head = (key: string, label: string, width?: number, align?: "left" | "right") => (
    <SortHead
      width={width}
      align={align}
      href={sortHref("/sales/salary", sort, key, `month=${month}`)}
      active={sort.key === key}
      dir={sort.dir}
    >
      {label}
    </SortHead>
  );

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
          body={`${unknown.map((u) => u.salesmanName).join(", ")}. Nothing links their MahekOne account to a payroll row, and the fallback guess — email, then company mobile — finds nobody on this book: most employees carry no email, and the work numbers on the accounts are not the company mobiles in the sheet. Link them by hand in Admin Console → Access → Link an HRMS record. That is a one-off per person, and it is what makes these figures appear.`}
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
                {head("name", "Salesman", 210)}
                {/* The employee code is an identifier rather than a quantity —
                    ordering people by it sorts them by whenever HR happened to
                    create their row, which is a question nobody asks. Who has
                    no payroll row at all is the one thing worth pulling out of
                    this column, and the banner above already names every one
                    of them by name. */}
                <HeadCell width={150}>Employee</HeadCell>
                {head("net", "Net", 140, "right")}
                {head("conveyance", "Conveyance", 140, "right")}
                {head("other", "Other", 130, "right")}
                {head("days", "Days", 170)}
                {head("reimbursed", "Reimbursed", 150, "right")}
                {/* Three states, none of them above another: applicable, not,
                    and nobody has said. A sort over that only ever groups the
                    blanks, which is what the dash already does on the row. */}
                <HeadCell width={130}>PF / ESIC</HeadCell>
              </>
            }
          >
            {sorted.map((r, i) => (
              <Row key={r.salesmanId} striped={i % 2 === 1}>
                <Cell truncate={210}>
                  <EntityLink
                    href={`/sales/people/${r.salesmanId}`}
                  >
                    {r.salesmanName}
                  </EntityLink>
                  {r.dateOfJoining ? (
                    <span className="block text-[12px] text-muted">
                      since {shortDate(r.dateOfJoining)}
                    </span>
                  ) : null}
                </Cell>
                <Cell truncate={150}>
                  {r.employeeCode ? (
                    <>
                      {r.employeeCode}
                      {/* A guess and a chosen answer look identical in this
                          column, and one of them is deciding what somebody is
                          shown as being paid. */}
                      {r.employeeMatch === "guessed" ? (
                        <span
                          className="block text-[12px] text-warn-ink"
                          title="Matched on email or work number rather than chosen. Link them in Admin Console → Access to be sure this is the right payroll row."
                        >
                          guessed, not linked
                        </span>
                      ) : null}
                    </>
                  ) : (
                    <span className="text-warn-ink" title="Nothing links this account to a payroll row.">
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

/**
 * What each sortable column is worth.
 *
 * `null` sorts last in both directions, and on this screen that is the whole
 * of the argument for it: a salesman payroll has no row for has no net pay,
 * and floating him to the top of "highest paid" would be the screen inventing
 * a figure out of a missing one. He is named in the banner instead, where the
 * sentence can say what to do about it.
 *
 * Days sorts on the days WORKED alone rather than on some combination with
 * leave. The cell prints both because they read together, but "who worked
 * fewest days" and "who took most leave" are different questions and a column
 * that quietly answered a blend of them would answer neither.
 */
const COLUMNS: SortColumns<{
  salesmanName: string;
  netSalaryPaise: number | null;
  conveyancePaise: number | null;
  otherSalaryPaise: number | null;
  daysWorked: number;
  reimbursedPaise: number | string;
}> = {
  name: (r) => r.salesmanName,
  net: (r) => r.netSalaryPaise,
  conveyance: (r) => r.conveyancePaise,
  other: (r) => r.otherSalaryPaise,
  days: (r) => r.daysWorked,
  reimbursed: (r) => Number(r.reimbursedPaise),
};
