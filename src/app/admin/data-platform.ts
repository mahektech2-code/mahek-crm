/* ---------------------------------------------------------------------------
 * The platform-side contracts and demo records.
 *
 * Everything here belongs to MahekOne itself rather than to any one app: what
 * the apps declare, whether they answer when called, what the platform sends,
 * and what an admin needs to see before touching a threshold.
 * ------------------------------------------------------------------------- */

import type { SchemaTab } from "@/lib/config/schema-contract";

/* ------------------------------------------------------------------- usage */

export const SIGNINS_PER_DAY = [
  4, 5, 5, 6, 5, 3, 0, 5, 6, 6, 5, 6, 4, 0, 6, 6, 5, 6, 6, 4, 0, 5, 6, 6, 6, 5, 4, 0, 5, 6,
];

export const APP_USAGE = [
  { app: "Telecaller CRM", active: 5, of: 5, lastActive: "2 minutes ago", opens: 118 },
  { app: "Order Management", active: 0, of: 1, lastActive: "Never", opens: 0 },
  { app: "Salesman App", active: 0, of: 0, lastActive: "—", opens: 0 },
];

/* -------------------------------------------------------- configuration drift */

export const DRIFT_RECENT = [
  { app: "Telecaller CRM", setting: "Stage 2 threshold", from: "18 days", to: "21 days", by: "Vikram Shah", t: "Today, 08:52" },
  { app: "Telecaller CRM", setting: "Routine check-in interval", from: "21 days", to: "14 days", by: "Vikram Shah", t: "Yesterday, 17:10" },
  { app: "Telecaller CRM", setting: "Aging bucket boundaries", from: "0 / 30 / 60 / 90", to: "0 / 7 / 21 / 45", by: "Vikram Shah", t: "24 Jul, 09:20" },
];

/**
 * Settings the business flagged as needing a decision before go-live. Still on
 * their default is not the same as agreed — during rollout this is the list an
 * admin works down.
 */
export const DRIFT_UNCONFIRMED = [
  { app: "Telecaller CRM", setting: "Product rates", value: "Single rate per product", why: "Rates may vary by customer. Without a decision, order value reads zero." },
  { app: "Telecaller CRM", setting: "Default credit period", value: "30 days", why: "Never confirmed with accounts." },
  { app: "Telecaller CRM", setting: "Maximum queue size per telecaller", value: "60 customers", why: "Guessed. Should be set from observed throughput after two weeks." },
  { app: "Telecaller CRM", setting: "Slow payer late-payment threshold", value: "3 late payments", why: "Awaiting a definition of “late” from the business." },
];

/* ------------------------------------------------------ contract validation */

export type ContractCheck = {
  app: string;
  endpoint: string;
  label: string;
  ok: boolean;
  ms: number | null;
  note: string;
};

export const CONTRACT_CHECKS: ContractCheck[] = [
  { app: "Telecaller CRM", endpoint: "/api/crm/config/schema", label: "Configuration schema", ok: true, ms: 41, note: "10 sub-tabs · 96 settings declared" },
  { app: "Telecaller CRM", endpoint: "/api/crm/config", label: "Configuration write", ok: true, ms: 55, note: "Accepts writes, rejects unknown keys" },
  { app: "Telecaller CRM", endpoint: "/api/crm/summary", label: "App summary", ok: true, ms: 38, note: "Attention count and status line" },
  {
    app: "Telecaller CRM", endpoint: "/api/crm/summary/user", label: "Per-user summary", ok: false, ms: null,
    note: "No response. Owned records and team workload will read empty, and offboarding cannot show its impact.",
  },
  { app: "Order Management", endpoint: "—", label: "Configuration schema", ok: false, ms: null, note: "Not deployed. Expected while the app is Coming soon." },
];

/* ---------------------------------------------------------- feature flags */

export const FEATURE_FLAGS = [
  { app: "Telecaller CRM", key: "queue", label: "Call queue", on: true, note: "The daily worklist." },
  { app: "Telecaller CRM", key: "collections", label: "Payment follow-up", on: true, note: "Escalation stages and the follow-up panel." },
  { app: "Telecaller CRM", key: "recovery", label: "Recovery cases", on: false, note: "Held back for phase two — telecallers learn collections first." },
  { app: "Telecaller CRM", key: "targets", label: "Monthly targets", on: true, note: "Needs product rates to read anything but zero." },
  { app: "Telecaller CRM", key: "whatsappAuto", label: "Automatic WhatsApp sending", on: false, note: "Manual mode until the provider is connected." },
  { app: "Telecaller CRM", key: "creditNotes", label: "Credit note requests", on: true, note: "Requests surface on a manager's list — there is no Accounts app yet." },
];

/* ------------------------------------------------------- migration status */

export const MIGRATION = [
  { what: "Customer book", total: 580, done: 580, failed: 0, note: "Complete." },
  { what: "Product catalogue", total: 92, done: 92, failed: 0, note: "Rates still to be confirmed." },
  { what: "Call history", total: 14238, done: 14200, failed: 38, note: "38 rows have no matching customer. Exception file downloadable." },
  { what: "Open bills", total: 316, done: 316, failed: 0, note: "Outstanding recomputed from bills after load." },
  { what: "Buying cycles", total: 580, done: 0, failed: 0, note: "Runs after call history is clean. Not started." },
];

/* ---------------------------------------------------------- notifications */

export const NOTIFICATION_CATALOGUE = [
  { app: "Telecaller CRM", event: "Reminder due", desc: "Fires at the reminder's due time.", roles: { Telecaller: true, Manager: false } },
  { app: "Telecaller CRM", event: "Reminder overdue", desc: "Fires once a reminder passes its due date.", roles: { Telecaller: true, Manager: true } },
  { app: "Telecaller CRM", event: "Complaint past SLA", desc: "Escalates to the manager when resolution runs late.", roles: { Telecaller: false, Manager: true } },
  { app: "Telecaller CRM", event: "Payment promise broken", desc: "The promised date passed with no payment.", roles: { Telecaller: true, Manager: true } },
  { app: "Telecaller CRM", event: "EOD report not submitted", desc: "Fires at the day boundary.", roles: { Telecaller: true, Manager: true } },
  { app: "Platform", event: "Password reset requested", desc: "Sent to the account's work email.", roles: { Telecaller: true, Manager: true } },
  { app: "Platform", event: "Access request raised", desc: "Sent to platform admins.", roles: { Telecaller: false, Manager: false } },
  { app: "Platform", event: "Scheduled job failed", desc: "Sent to platform admins.", roles: { Telecaller: false, Manager: false } },
];

export const ANNOUNCEMENTS = [
  {
    id: "a1", title: "Diwali dispatch cut-off is 18 October", severity: "Info",
    body: "Orders taken after the 18th dispatch on the 24th. Tell customers the date when you take the order, not afterwards.",
    from: "08 Aug 2026", to: "19 Oct 2026", audience: "Telecaller CRM · everyone", state: "Scheduled",
  },
  {
    id: "a2", title: "The order system is not syncing", severity: "Warning",
    body: "Live order data is stale since 07:30. Do not tell a customer their order has left until this is fixed.",
    from: "Today", to: "Until resolved", audience: "Telecaller CRM · everyone", state: "Live",
  },
  {
    id: "a3", title: "New payment reminder wording", severity: "Info",
    body: "Stage 2 template has been rewritten. Read it once before your first collections call today.",
    from: "25 Jul 2026", to: "01 Aug 2026", audience: "Telecaller CRM · Telecaller", state: "Ended",
  },
];

export const DELIVERY_LOG = [
  { what: "Reminder overdue", to: "Priya Sharma", channel: "In-app", t: "Today, 09:40", state: "Seen" },
  { what: "Reminder overdue", to: "Rakesh Yadav", channel: "In-app", t: "Today, 09:40", state: "Delivered" },
  { what: "Password reset requested", to: "neha@mahek.in", channel: "Email", t: "Today, 08:20", state: "Delivered" },
  { what: "Scheduled job failed", to: "Sandeep Rao", channel: "Email", t: "Today, 03:22", state: "Seen" },
  { what: "Announcement · order system not syncing", to: "5 people", channel: "Launcher", t: "Today, 07:45", state: "Seen by 4" },
  { what: "EOD report not submitted", to: "Anjali Kulkarni", channel: "In-app", t: "Yesterday, 19:05", state: "Not seen" },
];

/* --------------------------------------------------------- leaver checklist */

export const LEAVER_CHECKLIST = [
  { label: "Customer book reassigned", done: true },
  { label: "Open complaints reassigned", done: true },
  { label: "Outstanding reminders reassigned", done: false },
  { label: "App access revoked", done: false },
  { label: "Sessions ended", done: false },
  { label: "Offboarding record exported", done: false },
];

/* ------------------------------------------------------- scheduled changes */

export const SCHEDULED_CHANGES = [
  {
    id: "sc1", app: "Telecaller CRM", setting: "Default target uplift",
    from: "0%", to: "12%", when: "01 Sep 2026", by: "Vikram Shah",
    why: "Festival season. Agreed with the business in the August review.",
  },
  {
    id: "sc2", app: "Telecaller CRM", setting: "Stage 1 permitted channels",
    from: "WhatsApp", to: "WhatsApp, Call", when: "20 Oct 2026", by: "Vikram Shah",
    why: "Collections tighten before the year end.",
  },
];

/* ------------------------------------------------- per-setting change history */

/**
 * What a setting has held before now. Shown inline on the setting rather than
 * buried in Audit, because the question — "what was this before I touched it?"
 * — is asked while looking at the field.
 */
export const SETTING_HISTORY: Record<string, Array<{ value: string; by: string; t: string }>> = {
  checkinInterval: [
    { value: "14 days", by: "Vikram Shah", t: "Yesterday, 17:10" },
    { value: "21 days", by: "Sandeep Rao", t: "12 Jun 2026" },
    { value: "30 days", by: "System", t: "02 Jan 2026 · default" },
  ],
  stageThresholds: [
    { value: "7 / 21 / 45", by: "Vikram Shah", t: "Today, 08:52" },
    { value: "7 / 18 / 45", by: "Vikram Shah", t: "14 Jun 2026" },
    { value: "7 / 21 / 45", by: "System", t: "02 Jan 2026 · default" },
  ],
  agingBuckets: [
    { value: "0 / 7 / 21 / 45", by: "Vikram Shah", t: "24 Jul 2026" },
    { value: "0 / 30 / 60 / 90", by: "System", t: "02 Jan 2026 · default" },
  ],
  maxQueue: [{ value: "60 customers", by: "System", t: "02 Jan 2026 · default" }],
};

/* ------------------------------------------------------- platform settings */

/**
 * MahekOne's own configuration, declared in exactly the shape an app declares
 * its own. The renderer does not know the difference.
 *
 * Attachment settings used to sit here as well. They are real settings the CRM
 * reads, so they live in the registry and render in the CRM's own section —
 * two places declaring the same thing is the drift this console exists to
 * prevent. Everything below is still platform demo data.
 */
export const PLATFORM_SCHEMA: { tabs: SchemaTab[] } = {
  tabs: [
    {
      key: "platform",
      label: "Platform settings",
      groups: [
        {
          label: "Security",
          fields: [
            { key: "secSessionTimeout", label: "Session timeout", control: "int", unit: "hours", def: 8, min: 1, max: 72, help: "How long a session survives without activity." },
            { key: "secRemember", label: "Remember-me duration", control: "int", unit: "days", def: 30, min: 1, max: 365, help: "How long a remembered sign-in lasts." },
            { key: "secAttempts", label: "Failed attempts before lockout", control: "int", unit: "attempts", def: 5, min: 3, max: 20, help: "Nothing is blocked automatically beyond this." },
            { key: "secLockout", label: "Lockout duration", control: "int", unit: "minutes", def: 30, min: 1, max: 1440, help: "How long a locked account stays locked." },
            { key: "secMinLength", label: "Password minimum length", control: "int", unit: "characters", def: 10, min: 8, max: 64, help: "Enforced when a password is set." },
            { key: "secResetExpiry", label: "Reset link expiry", control: "int", unit: "minutes", def: 30, min: 5, max: 1440, help: "Asking for a new link kills the old one, and using it deletes every session that account had." },
            { key: "secForceChange", label: "Force a password change on first sign-in", control: "bool", def: true, help: "An admin-created account starts with a link, never a password." },
            { key: "secConcurrent", label: "Concurrent sessions per user", control: "int", unit: "sessions", def: 3, min: 1, max: 10, help: "Beyond this, the oldest session ends." },
          ],
        },
      ],
    },
  ],
};

/* ------------------------------------------------------------ user activity */

export type ActivityKind = "Sign-in" | "App" | "Account" | "Session";

export type ActivityRow = {
  t: string;
  kind: ActivityKind;
  what: string;
  meta: string;
};

/**
 * A person's use of the system, not their work. An admin reading this is
 * answering "did anyone actually open Dispatch last month?" or "when did they
 * last really work, rather than merely authenticate?"
 */
export function activityFor(userId: string, joined: string, createdBy: string): ActivityRow[] {
  const base: ActivityRow[] = [
    { t: "Today, 11:20", kind: "App", what: "Telecaller CRM · Call Log", meta: "42 minutes on screen" },
    { t: "Today, 10:04", kind: "App", what: "Telecaller CRM · Payment Follow-up", meta: "12 minutes on screen" },
    { t: "Today, 09:04", kind: "Sign-in", what: "Signed in", meta: "Windows 11 · Chrome 128 · 103.21.58.14" },
    { t: "Yesterday, 18:02", kind: "Session", what: "Signed out", meta: "Session ended normally" },
    { t: "Yesterday, 17:40", kind: "App", what: "Telecaller CRM · EOD Report", meta: "Submitted" },
    { t: "Yesterday, 09:11", kind: "Sign-in", what: "Signed in", meta: "Windows 11 · Chrome 128 · 103.21.58.14" },
    { t: "05 Aug, 16:22", kind: "Account", what: "Password reset link used", meta: "Every earlier session was ended" },
    { t: "05 Aug, 16:10", kind: "Account", what: "Password reset requested", meta: "By Vikram Shah" },
    { t: "05 Aug, 09:02", kind: "Sign-in", what: "Signed in", meta: "Windows 11 · Chrome 128 · 103.21.58.14" },
    { t: "04 Aug, 19:14", kind: "Session", what: "Session expired", meta: "Idle past the 8-hour timeout" },
    { t: "04 Aug, 09:06", kind: "Sign-in", what: "Signed in", meta: "Android · Chrome 128 · 182.70.44.9" },
    { t: "03 Aug, 14:30", kind: "Account", what: "Role changed", meta: "CRM · Telecaller, by Vikram Shah" },
    { t: "02 Aug, 09:00", kind: "Sign-in", what: "Signed in", meta: "Windows 11 · Chrome 128 · 103.21.58.14" },
    { t: "01 Aug, 08:58", kind: "Sign-in", what: "Failed sign-in", meta: "Wrong password · attempt 1" },
  ];
  // Everybody's record ends where their account began.
  return [
    ...(userId === "u5" ? [] : base),
    { t: joined, kind: "Account", what: "Account created", meta: `By ${createdBy}` },
  ];
}

/* ------------------------------------------------------------ audit policy */

export const AUDIT_POLICY = {
  retentionMonths: 36,
  exportBeforeAgeOut: true,
  scheduledExport: true,
  scheduleDay: "Monday",
  destination: "sandeep@mahek.in",
  lastExport: "03 Aug 2026 · 1,204 records",
  oldestRecord: "02 Jan 2026",
};
