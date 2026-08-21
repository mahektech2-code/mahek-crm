import "server-only";
import {
  conflictsFor,
  type Role,
  type RoleConflict,
} from "@/lib/access-control";
import { asc } from "drizzle-orm";
import { db } from "@/db";
import { appAccess, appModuleAccess, employees, users } from "@/db/schema";
import { APPS, type AppId } from "@/lib/apps";
import { moduleKeysForApp, modulesForApp } from "@/lib/modules";

/* ---------------------------------------------------------------------------
 * Who can open what, read for the Access screen.
 *
 * Two lists that used to be three screens: what has been granted, and who
 * there is to grant it to. The second is the one that was missing — a manager
 * could only grant an app to somebody who already had a MahekOne account, and
 * the list of people who work here lives in HRMS, so "give the new telecaller
 * the CRM" meant creating an account on one tab and finding them again on
 * another.
 *
 * The employee master is a mirror of the HR sheet and mirrors are not edited,
 * so nothing here writes to `employees`. It is read as what it is: the list of
 * people who work here, and the answer to whether one of them is still active.
 * ------------------------------------------------------------------------- */

export type ModuleGrant = {
  key: string;
  label: string;
  group: string;
  granted: boolean;
};

export type AppGrant = {
  app: AppId;
  appName: string;
  /**
   * The hat this app is held under. Null means the account's own role, which
   * is what every grant meant before roles existed and what `app:grant`
   * writes — the screen shows the account's role there rather than an empty
   * box, because "inherited" and "unset" look identical and are not.
   */
  role: Role | null;
  /** Every module of the app, ticked or not — the review table renders this. */
  modules: ModuleGrant[];
  grantedCount: number;
  totalCount: number;
  /** True where nothing has ever been unticked, so the grant is the whole app. */
  whole: boolean;
};

export type AccessRow = {
  userId: string;
  name: string;
  email: string;
  phone: string | null;
  role: "telecaller" | "manager" | "accounts" | "admin";
  initials: string;
  active: boolean;
  /** The HRMS row this account matches, where there is one. */
  employeeCode: string | null;
  department: string | null;
  /** Active in the employee sheet. Null where HRMS has never heard of them. */
  employeeStatus: "active" | "inactive" | "unknown" | null;
  grants: AppGrant[];
  /**
   * Every hat this person wears, and what the combination lets them do that
   * the capability matrix was written to prevent. Empty for almost everybody;
   * where it is not, the screen says it in words rather than refusing the
   * grant — at nine people the same person does have to do both.
   */
  roles: Role[];
  conflicts: RoleConflict[];
};

/**
 * Matching a MahekOne account to an employee row.
 *
 * Two keys, because the sheet fills them in unevenly: an email if there is
 * one, otherwise the work number. Phones are compared on their last ten digits
 * — the sheet carries `+91 ` prefixes, spaces and the occasional stray hyphen,
 * and a person is not two people because of how somebody typed their number.
 */
function phoneKey(value: string | null | undefined): string | null {
  const digits = (value ?? "").replace(/\D/g, "");
  return digits.length >= 10 ? digits.slice(-10) : null;
}

function emailKey(value: string | null | undefined): string | null {
  const v = (value ?? "").trim().toLowerCase();
  return v.includes("@") ? v : null;
}

type EmployeeLite = {
  id: string;
  employeeCode: string;
  name: string;
  status: "active" | "inactive" | "unknown";
  department: string | null;
  position: string | null;
  officeName: string | null;
  email: string | null;
  phone: string | null;
  withdrawn: boolean;
};

/** Every column this file is allowed to see. Salaries and identity are not. */
async function employeeRows(): Promise<EmployeeLite[]> {
  const rows = await db
    .select({
      id: employees.id,
      employeeCode: employees.employeeCode,
      name: employees.name,
      status: employees.status,
      department: employees.department,
      position: employees.position,
      officeName: employees.officeName,
      email: employees.email,
      companyMobile: employees.companyMobile,
      personalMobile: employees.personalMobile,
      sheetStatus: employees.sheetStatus,
    })
    .from(employees)
    .orderBy(asc(employees.name));

  return rows.map((r) => ({
    id: r.id,
    employeeCode: r.employeeCode,
    name: r.name,
    status: r.status as EmployeeLite["status"],
    department: r.department,
    position: r.position,
    officeName: r.officeName,
    email: r.email,
    // The company number first: it is the one the office knows, and it is what
    // somebody signs in with.
    phone: phoneKey(r.companyMobile) ?? phoneKey(r.personalMobile),
    withdrawn: r.sheetStatus === "withdrawn",
  }));
}

function buildGrants(
  apps: AppId[],
  modulesByApp: Map<AppId, string[]>,
  roleFor: (app: AppId) => Role | null,
): AppGrant[] {
  return APPS.filter((a) => apps.includes(a.id)).map((a) => {
    const stored = modulesByApp.get(a.id) ?? [];
    const all = modulesForApp(a.id);
    // No stored rows means the whole app — the same rule the guard reads, said
    // once in `moduleAllowed` and shown here rather than re-derived.
    const whole = stored.length === 0;
    const role = roleFor(a.id);
    const modules: ModuleGrant[] = all.map((m) => ({
      key: m.key,
      label: m.label,
      group: m.group,
      granted: whole || stored.includes(m.key),
    }));
    return {
      app: a.id,
      appName: a.name,
      role,
      modules,
      grantedCount: modules.filter((m) => m.granted).length,
      totalCount: modules.length,
      whole,
    };
  });
}

/** Every account, with what it opens and how far into each app it reaches. */
export async function listAccess(): Promise<AccessRow[]> {
  const [accounts, access, moduleRows, staff] = await Promise.all([
    db
      .select({
        id: users.id,
        name: users.name,
        email: users.email,
        phone: users.phone,
        role: users.role,
        initials: users.initials,
        active: users.active,
      })
      .from(users)
      .orderBy(asc(users.name)),
    db
      .select({ userId: appAccess.userId, app: appAccess.app, role: appAccess.role })
      .from(appAccess),
    db
      .select({
        userId: appModuleAccess.userId,
        app: appModuleAccess.app,
        module: appModuleAccess.module,
      })
      .from(appModuleAccess),
    employeeRows(),
  ]);

  const appsByUser = new Map<string, AppId[]>();
  const rolesByUserApp = new Map<string, Role | null>();
  for (const a of access) {
    const list = appsByUser.get(a.userId) ?? [];
    list.push(a.app as AppId);
    appsByUser.set(a.userId, list);
    rolesByUserApp.set(`${a.userId}:${a.app}`, (a.role as Role) ?? null);
  }

  const modulesByUser = new Map<string, Map<AppId, string[]>>();
  for (const m of moduleRows) {
    const forUser = modulesByUser.get(m.userId) ?? new Map<AppId, string[]>();
    const list = forUser.get(m.app as AppId) ?? [];
    list.push(m.module);
    forUser.set(m.app as AppId, list);
    modulesByUser.set(m.userId, forUser);
  }

  const byEmail = new Map<string, EmployeeLite>();
  const byPhone = new Map<string, EmployeeLite>();
  for (const e of staff) {
    const em = emailKey(e.email);
    if (em && !byEmail.has(em)) byEmail.set(em, e);
    if (e.phone && !byPhone.has(e.phone)) byPhone.set(e.phone, e);
  }

  return accounts.map((u) => {
    // Every hat, the account's own included: a grant with no role of its own
    // is held under it, so it is one of the roles this person wears.
    const heldRoles = [
      ...new Set<Role>([
        u.role as Role,
        ...(appsByUser.get(u.id) ?? []).map(
          (app) => rolesByUserApp.get(`${u.id}:${app}`) ?? (u.role as Role),
        ),
      ]),
    ];
    const match =
      byEmail.get(emailKey(u.email) ?? "") ??
      byPhone.get(phoneKey(u.phone) ?? "") ??
      null;
    return {
      userId: u.id,
      name: u.name,
      email: u.email,
      phone: u.phone,
      role: u.role as AccessRow["role"],
      initials: u.initials,
      active: u.active,
      employeeCode: match?.employeeCode ?? null,
      department: match?.department ?? null,
      employeeStatus: match ? match.status : null,
      grants: buildGrants(
        appsByUser.get(u.id) ?? [],
        modulesByUser.get(u.id) ?? new Map(),
        (app) => rolesByUserApp.get(`${u.id}:${app}`) ?? null,
      ),
      roles: heldRoles,
      conflicts: conflictsFor(heldRoles),
    };
  });
}

/* -------------------------------------------------- who there is to grant to */

export type Candidate = {
  /** The MahekOne account, where one exists. */
  userId: string | null;
  employeeId: string | null;
  employeeCode: string | null;
  name: string;
  email: string | null;
  phone: string | null;
  department: string | null;
  position: string | null;
  office: string | null;
  /** What HRMS says. Null for an account with no employee row behind it. */
  employeeStatus: "active" | "inactive" | "unknown" | null;
  /** True where the account exists and is not deactivated. */
  accountActive: boolean;
  /** Apps they already hold, so the dialog can say "they already have this". */
  apps: AppId[];
  /**
   * Set where this person cannot be granted anything, and it is the sentence
   * the picker shows. An employee who is not active in HRMS is listed and
   * refused rather than hidden — somebody looking for a leaver has to find out
   * that they left, not conclude the search box is broken.
   */
  blocked: string | null;
};

/**
 * Everybody access could be given to: the employee master and the accounts
 * that already exist, merged on email or work number.
 *
 * Read fresh on every open of the dialog, so an employee added to the sheet
 * and synced a minute ago is pickable without anybody reloading the console.
 */
export async function listCandidates(): Promise<Candidate[]> {
  const [staff, accounts, access] = await Promise.all([
    employeeRows(),
    db
      .select({
        id: users.id,
        name: users.name,
        email: users.email,
        phone: users.phone,
        active: users.active,
      })
      .from(users)
      .orderBy(asc(users.name)),
    db
      .select({ userId: appAccess.userId, app: appAccess.app, role: appAccess.role })
      .from(appAccess),
  ]);

  const appsByUser = new Map<string, AppId[]>();
  const rolesByUserApp = new Map<string, Role | null>();
  for (const a of access) {
    const list = appsByUser.get(a.userId) ?? [];
    list.push(a.app as AppId);
    appsByUser.set(a.userId, list);
    rolesByUserApp.set(`${a.userId}:${a.app}`, (a.role as Role) ?? null);
  }

  const userByEmail = new Map(
    accounts.flatMap((u) => {
      const k = emailKey(u.email);
      return k ? ([[k, u]] as const) : [];
    }),
  );
  const userByPhone = new Map(
    accounts.flatMap((u) => {
      const k = phoneKey(u.phone);
      return k ? ([[k, u]] as const) : [];
    }),
  );

  const claimed = new Set<string>();
  const out: Candidate[] = [];

  for (const e of staff) {
    const account =
      userByEmail.get(emailKey(e.email) ?? "") ??
      userByPhone.get(e.phone ?? "") ??
      null;
    if (account) claimed.add(account.id);

    // Only an active employee gets access. A leaver whose row is still in the
    // sheet, and somebody whose status cell nobody filled in, are both refused
    // — and both are shown, with the reason, because a person missing from a
    // search box reads as a broken search box.
    const blocked = e.withdrawn
      ? "No longer in the employee sheet."
      : e.status === "inactive"
        ? "Not active in HRMS."
        : e.status === "unknown"
          ? "HRMS does not say whether they are active."
          : account && !account.active
            ? "Their MahekOne account is deactivated."
            : null;

    out.push({
      userId: account?.id ?? null,
      employeeId: e.id,
      employeeCode: e.employeeCode,
      name: account?.name ?? e.name,
      email: account?.email ?? e.email,
      phone: account?.phone ?? e.phone,
      department: e.department,
      position: e.position,
      office: e.officeName,
      employeeStatus: e.status,
      accountActive: account?.active ?? false,
      apps: account ? (appsByUser.get(account.id) ?? []) : [],
      blocked,
    });
  }

  // Accounts with nobody behind them in HRMS. Several are real — an account
  // created before the employee sheet existed, or somebody the sheet spells
  // differently — so they are offered rather than dropped, and labelled so
  // whoever grants knows the check that could not be made.
  for (const u of accounts) {
    if (claimed.has(u.id)) continue;
    out.push({
      userId: u.id,
      employeeId: null,
      employeeCode: null,
      name: u.name,
      email: u.email,
      phone: u.phone,
      department: null,
      position: null,
      office: null,
      employeeStatus: null,
      accountActive: u.active,
      apps: appsByUser.get(u.id) ?? [],
      blocked: u.active ? null : "This account is deactivated.",
    });
  }

  // Grantable first, then by name. Most of the employee master is inactive, so
  // sorting by name alone puts a wall of refusals above everybody who can
  // actually be given something — a list that has to be scrolled past to reach
  // the answer reads as a list that does not have it.
  return out.sort((a, b) => {
    const blocked = Number(!!a.blocked) - Number(!!b.blocked);
    return blocked !== 0 ? blocked : a.name.localeCompare(b.name);
  });
}

/** Every module of every app, for the review table. Pure data, sent once. */
export function moduleCatalogue() {
  return APPS.map((a) => ({
    app: a.id,
    name: a.name,
    built: a.built,
    keys: moduleKeysForApp(a.id),
  })).filter((a) => a.keys.length > 0);
}
