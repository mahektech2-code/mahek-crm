"use client";

import * as React from "react";
import { downloadCsv, toCsv } from "@/lib/csv";
import { useRouter } from "next/navigation";
import {
  Badge,
  Button,
  Checkbox,
  Field,
  Input,
  cx,
} from "@/components/ui/primitives";
import { Modal, RowMenu } from "@/components/ui/overlays";
import { ImpactDialog } from "@/components/ui/impact-dialog";
import { ACCESS_REVOKE_KIND, accessRevokeKey } from "@/lib/impact/kinds/access-revoke-key";
import type { ImpactConfirmation } from "@/lib/impact/types";
import type { Result } from "@/lib/result";
import { useToast } from "@/components/ui/toast";
import { getModule, grantableApps, isAlwaysOpen, moduleGroupsForApp, modulesForApp, toggleModule, withoutOrphanLevels, writeLevelsForApp } from "@/lib/modules";
import {
  describeDiff,
  designationShape,
  diffFromDesignation,
  draftFor,
  heldShape,
  isEmptyDiff,
  type DesignationDiff,
  type ErpDesignationDef,
  type ErpLevel,
} from "@/lib/erp/designations";
import { levelCarries } from "@/lib/capability-labels";
import { dayLabel, namedList } from "@/lib/module-since";
import { LEVEL_LABELS } from "@/lib/hat-labels";
import { getApp, type AppId } from "@/lib/apps";
import { ERP_POWERS, ERP_POWER_LABEL, type ErpPower } from "@/lib/erp/powers";
import { ERP_POWER_SCREENS } from "@/lib/access-bulk";
import { HRMS_POWERS, HRMS_POWER_LABEL } from "@/lib/hrms/powers";
import { TASK_POWERS, TASK_POWER_LABEL } from "@/lib/tasks/permissions";
import { HIRE_ROLES, LEVEL_FOR_ROLE, ROLE_LABEL as HIRE_ROLE_LABEL, ROLE_SENTENCE as HIRE_ROLE_SENTENCE, defaultRoleFor, type HireRole } from "@/lib/hire/roles";
import {
  candidatesForGrant,
  employeesToLink,
  issueCredential,
  linkEmployee,
  renamePerson,
  setAccess,
  setNotEmployee,
  type IssuedCredential,
} from "@/lib/actions/access";
import {
  endSessionsFor,
  sendPasswordResetFor,
  setUserActive,
  offboardPerson,
} from "@/lib/actions/people";
import { mintImpersonationLink } from "@/lib/actions/impersonation";
import type {
  AccessRow,
  Candidate,
  LinkableEmployee,
} from "@/lib/services/access-service";
import { ADMIN } from "@/lib/admin-routes";
import { AdminPage } from "./_shell/admin-page";
import { Avatar, Pill, btnClass } from "./_shell/kit";
import type { AccessView, PersonExtras } from "@/lib/services/admin-access-view-service";
import { giveAppTo } from "./access/bulk-apps";

/* ---------------------------------------------------------------------------
 * The Access screen.
 *
 * One question, asked in one place: who can open what, and how far into it.
 *
 * It replaced five tabs that each held a piece of the answer — a roster, a
 * grid of app checkboxes, a roles table, a session list — and none of which
 * could grant anything to somebody who did not already have an account. The
 * people who work here are in HRMS, so this starts there.
 *
 * ONE DIALOG PER PERSON, and it holds every app at once. Granting an app,
 * narrowing one and taking one away are the same act — somebody deciding what
 * this person's MahekOne looks like — and doing them one app at a time meant
 * opening the same dialog four times to set up one telecaller, with no screen
 * ever showing the whole answer. The middle page IS the whole answer, and the
 * page after it is the review: what changes, in words, before anything is
 * written.
 *
 * The modules of an app arrive fully ticked. That is not a default so much as
 * a statement of what granting an app has always meant, and the unticking is
 * the new part.
 * ------------------------------------------------------------------------- */

const APPS = grantableApps();

import { conflictsFor } from "@/lib/role-conflicts";
import { cleanDepts, CREW_ROLES, crewLabel, DEPT_LABEL, FACTORY_DEPTS, isProc, placeProblem, placeSentence, placeWords, procsOf, type CrewRole, type FactoryDept, type FactoryPlace } from "@/lib/factory/departments";

/*
 * THE SAME THREE IN EVERY APP.
 *
 * This list used to carry `Telecaller` and `Accounts` beside `Manager` and
 * `Admin` — two job titles from two particular apps in a list of seniority
 * levels — so granting the Salesman App asked which kind of telecaller a
 * field salesman was. What the app is, the row already says; this only has to
 * say how senior they are in it.
 */
const ROLES = [
  { id: "associate", label: "Associate" },
  { id: "manager", label: "Manager" },
  { id: "admin", label: "Admin" },
] as const;

type RoleId = (typeof ROLES)[number]["id"];

/**
 * What the Admin option is CALLED, which depends on the app it sits beside.
 *
 * "Admin" alone read the same on every row, and it stopped meaning the same
 * thing the day `can()` began reading an admin hat against its own app: Admin
 * on HRMS is HRMS's administrator and nothing more, while Admin on the Admin
 * Console is the platform administrator, who holds everything everywhere. Two
 * very different grants behind one identical word is exactly how somebody
 * hands out the platform while meaning to hand out a desk.
 */
function levelOptionLabel(level: RoleId, app: AppId, appName: string): string {
  if (level !== "admin") return ROLES.find((r) => r.id === level)?.label ?? level;
  return app === "admin" ? "Admin — the whole platform" : `Admin — everything in ${appName}`;
}

/** Every module of an app that its holders reach whatever is ticked. */
const ALWAYS_OF = (app: AppId) => modulesForApp(app).filter((m) => isAlwaysOpen(m.key)).map((m) => m.key);

/**
 * An account nobody has said WHICH employee it is — and nobody has said it is
 * not one. Who is on whose team, whose book, whose leave all read the HRMS
 * record by id, so this list is meant to be worked down to empty.
 */
const needsHrmsLink = (r: AccessRow) => r.employeeMatch !== "linked" && !r.notEmployee;

const TABS = [
  { key: "everybody", label: "Everybody" },
  { key: "admins", label: "Platform admins" },
  { key: "not-hrms", label: "Not linked to HRMS" },
  { key: "no-account", label: "In HRMS, no account" },
  { key: "disabled", label: "Disabled" },
  /* HRMS says they have left and their sign-in still works: the list that
     used to exist only as a pill on a row somebody had to notice. */
  { key: "left", label: "Left, still enabled" },
] as const;
type Tab = (typeof TABS)[number]["key"];

/** What the Filters panel narrows a tab to — the views this screen always had. */
const FILTERS = [
  { key: "narrowed", label: "Narrowed access" },
  { key: "new-screens", label: "New screens to decide" },
  { key: "no-app", label: "No app at all" },
  { key: "clash", label: "Hats that clash" },
] as const;
type Filter = (typeof FILTERS)[number]["key"] | "";

const PAGE = 25;

/** HRMS marks them as left, and the account can still sign in. */
const leftButEnabled = (r: AccessRow) => r.active && r.employeeStatus === "inactive";

const isPlatformAdminRow = (r: AccessRow) => r.grants.some((g) => g.app === "admin" && g.role === "admin");

/** Per app: the screens shipped after a narrowed grant was last saved. */
type Fresh = Record<string, { keys: string[]; labels: string[]; setOn: string }>;

/** The desired state while the dialog is open: app → the modules ticked. */
type Draft = Record<string, string[]>;

const ALL_OF = (app: AppId) => modulesForApp(app).map((m) => m.key);

/** What ticking an app (or starting a new grant) selects: every module except the ones that are handed out deliberately. */
const DEFAULT_OF = (app: AppId) => modulesForApp(app).filter((m) => !m.offByDefault).map((m) => m.key);

/** A designation's difference from somebody, in the words a row can carry. */
function diffLines(diff: DesignationDiff): string[] {
  return describeDiff(
    diff,
    (k) => getModule(k)?.label ?? k,
    (p) => ERP_POWER_LABEL[p as keyof typeof ERP_POWER_LABEL]?.label ?? p,
  );
}

/**
 * How a draft stands against a designation — computed live while the boxes
 * move, from the same arithmetic the server applies an edit by, so "matches"
 * here is exactly what decides whether the next edit to the designation
 * reaches this person.
 */
function standingOf(d: ErpDesignationDef, modules: string[], level: RoleId, powers: string[]): { matches: boolean; lines: string[] } {
  const all = ALL_OF("erp");
  const diff = diffFromDesignation(heldShape({ level: level as ErpLevel, moduleRows: modules, powers }, all), designationShape(d, all), all);
  return { matches: isEmptyDiff(diff), lines: diffLines(diff) };
}

export function AccessSection({
  rows: allRows,
  designations,
  onlyDesignation,
  isPlatformAdmin,
  enabling,
  onEnablingDone,
  onEnable,
  onlyApp,
  view: view_,
  now,
  manage = null,
}: {
  rows: AccessRow[];
  /** The ERP's designations, offered on the ERP's block of the dialog. */
  designations: ErpDesignationDef[];
  /** Arrived narrowed to one designation's holders. */
  onlyDesignation: string | null;
  /**
   * Whether the viewer is a PLATFORM ADMINISTRATOR — Admin on the Admin
   * Console. Every action this screen offers refuses anybody else on the
   * server (`requirePlatformAdminUser`), and the page itself is gated the same
   * way, so this is belt and braces: if the page gate is ever loosened, what
   * appears is a read-only list rather than a page of buttons that all fail.
   */
  isPlatformAdmin: boolean;
  /** The page's Enable access button was pressed: the picker comes first. */
  enabling: boolean;
  onEnablingDone: () => void;
  /** Narrowed to the people holding one app — the Home page's apps table links here. */
  onlyApp: AppId | null;
  /** "Give somebody access": the picker opens. */
  onEnable: () => void;
  /** Last sign-in, live sessions, HRMS jobs and the HRMS people with no account. */
  view: AccessView;
  /** The clock, read on the server — "Today 09:04" is relative to it. */
  now: number;
  /** Arrived from a person's page: their dialog opens first. */
  manage?: string | null;
}) {
  const router = useRouter();
  const { push } = useToast();
  const onOpenUser = (id: string) => router.push(ADMIN.person(id));
  /* BY DESIGNATION, because "who are our quality testers" is asked of this
     screen as often as "who holds the ERP" — and the answer has to include
     the customised ones, which a designation's own page counts separately. */
  const [byDesignation, setByDesignation] = React.useState<string>(onlyDesignation ?? "");
  const [byApp, setByApp] = React.useState<AppId | "">(onlyApp ?? "");
  const [byLevel, setByLevel] = React.useState<RoleId | "">("");
  const [filter, setFilter] = React.useState<Filter>("");
  const [tab, setTab] = React.useState<Tab>("everybody");
  const [q, setQ] = React.useState("");
  const [page, setPage] = React.useState(0);
  const [filtersOpen, setFiltersOpen] = React.useState(false);
  const [giving, setGiving] = React.useState(false);
  const rows = allRows
    .filter((r) =>
      !byDesignation
        ? true
        : byDesignation === "none"
          ? r.grants.some((g) => g.app === "erp") && !r.erpDesignation
          : r.erpDesignation?.id === byDesignation,
    );
  /** Managing somebody already on the list skips the picker. */
  const [managing, setManaging] = React.useState<AccessRow | null>(() => (manage ? (allRows.find((r) => r.userId === manage) ?? null) : null));
  /** Turning the sign-in itself off, or back on. */
  const [switching, setSwitching] = React.useState<AccessRow | null>(null);
  const [offboarding, setOffboarding] = React.useState<AccessRow | null>(null);
  /** Saying which HRMS row this account is — see `EmployeeLinkDialog`. */
  const [linking, setLinking] = React.useState<AccessRow | null>(null);
  /** Renaming somebody — once, carried to HRMS and every customer. */
  const [renaming, setRenaming] = React.useState<AccessRow | null>(null);
  /* THE SECOND DOOR ONTO A PASSWORD. The grant flow offers one at the moment
     an account is set up, which is the moment most of them are needed — but
     somebody set up in March who cannot get in today is not going to be given
     access again to reach it. */
  const [crediting, setCrediting] = React.useState<AccessRow | null>(null);
  /** A just-minted sign-in link, shown once so it can be copied. */
  const [linkFor, setLinkFor] = React.useState<{
    name: string;
    url: string;
    expiresInMinutes: number;
  } | null>(null);

  /* BULK. Selection is a set of user ids; it survives switching views, and
     every bulk action runs the same per-person action the row menu runs, so a
     refusal for one person is that person's and the rest still go through. */
  const [picked, setPicked] = React.useState<Set<string>>(new Set());
  const [bulkBusy, setBulkBusy] = React.useState(false);
  const toggle = (id: string) =>
    setPicked((p) => {
      const n = new Set(p);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  async function runBulk(label: string, fn: (id: string) => Promise<{ ok: boolean }>) {
    const ids = [...picked];
    setBulkBusy(true);
    let done = 0;
    for (const id of ids) if ((await fn(id)).ok) done++;
    setBulkBusy(false);
    push(done === ids.length ? `${label} for ${done} ${done === 1 ? "person" : "people"}.` : `${label} for ${done} of ${ids.length}. The rest were refused.`);
    setPicked(new Set());
    router.refresh();
  }
  function exportCsv(list: AccessRow[]) {
    downloadCsv(
      "people-and-access",
      toCsv(
        ["Name", "Email", "Phone", "Signs in", "Account level", "Employee", "Apps"],
        list.map((r) => [
          r.name,
          r.email,
          r.phone,
          r.active ? "Enabled" : "Disabled",
          r.role,
          r.employeeCode,
          r.grants.map((g) => `${g.appName} (${g.role}, ${g.grantedCount}/${g.totalCount})`).join("; "),
        ]),
      ),
      [tab, filter, byApp],
    );
  }

  const say = (r: { ok: boolean; message?: string; error?: string }) => {
    push(r.ok ? (r.message ?? "Saved.") : (r.error ?? "That did not work."));
    if (r.ok) router.refresh();
  };


  const tabCount: Record<Tab, number> = {
    everybody: rows.length,
    admins: rows.filter(isPlatformAdminRow).length,
    "not-hrms": rows.filter(needsHrmsLink).length,
    "no-account": view_.noAccount.length,
    disabled: rows.filter((r) => !r.active).length,
    left: rows.filter(leftButEnabled).length,
  };
  const needle = q.trim().toLowerCase();
  const inView = rows
    .filter((r) => {
      if (tab === "disabled") return !r.active;
      if (tab === "left") return leftButEnabled(r);
      if (tab === "admins") return isPlatformAdminRow(r);
      if (tab === "not-hrms") return needsHrmsLink(r);
      return true;
    })
    .filter((r) => {
      if (filter === "narrowed") return r.grants.some((g) => !g.whole);
      if (filter === "new-screens") return r.active && r.grants.some((g) => g.newScreens.length > 0);
      if (filter === "no-app") return r.grants.length === 0;
      if (filter === "clash") return r.conflicts.length > 0;
      return true;
    })
    .filter((r) => !byApp || r.grants.some((g) => g.app === byApp))
    .filter((r) => !byLevel || r.grants.some((g) => g.role === byLevel))
    .filter(
      (r) =>
        !needle ||
        [r.name, r.email, r.phone, r.employeeCode].some((v) => v?.toLowerCase().includes(needle)),
    );
  const pages = Math.max(1, Math.ceil(inView.length / PAGE));
  const at = Math.min(page, pages - 1);
  const shown = inView.slice(at * PAGE, at * PAGE + PAGE);
  const noAccountShown = view_.noAccount.filter(
    (e) => !needle || [e.name, e.code, e.phone, e.email].some((v) => v?.toLowerCase().includes(needle)),
  );

  const chips: { label: string; clear: () => void }[] = [
    ...(filter ? [{ label: FILTERS.find((f) => f.key === filter)!.label, clear: () => setFilter("") }] : []),
    ...(byApp ? [{ label: `App: ${getApp(byApp)?.name ?? byApp}`, clear: () => setByApp("") }] : []),
    ...(byLevel ? [{ label: `Level: ${byLevel}`, clear: () => setByLevel("") }] : []),
    ...(byDesignation
      ? [{ label: `Designation: ${byDesignation === "none" ? "ERP, none" : (designations.find((d) => d.id === byDesignation)?.name ?? "—")}`, clear: () => setByDesignation("") }]
      : []),
  ];

  return (
    <AdminPage
      title="People & access"
      subtitle="Who can open which app, and how far into it."
      figures={[
        { label: "People", value: String(rows.length), sub: `${view_.inHrms} in HRMS` },
        { label: "Signed in today", value: String(view_.signedInToday), sub: `${view_.liveNow} now` },
        { label: "Disabled", value: String(tabCount.disabled) },
        { label: "Left, still enabled", value: String(tabCount.left), sub: tabCount.left ? "offboard them" : undefined },
        { label: "Never signed in", value: String(rows.filter((r) => r.active && !view_.extras[r.userId]?.lastSignedIn).length) },
        {
          label: "Hats that clash",
          value: String(rows.filter((r) => r.conflicts.length > 0).length),
          tone: rows.some((r) => r.conflicts.length > 0) ? "warn" : undefined,
        },
        {
          label: "Missed new screens",
          value: String(rows.filter((r) => r.active && r.grants.some((g) => g.newScreens.length > 0)).length),
          tone: rows.some((r) => r.active && r.grants.some((g) => g.newScreens.length > 0)) ? "warn" : undefined,
        },
      ]}
      actions={
        <>
          <button type="button" className={btnClass()} onClick={() => exportCsv(picked.size ? rows.filter((r) => picked.has(r.userId)) : inView)}>
            Export CSV
          </button>
          {isPlatformAdmin ? (
            <button type="button" className={btnClass("primary")} onClick={onEnable}>
              Give somebody access
            </button>
          ) : null}
        </>
      }
    >
      <nav aria-label="Tabs" className="-mt-0.5 flex flex-wrap gap-x-[22px] border-b border-line">
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            aria-current={tab === t.key ? "page" : undefined}
            onClick={() => {
              setTab(t.key);
              setPage(0);
            }}
            className={cx(
              "-mb-px flex cursor-pointer items-center gap-1.5 border-b-2 py-2.5 text-[13px] font-semibold whitespace-nowrap",
              tab === t.key ? "border-brand text-ink" : "border-transparent text-muted hover:text-body",
            )}
          >
            {t.label}
            <span className="rounded-full bg-[#eef1f6] px-[7px] py-px text-[11px] font-semibold text-[#4a5670]">{tabCount[t.key]}</span>
          </button>
        ))}
      </nav>

      <div className="flex flex-wrap items-center gap-2.5">
        <input
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setPage(0);
          }}
          aria-label="Find a person"
          placeholder="Name, number, email, employee code"
          className="h-9 w-[300px] rounded-control border border-line-strong bg-surface px-3 text-[13px] text-ink placeholder:text-muted focus:border-brand focus:outline-none"
        />
        {tab !== "no-account" ? (
          <div className="relative">
            <button type="button" className={btnClass()} aria-expanded={filtersOpen} onClick={() => setFiltersOpen((o) => !o)}>
              Filters{chips.length ? ` · ${chips.length}` : ""}
            </button>
            {filtersOpen ? (
              <div className="absolute top-10 left-0 z-40 flex w-[300px] flex-col gap-3 rounded-card border border-line bg-surface p-4 shadow-[0_12px_32px_rgba(15,27,51,0.16)]">
                <FilterSelect label="Show" value={filter} onChange={(v) => { setFilter(v as Filter); setPage(0); }} options={[{ value: "", label: "Everybody in this tab" }, ...FILTERS.map((f) => ({ value: f.key, label: f.label }))]} />
                <FilterSelect label="App" value={byApp} onChange={(v) => { setByApp(v as AppId | ""); setPage(0); }} options={[{ value: "", label: "Any app" }, ...APPS.map((a) => ({ value: a.id, label: a.name }))]} />
                <FilterSelect label="Level" value={byLevel} onChange={(v) => { setByLevel(v as RoleId | ""); setPage(0); }} options={[{ value: "", label: "Any level" }, ...ROLES.map((r) => ({ value: r.id, label: r.label }))]} />
                {designations.length ? (
                  <FilterSelect
                    label="ERP designation"
                    value={byDesignation}
                    onChange={(v) => { setByDesignation(v); setPage(0); }}
                    options={[{ value: "", label: "Any" }, ...designations.map((d) => ({ value: d.id, label: d.name })), { value: "none", label: "ERP, no designation" }]}
                  />
                ) : null}
                <div className="flex justify-end">
                  <button type="button" className={btnClass("plain", "sm")} onClick={() => setFiltersOpen(false)}>
                    Done
                  </button>
                </div>
              </div>
            ) : null}
          </div>
        ) : null}
        {tab !== "no-account"
          ? chips.map((c) => (
              <button
                key={c.label}
                type="button"
                onClick={c.clear}
                aria-label={`Remove filter ${c.label}`}
                className="inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-full bg-brand-soft px-2.5 text-xs font-semibold text-brand-deep"
              >
                {c.label} ✕
              </button>
            ))
          : null}
        <span className="flex-1" />
        {tab === "no-account" ? (
          <span className="text-muted">{noAccountShown.length} without an account</span>
        ) : (
          <span className="flex items-center gap-2 text-muted">
            {inView.length ? `Showing ${at * PAGE + 1}–${Math.min(inView.length, at * PAGE + PAGE)} of ${inView.length}` : "Nobody matches"}
            {pages > 1 ? (
              <>
                <button type="button" className={btnClass("plain", "sm")} disabled={at === 0} onClick={() => setPage(at - 1)} aria-label="Previous page">
                  ‹
                </button>
                <button type="button" className={btnClass("plain", "sm")} disabled={at >= pages - 1} onClick={() => setPage(at + 1)} aria-label="Next page">
                  ›
                </button>
              </>
            ) : null}
          </span>
        )}
      </div>

      {picked.size && isPlatformAdmin && tab !== "no-account" ? (
        <div className="flex flex-wrap items-center gap-2.5 rounded-card bg-ink px-3.5 py-2.5 text-white">
          <b>{picked.size} selected</b>
          <span className="flex-1" />
          <BarButton disabled={bulkBusy} onClick={() => setGiving(true)}>
            Give an app
          </BarButton>
          <BarButton disabled={bulkBusy} onClick={() => void runBulk("Reset link sent", sendPasswordResetFor)}>
            Send reset links
          </BarButton>
          <BarButton disabled={bulkBusy} onClick={() => void runBulk("Sessions ended", endSessionsFor)}>
            End sessions
          </BarButton>
          <BarButton onClick={() => exportCsv(rows.filter((r) => picked.has(r.userId)))}>Export</BarButton>
          <BarButton quiet onClick={() => setPicked(new Set())}>
            Clear
          </BarButton>
        </div>
      ) : null}

      {tab === "no-account" ? (
        <section className="overflow-hidden rounded-card border border-line bg-surface">
          {noAccountShown.length === 0 ? (
            <div className="px-4 py-10 text-center text-muted">Everybody active in HRMS has an account.</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-[13px]">
                <thead>
                  <tr>
                    <AccTh>Person</AccTh>
                    <AccTh>HRMS</AccTh>
                    <AccTh>Mobile</AccTh>
                    <AccTh>Email</AccTh>
                    <AccTh />
                  </tr>
                </thead>
                <tbody>
                  {noAccountShown.map((e) => (
                    <tr key={e.id}>
                      <AccTd>
                        <span className="flex items-center gap-2.5">
                          <Avatar name={e.name} />
                          <b className="font-semibold text-ink">{e.name}</b>
                        </span>
                      </AccTd>
                      <AccTd>
                        {e.code}
                        {e.position ? ` · ${e.position}` : ""}
                      </AccTd>
                      <AccTd>{e.phone ?? "—"}</AccTd>
                      <AccTd>{e.email ?? "—"}</AccTd>
                      <AccTd className="text-right">
                        {isPlatformAdmin ? (
                          <button type="button" className={btnClass("plain", "sm")} onClick={onEnable}>
                            Give access
                          </button>
                        ) : null}
                      </AccTd>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      ) : (
      <section className="overflow-hidden rounded-card border border-line bg-surface">
        {inView.length === 0 ? (
          <div className="px-4 py-10 text-center text-muted">
            {filter === "narrowed"
              ? "Nobody has been narrowed yet."
              : filter === "new-screens"
                ? "Nothing new to decide."
                : filter === "no-app"
                  ? "Everybody has at least one app."
                  : tab === "disabled"
                    ? "Every account can sign in."
                    : "Nobody matches."}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-[13px]">
              <thead>
                <tr>
                  <AccTh className="w-7">
                    <input
                      type="checkbox"
                      aria-label="Select everyone on this page"
                      checked={shown.length > 0 && shown.every((r) => picked.has(r.userId))}
                      onChange={(e) =>
                        setPicked((p) => {
                          const n = new Set(p);
                          for (const r of shown) {
                            if (e.target.checked) n.add(r.userId);
                            else n.delete(r.userId);
                          }
                          return n;
                        })
                      }
                      className="m-0 h-4 w-4 align-middle accent-brand"
                    />
                  </AccTh>
                  <AccTh>Person</AccTh>
                  <AccTh>HRMS</AccTh>
                  <AccTh>Apps (level)</AccTh>
                  <AccTh>Sign-in</AccTh>
                  <AccTh>Last signed in</AccTh>
                  <AccTh />
                </tr>
              </thead>
              <tbody>
                {shown.map((r) => {
                  const ex = view_.extras[r.userId];
                  const never = r.active && !ex?.lastSignedIn;
                  return (
                    <tr key={r.userId} className={cx("[&:last-child>td]:border-b-0", picked.has(r.userId) && "[&>td]:bg-[#f7f5ff]")}>
                      <AccTd>
                        <input
                          type="checkbox"
                          aria-label={`Select ${r.name}`}
                          checked={picked.has(r.userId)}
                          onChange={() => toggle(r.userId)}
                          className="m-0 h-4 w-4 align-middle accent-brand"
                        />
                      </AccTd>
                      <PersonCells row={r} onOpen={() => onOpenUser(r.userId)} position={ex?.position ?? null} say={say} />
                      <AccTd>
                        <AppChips row={r} />
                      </AccTd>
                      <AccTd>
                        {!r.active ? (
                          <Pill tone="muted">Disabled</Pill>
                        ) : never ? (
                          <Pill tone="warn">Never signed in</Pill>
                        ) : (
                          <Pill tone="ok">Enabled</Pill>
                        )}
                      </AccTd>
                      <AccTd>{lastSeen(ex, now)}</AccTd>
                      <AccTd className="text-right">
                        {isPlatformAdmin ? (
                          <span className="inline-flex items-center justify-end gap-1">
                            {never && r.active ? (
                              <button
                                type="button"
                                className={btnClass("plain", "sm")}
                                onClick={() => void sendPasswordResetFor(r.userId).then(say)}
                                title="Mail them a single-use link to set a password"
                              >
                                Send link
                              </button>
                            ) : null}
                            <button
                              type="button"
                              className={btnClass("plain", "sm")}
                              disabled={!r.active}
                              title={r.active ? undefined : "This account cannot sign in. Enable it before changing what it opens."}
                              onClick={() => setManaging(r)}
                            >
                              Manage
                            </button>
                            <PersonMenu
                              row={r}
                              say={say}
                              onManage={() => setManaging(r)}
                              onSwitch={() => setSwitching(r)}
                              onOffboard={() => setOffboarding(r)}
                              onOpen={() => onOpenUser(r.userId)}
                              onLinkEmployee={() => setLinking(r)}
                              onRename={() => setRenaming(r)}
                              onCredential={() => setCrediting(r)}
                              onGotLink={setLinkFor}
                            />
                          </span>
                        ) : null}
                      </AccTd>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
      )}

      {tab !== "no-account" ? (
        <div className="flex flex-wrap items-center gap-3.5 text-muted">
          <span>
            <b className="text-ink">A</b> Associate
          </span>
          <span>
            <b className="text-brand-deep">M</b> Manager
          </span>
          <span>
            <b className="text-ink">Ad</b> Admin
          </span>
          <span>Dashed = narrowed</span>
        </div>
      ) : null}

      {giving ? (
        <GiveAppDialog
          count={picked.size}
          onClose={() => setGiving(false)}
          onGive={async (app, role) => {
            setBulkBusy(true);
            const res = await giveAppTo({ app, role, userIds: [...picked] });
            setBulkBusy(false);
            setGiving(false);
            if (!res.ok) {
              push(res.error, "error");
              return;
            }
            const { moved, skipped } = res.data;
            push(
              skipped.length
                ? `Given to ${moved.length}. Skipped ${skipped.length}: ${skipped.slice(0, 3).map((s) => `${s.name} ${s.why}`).join("; ")}${skipped.length > 3 ? "…" : ""}`
                : `Given to ${moved.length} ${moved.length === 1 ? "person" : "people"}.`,
            );
            setPicked(new Set());
            router.refresh();
          }}
        />
      ) : null}

      {/* Enabling access for somebody new: the picker comes first. */}
      {enabling && isPlatformAdmin ? (
        <AccessDialog
          rows={allRows}
          designations={designations}
          onClose={onEnablingDone}
          onDone={(r) => {
            say(r);
            onEnablingDone();
          }}
          /* Saved, and the dialog stays up to offer a password. The toast
             fires either way, so the list behind it is already right. */
          onSaved={say}
        />
      ) : null}

      {/*
        Turning the sign-in off, and back on.

        Disabling is not revoking: the apps are kept, so a month's leave is one
        click each way and comes back to the book they left. Which is exactly
        why it is worth saying on the dialog — "disabled" and "has no apps" look
        identical from the outside and mean completely different things. Turning
        it OFF goes through the impact modal, which names the sessions it ends,
        the phone it shuts out and the book left with nobody working it; turning
        it back on takes nothing away, so it asks plainly.
      */}
      {offboarding ? (
        <ImpactDialog
          key={`off-${offboarding.userId}`}
          kind="admin-offboard"
          id={offboarding.userId}
          confirmLabel="Offboard"
          onClose={() => setOffboarding(null)}
          onConfirm={async (confirmation) => {
            const r = await offboardPerson(offboarding.userId, confirmation);
            if (r.ok) say(r);
            return r;
          }}
        />
      ) : null}
      {switching?.active ? (
        <ImpactDialog
          key={switching.userId}
          kind="admin-user-disable"
          id={switching.userId}
          confirmLabel="Disable"
          onClose={() => setSwitching(null)}
          onConfirm={async (confirmation) => {
            const r = await setUserActive(switching.userId, false, confirmation);
            if (r.ok) say(r);
            return r;
          }}
        />
      ) : null}
      <Modal
        open={!!switching && !switching.active}
        onClose={() => setSwitching(null)}
        title="Enable this sign-in"
        footer={
          <>
            <Button variant="secondary" onClick={() => setSwitching(null)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              onClick={() => {
                if (!switching) return;
                const { userId } = switching;
                setSwitching(null);
                void setUserActive(userId, true).then(say);
              }}
            >
              Enable
            </Button>
          </>
        }
      >
        {switching && !switching.active ? (
          <div className="text-sm leading-[21px] text-body">
            {switching.name} will be able to sign in again, with the password they
            already have.
            <p className="mt-2">
              {switching.grants.length
                ? `They open what they opened before — ${switching.grants.map((g) => g.appName).join(", ")}.`
                : "They hold no app, so they land on a launcher that says so. Give them one with Manage access."}
            </p>
          </div>
        ) : null}
      </Modal>

      {/*
        A sign-in link, shown once. It is never mailed or stored anywhere
        this screen can show it again — it exists exactly once, here, for
        the admin to copy themselves.
      */}
      <Modal
        open={!!linkFor}
        onClose={() => setLinkFor(null)}
        title={linkFor ? `Sign-in link for ${linkFor.name}` : ""}
        footer={
          <Button variant="secondary" onClick={() => setLinkFor(null)}>
            Close
          </Button>
        }
      >
        {linkFor ? (
          <div className="text-sm leading-[21px] text-body">
            <p>
              Works once, and expires in {linkFor.expiresInMinutes} minutes.
              Opening it signs that browser out of whatever account it
              currently holds and into {linkFor.name}&rsquo;s — their own
              password and sessions elsewhere are untouched.
            </p>
            <div className="mt-3 flex items-center gap-2">
              <input
                readOnly
                value={linkFor.url}
                onFocus={(e) => e.currentTarget.select()}
                className="h-9 min-w-0 flex-1 rounded-[4px] border border-line bg-canvas px-2.5 text-[13px] text-ink"
              />
              <Button
                size="sm"
                variant="primary"
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(linkFor.url);
                    push("Link copied");
                  } catch {
                    push("The browser blocked the clipboard.", "error");
                  }
                }}
              >
                Copy
              </Button>
            </div>
          </div>
        ) : null}
      </Modal>

      {/* Which payroll row this account is. Keyed on the person for the same
          reason the access dialog is: fresh initial state on a remount beats an
          effect resetting it when a prop changes. */}
      {renaming ? (
        <RenameDialog
          key={renaming.userId}
          row={renaming}
          onClose={() => setRenaming(null)}
          onDone={(r) => {
            say(r);
            setRenaming(null);
          }}
        />
      ) : null}

      {linking ? (
        <EmployeeLinkDialog
          key={linking.userId}
          row={linking}
          onClose={() => setLinking(null)}
          onDone={(r) => {
            say(r);
            setLinking(null);
          }}
        />
      ) : null}

      {/* Managing somebody already on the list: straight to the apps. Keyed on
          the person, so the draft is initial state on a fresh mount rather than
          something an effect has to reset. */}
      {managing ? (
        <AccessDialog
          key={managing.userId}
          rows={allRows}
          designations={designations}
          person={managing}
          onClose={() => setManaging(null)}
          onDone={(r) => {
            say(r);
            setManaging(null);
          }}
          onSaved={say}
        />
      ) : null}

      {/* The same page the grant flow ends on, reached from a row. Keyed on
          the person so a second person opens a fresh one rather than the last
          one's password. */}
      {crediting ? (
        <Modal
          open
          onClose={() => setCrediting(null)}
          width={720}
          title={`A password for ${crediting.name}`}
          footer={
            <Button variant="primary" onClick={() => setCrediting(null)}>
              Done
            </Button>
          }
        >
          <CredentialStep
            key={crediting.userId}
            userId={crediting.userId}
            name={crediting.name}
            created={false}
            phone={crediting.phone}
          />
        </Modal>
      ) : null}
    </AdminPage>
  );
}

function PersonCells({
  row,
  onOpen,
  position,
  say,
}: {
  row: AccessRow;
  onOpen: () => void;
  position: string | null;
  say: (r: { ok: boolean; message?: string; error?: string }) => void;
}) {
  const admin = isPlatformAdminRow(row);
  const [busy, setBusy] = React.useState(false);
  const act = (p: Promise<{ ok: boolean; message?: string; error?: string }>) => {
    setBusy(true);
    void p.then((r) => {
      setBusy(false);
      say(r);
    });
  };
  /* One click each way on "Not linked to HRMS": confirm the record the
     directory suggests, or say this account is not an employee at all. */
  const review = !row.notEmployee && row.employeeMatch !== "linked" ? (
    <span className="mt-1 flex flex-wrap items-center gap-1.5 text-[12px]">
      {row.suggestion ? (
        <button
          type="button"
          disabled={busy}
          className="cursor-pointer rounded-[4px] border border-line bg-surface px-1.5 py-0.5 font-medium text-ink hover:bg-canvas disabled:cursor-not-allowed"
          title={`Suggested because the ${row.suggestion.on === "name" ? "name" : row.suggestion.on === "email" ? "email" : "mobile number"} matches`}
          onClick={() => act(linkEmployee({ userId: row.userId, employeeId: row.suggestion!.employeeId }))}
        >
          Link {row.suggestion.employeeCode} {row.suggestion.name}
        </button>
      ) : null}
      <button
        type="button"
        disabled={busy}
        className="cursor-pointer rounded-[4px] border border-line bg-surface px-1.5 py-0.5 text-muted hover:bg-canvas disabled:cursor-not-allowed"
        title="A shared login or an outside person — never matched to a payroll row"
        onClick={() => act(setNotEmployee({ userId: row.userId, notEmployee: true }))}
      >
        Not an employee
      </button>
    </span>
  ) : null;
  return (
    <>
      <AccTd>
        <span className="flex items-center gap-2.5">
          <Avatar name={row.name} tone={admin ? "navy" : "brand"} />
          <span className="min-w-0">
            <button
              type="button"
              onClick={onOpen}
              className="block cursor-pointer border-0 bg-transparent p-0 text-left text-[13px] font-semibold text-ink hover:text-brand"
            >
              {row.name}
            </button>
            <span className="block text-muted">{[row.phone, row.email].filter(Boolean).join(" · ") || "No number or email"}</span>
          </span>
        </span>
      </AccTd>
      <AccTd>
        {row.employeeCode ? (
          <span className="inline-flex items-center gap-1.5">
            {row.employeeCode}
            {position ? ` · ${position}` : ""}
            {row.employeeStatus === "active" ? null : <Pill tone="warn">{row.employeeStatus === "inactive" ? "Left" : "Status unknown"}</Pill>}
            {/* Chosen, or merely matched — a guess decides whose salary shows. */}
            {row.employeeMatch === "guessed" ? (
              <Pill tone="warn" title="Matched on email or work number, not chosen. Link them to be sure.">
                Guessed
              </Pill>
            ) : null}
          </span>
        ) : row.notEmployee ? (
          <span className="text-muted">Not an employee</span>
        ) : (
          <span className="text-muted">Not linked to HRMS</span>
        )}
        {review}
      </AccTd>
    </>
  );
}

/** The short name an app chip carries — "CRM 9/15", not "Telecaller CRM, 9 of 15 screens". */
const SHORT: Partial<Record<AppId, string>> = {
  crm: "CRM",
  sales: "Sales",
  admin: "Admin",
  founder: "Founder",
  enquiries: "Enquiries",
  docs: "Docs",
};
const LEVEL_MARK: Record<RoleId, { mark: string; cls: string }> = {
  associate: { mark: "A", cls: "bg-[#eef1f6] text-[#4a5670]" },
  manager: { mark: "M", cls: "bg-brand-soft text-brand-deep" },
  admin: { mark: "Ad", cls: "bg-ink text-brand-lime" },
};

/** Every app somebody holds, as the canvas's chips: name, screens where narrowed, level. */
function AppChips({ row }: { row: AccessRow }) {
  if (!row.grants.length) return <span className="text-muted">No app</span>;
  const max = 3;
  /* The widest hats first, the Admin Console before the rest, so a platform administrator reads as one. */
  const rank = { admin: 0, manager: 1, associate: 2 } as Record<string, number>;
  const ordered = [...row.grants].sort((a, b) => (rank[a.role] ?? 3) - (rank[b.role] ?? 3) || (a.app === "admin" ? -1 : b.app === "admin" ? 1 : 0));
  const shown = ordered.slice(0, max);
  const rest = ordered.slice(max);
  const fresh = row.grants.reduce((n, g) => n + (g.setOn ? g.newScreens.length : 0), 0);
  return (
    <span className="inline-flex items-center gap-1">
      {shown.map((g) => {
        const lv = LEVEL_MARK[g.role as RoleId] ?? LEVEL_MARK.associate;
        const narrowed = g.grantedCount < g.totalCount;
        const words = [
          `${g.appName}, ${LEVEL_LABELS[g.role] ?? g.role}`,
          narrowed ? `${g.grantedCount} of ${g.totalCount} screens` : g.totalCount === 1 ? "its one screen" : `all ${g.totalCount} screens`,
          ...g.readOnly.map((l) => `${l} read only`),
          ...(g.app === "erp" && row.erpDesignation ? [`${row.erpDesignation.name}${row.erpDesignation.matches ? "" : " (customised)"}`] : []),
        ].join(" · ");
        return (
          <span
            key={g.app}
            title={words}
            className={cx(
              "inline-flex h-[22px] items-stretch overflow-hidden rounded-[5px] border border-line text-[11px] font-semibold whitespace-nowrap text-ink",
              narrowed && "border-dashed",
            )}
          >
            <span className="flex items-center px-1.5">
              {SHORT[g.app] ?? g.appName}
              {narrowed ? ` ${g.grantedCount}/${g.totalCount}` : ""}
            </span>
            <span className={cx("flex items-center px-[5px]", lv.cls)}>{lv.mark}</span>
          </span>
        );
      })}
      {rest.length ? (
        <span title={rest.map((g) => g.appName).join(", ")} className="inline-flex h-[22px] items-center rounded-[5px] border border-line px-1.5 text-[11px] font-semibold text-ink">
          +{rest.length}
        </span>
      ) : null}
      {fresh ? <Pill tone="warn">{fresh} new screen{fresh === 1 ? "" : "s"}</Pill> : null}
      {row.conflicts.length ? (
        <Pill tone="warn" title={row.conflicts.map((c) => c.sentence ?? "").filter(Boolean).join(" ")}>
          Hats clash
        </Pill>
      ) : null}
    </span>
  );
}

function AccTh({ children, className }: { children?: React.ReactNode; className?: string }) {
  return <th className={cx("bg-ink px-3 py-[9px] text-left text-xs font-semibold whitespace-nowrap text-white normal-case tracking-normal", className)}>{children}</th>;
}

function AccTd({ children, className }: { children?: React.ReactNode; className?: string }) {
  return <td className={cx("border-b border-divider px-3 py-2 align-middle whitespace-nowrap", className)}>{children}</td>;
}

function BarButton({ children, onClick, disabled, quiet }: { children: React.ReactNode; onClick: () => void; disabled?: boolean; quiet?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cx(
        "inline-flex h-[30px] cursor-pointer items-center rounded-control border px-2.5 text-xs font-semibold disabled:opacity-50",
        quiet ? "border-transparent text-[#c9d1e3]" : "border-[#3a4766] bg-transparent text-white hover:bg-[#1c2a47]",
      )}
    >
      {children}
    </button>
  );
}

function FilterSelect({ label, value, onChange, options }: { label: string; value: string; onChange: (v: string) => void; options: { value: string; label: string }[] }) {
  return (
    <label className="flex flex-col gap-1 text-xs font-semibold text-body">
      {label}
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="h-9 cursor-pointer rounded-control border border-line-strong bg-surface px-2 text-[13px] font-normal text-ink"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}

/** Pick the app and the level to give everybody selected. It only ever widens. */
function GiveAppDialog({ count, onClose, onGive }: { count: number; onClose: () => void; onGive: (app: AppId, role: RoleId) => Promise<void> }) {
  const [app, setApp] = React.useState<AppId | "">("");
  const [role, setRole] = React.useState<RoleId>("associate");
  const [busy, setBusy] = React.useState(false);
  return (
    <Modal
      open
      onClose={onClose}
      title={`Give an app to ${count} ${count === 1 ? "person" : "people"}`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={!app || busy}
            onClick={async () => {
              if (!app) return;
              setBusy(true);
              await onGive(app, role);
            }}
          >
            Give it
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3 text-sm text-body">
        <FilterSelect label="App" value={app} onChange={(v) => setApp(v as AppId)} options={[{ value: "", label: "Choose an app" }, ...APPS.map((a) => ({ value: a.id, label: a.name }))]} />
        <FilterSelect label="Level" value={role} onChange={(v) => setRole(v as RoleId)} options={ROLES.map((r) => ({ value: r.id, label: app ? levelOptionLabel(r.id, app, getApp(app)?.name ?? app) : r.label }))} />
        <p className="m-0 text-[13px] text-muted">
          The whole app, every screen. Somebody who holds it already keeps what they have, at the wider of the two levels. Nothing is taken away.
        </p>
      </div>
    </Modal>
  );
}

const DAY = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" });
const CLOCK = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit", hour12: false });
const SHORT_DATE = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kolkata", day: "numeric", month: "short" });

/** "Now", "Today 09:04", "Yesterday 18:40", "3 Nov", or a dash for never. */
function lastSeen(ex: PersonExtras | undefined, now: number): string {
  if (!ex?.lastSignedIn) return "—";
  const at = new Date(ex.lastSignedIn);
  if (Number.isNaN(at.getTime())) return "—";
  const day = DAY.format(at);
  if (day === DAY.format(new Date(now))) return ex.liveNow && now - at.getTime() < 15 * 60_000 ? "Now" : `Today ${CLOCK.format(at)}`;
  if (day === DAY.format(new Date(now - 86_400_000))) return `Yesterday ${CLOCK.format(at)}`;
  return SHORT_DATE.format(at);
}

function PersonMenu({
  row,
  say,
  onManage,
  onSwitch,
  onOffboard,
  onOpen,
  onLinkEmployee,
  onRename,
  onCredential,
  onGotLink,
}: {
  row: AccessRow;
  say: (r: { ok: boolean; message?: string; error?: string }) => void;
  onManage: () => void;
  onSwitch: () => void;
  onOffboard: () => void;
  onOpen: () => void;
  onLinkEmployee: () => void;
  onRename: () => void;
  onCredential: () => void;
  onGotLink: (link: { name: string; url: string; expiresInMinutes: number }) => void;
}) {
  return (
    <RowMenu
      items={[
        {
          label: "Manage access",
          disabled: !row.active,
          title: row.active ? undefined : "This account cannot sign in",
          onSelect: onManage,
        },
        {
          label: row.active ? "Disable this sign-in" : "Enable this sign-in",
          destructive: row.active,
          onSelect: onSwitch,
        },
        {
          label: "Offboard — they have left…",
          destructive: true,
          disabled: !row.active && row.grants.length === 0,
          title:
            !row.active && row.grants.length === 0
              ? "Already off, with nothing left to take away"
              : "Turn the sign-in off and take every app, power, seat and assignment away — for somebody who has left, not somebody on leave",
          onSelect: onOffboard,
        },
        { label: "Open their record", onSelect: onOpen },
        { label: "Rename", onSelect: onRename },
        ...(row.notEmployee
          ? [{ label: "They are an employee after all", onSelect: () => void setNotEmployee({ userId: row.userId, notEmployee: false }).then(say) }]
          : []),
        {
          /* Not hidden where a row was already guessed: a guess is exactly what
             somebody would come here to confirm or correct. */
          label:
            row.employeeMatch === "linked"
              ? "Change the HRMS record"
              : "Link an HRMS record",
          onSelect: onLinkEmployee,
        },
        {
          /* Two ways to give somebody a password and they are not the same
             act: this one goes to a mailbox and lets them choose it, which is
             better wherever they have a work email they read. The one below
             is for everybody else — most of the field staff. */
          label: "Email a password-reset link",
          disabled: !row.active || !row.email,
          title: !row.active
            ? "This account cannot sign in"
            : !row.email
              ? "This account has no work email to send a link to. Generate a password to read out instead."
              : undefined,
          onSelect: () => void sendPasswordResetFor(row.userId).then(say),
        },
        {
          label: "Generate a password to read out",
          destructive: true,
          disabled: !row.active,
          title: row.active
            ? "Replaces their current password and signs them out everywhere"
            : "This account cannot sign in",
          onSelect: onCredential,
        },
        {
          label: "End every session",
          onSelect: () => void endSessionsFor(row.userId).then(say),
        },
        /* Only a platform administrator may sign in as somebody else — see
           `mintImpersonationLink` — and the whole menu is drawn only for one,
           so the item needs no gate of its own. */
        {
          label: `Login as ${row.name.split(" ")[0]}`,
          disabled: !row.active,
          title: row.active
            ? "Opens a one-time link that signs in as this person, with no password"
            : "This account cannot sign in",
          onSelect: () =>
            void mintImpersonationLink(row.userId).then((r) => {
              if (r.ok) onGotLink({ name: row.name, ...r.data });
              else say(r);
            }),
        },
      ]}
    />
  );
}

/* ------------------------------------------------------------- the dialog */

type Step = "who" | "access" | "review" | "done";

/** What somebody holds today, as the dialog's draft: app → modules ticked. */
function draftOf(row: AccessRow | null): Draft {
  const out: Draft = {};
  for (const g of row?.grants ?? []) {
    out[g.app] = g.modules.filter((m) => m.granted).map((m) => m.key);
  }
  return out;
}

/**
 * What the dialog OPENS with: what they hold, plus HRMS if they do not hold it.
 *
 * Everybody in MahekOne holds HRMS as an associate — their own attendance,
 * leave and payslips, nobody else's — so it arrives ticked, at associate,
 * because `levelOf` reads an unsaid level as associate. It is a starting
 * point and not a rule: untick it and it stays off, and the review page names
 * the grant like any other before anything is written.
 */
function startingDraft(row: AccessRow | null): Draft {
  const out = draftOf(row);
  if (!out.hrms) out.hrms = DEFAULT_OF("hrms");
  return out;
}

/** The level each app is held under today. Never the account's: see `AppGrant.role`. */
function levelsOf(row: AccessRow | null): Record<string, RoleId> {
  const out: Record<string, RoleId> = {};
  for (const g of row?.grants ?? []) out[g.app] = g.role;
  return out;
}

function AccessDialog({
  person,
  rows,
  designations,
  onClose,
  onDone,
  onSaved,
}: {
  /** Somebody already on the list. Absent means start from the picker. */
  person?: AccessRow;
  /**
   * Everybody on the list, so somebody picked from the employee master who
   * ALREADY has an account starts from what they actually hold.
   *
   * The picker used to seed such a person with every app they held at its
   * default modules and no levels at all — so a CRM manager narrowed to six
   * screens, reached through Enable access rather than through their own row,
   * was offered back as a whole-CRM associate, and saving without looking
   * would have written exactly that.
   */
  rows: AccessRow[];
  designations: ErpDesignationDef[];
  onClose: () => void;
  onDone: (r: { ok: boolean; message?: string; error?: string }) => void;
  /** Saved, but not finished with — the dialog is still open behind the toast. */
  onSaved: (r: { ok: boolean; message?: string; error?: string }) => void;
}) {
  const [step, setStep] = React.useState<Step>(person ? "access" : "who");
  /** The account the review compares against: the row managed, or the one picked. */
  const [basis, setBasis] = React.useState<AccessRow | null>(person ?? null);
  const [chosen, setChosen] = React.useState<Candidate | null>(
    person
      ? {
          userId: person.userId,
          employeeId: null,
          employeeCode: person.employeeCode,
          name: person.name,
          email: person.email,
          phone: person.phone,
          department: person.department,
          position: null,
          office: null,
          employeeStatus: person.employeeStatus,
          accountActive: person.active,
          /* Somebody already on the Access table: their account is in use. */
          setUp: true,
          apps: person.grants.map((g) => g.app),
          blocked: null,
        }
      : null,
  );

  /** What they hold today, so the review can say what actually changes. */
  const before: Draft = React.useMemo(() => draftOf(basis), [basis]);
  const levelsBefore = React.useMemo(() => levelsOf(basis), [basis]);

  const [draft, setDraft] = React.useState<Draft>(() => startingDraft(basis));
  /* SCREENS NOBODY HAS DECIDED FOR THEM: shipped after a narrowed grant was
     last saved. Drawn with a "new" mark beside their boxes, and sent with the
     save so that leaving one out is recorded as a decision rather than as
     the same silence that made it invisible. */
  const fresh: Fresh = React.useMemo(
    () =>
      Object.fromEntries(
        (basis?.grants ?? [])
          .filter((g) => g.newScreens.length && g.setOn)
          .map((g) => [g.app, { keys: g.newScreens.map((m) => m.key), labels: g.newScreens.map((m) => m.label), setOn: g.setOn! }]),
      ),
    [basis],
  );
  const freshInDraft = Object.keys(fresh).filter((a) => draft[a]);
  /* THE ERP'S POWERS, beside the ERP grant: who verifies tests, who sees
     purchase money. Sent only while the ERP is ticked — unticking it takes the
     powers with it, the same as its screens. */
  const powersBefore = React.useMemo(() => basis?.erpPowers ?? [], [basis]);
  const [powers, setPowers] = React.useState<string[]>(powersBefore);
  /* HRMS's powers, the same way: who is HR, who approves leave, who runs
     payroll. Unticking HRMS takes them with it. */
  const hrmsPowersBefore = React.useMemo(() => basis?.hrmsPowers ?? [], [basis]);
  const [hrmsPowers, setHrmsPowers] = React.useState<string[]>(hrmsPowersBefore);
  /* THE TASKS PERMISSIONS: who reaches past the org chart — sees, gives to or
     manages anybody's tasks — and who runs the automatic tasks. Unticking
     Tasks takes them with it. */
  const taskPowersBefore = React.useMemo(() => basis?.taskPowers ?? [], [basis]);
  const [taskPowers, setTaskPowers] = React.useState<string[]>(taskPowersBefore);
  /* HIRE'S ROLE — their job inside Hire. Null means the level decides.
     Unticking Hire takes it with it, like the powers above. */
  const hireRoleBefore = basis?.hireRole ?? null;
  const [hireRole, setHireRole] = React.useState<string | null>(hireRoleBefore);
  /* THE FACTORY FLOOR — which department, and their seat in its crew. With
     the Factory level it is their department-level permission. Unticking
     Factory takes it with it. */
  const placeBefore = basis?.factoryPlace ?? null;
  const [factoryPlace, setFactoryPlace] = React.useState<FactoryPlace | null>(placeBefore);
  /* THE ERP DESIGNATION — the name on their ERP access, and the link an edit
     to it follows. Picking one sets the screens, level and powers below;
     changing any of those afterwards leaves the name and marks them
     customised. */
  const designationBefore = basis?.erpDesignation?.id ?? null;
  const [designationId, setDesignationId] = React.useState<string | null>(designationBefore);
  /*
   * WHICH LEVEL EACH APP IS HELD UNDER, beside the screens it opens.
   *
   * A person is a manager in the CRM and a clerk in Accounts — different
   * powers over different data, not one power applied twice. Seeded from what
   * they hold today. An app ticked for the first time is held as an
   * ASSOCIATE until somebody chooses otherwise: it used to inherit the
   * account's own level, so ticking Accounts for a CRM manager quietly made
   * them an Accounts manager — order approval, granted by a checkbox that was
   * only meant to open a screen.
   */
  const [roleDraft, setRoleDraft] = React.useState<Record<string, RoleId>>(levelsBefore);
  const [email, setEmail] = React.useState(person?.email ?? "");
  const [phone, setPhone] = React.useState(person?.phone ?? "");
  const [saving, setSaving] = React.useState(false);
  const [fieldError, setFieldError] = React.useState<Record<string, string>>({});

  /* Nobody's account in use yet: the one HRMS gave them automatically is set
     up here, with a way to sign in, exactly as a brand new one used to be. */
  const needsAccount = !!chosen && (!chosen.userId || !chosen.setUp);

  const pick = (c: Candidate) => {
    const existing = c.userId ? (rows.find((r) => r.userId === c.userId) ?? null) : null;
    setChosen(c);
    setBasis(existing);
    setEmail(c.email ?? "");
    setPhone(c.phone ?? "");
    // Somebody already holding apps arrives with what they hold — modules,
    // levels and powers — not empty and not defaulted: this dialog sets the
    // whole picture, so it has to start from the picture.
    setDraft(startingDraft(existing));
    setRoleDraft(levelsOf(existing));
    setPowers(existing?.erpPowers ?? []);
    setHrmsPowers(existing?.hrmsPowers ?? []);
    setTaskPowers(existing?.taskPowers ?? []);
    setHireRole(existing?.hireRole ?? null);
    setFactoryPlace(existing?.factoryPlace ?? null);
    setDesignationId(existing?.erpDesignation?.id ?? null);
    setFieldError({});
    setStep("access");
  };

  /* WHAT THE SAVE PRODUCED, so the last page can ask the right question. A
     brand new account has a password nobody has ever been told; an existing
     one may have somebody signed in on theirs right now, and generating a
     replacement takes that away. Only this component knows which, so the
     wording lives here rather than being guessed at in the action. */
  const [saved, setSaved] = React.useState<{ created: boolean; userId: string } | null>(null);

  /** The level an app will be saved under. Unsaid is associate, as on the server. */
  const levelOf = (app: string): RoleId => roleDraft[app] ?? "associate";

  /* Taking an app away is confirmed through the impact modal — the powers,
     the factory place and the phone that go with it — before anything is
     written. A save that only grants, narrows or changes a level goes straight
     through, as it always did. */
  const [confirmingRevoke, setConfirmingRevoke] = React.useState(false);

  const submit = (confirmation?: ImpactConfirmation): Promise<Result<unknown>> => {
    if (!chosen) return Promise.resolve({ ok: false, error: "Nobody was chosen." });
    setSaving(true);
    setFieldError({});
    return setAccess({
      userId: needsAccount ? null : chosen.userId,
      employeeId: chosen.employeeId,
      grants: Object.entries(draft).map(([app, modules]) => ({
        app,
        modules,
        role: levelOf(app),
      })),
      erpPowers: draft.erp ? powers : [],
      hrmsPowers: draft.hrms ? hrmsPowers : [],
      taskPowers: draft.tasks ? taskPowers : [],
      hireRole: draft.hire ? hireRole : null,
      factoryPlace: draft.factory ? factoryPlace : null,
      erpDesignationId: draft.erp ? designationId : null,
      /* No level on the account. It is DERIVED from the per-app levels by the
         action, and the select that used to sit here could make a platform
         administrator out of somebody given nothing but associate grants. */
      account: needsAccount ? { email: email.trim() || null, phone: phone.trim() || null } : undefined,
      confirmation,
      reviewedNew: freshInDraft,
    }).then((r) => {
      setSaving(false);
      if (!r.ok && r.fieldErrors?.length) {
        // A field error belongs to the page that carries the field, so the
        // review page hands back rather than showing a message about a box
        // that is not on it.
        setFieldError(Object.fromEntries(r.fieldErrors.map((f) => [f.field, f.message])));
        setConfirmingRevoke(false);
        setStep("access");
        return r;
      }
      /* The impact modal shows its own refusal, and reloads on `conflict`. */
      if (!r.ok && confirmation) return r;
      /* SAVED, AND THE DIALOG STAYS OPEN TO ASK ONE MORE THING. The access is
         written and the toast says so — nothing here is pending — but a person
         who cannot sign in has not been set up, and the moment the office is
         thinking about this person is the only moment they will do anything
         about it. Closing on success is what left every new account holding a
         password nobody knew. */
      if (r.ok) {
        setSaved({ created: r.data.created, userId: r.data.userId });
        setStep("done");
        onSaved(r);
        return r;
      }
      onDone(r);
      return r;
    });
  };

  const powersAfter = draft.erp ? powers : [];
  const powersChanged = powersAfter.length !== powersBefore.length || powersAfter.some((p) => !powersBefore.includes(p));
  const levelsAfter: Record<string, RoleId> = Object.fromEntries(Object.keys(draft).map((a) => [a, levelOf(a)]));
  const moduleChanges = describeChanges(before, draft, levelsBefore, levelsAfter);
  const hrmsPowersAfter = draft.hrms ? hrmsPowers : [];
  const hrmsPowersChanged =
    hrmsPowersAfter.length !== hrmsPowersBefore.length || hrmsPowersAfter.some((p) => !hrmsPowersBefore.includes(p));
  const taskPowersAfter = draft.tasks ? taskPowers : [];
  const taskPowersChanged =
    taskPowersAfter.length !== taskPowersBefore.length || taskPowersAfter.some((p) => !taskPowersBefore.includes(p));
  const designationAfter = draft.erp ? designationId : null;
  const designationChanged = designationAfter !== designationBefore;
  const designationName = (id: string | null) => (id ? (designations.find((d) => d.id === id)?.name ?? "a removed designation") : null);
  const designationNow = designationAfter ? (designations.find((d) => d.id === designationAfter) ?? null) : null;
  const standingAfter = designationNow ? standingOf(designationNow, draft.erp ?? [], levelOf("erp"), powers) : null;
  const hireRoleAfter = draft.hire ? hireRole : null;
  const hireRoleChanged = hireRoleAfter !== hireRoleBefore;
  const placeAfter = draft.factory ? factoryPlace : null;
  const placeChanged = JSON.stringify(placeAfter) !== JSON.stringify(placeBefore);
  /* The footer's count: one per app moved, plus one for each power list, role or place changed. */
  const changeCount =
    moduleChanges.granted.length +
    moduleChanges.revoked.length +
    moduleChanges.narrowed.length +
    moduleChanges.widened.length +
    moduleChanges.releveled.length +
    [powersChanged, hrmsPowersChanged, taskPowersChanged, designationChanged, hireRoleChanged, placeChanged].filter(Boolean).length;
  const changes = { ...moduleChanges, any: moduleChanges.any || freshInDraft.length > 0 || powersChanged || hrmsPowersChanged || taskPowersChanged || designationChanged || hireRoleChanged || placeChanged };

  return (
    <>
      <Modal
        open
        onClose={onClose}
        width={1000}
        title={
          <div className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center gap-2.5">
              <span className="text-lg font-bold text-ink">
                {step === "who"
                  ? "Give somebody access"
                  : step === "done"
                    ? `${chosen?.name} can now sign in`
                    : `Manage access · ${chosen?.name}`}
              </span>
              {step !== "who" && chosen?.employeeCode ? <Pill tone="brand">{chosen.employeeCode}</Pill> : null}
            </div>
            {step !== "done" ? (
              <div className="flex flex-wrap items-center gap-[22px] text-[13px] font-semibold">
                {(
                  [
                    ["who", "Person"],
                    ["access", "Apps & screens"],
                    ["review", "Review"],
                  ] as const
                ).map(([s_, label], i, list) => {
                  const at = list.findIndex(([k]) => k === step);
                  const done = i < at;
                  const on = i === at;
                  return (
                    <React.Fragment key={s_}>
                      {i ? <span aria-hidden className="h-px w-10 bg-line" /> : null}
                      <span className={cx("flex items-center gap-2", on ? "text-ink" : "text-muted")}>
                        <i
                          className={cx(
                            "inline-flex h-[22px] w-[22px] items-center justify-center rounded-full border-[1.5px] text-[11px] not-italic",
                            done ? "border-success bg-success text-white" : on ? "border-brand bg-brand text-white" : "border-line-strong",
                          )}
                        >
                          {done ? "✓" : i + 1}
                        </i>
                        {label}
                      </span>
                    </React.Fragment>
                  );
                })}
              </div>
            ) : null}
          </div>
        }
        footer={
          step === "done" ? (
            /* One way out, and it is not "Cancel" — there is nothing left to
               cancel. The access is written whatever happens on this page. */
            <Button variant="primary" onClick={onClose}>
              Done
            </Button>
          ) : (
            <>
              {step !== "who" && changeCount ? (
                <span className="mr-auto self-center">
                  <Pill tone="brand">
                    {changeCount} change{changeCount === 1 ? "" : "s"}
                  </Pill>
                </span>
              ) : null}
              <Button
                variant="secondary"
                onClick={() => {
                  if (step === "review") return setStep("access");
                  if (step === "access" && !person) return setStep("who");
                  onClose();
                }}
              >
                {step === "review" || (step === "access" && !person) ? "Back" : "Cancel"}
              </Button>
              {step === "access" ? (
                <Button variant="primary" onClick={() => setStep("review")}>
                  Review changes
                </Button>
              ) : step === "review" ? (
                <Button
                  variant={changes.revoked.length ? "danger" : "primary"}
                  disabled={saving || !changes.any}
                  title={changes.any ? undefined : "Nothing has changed"}
                  onClick={() => (chosen?.userId && changes.revoked.length ? setConfirmingRevoke(true) : void submit())}
                >
                  {saving ? "Saving…" : "Grant access"}
                </Button>
              ) : null}
            </>
          )
        }
      >
        {step === "who" ? (
          <WhoStep onPick={pick} />
        ) : step === "access" ? (
          <AccessStep
            needsAccount={needsAccount}
            name={chosen?.name ?? ""}
            email={email}
            phone={phone}
            onEmail={setEmail}
            onPhone={setPhone}
            draft={draft}
            held={before}
            onDraft={setDraft}
            roleDraft={roleDraft}
            onRoleDraft={setRoleDraft}
            fieldError={fieldError}
            powers={powers}
            onPowers={setPowers}
            hrmsPowers={hrmsPowers}
            onHrmsPowers={setHrmsPowers}
            taskPowers={taskPowers}
            onTaskPowers={setTaskPowers}
            hireRole={hireRole}
            onHireRole={setHireRole}
            factoryPlace={factoryPlace}
            onFactoryPlace={setFactoryPlace}
            designations={designations}
            designationId={designationId}
            onDesignation={setDesignationId}
            fresh={fresh}
          />
        ) : step === "review" ? (
          <ReviewStep
            name={chosen?.name ?? ""}
            creating={needsAccount}
            email={email}
            phone={phone}
            changes={changes}
            draft={draft}
            levels={levelsAfter}
            powerChange={powersChanged ? { before: powersBefore, after: powersAfter } : null}
            hrmsPowerChange={hrmsPowersChanged ? { before: hrmsPowersBefore, after: hrmsPowersAfter } : null}
            taskPowerChange={taskPowersChanged ? { before: taskPowersBefore, after: taskPowersAfter } : null}
            hireRoleChange={hireRoleChanged && draft.hire ? { before: hireRoleBefore, after: hireRoleAfter, level: levelOf("hire") } : null}
            placeChange={placeChanged && draft.factory ? { before: placeBefore, after: placeAfter, level: levelOf("factory") } : null}
            fresh={Object.fromEntries(freshInDraft.map((a) => [a, fresh[a]]))}
            designationChange={
              designationChanged || (designationNow && standingAfter && !standingAfter.matches)
                ? { before: designationName(designationBefore), after: designationName(designationAfter), standing: standingAfter }
                : null
            }
          />
        ) : (
          <CredentialStep
            userId={saved?.userId ?? ""}
            name={chosen?.name ?? ""}
            created={saved?.created ?? false}
            phone={phone.trim() || chosen?.phone || null}
          />
        )}
      </Modal>
      {confirmingRevoke && chosen?.userId ? (
        <ImpactDialog
          key={accessRevokeKey(chosen.userId, changes.revoked)}
          kind={ACCESS_REVOKE_KIND}
          id={accessRevokeKey(chosen.userId, changes.revoked)}
          confirmLabel="Take them away"
          onClose={() => setConfirmingRevoke(false)}
          onConfirm={(confirmation) => submit(confirmation)}
        />
      ) : null}
    </>
  );
}

/* --------------------------------------------------------------- step four */

/**
 * The page that ASKS.
 *
 * Granting access does not mint a password — the office decides. A credential
 * that appeared unasked would be one left on a screen somebody walks away
 * from, and on an existing account it would sign somebody out mid-call with no
 * warning at all.
 *
 * What it exists to prevent is the state this flow used to end in: an account
 * granted four apps, a welcome email telling the employee to wait for a code
 * that is never sent, and a password `randomUUID()` chose. Everything was
 * green and nobody could sign in.
 */
function CredentialStep({
  userId,
  name,
  created,
  phone,
}: {
  userId: string;
  name: string;
  /** Whether the grant that just ran created the account. */
  created: boolean;
  phone: string | null;
}) {
  const [issued, setIssued] = React.useState<IssuedCredential | null>(null);
  const [working, setWorking] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [copied, setCopied] = React.useState(false);

  const first = name.split(" ")[0];

  const generate = () => {
    setWorking(true);
    setError(null);
    void issueCredential(userId).then((r) => {
      setWorking(false);
      if (r.ok) setIssued(r.data);
      else setError(r.error);
    });
  };

  if (issued) {
    return (
      <div>
        <div className="rounded-[4px] border border-line bg-canvas px-4 py-3.5">
          <p className="text-[13px] text-body">
            Read this out to {first}, or copy it into a message. {" "}
            <span className="font-medium text-ink">
              It is not stored anywhere and cannot be shown again
            </span>{" "}
            — closing this box is the last time anyone sees it.
          </p>

          <div className="mt-3 grid grid-cols-[auto_1fr] items-baseline gap-x-4 gap-y-2">
            <span className="text-xs font-medium tracking-[0.04em] text-muted uppercase">
              Signs in with
            </span>
            <span className="font-mono text-[15px] text-ink">{issued.signInWith}</span>

            <span className="text-xs font-medium tracking-[0.04em] text-muted uppercase">
              Password
            </span>
            <span className="flex flex-wrap items-center gap-2">
              <span className="rounded-[4px] border border-line bg-surface px-2.5 py-1 font-mono text-[19px] tracking-[0.08em] text-ink select-all">
                {issued.password}
              </span>
              <Button
                variant="secondary"
                onClick={() => {
                  void navigator.clipboard
                    ?.writeText(issued.password)
                    .then(() => setCopied(true))
                    .catch(() => setError("This browser would not let the page copy. Read it out instead."));
                }}
              >
                {copied ? "Copied" : "Copy"}
              </Button>
            </span>
          </div>

          {/* THE DASH COUNTS. It is in the string and in the hash, so somebody
              who leaves it out is refused — which reads as a wrong password
              rather than as a mistyped one. */}
          <p className="mt-3 text-[13px] text-muted">
            The dash is part of the password. Letters are capitals. Ask {first} to
            change it once they are in, from Forgot password on the sign-in screen.
          </p>
        </div>

        {issued.sessionsEnded > 0 ? (
          <p className="mt-3 text-[13px] text-body">
            {issued.sessionsEnded === 1
              ? `${first} was signed in somewhere and has been signed out — the old password no longer works.`
              : `${first} was signed in on ${issued.sessionsEnded} devices and has been signed out of all of them — the old password no longer works.`}
          </p>
        ) : null}

        {error ? <p className="mt-3 text-[13px] text-danger">{error}</p> : null}
      </div>
    );
  }

  return (
    <div>
      <div className="rounded-[4px] border border-line bg-canvas px-4 py-3.5">
        <p className="text-[15px] font-medium text-ink">
          {created
            ? `Generate a password for ${first}?`
            : `Give ${first} a new password?`}
        </p>
        <p className="mt-1.5 text-[13px] text-body">
          {created ? (
            <>
              The account exists and the apps are granted, but nobody can sign into it
              yet — a new account is created with a password nobody knows, and nothing
              has been emailed to anyone. Generate one to read out or paste into a
              message. If {first} has a work email they can set their own instead, from
              Forgot password on the sign-in screen.
            </>
          ) : (
            <>
              Only if they cannot get in. This{" "}
              <span className="font-medium text-ink">replaces the password they have now</span>{" "}
              and signs them out everywhere, so do not do it to somebody who is working.
              A reset link from their row menu lets them choose their own instead.
            </>
          )}
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Button
            variant={created ? "primary" : "danger"}
            disabled={working || !userId}
            onClick={generate}
          >
            {working
              ? "Generating…"
              : created
                ? "Generate a password"
                : "Replace their password"}
          </Button>
          <span className="text-[13px] text-muted">
            {phone
              ? `They sign in with ${phone} and this password.`
              : "They sign in with their work email and this password."}
          </span>
        </div>
        {error ? <p className="mt-2.5 text-[13px] text-danger">{error}</p> : null}
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- step one */

function WhoStep({ onPick }: { onPick: (c: Candidate) => void }) {
  const [people, setPeople] = React.useState<Candidate[] | null>(null);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [query, setQuery] = React.useState("");
  const [reload, setReload] = React.useState(0);

  // Read on open rather than passed down with the page: somebody who has just
  // been added to the employee sheet and synced is pickable without a reload.
  //
  // The effect starts the read and nothing else — the state lands in the
  // promise's callback, which is what keeps it out of the render path the
  // React Compiler rules are about.
  React.useEffect(() => {
    let live = true;
    void candidatesForGrant().then((r) => {
      if (!live) return;
      if (r.ok) setPeople(r.data);
      else setLoadError(r.error);
    });
    return () => {
      live = false;
    };
  }, [reload]);

  const matches = (people ?? []).filter((c) => {
    const q = query.trim().toLowerCase();
    if (!q) return true;
    return [c.name, c.email, c.phone, c.employeeCode, c.department, c.position]
      .filter(Boolean)
      .some((v) => String(v).toLowerCase().includes(q));
  });

  return (
    <div>
      <div className="flex items-center gap-2">
        <Input
          autoFocus
          placeholder="Search the HRMS directory"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <Button
          size="sm"
          variant="secondary"
          onClick={() => {
            setPeople(null);
            setLoadError(null);
            setReload((n) => n + 1);
          }}
        >
          Refresh
        </Button>
      </div>
      <p className="mt-1.5 text-[13px] leading-[19px] text-muted">
        Everybody in the HRMS People directory, once each. Only somebody active in HRMS can be
        given access — a leaver is listed with the reason rather than hidden.
      </p>

      {loadError ? (
        <p className="mt-4 text-sm text-danger">{loadError}</p>
      ) : people === null ? (
        <p className="mt-4 text-sm text-muted">Reading the employee master…</p>
      ) : matches.length === 0 ? (
        <p className="mt-4 text-sm text-muted">Nobody matches “{query}”.</p>
      ) : (
        <div className="mt-2 max-h-[52vh] overflow-auto rounded-[4px] border border-line">
          {matches.map((c) => (
            <button
              key={c.employeeId ?? c.userId}
              disabled={!!c.blocked}
              title={c.blocked ?? undefined}
              onClick={() => onPick(c)}
              className={cx(
                "flex w-full items-baseline gap-2.5 border-0 border-b border-divider bg-transparent px-2.5 py-1.5 text-left last:border-b-0",
                c.blocked ? "cursor-not-allowed opacity-60" : "cursor-pointer hover:bg-canvas",
              )}
            >
              {/* One line per person: the name, then everything that tells
                  two people of the same name apart, in the space left over. */}
              <span className="w-[13rem] flex-none truncate text-[13px] font-medium text-ink">
                {c.name}
              </span>
              <span className="min-w-0 flex-1 truncate text-[13px] text-muted">
                {[c.employeeCode, c.position ?? c.department, c.email ?? c.phone]
                  .filter(Boolean)
                  .join(" · ") || "No contact details on file"}
              </span>
              {c.blocked ? (
                <span className="flex-none text-[11px] whitespace-nowrap text-muted">
                  {c.blocked}
                </span>
              ) : (
                <>
                  {c.userId && c.setUp ? null : (
                    <span className="flex-none rounded-[3px] bg-brand-soft px-1.5 text-[11px] font-medium text-[#5223E0]">
                      not set up
                    </span>
                  )}
                  <span className="w-[3.5rem] flex-none text-right text-[11px] whitespace-nowrap text-muted">
                    {c.apps.length
                      ? `${c.apps.length} app${c.apps.length === 1 ? "" : "s"}`
                      : ""}
                  </span>
                </>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/* ---------------------------------------------------------------- step two */

/**
 * Every app, and every module of every app, on one page.
 *
 * The app's own checkbox is derived rather than stored: an app is granted if
 * and only if at least one of its modules is ticked. That removes the one
 * invalid state this screen could otherwise express — an app held with nothing
 * inside it, whose every route redirects somewhere else — instead of drawing it
 * and then refusing it at the save.
 *
 * It is DENSE on purpose. Somebody setting up a telecaller is answering forty
 * small yes-or-no questions, and the answer to each is one word — so the space
 * belongs to the words, not around them. Every module in an app is meant to be
 * readable without scrolling past the app it belongs to; the sentence
 * explaining what unticking does is said once at the top rather than repeated
 * inside all seven blocks.
 */
function AccessStep({
  needsAccount,
  name,
  email,
  phone,
  onEmail,
  onPhone,
  draft,
  held,
  onDraft,
  roleDraft,
  onRoleDraft,
  fieldError,
  powers,
  onPowers,
  hrmsPowers,
  onHrmsPowers,
  taskPowers,
  onTaskPowers,
  hireRole,
  onHireRole,
  factoryPlace,
  onFactoryPlace,
  designations,
  designationId,
  onDesignation,
  fresh,
}: {
  needsAccount: boolean;
  name: string;
  email: string;
  phone: string;
  onEmail: (v: string) => void;
  onPhone: (v: string) => void;
  draft: Draft;
  /** What they held when the dialog opened — a retired app is drawn only if it is here. */
  held: Draft;
  onDraft: (next: Draft) => void;
  /** The level each granted app is held under. Absent is associate. */
  roleDraft: Record<string, RoleId>;
  onRoleDraft: (next: Record<string, RoleId>) => void;
  fieldError: Record<string, string>;
  /** The ERP's special powers, drawn under the ERP app while it is ticked. */
  powers: string[];
  onPowers: (next: string[]) => void;
  /** HRMS's special powers, drawn under HRMS while it is ticked. */
  hrmsPowers: string[];
  onHrmsPowers: (next: string[]) => void;
  /** The Tasks permissions, drawn under Tasks while it is ticked. */
  taskPowers: string[];
  onTaskPowers: (next: string[]) => void;
  /** Their job inside Hire; null lets the level decide. */
  hireRole: string | null;
  onHireRole: (role: string | null) => void;
  /** Where they work on the factory floor; null until a department is picked. */
  factoryPlace: FactoryPlace | null;
  onFactoryPlace: (p: FactoryPlace | null) => void;
  designations: ErpDesignationDef[];
  designationId: string | null;
  onDesignation: (id: string | null) => void;
  /** Screens shipped after each narrowed grant was last saved. */
  fresh: Fresh;
}) {
  /* PICKING A DESIGNATION WRITES WHAT IT HOLDS — screens, level and powers in
     one move, through the same `draftFor` the server's own reading of
     "matches" is built from, so what is picked here is what then matches. */
  const pickDesignation = (id: string | null) => {
    onDesignation(id);
    const d = id ? designations.find((x) => x.id === id) : null;
    if (!d) return;
    const f = draftFor(d, ALL_OF("erp"));
    onDraft({ ...draft, erp: f.modules });
    onRoleDraft({ ...roleDraft, erp: f.level as RoleId });
    onPowers(f.powers);
  };
  /* PICKING A HIRE ROLE SETS THE LEVEL IT NEEDS, the way a designation sets
     the ERP's: an HR Head is a manager of Hire, an Admin its administrator. */
  const pickHireRole = (role: string | null) => {
    onHireRole(role);
    if (role) onRoleDraft({ ...roleDraft, hire: LEVEL_FOR_ROLE[role as HireRole] as RoleId });
  };
  /* THE WHOLE FLOOR IS THE PRODUCTION HEAD, who is a manager: picking it
     raises the Factory level with it, as a designation sets the ERP's. */
  const pickPlace = (p: FactoryPlace | null) => {
    onFactoryPlace(p);
    if (p?.depts.includes("head") && (roleDraft.factory ?? "associate") === "associate") onRoleDraft({ ...roleDraft, factory: "manager" });
  };
  const current = designationId ? (designations.find((d) => d.id === designationId) ?? null) : null;
  const erpStanding = current && draft.erp ? standingOf(current, draft.erp, roleDraft.erp ?? "associate", powers) : null;

  /* A POWER TICKS THE SCREEN IT IS USED ON. The Production Head check with no
     Order Hub is a person told about TOs they cannot open — which is how the
     Order Hub stalled on 2026-11-17. Unticking a power leaves its screens:
     a screen has readers who never held the power. */
  const onErpPowers = (next: string[]) => {
    onPowers(next);
    const added = next.filter((p) => !powers.includes(p));
    if (!added.length || !draft.erp) return;
    const needed = added.flatMap((p) => ERP_POWER_SCREENS[p as ErpPower] ?? []).filter((k) => !draft.erp.includes(k));
    if (needed.length) onDraft({ ...draft, erp: [...draft.erp, ...needed] });
  };

  const setApp = (app: AppId, modules: string[]) => {
    const next = { ...draft };
    if (modules.length) next[app] = modules;
    else delete next[app];
    onDraft(next);
  };

  const apps = Object.keys(draft).length;
  const screens = Object.values(draft).reduce((n, m) => n + m.length, 0);
  /* A retired app is drawn only while somebody HELD it when the dialog
     opened, so the grant can be taken away — and it stays drawn after it is
     unticked, so the untick can be taken back. */
  const offered = APPS.filter((a) => !a.retiredInto || held[a.id]);
  /* ONE APP'S SCREENS AT A TIME, the canvas's way: the apps down the left,
     the one picked on the right — so seventeen apps are one column to read
     rather than a scroll of every screen in the building. */
  /* COMING DOWN FROM ADMIN TAKES THE ADMINISTRATOR'S SCREENS WITH IT. An
     administrator holds every off-by-default screen whatever was ticked, so
     their draft arrives with those boxes ticked; left as they were, a demotion
     would write them down as real rows and the manager would keep the calling
     desk the administrator only had by being one. They are unticked here,
     where the review shows it as a narrowing, and ticking one back is a
     deliberate act. */
  const levelChange = (app: AppId, next: RoleId) => {
    onRoleDraft({ ...roleDraft, [app]: next });
    const was = roleDraft[app] ?? "associate";
    const ticked = draft[app];
    if (was === "admin" && next !== "admin" && ticked) {
      const offByDefault = new Set(modulesForApp(app).filter((m) => m.offByDefault).map((m) => m.key));
      const kept = ticked.filter((k) => !offByDefault.has(k));
      if (kept.length !== ticked.length && kept.length) setApp(app, kept);
    }
  };
  const [focus, setFocus] = React.useState<AppId>(() => offered.find((a) => draft[a.id])?.id ?? offered[0].id);
  const focused = offered.find((a) => a.id === focus) ?? offered[0];

  return (
    <div className="-mx-1">
      {needsAccount ? (
        <div className="mb-3 rounded-[4px] border border-line bg-canvas px-3 py-2.5">
          <div className="flex flex-wrap items-baseline gap-x-2">
            <span className="text-[13px] font-medium text-ink">
              {name} has no MahekOne account yet
            </span>
            <span className="text-[13px] text-muted">
              One is created when you grant access. Give them a work number or an email —
              either one signs them in, and with both they pick. No password is typed
              here; you generate one to read out on the last page.
            </span>
          </div>
          {/* NO ACCOUNT LEVEL. There was a Role select here beside the two
              sign-ins, and it was a second answer to a question the per-app
              levels below already answer: "Admin" chosen here with
              "Associate" on every app produced a platform administrator
              nobody had meant. The account level is derived from the grants
              by the action, and is shown on the list once it exists. */}
          <div className="mt-2 grid grid-cols-2 gap-2">
            {/* NEITHER IS STARRED, because neither on its own is required —
                what is required is one of the two, which is a sentence about
                the pair and belongs above them rather than on either. */}
            <Field
              label="Work email"
              hint={phone.trim() ? "Optional" : undefined}
              error={fieldError.email}
            >
              <Input
                value={email}
                placeholder="priya@mahek.in"
                onChange={(e) => onEmail(e.target.value)}
              />
            </Field>
            <Field
              label="Work number"
              hint={email.trim() ? "Optional" : undefined}
              error={fieldError.phone}
            >
              <Input
                value={phone}
                placeholder="9820011001"
                inputMode="numeric"
                onChange={(e) => onPhone(e.target.value)}
              />
            </Field>
          </div>
        </div>
      ) : null}

      {fieldError.grants ? <p className="px-1 pb-2 text-[13px] text-danger">{fieldError.grants}</p> : null}

      <div className={cx("-mx-4 grid grid-cols-[330px_minmax(0,1fr)]", needsAccount ? "mt-1 -mb-4 h-[48vh] border-t border-divider" : "-my-4 h-[62vh]")}>
        <div className="flex flex-col gap-0.5 overflow-y-auto border-r border-divider px-3 py-3.5">
          <div className="flex items-center gap-2 px-3 pb-1.5">
            <span className="text-[11px] font-semibold tracking-[0.05em] text-muted uppercase">Apps</span>
            <span className="flex-1" />
            <span
              className="text-[11px] whitespace-nowrap text-muted"
              title="Tick an app to grant it; untick a screen to withhold it. A withheld screen is not drawn in their navigation. The level beside an app says what they may do in it."
            >
              {apps} app{apps === 1 ? "" : "s"} · {screens} screen{screens === 1 ? "" : "s"}
            </span>
          </div>
          {offered.map((a) => {
            const on = (draft[a.id] ?? []).length > 0;
            return (
              <div
                key={a.id}
                onClick={() => setFocus(a.id)}
                className={cx(
                  "flex cursor-pointer items-center gap-2.5 rounded-control px-3 py-[9px]",
                  a.id === focused.id ? "bg-brand-soft" : "hover:bg-canvas",
                )}
              >
                <input
                  type="checkbox"
                  checked={on}
                  aria-label={a.name}
                  title={a.description}
                  className="h-4 w-4 flex-none cursor-pointer accent-brand"
                  onClick={(e) => e.stopPropagation()}
                  onChange={() => {
                    setApp(a.id, on ? [] : DEFAULT_OF(a.id));
                    setFocus(a.id);
                  }}
                />
                <span className={cx("min-w-0 flex-1 truncate", on ? "font-semibold text-ink" : "text-body")} title={a.description}>
                  {a.name}
                </span>
                {a.retiredInto ? <Pill tone="warn">Retired</Pill> : null}
                {a.mobileOnly ? <Pill tone="muted">Handset</Pill> : null}
                {a.id === "admin" ? <Pill tone="warn">Platform</Pill> : null}
                {on ? (
                  <select
                    value={roleDraft[a.id] ?? "associate"}
                    aria-label={`Level on ${a.name}`}
                    onClick={(e) => e.stopPropagation()}
                    onChange={(e) => {
                      setFocus(a.id);
                      levelChange(a.id, e.target.value as RoleId);
                    }}
                    className="h-[30px] w-[112px] flex-none cursor-pointer rounded-control border border-line-strong bg-surface px-2 text-xs text-ink"
                  >
                    {ROLES.map((r) => (
                      <option key={r.id} value={r.id}>
                        {levelOptionLabel(r.id, a.id, a.name)}
                      </option>
                    ))}
                  </select>
                ) : null}
              </div>
            );
          })}
        </div>
        <div className="min-w-0 overflow-y-auto">
          <AppBlock
            key={focused.id}
            app={focused.id}
            name={focused.name}
            description={focused.description}
            built={focused.built}
            retired={!!focused.retiredInto}
            ticked={draft[focused.id] ?? []}
            fresh={fresh[focused.id]}
            first
            role={roleDraft[focused.id] ?? "associate"}
            onRole={(next) => levelChange(focused.id, next)}
            onChange={(modules) => setApp(focused.id, modules)}
            designation={
              focused.id === "erp"
                ? {
                    list: designations,
                    value: designationId,
                    onPick: pickDesignation,
                    standing: erpStanding,
                  }
                : undefined
            }
            hireRole={focused.id === "hire" ? { value: hireRole, onPick: pickHireRole, level: roleDraft.hire ?? "associate", error: fieldError.hireRole } : undefined}
            factory={focused.id === "factory" ? { value: factoryPlace, onPick: pickPlace, level: roleDraft.factory ?? "associate", error: fieldError.factoryPlace } : undefined}
            powers={
              focused.id === "erp"
                ? { held: powers, onChange: onErpPowers, error: fieldError.erpPowers, list: ERP_POWERS, labels: ERP_POWER_LABEL, adminLine: "An ERP administrator holds every power.", screensOf: (p: string) => (ERP_POWER_SCREENS[p as ErpPower] ?? []).map((k) => getModule(k)?.label ?? k) }
                : focused.id === "hrms"
                  ? { held: hrmsPowers, onChange: onHrmsPowers, error: fieldError.hrmsPowers, list: HRMS_POWERS, labels: HRMS_POWER_LABEL, adminLine: "An HRMS administrator holds every power." }
                  : focused.id === "tasks"
                    ? {
                        held: taskPowers,
                        onChange: onTaskPowers,
                        error: fieldError.taskPowers,
                        list: TASK_POWERS,
                        labels: TASK_POWER_LABEL,
                        adminLine: "A Tasks administrator holds every permission: sees, gives to and manages anybody's tasks, and runs the automatic tasks.",
                        heading: "Permissions",
                        note: "Without any, they reach only the people under them on the org chart.",
                      }
                    : undefined
            }
          />
        </div>
      </div>
    </div>
  );
}

/**
 * One app: a single line, and its screens underneath when it is granted.
 *
 * The screens sit in a grid with the sidebar group named down the left, which
 * is the shape the app itself has — somebody who has used the CRM is looking
 * for "Collections" and then for the row within it, not reading forty labels in
 * sequence.
 */
function AppBlock({
  app,
  name,
  description,
  built,
  retired,
  ticked,
  fresh,
  first,
  role,
  onRole,
  onChange,
  powers,
  designation,
  hireRole,
  factory,
}: {
  app: AppId;
  name: string;
  description: string;
  built: boolean;
  /** Retired into another app: drawn only while held, so it can be taken away. */
  retired: boolean;
  ticked: string[];
  /** Screens of this app shipped after the grant was last saved. */
  fresh?: Fresh[string];
  first: boolean;
  role: RoleId;
  onRole: (next: RoleId) => void;
  onChange: (modules: string[]) => void;
  /** An app's special powers — the ERP's and HRMS's — beside its screens. */
  powers?: {
    held: string[];
    onChange: (next: string[]) => void;
    error?: string;
    list: readonly string[];
    labels: Record<string, { label: string; source: string }>;
    adminLine: string;
    /** The word down the left; "Powers" where unsaid. */
    heading?: string;
    /** A line under the boxes saying what holding none of them means. */
    note?: string;
    /** The screens a power is used on, named under it — ticking the power ticks them. */
    screensOf?: (p: string) => string[];
  };
  /** Hire's role picker — their job inside Hire — drawn under Hire once it is ticked. */
  hireRole?: { value: string | null; onPick: (role: string | null) => void; level: string; error?: string };
  /** The factory floor: department, crew seat, badge — drawn under Factory once it is ticked. */
  factory?: { value: FactoryPlace | null; onPick: (p: FactoryPlace | null) => void; level: string; error?: string };
  /** The ERP's designation picker, drawn first under the app once it is ticked. */
  designation?: {
    list: ErpDesignationDef[];
    value: string | null;
    onPick: (id: string | null) => void;
    standing: { matches: boolean; lines: string[] } | null;
  };
}) {
  const all = ALL_OF(app);
  const always = ALWAYS_OF(app);
  /* A write level is not a screen: it is drawn as Read / Write on the row of
     the screen it belongs to, and counted nowhere a screen is counted. */
  const writeOf = writeLevelsForApp(app);
  const isWrite = new Set(writeOf.values());
  const groups = moduleGroupsForApp(app).map((g) => ({ ...g, modules: g.modules.filter((m) => !isWrite.has(m.key)) }));
  const screens = all.filter((k) => !isWrite.has(k));
  const tickedScreens = ticked.filter((k) => !isWrite.has(k));
  const readOnly = [...writeOf].filter(([screen, write]) => ticked.includes(screen) && !ticked.includes(write));
  const on = ticked.length > 0;
  const whole = ticked.length >= all.length;
  /* A screen changed by hand never drops the always-open ones: they are held
     whatever is ticked, and a draft that left them out would describe a grant
     narrower than the one the app actually enforces. A write level never
     outlives its screen — the server drops one that does, and so does this. */
  const change = (next: string[]) =>
    onChange(
      withoutOrphanLevels([...new Set([...always, ...next])]),
    );
  /* What the chosen level lets them DO, read off the capability matrix the
     server enforces — never a sentence typed here. See `capability-labels`. */
  const carries = on ? levelCarries(app, role) : [];

  return (
    <div className={cx(first ? "" : "border-t border-line")}>
      <div
        className={cx(
          "flex items-center gap-2 px-2.5 py-1.5",
          on ? "bg-brand-soft" : "hover:bg-canvas",
        )}
      >
        <Checkbox
          checked={on}
          aria-label={name}
          // The description rides on the title. On one line per app the whole
          // registry is visible at once, which is what makes this page a
          // decision rather than a scroll.
          title={description}
          onChange={() => onChange(on ? [] : DEFAULT_OF(app))}
          label={<span className="text-[13px] font-medium text-ink">{name}</span>}
        />
        {retired ? (
          <span
            className="text-[11px] whitespace-nowrap text-warn-ink"
            title="This app was retired. It can be taken away from somebody who still holds it, and is never granted again."
          >
            retired — can only be taken away
          </span>
        ) : built ? null : (
          <span className="text-[11px] whitespace-nowrap text-muted">not built yet</span>
        )}
        <span className="flex-1" />
        {/*
          THE LEVEL, on the app's own line and only while it is granted.

          A level picker on an app nobody holds is a question about nothing,
          and it would read as though the level were the thing being granted.
          It sits before the module count because it is the more consequential
          of the two: withholding a screen hides a link, choosing a level
          decides what the person may DO with the ones they keep.
        */}
        {on ? (
          <span className="flex items-center gap-1.5">
            <span className="text-[11px] whitespace-nowrap text-muted">as</span>
            <select
              value={role}
              aria-label={`Level on ${name}`}
              onClick={(e) => e.stopPropagation()}
              onChange={(e) => onRole(e.target.value as RoleId)}
              className="h-6 cursor-pointer rounded-[3px] border border-line bg-surface px-1 text-[11px] text-body"
            >
              {ROLES.map((r) => (
                <option key={r.id} value={r.id}>
                  {levelOptionLabel(r.id, app, name)}
                </option>
              ))}
            </select>
          </span>
        ) : null}
        {on && fresh ? (
          <span
            className="text-[11px] whitespace-nowrap text-brand-hover"
            title={`Shipped after this was last set on ${dayLabel(fresh.setOn)}: ${namedList(fresh.labels, 99)}. Tick what they should have; saving records the rest as decided.`}
          >
            {fresh.keys.length} new since {dayLabel(fresh.setOn)}
          </span>
        ) : null}
        {on && !whole ? (
          <span className="rounded-[3px] bg-warn-soft px-1.5 text-[11px] font-medium text-warn-ink">
            {tickedScreens.length < screens.length
              ? `${tickedScreens.length}/${screens.length}`
              : `all ${screens.length}`}
            {readOnly.length ? " · read only" : ""}
          </span>
        ) : (
          <span className="text-[11px] whitespace-nowrap text-muted">
            {!on
              ? `${screens.length} screen${screens.length === 1 ? "" : "s"}`
              : screens.length === 1
                ? "granted"
                : `all ${screens.length}`}
          </span>
        )}
        {on && !whole ? (
          <button
            onClick={() => onChange(all)}
            className="cursor-pointer border-0 bg-transparent p-0 text-[11px] font-medium text-brand-hover hover:text-brand"
          >
            all
          </button>
        ) : (
          // Kept in the layout so the rows do not jump as boxes are ticked.
          <span className="w-[18px]" />
        )}
      </div>

      {/* THE DESIGNATION, FIRST, because it answers every question below it at
          once: picking Quality tester sets the level, the screens and the
          powers. What follows it is then either confirmation or exception —
          and an exception is said in words, with the way back beside it. */}
      {on && designation ? (
        <div className="flex items-start gap-2 border-t border-divider bg-surface px-2.5 py-1.5">
          <span className="w-[132px] flex-none pt-[5px] text-[10px] leading-[14px] font-medium tracking-[0.04em] whitespace-nowrap text-muted uppercase">
            Designation
          </span>
          <span className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1">
            <select
              value={designation.value ?? ""}
              aria-label="ERP designation"
              onChange={(e) => designation.onPick(e.target.value || null)}
              className="h-7 cursor-pointer rounded-[4px] border border-line bg-surface px-1.5 text-[13px] text-ink"
            >
              <option value="">No designation — set by hand</option>
              {designation.list.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </select>
            {designation.value && designation.standing ? (
              designation.standing.matches ? (
                <span className="text-[12px] text-muted">
                  Matches it exactly — an edit to the designation moves them too.
                </span>
              ) : (
                <>
                  <Badge tone="warn">Customised</Badge>
                  <span className="text-[12px] text-body">{designation.standing.lines.join(" · ")}</span>
                  <button
                    type="button"
                    onClick={() => designation.onPick(designation.value)}
                    className="cursor-pointer border-0 bg-transparent p-0 text-[12px] font-medium text-brand-hover hover:text-brand"
                  >
                    Reset to {designation.list.find((d) => d.id === designation.value)?.name}
                  </button>
                </>
              )
            ) : !designation.value ? (
              <span className="text-[12px] text-muted">
                Pick one to set the level, screens and powers in one go.
              </span>
            ) : null}
          </span>
        </div>
      ) : null}

      {on && hireRole ? (
        <div className="flex items-start gap-2 border-t border-divider bg-surface px-2.5 py-1.5">
          <span className="w-[132px] flex-none pt-[5px] text-[10px] leading-[14px] font-medium tracking-[0.04em] whitespace-nowrap text-muted uppercase">
            Role in Hire
          </span>
          <span className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1">
            <select
              value={hireRole.value ?? ""}
              aria-label="Role in Hire"
              onChange={(e) => hireRole.onPick(e.target.value || null)}
              className="h-7 cursor-pointer rounded-[4px] border border-line bg-surface px-1.5 text-[13px] text-ink"
            >
              <option value="">Level decides — {HIRE_ROLE_LABEL[defaultRoleFor(hireRole.level)]}</option>
              {HIRE_ROLES.map((r) => (
                <option key={r} value={r}>
                  {HIRE_ROLE_LABEL[r]}
                </option>
              ))}
            </select>
            <span className="text-[12px] text-muted">{HIRE_ROLE_SENTENCE[(hireRole.value as HireRole | null) ?? defaultRoleFor(hireRole.level)]}</span>
            {hireRole.error ? <span className="text-[12px] text-danger">{hireRole.error}</span> : null}
          </span>
        </div>
      ) : null}

      {on && factory ? <FactoryPlaceRow {...factory} /> : null}

      {/* WHAT THE LEVEL CARRIES, under the line that chooses it. Short lines,
          in the order the matrix lists them, so "Approve and decline orders"
          appears or disappears in the same place as the select changes. */}
      {on ? (
        <div className="flex items-start gap-2 border-t border-divider bg-surface px-2.5 py-1">
          <span className="w-[132px] flex-none pt-[3px] text-[10px] leading-[14px] font-medium tracking-[0.04em] whitespace-nowrap text-muted uppercase">
            {LEVEL_LABELS[role]} carries
          </span>
          <span className="min-w-0 flex-1 text-[12px] leading-[18px] text-body">
            {carries.join(" · ")}
          </span>
        </div>
      ) : null}

      {/* The screens appear once the app is ticked. Drawing forty checkboxes
          nobody can act on would bury the seven decisions that matter.

          An app with ONE screen draws none of them: its checkbox already is
          that screen, and a row repeating the app's own name under itself is
          furniture rather than a decision. */}
      {on && all.length > 1 ? (
        <div className="border-t border-divider bg-surface px-2.5 py-1">
          {groups.map((g) => (
            <div
              key={g.group}
              className="flex items-start gap-2 border-b border-divider py-1 last:border-b-0"
            >
              <span className="w-[132px] flex-none pt-[3px] text-[10px] leading-[14px] font-medium tracking-[0.04em] whitespace-nowrap text-muted uppercase">
                {g.group}
              </span>
              <span className="grid min-w-0 flex-1 grid-cols-3 gap-x-3">
                {g.modules.map((m) =>
                  isAlwaysOpen(m.key) ? (
                    /* ALWAYS ON, AND DRAWN THAT WAY. The app opens this screen
                       for every holder whatever is ticked, so a checkbox that
                       could be unticked would be a control that changes
                       nothing — the one kind that teaches somebody the page
                       is lying to them. The title is on a wrapper because a
                       disabled input swallows its own hover. */
                    <span
                      key={m.key}
                      className="min-w-0"
                      title={`Always open — everybody who holds ${name} reaches this screen whatever is ticked.${m.note ? ` ${m.note}` : ""}`}
                    >
                      <Checkbox
                        checked
                        disabled
                        readOnly
                        className="min-w-0 cursor-default py-[1px]"
                        label={<span className="truncate text-[13px] text-muted">{m.label} · always</span>}
                      />
                    </span>
                  ) : writeOf.has(m.key) ? (
                    /* A SCREEN WITH TWO LEVELS. Ticking it grants both, which
                       is what holding it has always meant; the select is the
                       only way to read-only, so it is a choice somebody made. */
                    <span key={m.key} className="flex min-w-0 items-center gap-1.5">
                      <Checkbox
                        checked={ticked.includes(m.key)}
                        title={m.note}
                        onChange={() => change(toggleModule(app, ticked, m.key))}
                        className="min-w-0 py-[1px]"
                        label={<span className="truncate text-[13px] text-body">{m.label}</span>}
                      />
                      {ticked.includes(m.key) ? (
                        <select
                          value={ticked.includes(writeOf.get(m.key)!) ? "write" : "read"}
                          aria-label={`${m.label} access`}
                          title="Read: the chats and the message log. Write: also reply, send, runs, templates and groups."
                          onChange={(e) => {
                            const w = writeOf.get(m.key)!;
                            const rest = ticked.filter((k) => k !== w);
                            change(e.target.value === "write" ? [...rest, w] : rest);
                          }}
                          className="h-5 flex-none cursor-pointer rounded-[3px] border border-line bg-surface px-0.5 text-[11px] text-body"
                        >
                          <option value="read">Read</option>
                          <option value="write">Write</option>
                        </select>
                      ) : null}
                    </span>
                  ) : (
                    <Checkbox
                      key={m.key}
                      checked={ticked.includes(m.key)}
                      // What withholding it costs rides on the title rather than
                      // in the layout: forty sentences on one page is clutter
                      // rather than help, the same trade the microphone's own
                      // guidance makes.
                      title={fresh?.keys.includes(m.key) ? `New since ${dayLabel(fresh.setOn)} — nobody has decided this one for them yet.${m.note ? ` ${m.note}` : ""}` : m.note}
                      onChange={() => change(toggleModule(app, ticked, m.key))}
                      className="min-w-0 py-[1px]"
                      label={
                        <span className="flex min-w-0 items-center gap-1">
                          <span className="truncate text-[13px] text-body">{m.label}</span>
                          {fresh?.keys.includes(m.key) ? (
                            <span className="flex-none rounded-[3px] bg-brand-soft px-1 text-[10px] font-medium text-brand-hover">new</span>
                          ) : null}
                        </span>
                      }
                    />
                  ),
                )}
              </span>
            </div>
          ))}
        </div>
      ) : null}

      {/* THE POWERS, under the screens they act on. An administrator of the
          app holds every one without a tick, so the boxes would be a question
          with no effect; the line says so instead. Drawn for whoever can see
          this dialog — a platform administrator, the only person the server
          lets save it — with no separate "may give powers" gate any more. */}
      {on && powers ? (
        <div className="flex items-start gap-2 border-t border-divider bg-surface px-2.5 py-1.5">
          <span className="w-[132px] flex-none pt-[3px] text-[10px] leading-[14px] font-medium tracking-[0.04em] whitespace-nowrap text-muted uppercase">
            {powers.heading ?? "Powers"}
          </span>
          {role === "admin" ? (
            <span className="text-[13px] text-muted">{powers.adminLine}</span>
          ) : (
            <span className="flex min-w-0 flex-1 flex-col gap-0.5">
              {/* Two columns with the whole description under each label: a
                  power is a decision about somebody's job, and a cut-off label
                  with its meaning in a hover tooltip was a guess. */}
              <span className="grid min-w-0 grid-cols-1 gap-x-4 gap-y-1.5 md:grid-cols-2">
                {powers.list.map((p) => {
                  const where = powers.screensOf?.(p) ?? [];
                  return (
                    <Checkbox
                      key={p}
                      checked={powers.held.includes(p)}
                      onChange={() => powers.onChange(powers.held.includes(p) ? powers.held.filter((x) => x !== p) : [...powers.held, p])}
                      className="min-w-0 items-start! py-[1px]"
                      label={
                        <span className="flex min-w-0 flex-col">
                          <span className="text-[13px] text-ink">{powers.labels[p]?.label ?? p}</span>
                          <span className="text-[11.5px] leading-[15px] text-muted">{powers.labels[p]?.source}</span>
                          {where.length ? <span className="text-[11.5px] leading-[15px] text-muted">Used on {where.join(", ")} — ticked with it.</span> : null}
                        </span>
                      }
                    />
                  );
                })}
              </span>
              {powers.note ? <span className="text-[12px] text-muted">{powers.note}</span> : null}
            </span>
          )}
        </div>
      ) : null}
      {on && powers?.error ? <p className="border-t border-divider px-2.5 py-1.5 text-[13px] text-danger">{powers.error}</p> : null}
    </div>
  );
}


/* -------------------------------------------------------------- step three */

type Changes = {
  granted: AppId[];
  revoked: AppId[];
  narrowed: AppId[];
  widened: AppId[];
  /**
   * An app kept, at a different LEVEL. This is the change that moves what
   * somebody may DO, and it used to be invisible: a dialog that only moved a
   * telecaller from associate to manager reported "Nothing has changed" and
   * disabled Save, so the one decision on the page with the largest
   * consequence could not be made at all.
   */
  releveled: Array<{ app: AppId; from: RoleId; to: RoleId }>;
  unchanged: AppId[];
  any: boolean;
};

function describeChanges(
  before: Draft,
  after: Draft,
  levelsBefore: Record<string, RoleId>,
  levelsAfter: Record<string, RoleId>,
): Changes {
  const beforeApps = Object.keys(before) as AppId[];
  const afterApps = Object.keys(after) as AppId[];

  const granted = afterApps.filter((a) => !beforeApps.includes(a));
  const revoked = beforeApps.filter((a) => !afterApps.includes(a));
  const narrowed: AppId[] = [];
  const widened: AppId[] = [];
  const releveled: Changes["releveled"] = [];
  const unchanged: AppId[] = [];

  for (const a of afterApps.filter((x) => beforeApps.includes(x))) {
    const was = before[a] ?? [];
    const now = after[a] ?? [];
    const from = levelsBefore[a] ?? "associate";
    const to = levelsAfter[a] ?? "associate";
    if (from !== to) releveled.push({ app: a, from, to });
    if (was.length === now.length && now.every((m) => was.includes(m))) {
      if (from === to) unchanged.push(a);
    } else if (now.length < was.length) narrowed.push(a);
    else widened.push(a);
  }

  return {
    granted,
    revoked,
    narrowed,
    widened,
    releveled,
    unchanged,
    any: granted.length + revoked.length + narrowed.length + widened.length + releveled.length > 0,
  };
}

/**
 * What is about to happen, in words, before anything is written.
 *
 * Revoking is why this page exists. It happens by unticking a box, which is a
 * small gesture for a large consequence — so the consequence is named, with
 * the app it takes away, on a page somebody has to pass through.
 */
function ReviewStep({
  name,
  creating,
  email,
  phone,
  changes,
  draft,
  levels,
  powerChange,
  hrmsPowerChange,
  taskPowerChange,
  hireRoleChange,
  placeChange,
  designationChange,
  fresh,
}: {
  name: string;
  creating: boolean;
  phone: string;
  email: string;
  changes: Changes;
  draft: Draft;
  /** The level each granted app will be held under, after this save. */
  levels: Record<string, RoleId>;
  /** The ERP powers before and after, where they change. */
  powerChange: { before: string[]; after: string[] } | null;
  /** The HRMS powers before and after, where they change. */
  hrmsPowerChange: { before: string[]; after: string[] } | null;
  /** The Tasks permissions before and after, where they change. */
  taskPowerChange: { before: string[]; after: string[] } | null;
  /** Their Hire role before and after, where it changes. */
  hireRoleChange: { before: string | null; after: string | null; level: string } | null;
  /** Their factory floor place before and after, where it changes. */
  placeChange: { before: FactoryPlace | null; after: FactoryPlace | null; level: string } | null;
  /** The ERP designation, where it changes or where the result is customised from it. */
  designationChange: {
    before: string | null;
    after: string | null;
    standing: { matches: boolean; lines: string[] } | null;
  } | null;
  /** New screens on apps they keep — what this save decides about each. */
  fresh: Fresh;
}) {
  const appName = (id: AppId) => APPS.find((a) => a.id === id)?.name ?? id;
  /* "Manager in Accounts", because a level on its own no longer names a hat
     and "Associate and Associate" is not a warning anybody can act on. */
  const hatName = (h: { app: string; level?: string }) =>
    `${h.level ? roleName(h.level as RoleId) : "Anyone"} in ${appName(h.app as AppId)}`;
  const roleOf = (id: AppId): RoleId => levels[id] ?? "associate";
  const roleName = (id: RoleId) => ROLES.find((r) => r.id === id)?.label ?? id;
  /* The level said the way the select said it, so "Admin — the whole
     platform" reads the same on the page that writes it as on the page that
     chose it — plus what it carries, from the same matrix. */
  const levelLine = (id: AppId, level: RoleId) =>
    `${levelOptionLabel(level, id, appName(id))}. Carries: ${levelCarries(id, level).join("; ")}.`;

  /*
   * WHAT THE COMBINATION LETS THEM DO, said before it is written.
   *
   * The capability matrix keeps approving orders away from managers on
   * purpose: the person chasing a target must not sign off the orders that hit
   * it. Several hats can put both on one person, and at nine people that is
   * sometimes the only way the work gets done — so it is allowed, and said
   * here in the words of the rule it bends, on the page where somebody is
   * deciding.
   */
  /* A hat is an app AND a level now, so the pair is compared on both — the
     ledger desk clashes with the calling book, and it is the Accounts
     MANAGER who decides, not the associate who records. */
  const heldHats = Object.keys(draft).map((a) => ({
    app: a,
    role: roleOf(a as AppId) as string,
  }));
  const conflicts = conflictsFor(heldHats);
  const scope = (id: AppId) => {
    /* Screens only: a write level is said in words after them, never counted
       as a screen, or "WhatsApp read only" would read as one screen fewer. */
    const mods = modulesForApp(id);
    const held = draft[id] ?? [];
    const screens = mods.filter((m) => !m.writeOf);
    const n = screens.filter((m) => held.includes(m.key)).length;
    const total = screens.length;
    const levels = new Set(writeLevelsForApp(id).values());
    const readOnly = mods
      .filter((m) => levels.has(m.key) && m.writeOf && held.includes(m.writeOf) && !held.includes(m.key))
      .map((m) => `${modulesForApp(id).find((x) => x.key === m.writeOf)?.label} read only`);
    const base =
      n >= total ? (total === 1 ? "its one screen" : `all ${total} screens`) : `${n} of ${total} screens`;
    return readOnly.length ? `${base}, ${readOnly.join(", ")}` : base;
  };

  const rows: Array<{
    key: string;
    tone: "success" | "warn" | "danger";
    tag: string;
    what: string;
    detail: string;
  }> = [
    ...(creating
      ? [
          {
            key: "account",
            tone: "success" as const,
            tag: "Create",
            what: name,
            /* WHAT THEY WILL TYPE INTO THE FIRST BOX, and nothing about mail.
               Granting access sends nothing now: it used to mint and email a
               reset link every time, which is a thing the office cannot see
               happen, cannot repeat, and which reaches nobody at all on an
               account with no address. The password is generated on the next
               page and read out. */
            detail: `signing in with ${[phone, email].filter(Boolean).join(" or ")}${
              phone && email ? " — whichever they prefer" : ""
            }. Their account level is worked out from the levels below.`,
          },
        ]
      : []),
    ...changes.granted.map((a) => ({
      key: `g:${a}`,
      tone: "success" as const,
      tag: "Grant",
      what: appName(a),
      detail: `${scope(a)}, as ${roleName(roleOf(a)).toLowerCase()}.`,
    })),
    /* A LEVEL ROW FOR EVERY APP GRANTED, as well as for every level changed,
       and with what the level carries spelled out. The grant line above says
       "as manager"; this says what that means, because a new grant's level
       is a decision as large as any change to an old one. */
    ...changes.granted.map((a) => ({
      key: `gl:${a}`,
      tone: "success" as const,
      tag: "Level",
      what: `${appName(a)}:`,
      detail: levelLine(a, roleOf(a)),
    })),
    ...changes.releveled.map(({ app: a, from, to }) => ({
      key: `l:${a}`,
      tone: (ROLES.findIndex((r) => r.id === to) < ROLES.findIndex((r) => r.id === from) ? "warn" : "success") as
        | "warn"
        | "success",
      tag: "Level",
      what: `${appName(a)}: ${roleName(from)} → ${roleName(to)}.`,
      detail: levelLine(a, to),
    })),
    ...changes.widened.map((a) => ({
      key: `w:${a}`,
      tone: "success" as const,
      tag: "Widen",
      what: appName(a),
      detail: `widened to ${scope(a)}.`,
    })),
    ...changes.narrowed.map((a) => ({
      key: `n:${a}`,
      tone: "warn" as const,
      tag: "Narrow",
      what: appName(a),
      detail: `${scope(a)} — the rest disappear from their navigation.`,
    })),
    ...(powerChange
      ? [
          {
            key: "powers",
            tone: (powerChange.after.length < powerChange.before.length ? "warn" : "success") as "warn" | "success",
            tag: "Powers",
            what: "ERP",
            detail: powerChange.after.length
              ? `${powerChange.after.map((p) => ERP_POWER_LABEL[p as keyof typeof ERP_POWER_LABEL]?.label ?? p).join(", ")}.`
              : "no ERP powers.",
          },
        ]
      : []),
    ...(designationChange
      ? [
          {
            key: "designation",
            tone: (designationChange.after && designationChange.standing?.matches !== false ? "success" : "warn") as "warn" | "success",
            tag: "Role",
            what: designationChange.after
              ? designationChange.before && designationChange.before !== designationChange.after
                ? `ERP: ${designationChange.before} → ${designationChange.after}.`
                : `ERP: ${designationChange.after}.`
              : `ERP: no designation.`,
            detail: !designationChange.after
              ? designationChange.before
                ? `no longer ${designationChange.before} — their access stays as it is, and edits to that designation stop reaching them.`
                : ""
              : designationChange.standing && !designationChange.standing.matches
                ? `customised from it: ${designationChange.standing.lines.join("; ")}. An edit to ${designationChange.after} will not change them.`
                : `an edit to ${designationChange.after} will change their access too.`,
          },
        ]
      : []),
    ...(hrmsPowerChange
      ? [
          {
            key: "hrms-powers",
            tone: (hrmsPowerChange.after.length < hrmsPowerChange.before.length ? "warn" : "success") as "warn" | "success",
            tag: "Powers",
            what: "HRMS",
            detail: hrmsPowerChange.after.length
              ? `${hrmsPowerChange.after.map((p) => HRMS_POWER_LABEL[p as keyof typeof HRMS_POWER_LABEL]?.label ?? p).join(", ")}.`
              : "no HRMS powers.",
          },
        ]
      : []),
    ...(taskPowerChange
      ? [
          {
            key: "task-powers",
            tone: (taskPowerChange.after.length < taskPowerChange.before.length ? "warn" : "success") as "warn" | "success",
            tag: "Permissions",
            what: "Tasks",
            detail: taskPowerChange.after.length
              ? `${taskPowerChange.after.map((p) => TASK_POWER_LABEL[p as keyof typeof TASK_POWER_LABEL]?.label ?? p).join(", ")}.`
              : "only the people under them on the org chart.",
          },
        ]
      : []),
    ...(hireRoleChange
      ? [
          {
            key: "hire-role",
            tone: "success" as const,
            tag: "Role",
            what: "Hire",
            detail: `${hireRoleChange.after ? HIRE_ROLE_LABEL[hireRoleChange.after as HireRole] : `the level decides — ${HIRE_ROLE_LABEL[defaultRoleFor(hireRoleChange.level)]}`}${hireRoleChange.before ? ` (was ${HIRE_ROLE_LABEL[hireRoleChange.before as HireRole] ?? hireRoleChange.before})` : ""}. ${HIRE_ROLE_SENTENCE[(hireRoleChange.after as HireRole | null) ?? defaultRoleFor(hireRoleChange.level)]}`,
          },
        ]
      : []),
    ...(placeChange
      ? [
          {
            key: "factory-place",
            tone: "success" as const,
            tag: "Floor",
            what: "Factory",
            detail: `${placeWords(placeChange.after)}${placeChange.before ? ` (was ${placeWords(placeChange.before)})` : ""}. ${placeSentence(placeChange.after, placeChange.level)}`,
          },
        ]
      : []),
    ...changes.revoked.map((a) => ({
      key: `r:${a}`,
      tone: "danger" as const,
      tag: "Revoke",
      what: appName(a),
      detail:
        "they stop opening it, a bookmarked link sends them to the launcher, and which screens they had is forgotten with the grant.",
    })),
  ];

  return (
    <div>
      {!changes.any ? (
        <p className="text-sm text-body">
          Nothing has changed. Go back and tick or untick something, or cancel.
        </p>
      ) : (
        <div className="overflow-hidden rounded-[4px] border border-line">
          {rows.map((r, i) => (
            <div
              key={r.key}
              className={cx(
                "flex items-baseline gap-2.5 px-2.5 py-2",
                i ? "border-t border-divider" : "",
              )}
            >
              <span
                className={cx(
                  "w-[54px] flex-none rounded-[3px] px-1.5 py-0.5 text-center text-[11px] font-medium",
                  r.tone === "danger"
                    ? "bg-danger-soft text-danger"
                    : r.tone === "warn"
                      ? "bg-warn-soft text-warn-ink"
                      : "bg-success-soft text-success",
                )}
              >
                {r.tag}
              </span>
              <span className="min-w-0 flex-1">
                <span className="text-[13px] font-medium text-ink">{r.what}</span>{" "}
                <span className="text-[13px] leading-[19px] text-muted">{r.detail}</span>
              </span>
            </div>
          ))}
        </div>
      )}

      {conflicts.length ? (
        <div className="mt-2 rounded-[4px] border border-warn bg-warn-soft px-3 py-2.5">
          <div className="text-[13px] font-medium text-warn-ink">
            {name} will wear {heldHats.length} hats at once
          </div>
          {conflicts.map((c) => (
            <p
              key={c.hats.map((h) => `${h.app}:${h.level ?? "any"}`).join("+")}
              className="mt-1 text-[13px] leading-[19px] text-warn-ink"
            >
              <span className="font-medium">
                {hatName(c.hats[0])} and {hatName(c.hats[1])}:
              </span>{" "}
              {c.sentence}
            </p>
          ))}
          <p className="mt-1.5 text-[12px] leading-[18px] text-warn-ink">
            This is allowed — in a company this size the same person often has
            to do both. Every action taken under it records which hat allowed
            it, so the audit can answer for it later.
          </p>
        </div>
      ) : null}

      {Object.keys(fresh).length ? (
        <div className="mt-2 text-[13px] leading-[19px] text-body">
          {Object.entries(fresh).map(([app, f]) => {
            const given = f.keys.filter((k) => draft[app]?.includes(k));
            const left = f.labels.filter((_, i) => !draft[app]?.includes(f.keys[i]));
            return (
              <p key={app}>
                New on {appName(app as AppId)} since {dayLabel(f.setOn)}:{" "}
                {given.length ? <>gets {namedList(f.labels.filter((_, i) => given.includes(f.keys[i])), 99)}</> : null}
                {given.length && left.length ? "; " : null}
                {left.length ? <>left out on purpose — {namedList(left, 99)}</> : null}.
              </p>
            );
          })}
        </div>
      ) : null}

      {changes.unchanged.length ? (
        <p className="mt-2 text-[13px] text-muted">
          Unchanged: {changes.unchanged.map(appName).join(", ")}.
        </p>
      ) : null}

      {changes.any && Object.keys(draft).length === 0 ? (
        <p className="mt-2 text-[13px] leading-[19px] text-warn-ink">
          This leaves {name} with no app at all. They can still sign in, onto a launcher that
          says so plainly rather than a blank screen.
        </p>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------- which payroll row this is */

/**
 * Saying which HRMS employee an account is.
 *
 * Salary, days worked and reimbursements are all read by joining the account to
 * the employee master, and until this existed that join was a guess on the
 * email or the company mobile. On the real book the guess finds almost nobody —
 * most employees carry no email at all, the accounts are `@mahek.in` while the
 * sheet holds personal addresses, and the work numbers on the accounts are not
 * the company mobiles in the sheet — so every field salesman's salary screen
 * was blank, in a way that looked exactly like being paid nothing.
 *
 * It is a picker rather than a matcher on purpose. The master carries two rows
 * for the same man at two different salaries sharing one mobile, so there is a
 * real question here that only a person can answer, and a screen that answered
 * it automatically would be deciding somebody's pay on a coin toss.
 *
 * A row already spoken for is shown and refused rather than hidden: somebody
 * hunting for an employee they cannot find would otherwise conclude the search
 * is broken when the answer is that a colleague linked it last week.
 */
/**
 * One name, changed once. The server decides where it lives (HRMS for a linked
 * person, the account otherwise) and carries it everywhere — see `renamePerson`.
 */
function RenameDialog({
  row,
  onClose,
  onDone,
}: {
  row: AccessRow;
  onClose: () => void;
  onDone: (r: { ok: boolean; message?: string; error?: string }) => void;
}) {
  const [name, setName] = React.useState(row.name);
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const unchanged = name.trim().replace(/\s+/g, " ") === row.name;
  const save = () => {
    setSaving(true);
    setError(null);
    void renamePerson({ userId: row.userId, name }).then((r) => {
      setSaving(false);
      if (r.ok) onDone(r);
      else setError(r.fieldErrors?.[0]?.message ?? r.error ?? "The name could not be changed.");
    });
  };
  return (
    <Modal
      open
      onClose={onClose}
      title={`Rename ${row.name}`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={saving || unchanged || name.trim().length < 2}
            title={unchanged ? "Type the new name first" : undefined}
            onClick={save}
          >
            {saving ? "Saving…" : "Rename"}
          </Button>
        </>
      }
    >
      <div className="text-sm leading-[21px] text-body">
        <p>
          The new name shows everywhere at once — HRMS, their account, the CRM and
          every customer they look after. Nothing they can see or do changes:
          who works which customer is kept by their account, not their name.
        </p>
        <div className="mt-3">
          <Field label="Full name">
            <Input value={name} onChange={(e) => setName(e.target.value)} autoFocus maxLength={120} />
          </Field>
        </div>
        {error ? <p className="mt-2 text-danger">{error}</p> : null}
      </div>
    </Modal>
  );
}

function EmployeeLinkDialog({
  row,
  onClose,
  onDone,
}: {
  row: AccessRow;
  onClose: () => void;
  onDone: (r: { ok: boolean; message?: string; error?: string }) => void;
}) {
  const [all, setAll] = React.useState<LinkableEmployee[] | null>(null);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [q, setQ] = React.useState("");
  const [chosen, setChosen] = React.useState<string | null>(null);
  const [saving, setSaving] = React.useState(false);

  React.useEffect(() => {
    let live = true;
    void employeesToLink().then((r) => {
      if (!live) return;
      if (r.ok) setAll(r.data);
      else setLoadError(r.error ?? "The employee master could not be read.");
    });
    return () => {
      live = false;
    };
  }, []);

  const shown = React.useMemo(() => {
    const rows = all ?? [];
    const needle = q.trim().toLowerCase();
    if (!needle) return rows.slice(0, 60);
    return rows
      .filter((e) =>
        [e.name, e.employeeCode, e.email, e.phone, e.department, e.position]
          .filter(Boolean)
          .join(" ")
          .toLowerCase()
          .includes(needle),
      )
      .slice(0, 60);
  }, [all, q]);

  const current = (all ?? []).find((e) => e.takenByUserId === row.userId) ?? null;

  const save = (employeeId: string | null) => {
    setSaving(true);
    void linkEmployee({ userId: row.userId, employeeId }).then((r) => {
      setSaving(false);
      onDone(r);
    });
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={`Which employee is ${row.name}?`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          {current ? (
            <Button
              variant="secondary"
              disabled={saving}
              /* Unlinking destroys nothing — it falls back to the guess, which
                 is where the account was before anybody linked it. So it takes
                 no confirmation beyond this click. */
              title="Their pay goes back to being matched on email or work number"
              onClick={() => save(null)}
            >
              Unlink
            </Button>
          ) : null}
          <Button
            variant="primary"
            disabled={!chosen || saving}
            title={chosen ? undefined : "Pick an employee first"}
            onClick={() => chosen && save(chosen)}
          >
            {saving ? "Saving…" : "Link them"}
          </Button>
        </>
      }
    >
      <div className="text-sm leading-[21px] text-body">
        <p>
          This is what their salary, days worked and reimbursements are read
          from — on the Sales Dashboard and on their handset, from the same
          record, so the two cannot disagree. Their account also takes the
          name HRMS has for them, and keeps it in step from then on.
        </p>
        {current ? (
          <p className="mt-2">
            Linked to{" "}
            <span className="font-medium text-ink">
              {current.employeeCode} {current.name}
            </span>
            .
          </p>
        ) : row.employeeCode ? (
          <p className="mt-2">
            Nothing is linked. {row.employeeCode} is showing because their email
            or work number happened to match it — worth confirming, because on
            this book that match is usually wrong or missing.
          </p>
        ) : (
          <p className="mt-2">
            Nothing is linked and nothing matched, which is why their pay reads
            blank rather than zero.
          </p>
        )}

        <div className="mt-3">
          <Field label="Search the employee master">
            <Input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Name, employee code, number or department"
              autoFocus
            />
          </Field>
        </div>

        {loadError ? (
          <p className="mt-3 text-danger">{loadError}</p>
        ) : all === null ? (
          <p className="mt-3 text-muted">Reading the employee master…</p>
        ) : shown.length === 0 ? (
          <p className="mt-3 text-muted">
            {q.trim()
              ? "Nobody in the master matches that."
              : "The employee master is empty. HRMS mirrors the workbook, so check the sync."}
          </p>
        ) : (
          <div className="mt-3 max-h-72 overflow-auto rounded-[4px] border border-line">
            {shown.map((e) => {
              const takenByOther = !!e.takenByUserId && e.takenByUserId !== row.userId;
              const isCurrent = e.takenByUserId === row.userId;
              return (
                <button
                  key={e.id}
                  type="button"
                  disabled={takenByOther}
                  title={
                    takenByOther
                      ? `Already linked to ${e.takenByName}. Unlink that account first — one payroll row cannot belong to two people.`
                      : undefined
                  }
                  onClick={() => setChosen(e.id)}
                  className={cx(
                    "flex w-full items-start gap-2 border-0 border-b border-line px-3 py-2 text-left last:border-b-0",
                    takenByOther
                      ? "cursor-not-allowed bg-canvas opacity-60"
                      : "cursor-pointer bg-transparent hover:bg-canvas",
                    chosen === e.id ? "bg-canvas ring-1 ring-inset ring-brand" : "",
                  )}
                >
                  <span className="min-w-0 flex-1">
                    <span className="block text-[13px] font-medium text-ink">
                      {e.name}
                    </span>
                    <span className="block text-[12px] text-muted">
                      {[e.employeeCode, e.position ?? e.department, e.email ?? e.phone]
                        .filter(Boolean)
                        .join(" · ")}
                    </span>
                  </span>
                  <span className="flex shrink-0 flex-wrap justify-end gap-1.5">
                    {isCurrent ? <Badge tone="success">Linked</Badge> : null}
                    {takenByOther ? <Badge tone="warn">{e.takenByName}</Badge> : null}
                    {e.status === "active" ? null : (
                      <Badge tone="warn">
                        {e.status === "inactive" ? "Left" : "Status unknown"}
                      </Badge>
                    )}
                  </span>
                </button>
              );
            })}
          </div>
        )}
      </div>
    </Modal>
  );
}

/* ------------------------------------------------------------ the factory floor */

/**
 * WHERE THEY WORK ON THE FLOOR, under the Factory grant: the department, their
 * seat in its standing crew, their badge, and whether HR has confirmed the
 * name and role. With the level above it this is their department-level
 * permission, and the sentence beside it says exactly what that lets them do.
 */
function FactoryPlaceRow({ value, onPick, level, error }: { value: FactoryPlace | null; onPick: (p: FactoryPlace | null) => void; level: string; error?: string }) {
  const p = value;
  const base: FactoryPlace = p ?? { depts: [], crews: {}, badge: null, hrConfirmed: true };
  const set = (patch: Partial<FactoryPlace>) => {
    const next = { ...base, ...patch };
    /* A seat only exists in a ticked production department. */
    const crews: FactoryPlace["crews"] = {};
    for (const d of procsOf(next.depts)) if (next.crews[d]) crews[d] = next.crews[d];
    next.crews = crews;
    onPick(next.depts.length || next.badge || p ? next : null);
  };
  /* The whole floor already covers every department: ticking it clears the
     rest, and ticking a department clears the whole floor. */
  const toggle = (d: FactoryDept) => {
    const on = base.depts.includes(d);
    const depts = on ? base.depts.filter((x) => x !== d) : d === "head" ? ["head" as FactoryDept] : cleanDepts([...base.depts.filter((x) => x !== "head"), d]);
    if (!depts.length && !base.badge) return onPick(null);
    set({ depts });
  };
  const problem = error || placeProblem(p, level);
  const label = "w-[132px] flex-none pt-[5px] text-[10px] leading-[14px] font-medium tracking-[0.04em] whitespace-nowrap text-muted uppercase";
  const select = "h-7 cursor-pointer rounded-[4px] border border-line bg-surface px-1.5 text-[13px] text-ink";
  const head = base.depts.includes("head");
  const ticked = FACTORY_DEPTS.filter((d) => base.depts.includes(d));
  return (
    <div className="flex flex-col gap-1 border-t border-divider bg-surface px-2.5 py-1.5">
      <div className="flex items-start gap-2">
        <span className={label}>Departments</span>
        <span className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Factory departments">
            {FACTORY_DEPTS.map((d) => {
              const on = base.depts.includes(d);
              const muted = head && d !== "head";
              return (
                <label
                  key={d}
                  title={muted ? "The whole floor already covers this department" : undefined}
                  className={
                    "flex h-7 cursor-pointer items-center gap-1.5 rounded-[4px] border px-2 text-[13px] " +
                    (on ? "border-brand bg-brand-soft text-ink" : "border-line bg-surface text-body hover:bg-canvas") +
                    (muted ? " opacity-60" : "")
                  }
                >
                  <input type="checkbox" checked={on || muted} onChange={() => toggle(d)} className="h-[14px] w-[14px] cursor-pointer accent-[#6835FB]" />
                  {d === "head" ? "Whole floor" : DEPT_LABEL[d]}
                </label>
              );
            })}
          </span>
          {ticked.filter(isProc).length ? (
            <span className="flex flex-col gap-1">
              {ticked.filter(isProc).map((d) => (
                <span key={d} className="flex items-center gap-2 text-[13px] text-body">
                  <span className="w-[140px] flex-none truncate">{DEPT_LABEL[d]}</span>
                  <select
                    value={base.crews[d] ?? ""}
                    aria-label={`Seat in the ${DEPT_LABEL[d]} crew`}
                    onChange={(e) => set({ crews: { ...base.crews, [d]: (e.target.value || undefined) as CrewRole | undefined } })}
                    className={select}
                  >
                    <option value="">No standing seat</option>
                    {CREW_ROLES.map((c) => (
                      <option key={c} value={c}>
                        {crewLabel(d, c)}
                      </option>
                    ))}
                  </select>
                </span>
              ))}
            </span>
          ) : null}
        </span>
      </div>
      {p && p.depts.length ? (
        <div className="flex items-start gap-2">
          <span className={label}>Badge · HR</span>
          <span className="flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-1">
            <input
              value={p.badge ?? ""}
              onChange={(e) => set({ badge: e.target.value || null })}
              placeholder="Badge code — blank uses the employee code"
              aria-label="Badge code"
              className="h-7 w-[260px] rounded-[4px] border border-line bg-surface px-1.5 text-[13px] text-ink"
            />
            <label className="flex cursor-pointer items-center gap-1.5 text-[13px] text-ink">
              <input type="checkbox" checked={p.hrConfirmed} onChange={(e) => set({ hrConfirmed: e.target.checked })} />
              Name and role confirmed by HR
            </label>
          </span>
        </div>
      ) : null}
      <div className="flex items-start gap-2">
        <span className={label} />
        <span className={"text-[12px] " + (problem ? "text-danger" : "text-muted")}>{problem || placeSentence(p, level)}</span>
      </div>
    </div>
  );
}
