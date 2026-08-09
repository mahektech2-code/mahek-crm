"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import {
  Badge,
  Button,
  Callout,
  Card,
  CardHeader,
  EmptyState,
  Input,
  MetricStrip,
  PageHeader,
  Select,
  Td,
  Th,
  Tr,
  cx,
  type Tone,
} from "@/components/ui/primitives";
import { Drawer, DrawerHeader, FilterPills } from "@/components/ui/overlays";
import { useToast } from "@/components/ui/toast";
import { initialsOf, longDate, money, phoneDisplay, stamp } from "@/lib/format";
import { syncEmployeesAction } from "@/lib/actions/hrms";
import type { EmployeeMaster, EmployeeRecord } from "@/lib/services/employee-service";

/* ---------------------------------------------------------------------------
 * All Employees — the master.
 *
 * A record, not a worklist. Nothing here is actioned, nothing is edited: HR
 * maintains the spreadsheet and this reflects it, so an editable field would
 * create a second answer that the next sync would overwrite without warning.
 *
 * The list is what somebody scans; the drawer is the person's record. Two
 * things stay OUT of the list on purpose. Pay, because a screen showing
 * seventy salaries is read over a shoulder in a way one record on a drawer is
 * not. And the bank account and Aadhaar numbers, which are never shown in full
 * anywhere — the last four digits are enough to recognise an account and
 * useless to anyone copying it down.
 * ------------------------------------------------------------------------- */

type StatusFilter = "all" | "active" | "inactive" | "attention";
type SortKey = "name" | "joined" | "department" | "status";

const STATUS_TONE: Record<EmployeeRecord["status"], Tone> = {
  active: "success",
  inactive: "muted",
  unknown: "warn",
};

/** How often the open screen asks the sheet whether anything changed. */
const WATCH_SECONDS = 60;

export function EmployeeScreen({ master }: { master: EmployeeMaster }) {
  const { employees, summary, lastSync, source } = master;

  const [query, setQuery] = React.useState("");
  const [status, setStatus] = React.useState<StatusFilter>("active");
  const [office, setOffice] = React.useState("all");
  const [department, setDepartment] = React.useState("all");
  const [sort, setSort] = React.useState<SortKey>("name");
  const [openId, setOpenId] = React.useState<string | null>(null);

  const rows = React.useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = employees.filter((e) => {
      if (status === "active" && e.status !== "active") return false;
      if (status === "inactive" && e.status === "active") return false;
      if (status === "attention" && e.issues.length === 0) return false;
      if (office !== "all" && e.officeName !== office) return false;
      if (department !== "all" && e.department !== department) return false;
      if (!q) return true;
      // Everything a person might type while looking for somebody: a name, a
      // code, a number they have on a slip, a place, a job title.
      return [
        e.name,
        e.employeeCode,
        e.position,
        e.department,
        e.officeName,
        e.areaAllocated,
        e.reportsTo,
        e.personalMobile,
        e.companyMobile,
        e.alternateMobile,
        e.email,
      ]
        .filter(Boolean)
        .some((v) => String(v).toLowerCase().includes(q));
    });

    const by: Record<SortKey, (a: EmployeeRecord, b: EmployeeRecord) => number> = {
      name: (a, b) => a.name.localeCompare(b.name),
      // Newest joiner first, and a record with no joining date sorts last
      // rather than sorting as the beginning of time.
      joined: (a, b) => (b.dateOfJoining ?? "").localeCompare(a.dateOfJoining ?? ""),
      department: (a, b) =>
        (a.department ?? "~").localeCompare(b.department ?? "~") ||
        a.name.localeCompare(b.name),
      status: (a, b) => a.status.localeCompare(b.status) || a.name.localeCompare(b.name),
    };
    return [...filtered].sort(by[sort]);
  }, [employees, query, status, office, department, sort]);

  const open = employees.find((e) => e.id === openId) ?? null;

  return (
    <div className="mx-auto w-full max-w-[1400px] px-5 py-6">
      <PageHeader
        title="All Employees"
        subtitle={
          <>
            The employee master, read from the <strong>Employee Details</strong>{" "}
            sheet. Maintained there, mirrored here — nothing on this screen can
            be edited, so the two can never disagree.
          </>
        }
        actions={<SyncControls lastSync={lastSync} configured={source.configured} />}
      />

      <MetricStrip
        metrics={[
          { label: "On the books", value: String(summary.total) },
          { label: "Active", value: String(summary.active), tone: "success" },
          { label: "Inactive", value: String(summary.inactive) },
          { label: "Offices", value: String(summary.offices.length) },
          {
            label: "Needs attention",
            value: String(summary.withIssues),
            tone: summary.withIssues ? "danger" : "ink",
            sub: summary.datesReadByConvention
              ? `${summary.datesReadByConvention} dates read by convention`
              : undefined,
          },
        ]}
      />

      {summary.withdrawn ? (
        <Callout tone="warn" className="mb-4">
          <strong>
            {summary.withdrawn} record{summary.withdrawn === 1 ? " is" : "s are"} no
            longer in the sheet.
          </strong>{" "}
          They are kept and marked, never deleted — payroll history outlives a
          spreadsheet edit. Filter by <em>Everyone else</em> to see them.
        </Callout>
      ) : null}

      <Card>
        <CardHeader
          title={`${rows.length} ${rows.length === 1 ? "person" : "people"}`}
          hint="Click anybody to open their record."
          action={
            <div className="flex items-center gap-2">
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Name, employee id, number, place…"
                className="w-64"
                aria-label="Search employees"
              />
              <Select
                value={sort}
                onChange={(e) => setSort(e.target.value as SortKey)}
                aria-label="Sort by"
                className="w-36"
              >
                <option value="name">Name</option>
                <option value="joined">Recently joined</option>
                <option value="department">Department</option>
                <option value="status">Status</option>
              </Select>
            </div>
          }
        />

        <div className="flex flex-wrap items-center gap-3 border-b border-divider px-5 py-3">
          <FilterPills
            value={status}
            onChange={setStatus}
            options={[
              { key: "active", label: "Active", count: summary.active },
              {
                key: "inactive",
                label: "Everyone else",
                count: summary.inactive + summary.unknown + summary.withdrawn,
              },
              { key: "all", label: "Everyone", count: employees.length },
              ...(summary.withIssues
                ? ([
                    {
                      key: "attention" as const,
                      label: "Needs attention",
                      count: summary.withIssues,
                    },
                  ] as const)
                : []),
            ]}
          />
          <span className="flex-1" />
          <Select
            value={office}
            onChange={(e) => setOffice(e.target.value)}
            aria-label="Office"
            className="w-48"
          >
            <option value="all">Every office</option>
            {summary.offices.map((o) => (
              <option key={o} value={o}>
                {o}
              </option>
            ))}
          </Select>
          <Select
            value={department}
            onChange={(e) => setDepartment(e.target.value)}
            aria-label="Department"
            className="w-44"
          >
            <option value="all">Every department</option>
            {summary.departments.map((d) => (
              <option key={d} value={d}>
                {d}
              </option>
            ))}
          </Select>
        </div>

        {rows.length === 0 ? (
          <EmptyState
            title={employees.length === 0 ? "Nobody imported yet" : "Nothing matches that"}
            body={
              employees.length === 0
                ? source.configured
                  ? "Press Sync now to read the Employee Details sheet."
                  : "Google Sheets is not configured, so the sheet cannot be read. Set GOOGLE_SA_EMAIL and GOOGLE_SA_PRIVATE_KEY."
                : "Try a name, an employee id, or clear the filters."
            }
          />
        ) : (
          <div className="overflow-x-auto" style={{ ["--rowh" as string]: "52px" }}>
            <table className="w-full border-collapse">
              <thead>
                <tr>
                  <Th>Employee</Th>
                  <Th>Position</Th>
                  <Th>Department</Th>
                  <Th>Office</Th>
                  <Th>Area</Th>
                  <Th>Joined</Th>
                  <Th>Contact</Th>
                  <Th>Status</Th>
                </tr>
              </thead>
              <tbody>
                {rows.map((e) => (
                  <Tr
                    key={e.id}
                    onClick={() => setOpenId(e.id)}
                    className="cursor-pointer hover:bg-canvas"
                  >
                    <Td>
                      <div className="flex items-center gap-2.5">
                        <span className="flex h-8 w-8 flex-none items-center justify-center rounded-full bg-brand-soft text-[11px] font-semibold text-[#5223E0]">
                          {initialsOf(e.name)}
                        </span>
                        <span className="min-w-0">
                          <span className="block truncate font-medium text-ink">
                            {e.name}
                          </span>
                          <span className="block text-[11px] text-muted">
                            {e.employeeCode}
                          </span>
                        </span>
                      </div>
                    </Td>
                    <Td>{e.position ?? <Blank />}</Td>
                    <Td>{e.department ?? <Blank />}</Td>
                    <Td>{e.officeName ?? <Blank />}</Td>
                    <Td>{e.areaAllocated ?? <Blank />}</Td>
                    <Td className="whitespace-nowrap">
                      {e.dateOfJoining ? longDate(e.dateOfJoining) : <Blank />}
                    </Td>
                    <Td className="whitespace-nowrap tabular-nums">
                      {e.personalMobile ? phoneDisplay(e.personalMobile) : <Blank />}
                    </Td>
                    <Td>
                      <div className="flex items-center gap-1.5">
                        <Badge tone={STATUS_TONE[e.status]}>
                          {e.status === "unknown" ? (e.statusRaw ?? "unknown") : e.status}
                        </Badge>
                        {e.withdrawn ? (
                          <span title="This row is no longer in the sheet">
                            <Badge tone="warn">off sheet</Badge>
                          </span>
                        ) : null}
                        {e.issues.length ? (
                          <span title={`${e.issues.length} cell(s) to check in the sheet`}>
                            <Badge tone="danger">{e.issues.length}</Badge>
                          </span>
                        ) : null}
                      </div>
                    </Td>
                  </Tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {/* Keyed, so opening a second person mounts a fresh drawer rather than
          leaving the first one's scroll position behind. */}
      {open ? (
        <EmployeeDrawer key={open.id} employee={open} onClose={() => setOpenId(null)} />
      ) : null}
    </div>
  );
}

/** A cell that holds nothing reads as a gap, not as a zero. */
function Blank() {
  return <span className="text-muted">—</span>;
}

/* --------------------------------------------------------- staying current */

/**
 * Sync now, and the quiet watch that runs while the screen is open.
 *
 * A person who adds a row to the sheet and switches to this tab expects to see
 * it. So the screen asks on a timer, and the answer is nearly always "nothing
 * changed" — which costs one hashed comparison per employee and no writes. It
 * only refreshes the page when something actually moved, because a refresh
 * under somebody reading a record is its own small annoyance.
 *
 * It pauses when the tab is hidden. A laptop with this open on a background
 * tab for a week should not spend the week reading a spreadsheet.
 */
function SyncControls({
  lastSync,
  configured,
}: {
  lastSync: EmployeeMaster["lastSync"];
  configured: boolean;
}) {
  const router = useRouter();
  const toast = useToast();
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
    if (!configured) return;
    let cancelled = false;

    const tick = async () => {
      if (document.visibilityState !== "visible") return;
      const result = await syncEmployeesAction();
      if (cancelled || !result.ok || result.data.skipped) return;
      const { created, updated, withdrawn } = result.data;
      if (created || updated || withdrawn) router.refresh();
    };

    void tick();
    const timer = setInterval(tick, WATCH_SECONDS * 1000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [configured, router]);

  const syncNow = async () => {
    setBusy(true);
    // `run` toasts the message the action returned, success or failure — the
    // counts it reports are the point of pressing the button.
    const result = await toast.run(syncEmployeesAction(true));
    setBusy(false);
    if (result.ok) router.refresh();
  };

  return (
    <div className="flex items-center gap-3">
      <div className="text-right text-[12px] leading-4 text-muted">
        {!configured ? (
          <span className="text-danger">Sheet access is not configured</span>
        ) : lastSync?.status === "failed" ? (
          <span className="text-danger">Last sync failed — {lastSync.error}</span>
        ) : lastSync ? (
          <>
            <div>Last synced {stamp(lastSync.at)}</div>
            <div>Checking the sheet every minute</div>
          </>
        ) : (
          <span>Never synced</span>
        )}
      </div>
      <Button variant="primary" onClick={syncNow} disabled={busy || !configured}>
        {busy ? "Syncing…" : "Sync now"}
      </Button>
    </div>
  );
}

/* -------------------------------------------------------------- the record */

function EmployeeDrawer({
  employee: e,
  onClose,
}: {
  employee: EmployeeRecord;
  onClose: () => void;
}) {
  return (
    <Drawer open onClose={onClose} width={560} label={`${e.name}, employee record`}>
      <DrawerHeader onClose={onClose}>
        <div className="flex items-center gap-3">
          <span className="flex h-10 w-10 flex-none items-center justify-center rounded-full bg-brand-soft text-[13px] font-semibold text-[#5223E0]">
            {initialsOf(e.name)}
          </span>
          <div className="min-w-0">
            <div className="truncate text-[17px] leading-6 font-semibold text-ink">
              {e.name}
            </div>
            <div className="text-[13px] text-muted">
              {[e.position, e.department].filter(Boolean).join(" · ") || "—"}
            </div>
          </div>
        </div>
      </DrawerHeader>

      <div className="flex-1 overflow-y-auto">
        <div className="flex flex-wrap items-center gap-1.5 border-b border-divider px-5 py-3">
          <Badge tone={STATUS_TONE[e.status]}>
            {e.status === "unknown" ? (e.statusRaw ?? "unknown") : e.status}
          </Badge>
          <Badge tone="neutral">{e.employeeCode}</Badge>
          {e.withdrawn ? <Badge tone="warn">no longer in the sheet</Badge> : null}
          {e.hasPhoto ? <Badge tone="muted">photo on file</Badge> : null}
        </div>

        {e.issues.length ? (
          <div className="border-b border-divider px-5 py-4">
            <Callout tone="warn" className="mb-0 items-start">
              <div>
                <strong>
                  {e.issues.length} cell{e.issues.length === 1 ? "" : "s"} to check on
                  sheet row {e.rowNumber}.
                </strong>
                <ul className="mt-2 space-y-1.5">
                  {e.issues.map((issue, i) => (
                    <li key={i} className="text-[13px]">
                      <Badge tone="danger">{issue.column}</Badge>{" "}
                      <span className="text-body">{issue.problem}</span>
                      {issue.value ? (
                        <span className="text-muted"> — cell holds “{issue.value}”</span>
                      ) : null}
                    </li>
                  ))}
                </ul>
              </div>
            </Callout>
          </div>
        ) : null}

        <Section title="Employment">
          <Row label="Office">{e.officeName}</Row>
          <Row label="Department">{e.department}</Row>
          <Row label="Position">{e.position}</Row>
          <Row label="Reports to">{e.reportsTo}</Row>
          <Row label="Area allocated">{e.areaAllocated}</Row>
          <Row label="Joined">{date(e.dateOfJoining)}</Row>
          <Row label="Left">{date(e.dateOfLeaving)}</Row>
        </Section>

        <Section title="Contact">
          <Row label="Personal mobile">{tel(e.personalMobile)}</Row>
          <Row label="Company mobile">{tel(e.companyMobile)}</Row>
          <Row label="Alternate">{tel(e.alternateMobile)}</Row>
          <Row label="Emergency">{tel(e.emergencyContact)}</Row>
          <Row label="Email">{e.email}</Row>
          <Row label="Address">{e.address}</Row>
          <Row label="Permanent address">{e.permanentAddress}</Row>
        </Section>

        <Section title="Personal">
          <Row label="Gender">{e.gender}</Row>
          <Row label="Date of birth">{date(e.dateOfBirth)}</Row>
          <Row label="Anniversary">{date(e.marriageAnniversary)}</Row>
          <Row label="Child’s birthday">{date(e.child1Birthday)}</Row>
          <Row label="Second child’s birthday">{date(e.child2Birthday)}</Row>
        </Section>

        <Section
          title="Pay and leave"
          hint="Monthly, as the sheet records it. Nothing here is computed."
        >
          <Row label="Salary">{amount(e.netSalaryPaise)}</Row>
          <Row label="Conveyance">{amount(e.conveyancePaise)}</Row>
          <Row label="Other">{amount(e.otherSalaryPaise)}</Row>
          <Row label="Paid leave a month">{num(e.monthlyPaidLeave)}</Row>
          <Row label="Maximum leave a year">{num(e.yearlyMaximumLeave)}</Row>
        </Section>

        <Section
          title="Statutory and bank"
          hint="Account and Aadhaar numbers are held but never shown — the last four digits identify them without exposing them."
        >
          <Row label="PF / ESIC">
            {e.pfEsicApplicable === null
              ? null
              : e.pfEsicApplicable
                ? "Applicable"
                : "Not applicable"}
          </Row>
          <Row label="UAN">{e.uanNo}</Row>
          <Row label="ESIC number">{e.esicNo}</Row>
          <Row label="PAN">{e.panNumber}</Row>
          <Row label="Bank">{e.bankName}</Row>
          <Row label="IFSC">{e.ifscCode}</Row>
          <Row label="Account">{masked(e.accountNumberLast4)}</Row>
          <Row label="Aadhaar">{masked(e.aadhaarLast4)}</Row>
        </Section>

        <Section title="Record">
          <Row label="Sheet row">{String(e.rowNumber)}</Row>
          <Row label="Last changed">{stamp(e.updatedAt)}</Row>
        </Section>

        {/* Kept apart from the issues above, and below the record rather than
            over it. "We took 5/1/2021 as the 5th of January" is worth being
            able to check; it is not a fault, and two thirds of this sheet's
            rows have one. Shown as what it is: a reading, with the cell. */}
        {e.dateNotes.length ? (
          <Section
            title="Dates read by convention"
            hint="These cells could be read two ways. Writing them as 5-Jan-2021 in the sheet settles it for good."
          >
            {e.dateNotes.map((note, i) => (
              <div key={i} className="text-[13px] text-muted">
                <span className="text-body">{note.column}</span> — cell holds “
                {note.value}”, {note.problem.split(" — ")[1] ?? note.problem}
              </div>
            ))}
          </Section>
        ) : null}

        <p className="px-5 pt-1 pb-6 text-[12px] leading-[18px] text-muted">
          Everything on this record comes from the Employee Details sheet and is
          read-only here. Correct it there and it arrives within the minute.
        </p>
      </div>
    </Drawer>
  );
}

function Section({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="border-b border-divider px-5 py-4 last:border-0">
      <div className="text-[11px] font-medium tracking-[0.04em] text-muted uppercase">
        {title}
      </div>
      {hint ? <p className="mt-1 text-[12px] text-muted">{hint}</p> : null}
      <div className="mt-2.5 space-y-1.5">{children}</div>
    </div>
  );
}

function Row({ label, children }: { label: string; children?: React.ReactNode }) {
  return (
    <div className="flex gap-3 text-[13px]">
      <span className="w-44 flex-none text-muted">{label}</span>
      <span className={cx("min-w-0 flex-1", children ? "text-body" : "text-muted")}>
        {children || "—"}
      </span>
    </div>
  );
}

/** Always with the year. "7 Sep" is a reminder; a joining date is a fact. */
const date = (iso: string | null) => (iso ? longDate(iso) : null);
const num = (n: number | null) => (n === null ? null : String(n));
const tel = (phone: string | null) => (phone ? phoneDisplay(phone) : null);
const amount = (paise: number | null) => (paise === null ? null : money(paise));
/** Four digits and nothing else. The rest never reaches the browser. */
const masked = (last4: string | null) =>
  last4 ? `•••• ${last4}` : null;
