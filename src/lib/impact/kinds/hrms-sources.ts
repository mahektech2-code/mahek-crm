import "server-only";
import type { ImpactSource } from "../registry";

/* Impact sources for HRMS and Hire. Each entry is loaded lazily by `registry.ts`; the
   key is the `impact.kind` a screen names and the act passes to
   `confirmImpact`. */
export const HRMS_SOURCES: Record<string, () => Promise<ImpactSource>> = {
  /* HRMS → Leave, Overtime, Monthly report, Attendance. */
  "hrms-leave-request": () => import("./hrms-time").then((m) => m.leaveRequestImpact),
  "hrms-leave-credit": () => import("./hrms-time").then((m) => m.leaveCreditImpact),
  "hrms-overtime": () => import("./hrms-time").then((m) => m.overtimeImpact),
  "hrms-monthly-remark": () => import("./hrms-time").then((m) => m.monthlyRemarkImpact),
  "hrms-attendance-day": () => import("./hrms-time").then((m) => m.attendanceDayImpact),

  /* HRMS → Help, Grievances, Documents, Announcements. */
  "hrms-help": () => import("./hrms-misc").then((m) => m.helpRequestImpact),
  "hrms-grievance": () => import("./hrms-misc").then((m) => m.grievanceImpact),
  "hrms-document": () => import("./hrms-misc").then((m) => m.documentWithdrawImpact),
  "hrms-announcement": () => import("./hrms-misc").then((m) => m.announcementImpact),

  /* HRMS → Payroll, Advances, Expenses. */
  "hrms-salary": () => import("./hrms-pay").then((m) => m.salaryImpact),
  "hrms-advance": () => import("./hrms-pay").then((m) => m.advanceImpact),
  "hrms-expense": () => import("./hrms-pay").then((m) => m.expenseImpact),

  /* HRMS → Employees, ID cards, Offices, Timings, Asset stock, Assignments. */
  "hrms-employee": () => import("./hrms-people").then((m) => m.employeeDeleteImpact),
  "hrms-employee-deactivate": () => import("./hrms-people").then((m) => m.employeeDeactivateImpact),
  "hrms-id-card": () => import("./hrms-people").then((m) => m.idCardImpact),
  "hrms-office": () => import("./hrms-people").then((m) => m.officeImpact),
  "hrms-timing": () => import("./hrms-people").then((m) => m.timingImpact),
  "hrms-asset-lot": () => import("./hrms-people").then((m) => m.assetLotImpact),
  "hrms-asset-assignment": () => import("./hrms-people").then((m) => m.assetAssignmentImpact),

  /* Hire → a candidate's application withdrawn. */
  "hire-withdraw": () => import("./hire").then((m) => m.hireWithdrawImpact),
};
