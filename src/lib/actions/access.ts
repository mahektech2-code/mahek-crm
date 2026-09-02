"use server";

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { db } from "@/db";
import {
  appAccess,
  appModuleAccess,
  auditLog,
  employees,
  passwordResets,
  users,
} from "@/db/schema";
import { APP_IDS, getApp, type AppId } from "@/lib/apps";
import { getModule, moduleKeysForApp } from "@/lib/modules";
import { hashPassword, isManager, requireUser } from "@/lib/auth";
import { initialsOf } from "@/lib/format";
import { mailConfigured, sendMail } from "@/lib/mailer";
import {
  appOrigin,
  hashResetToken,
  newResetToken,
  RESET_TTL_MINUTES,
} from "@/lib/password-reset";
import { err as fail, fieldErr, ok, type Result } from "@/lib/result";
import { widestRole, type Role } from "@/lib/access-control";
import { listCandidates, type Candidate } from "@/lib/services/access-service";

/* ---------------------------------------------------------------------------
 * Granting and narrowing access.
 *
 * Every write here is checked server-side against the actor, not by hiding a
 * control: a server action is a URL like any other, and this is the URL that
 * decides who can open payroll.
 *
 * Access is granted to a PERSON, and until now the only people MahekOne could
 * see were the ones who already had accounts. Everybody who works here is in
 * HRMS, so this reads that list and creates the account in the same breath —
 * a manager thinks "give the new telecaller the CRM", not "create an account,
 * then find them again on another tab".
 *
 * ONE write sets a person's whole access. Granting an app, narrowing one,
 * widening one and taking one away are the same act — somebody deciding what
 * this person's MahekOne looks like — and splitting them into three actions is
 * what produced three screens that could each tell a different half of the
 * story. The screen shows all of it on one page and saves all of it at once,
 * so what was reviewed is what is written.
 * ------------------------------------------------------------------------- */

const newId = (p: string) => `${p}_${randomUUID().slice(0, 12)}`;

/**
 * Who may change access.
 *
 * A platform admin, or a manager. Deliberately the same bar `people.ts`
 * already sets — this screen replaced controls that lived there, and moving a
 * permission is not the same as changing it.
 */
async function actor() {
  const user = await requireUser();
  if (!isManager(user)) throw new Error("Only a manager can change access.");
  return user;
}

async function audit(
  actorId: string,
  action: string,
  userId: string,
  detail: string,
) {
  await db.insert(auditLog).values({
    id: newId("aud"),
    actorId,
    action,
    entityType: "user",
    entityId: userId,
    afterState: { detail } as never,
  });
}

function refresh() {
  try {
    revalidatePath("/admin");
    revalidatePath("/apps");
  } catch {
    /* outside a request, which is fine */
  }
}

/** What the dialog sends: the complete desired state, app by app. */
export type AccessGrantInput = {
  app: string;
  /** The modules left ticked. An app with none is an app not granted. */
  modules: string[];
  /**
   * The hat this app is held under. A person is a manager in the CRM and a
   * clerk in Accounts, and those are different powers over different data.
   *
   * Absent means the account's own role, which is what every grant meant
   * before roles existed and what `npm run app:grant` still writes — so a
   * dialog that does not send one, or a terminal that knows nothing about
   * them, goes on granting an app that works.
   */
  role?: "telecaller" | "manager" | "accounts" | "admin" | null;
};

export type SetAccessInput = {
  /** An existing account. One of these two is required. */
  userId?: string | null;
  /** An HRMS employee with no account yet — one is created for them. */
  employeeId?: string | null;
  /** The whole picture, not a change to it. Apps absent here are revoked. */
  grants: AccessGrantInput[];
  /** Only read when an account has to be created. */
  account?: {
    email: string;
    phone?: string | null;
    role: "telecaller" | "manager" | "accounts" | "admin";
  };
};

export type SetAccessResult = {
  userId: string;
  created: boolean;
  /** Said plainly rather than assumed — mail may not be configured. */
  resetLinkSent: boolean;
  granted: string[];
  revoked: string[];
  changed: string[];
};

/** Modules that are real, belong to this app, and are not repeated. */
function cleanModules(app: AppId, keys: string[]): { ok: string[]; bad: string[] } {
  const seen = new Set<string>();
  const good: string[] = [];
  const bad: string[] = [];
  for (const k of keys) {
    if (seen.has(k)) continue;
    seen.add(k);
    if (getModule(k)?.app === app) good.push(k);
    else bad.push(k);
  }
  return { ok: good, bad };
}

/**
 * Normalise what the dialog sent into one desired state.
 *
 * An app with no modules ticked is an app that is NOT granted, rather than a
 * grant onto nothing — that invalid state is removed here as well as being
 * impossible to draw, because the screen is not where authority lives.
 */
function desiredState(grants: AccessGrantInput[]): {
  state: Map<AppId, string[]>;
  /** The hat each granted app is held under. Null means the account's own. */
  roles: Map<AppId, Role | null>;
  error: string | null;
} {
  const state = new Map<AppId, string[]>();
  const roles = new Map<AppId, Role | null>();
  for (const g of grants) {
    const app = g.app as AppId;
    if (!APP_IDS.includes(app)) return { state, roles, error: `Not an app: ${g.app}` };
    const { ok: modules, bad } = cleanModules(app, g.modules);
    if (bad.length) {
      return { state, roles, error: `Not a module of ${app}: ${bad.join(", ")}` };
    }
    if (g.role && !ROLES.includes(g.role)) {
      return { state, roles, error: `Not a role: ${g.role}` };
    }
    if (!modules.length) continue;
    state.set(app, [...(state.get(app) ?? []), ...modules]);
    roles.set(app, g.role ?? null);
  }
  return { state, roles, error: null };
}

/** The four, as a list, so an unknown one is refused rather than stored. */
const ROLES = ["telecaller", "manager", "accounts", "admin"] as const;

/**
 * Write one app's module rows.
 *
 * Every module ticked stores NO rows rather than a row each. That is what
 * makes "the whole app" a single fact instead of fourteen that can go stale:
 * add a fifteenth screen to the CRM tomorrow and everybody who holds the whole
 * app gets it, while everybody who was deliberately narrowed does not — which
 * is what both of those decisions meant.
 */
async function writeModules(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  userId: string,
  app: AppId,
  modules: string[],
  grantedById: string,
) {
  await tx
    .delete(appModuleAccess)
    .where(and(eq(appModuleAccess.userId, userId), eq(appModuleAccess.app, app)));

  if (modules.length >= moduleKeysForApp(app).length) return;

  await tx.insert(appModuleAccess).values(
    modules.map((module) => ({
      id: newId("mod"),
      userId,
      app,
      module,
      grantedById,
    })),
  );
}

/**
 * Set what one person can open, across every app, in one write.
 *
 * The employee must be ACTIVE in HRMS. That check is here and not only in the
 * picker, because the picker is a screen and this is the door.
 */
export async function setAccess(
  input: SetAccessInput,
): Promise<Result<SetAccessResult>> {
  let me;
  try {
    me = await actor();
  } catch (e) {
    return fail(e instanceof Error ? e.message : "Not allowed.", "not_permitted");
  }

  const { state: wanted, roles: wantedRoles, error } = desiredState(input.grants);
  if (error) return fail(error);

  let userId = input.userId ?? null;
  let created = false;
  let resetLinkSent = false;
  let personName = "";

  /* ------------------------------------------------------ a new account */

  if (!userId) {
    if (!input.employeeId) return fail("Nobody was chosen.");
    if (!input.account) return fail("A new account needs a sign-in email and a role.");
    if (wanted.size === 0) {
      // For somebody who already has an account, taking every app away is a
      // real decision. Creating one that opens nothing is not — it is somebody
      // who cannot start work, and who will ring about it tomorrow.
      return fieldErr("grants", "Give them at least one app, or the account opens onto nothing.");
    }

    const [employee] = await db
      .select({
        id: employees.id,
        name: employees.name,
        code: employees.employeeCode,
        status: employees.status,
        sheetStatus: employees.sheetStatus,
      })
      .from(employees)
      .where(eq(employees.id, input.employeeId))
      .limit(1);

    if (!employee) return fail("That employee is no longer in the master.", "not_found");
    if (employee.sheetStatus === "withdrawn") {
      return fail(`${employee.name} is no longer in the employee sheet.`, "rule_violation");
    }
    if (employee.status !== "active") {
      // The rule the whole flow rests on, enforced where it counts.
      return fail(
        `${employee.name} is ${employee.status === "inactive" ? "not active" : "of unknown status"} in HRMS. Access is for active employees.`,
        "rule_violation",
      );
    }

    const email = input.account.email.trim().toLowerCase();
    const phone = input.account.phone ? input.account.phone.replace(/\D/g, "").slice(-10) : null;
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      return fieldErr("email", "That does not look like an email address.");
    }
    // The web has no password any more — a work number and a code sent to it
    // is the whole credential, so an account with no number is one nobody can
    // ever sign into.
    if (!phone) {
      return fieldErr("phone", "A work number is required — it's how they sign in.");
    }
    if (!/^[6-9]\d{9}$/.test(phone)) {
      return fieldErr("phone", "A work number is ten digits, starting 6 to 9.");
    }

    // Both are sign-ins, so both have to be unique or the login form has two
    // answers to one question.
    const clash = await db
      .select({ id: users.id, email: users.email, phone: users.phone })
      .from(users);
    if (clash.some((c) => c.email === email)) {
      return fieldErr("email", "An account already uses that email.");
    }
    if (clash.some((c) => c.phone === phone)) {
      return fieldErr("phone", "An account already uses that work number.");
    }

    userId = newId("usr");
    personName = employee.name;
    created = true;

    /*
     * A password nobody knows.
     *
     * The web needs none — a code sent to the work number above is what makes
     * the account usable, immediately. This hash exists only in case the same
     * account is ever paired with MBOS, the field salesman handset app, which
     * still authenticates the old way over its own API and cannot be changed
     * from here. Typing a real one into this dialog would mean somebody
     * reading it out over a phone, so it stays one nobody knows.
     */
    const passwordHash = await hashPassword(randomUUID() + randomUUID());
    const apps = [...wanted.keys()];

    await db.transaction(async (tx) => {
      await tx.insert(users).values({
        id: userId!,
        name: employee.name,
        email,
        phone,
        role: input.account!.role,
        initials: initialsOf(employee.name),
        passwordHash,
        active: true,
      });
      await tx.insert(appAccess).values(
        apps.map((app) => ({
          id: newId("acc"),
          userId: userId!,
          app,
          role: wantedRoles.get(app) ?? null,
          grantedById: me.id,
        })),
      );
      for (const [app, modules] of wanted) {
        await writeModules(tx, userId!, app, modules, me.id);
      }
    });

    resetLinkSent = await mailResetLink(userId, employee.name, email, phone, me.name);

    await audit(
      me.id,
      "create-user",
      userId,
      `${employee.name} · ${employee.code} · ${input.account.role} · ${apps
        .map((a) => `${a} (${wanted.get(a)!.length}/${moduleKeysForApp(a).length})`)
        .join(", ")}`,
    );
    refresh();

    return ok(
      { userId, created, resetLinkSent, granted: apps, revoked: [], changed: [] },
      `${personName} can now open ${describe(apps)} — sign-in is a code sent to ${phone}. ${
        resetLinkSent
          ? "A link to set a field-app password has also been emailed to them, in case they are ever paired with MBOS."
          : "No mail is configured on this deployment, so that field-app password link went to the server log instead of to them."
      }`,
    );
  }

  /* ------------------------------------------------- an existing account */

  const [account] = await db
    .select({
      id: users.id,
      name: users.name,
      active: users.active,
      // The account's own role, which is what a grant with no hat of its own
      // means — and what the primary role falls back to.
      role: users.role,
    })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (!account) return fail("That account no longer exists.", "not_found");
  personName = account.name;
  if (!account.active && wanted.size) {
    return fail(`${account.name}'s account is deactivated, so it opens nothing.`);
  }

  // An employee row behind the account has to be active too, where there is
  // one. Where there is not, the account itself is the only authority there is
  // and it is enough — several real accounts predate the employee sheet.
  if (wanted.size) {
    const blocked = await hrmsBlock(userId);
    if (blocked) return fail(blocked, "rule_violation");
  }

  const heldRows = await db
    .select({ app: appAccess.app })
    .from(appAccess)
    .where(eq(appAccess.userId, userId));
  const held = heldRows.map((r) => r.app as AppId);

  const storedRows = await db
    .select({ app: appModuleAccess.app, module: appModuleAccess.module })
    .from(appModuleAccess)
    .where(eq(appModuleAccess.userId, userId));
  const storedByApp = new Map<AppId, string[]>();
  for (const r of storedRows) {
    const app = r.app as AppId;
    storedByApp.set(app, [...(storedByApp.get(app) ?? []), r.module]);
  }
  /** What they hold today, with "no rows" spelled out as every module. */
  const before = new Map<AppId, string[]>(
    held.map((a) => [a, storedByApp.get(a) ?? moduleKeysForApp(a)]),
  );

  const granted = [...wanted.keys()].filter((a) => !held.includes(a));
  const revoked = held.filter((a) => !wanted.has(a));
  const changed = [...wanted.keys()].filter((a) => {
    if (!held.includes(a)) return false;
    const was = new Set(before.get(a) ?? []);
    const now = wanted.get(a)!;
    return was.size !== now.length || now.some((m) => !was.has(m));
  });

  if (!granted.length && !revoked.length && !changed.length) {
    return ok(
      { userId, created: false, resetLinkSent: false, granted: [], revoked: [], changed: [] },
      "No change.",
    );
  }

  await db.transaction(async (tx) => {
    if (revoked.length) {
      await tx
        .delete(appAccess)
        .where(and(eq(appAccess.userId, userId!), inArray(appAccess.app, revoked)));
      // The module rows go with the app. Left behind, they would silently
      // narrow it the day somebody granted it back.
      await tx
        .delete(appModuleAccess)
        .where(and(eq(appModuleAccess.userId, userId!), inArray(appModuleAccess.app, revoked)));
    }
    if (granted.length) {
      await tx.insert(appAccess).values(
        granted.map((app) => ({
          id: newId("acc"),
          userId: userId!,
          app,
          role: wantedRoles.get(app) ?? null,
          grantedById: me.id,
        })),
      );
    }
    /*
     * The hat on an app somebody already holds. Changing it is not granting or
     * revoking anything — the app stays open, the screens stay the same — so
     * it is written here rather than being expressed as a revoke and a grant,
     * which would read as losing the app for a moment in the audit and in any
     * notification built from it.
     */
    for (const [app, role] of wantedRoles) {
      if (!wanted.has(app) || granted.includes(app)) continue;
      await tx
        .update(appAccess)
        .set({ role })
        .where(and(eq(appAccess.userId, userId!), eq(appAccess.app, app)));
    }

    /*
     * THE PRIMARY ROLE IS A CACHE of the hats, and this is where it is
     * rebuilt. `users.role` decides mine/team/all through `isManager`, read by
     * thirty-one screens; rather than teach every one of them about a list, it
     * holds the widest role the person holds anywhere. Granting somebody the
     * manager hat in the CRM gives them their team on the day it is granted,
     * which is what the person granting it expects.
     */
    const heldRoles = [...wanted.keys()].map(
      (app) => (wantedRoles.get(app) ?? account.role) as Role,
    );
    if (heldRoles.length) {
      await tx
        .update(users)
        .set({ role: widestRole(heldRoles) })
        .where(eq(users.id, userId!));
    }
    for (const app of [...granted, ...changed]) {
      await writeModules(tx, userId!, app, wanted.get(app)!, me.id);
    }
  });

  const detail = [
    granted.length ? `granted ${granted.map(withCount(wanted)).join(", ")}` : "",
    changed.length
      ? `changed ${changed
          .map((a) => `${a} ${before.get(a)!.length}/${moduleKeysForApp(a).length} → ${wanted.get(a)!.length}/${moduleKeysForApp(a).length}`)
          .join(", ")}`
      : "",
    revoked.length ? `revoked ${revoked.join(", ")}` : "",
  ]
    .filter(Boolean)
    .join("; ");

  await audit(me.id, "set-app-access", userId, detail);
  refresh();

  const said = [
    granted.length ? `now opens ${describe(granted)}` : "",
    changed.length
      ? changed
          .map(
            (a) =>
              `${getApp(a)?.name ?? a} narrowed to ${wanted.get(a)!.length} of ${moduleKeysForApp(a).length} screens`,
          )
          .join(", ")
      : "",
    revoked.length ? `no longer opens ${describe(revoked)}` : "",
  ].filter(Boolean);

  return ok(
    { userId, created: false, resetLinkSent: false, granted, revoked, changed },
    `${personName} ${said.join(" · ")}.` +
      (revoked.length && !wanted.size
        ? " They can still sign in, and the launcher will say plainly that they have nothing."
        : ""),
  );
}

function withCount(wanted: Map<AppId, string[]>) {
  return (app: AppId) =>
    `${app} (${wanted.get(app)!.length}/${moduleKeysForApp(app).length} modules)`;
}

function describe(apps: AppId[]): string {
  const names = apps.map((a) => getApp(a)?.name ?? a);
  if (names.length === 1) return names[0];
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/**
 * Whether HRMS refuses this account.
 *
 * Read through the same list the picker reads, so the screen and the door
 * cannot disagree about who is active — two answers to that question is how
 * one of them ends up more generous than the other.
 */
async function hrmsBlock(userId: string): Promise<string | null> {
  const candidates = await listCandidates();
  const match: Candidate | undefined = candidates.find((c) => c.userId === userId);
  return match?.blocked ?? null;
}

/** Mint and send a single-use reset link. Returns whether it actually went. */
async function mailResetLink(
  userId: string,
  name: string,
  email: string,
  phone: string,
  actorName: string,
): Promise<boolean> {
  const token = newResetToken();
  await db.transaction(async (tx) => {
    await tx
      .update(passwordResets)
      .set({ usedAt: new Date() })
      .where(and(eq(passwordResets.userId, userId), isNull(passwordResets.usedAt)));
    await tx.insert(passwordResets).values({
      id: newId("rst"),
      userId,
      tokenHash: hashResetToken(token),
      expiresAt: new Date(Date.now() + RESET_TTL_MINUTES * 60_000),
    });
  });

  await sendMail({
    to: email,
    subject: "Your MahekOne sign-in",
    text: [
      `Hello ${name.split(" ")[0]},`,
      "",
      `${actorName} has set you up on MahekOne. To sign in on the web, open`,
      `MahekOne and enter your work number, ${phone} — we send a code to it,`,
      "no password needed.",
      "",
      "The link below is only for the MBOS field salesman app, which pairs",
      "with a password rather than a code. Skip it unless you use that app:",
      `Open this link to choose one — it works once and expires in ${RESET_TTL_MINUTES} minutes:`,
      "",
      `${await appOrigin()}/login/reset?token=${token}`,
    ].join("\n"),
  });

  return mailConfigured();
}

/** The picker's list, re-read on demand so a fresh HRMS sync shows up. */
export async function candidatesForGrant(): Promise<Result<Candidate[]>> {
  try {
    await actor();
  } catch (e) {
    return fail(e instanceof Error ? e.message : "Not allowed.", "not_permitted");
  }
  return ok(await listCandidates());
}
