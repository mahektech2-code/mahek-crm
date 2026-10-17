/* ---------------------------------------------------------------------------
 * The HRMS's special powers (PRD §5.3), as data.
 *
 * The source hard-codes these against the AppSheet admin role, seven email
 * addresses and four named people. Here each is a named power granted to a
 * person (`hrms_user_powers`) on the Access dialog. An HRMS ADMINISTRATOR —
 * the admin level on the `hrms` grant, or a platform admin — holds every
 * power without a row.
 *
 * Two powers also come with a position rather than a grant: a department
 * head (Position ending in "Head") marks attendance for, and checks out, the
 * field and other staff of their office — that is what the source's
 * "Attendance By Officer" gave every head.
 *
 * PURE and client-safe.
 * ------------------------------------------------------------------------- */

export const HRMS_POWERS = [
  "hr",
  "markStaff",
  "checkoutStaff",
  "onBehalf",
  "editAtt",
  "import",
  "approveLeave",
  "split",
  "entitle",
  "aadhaar",
  "payroll",
  "pay",
  "advance",
  "verifyExp",
  "tasksAdmin",
  "perfAdmin",
  "salesAll",
  "journeyAnyone",
  "custStatus",
  "resolve",
  "timings",
  "admin",
] as const;

export type HrmsPower = (typeof HRMS_POWERS)[number];

export const HRMS_POWER_LABEL: Record<HrmsPower, { label: string; source: string }> = {
  hr: { label: "HR: employees, holidays, offices, documents and assets", source: "The HR email address in the source: signs employees up, keeps the holidays, documents and assets, and sees everyone's attendance." },
  markStaff: { label: "Mark attendance for staff", source: "“Attendance By Officer”: heads, HR and admin mark field and other staff present (a head holds it by position)." },
  checkoutStaff: { label: "Check out another person", source: "“Check Out by Officer” (heads and admin)." },
  onBehalf: { label: "Apply for leave on behalf of staff", source: "The UX permission “Apply Leave Request”." },
  editAtt: { label: "Edit, import and delete attendance", source: "Admin in the source: set the check-in time, edit, import and delete." },
  import: { label: "Import attendance and holidays", source: "Admin in the source: “Import attendance” and “Upload holiday”." },
  approveLeave: { label: "Approve and reject leave", source: "Admin in the source: “Do Approve” (with the paid-leave split), “Do Reject” and the admin remark." },
  split: { label: "See the paid and unpaid leave split", source: "In the source, only admin sees the paid and unpaid days on a leave request." },
  entitle: { label: "See and set leave entitlements", source: "Monthly paid leave and yearly maximum leave: admin only in the source." },
  aadhaar: { label: "See and edit the full Aadhaar number", source: "In the source only admin edits Aadhaar; everyone else sees the last four digits." },
  payroll: { label: "Prepare and approve salaries", source: "The payroll register: admin, the CEO and two named payroll clerks." },
  pay: { label: "Pay salaries (enter the UTR)", source: "“Salary Prepared”: the payment UTR and date." },
  advance: { label: "Give salary advances", source: "“Given Advanced Form”: one named clerk; the advances list is admin’s." },
  verifyExp: { label: "Verify expenses", source: "Admin in the source." },
  tasksAdmin: { label: "Manage everyone’s tasks", source: "“Task Management (Admin)”: templates, daily checklists, to-dos and verification for everyone." },
  perfAdmin: { label: "See everyone’s performance", source: "Admin and HR: sales performance, staff performance and the charts for everyone." },
  salesAll: { label: "Everyone’s sales KPIs, activity, customers and journeys", source: "Admin, HR and the two sales email addresses: every KPI, activity, customer and journey plan; the CEO’s calling data." },
  journeyAnyone: { label: "Plan journeys for any employee", source: "One named person in the source could plan journeys for anyone, not only sales staff." },
  custStatus: { label: "Decide customer deactivations", source: "Admin in the source: accept or reject a deactivation, make a customer active again." },
  resolve: { label: "Resolve help requests and grievances", source: "Admin in the source: approve help, give a grievance its solution." },
  timings: { label: "Set staff timings", source: "Admin and the CEO in the source." },
  admin: { label: "HRMS administration: settings, pick lists and deletions", source: "The AppSheet admin role." },
};

export function isHrmsPower(v: string): v is HrmsPower {
  return (HRMS_POWERS as readonly string[]).includes(v);
}
