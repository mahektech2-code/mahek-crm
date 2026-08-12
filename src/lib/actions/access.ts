"use server";

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { and, eq, isNull } from "drizzle-orm";
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
import { listUserApps } from "@/lib/access";
import { initialsOf } from "@/lib/format";
import { mailConfigured, sendMail } from "@/lib/mailer";
import {
  appOrigin,
  hashResetToken,
  newResetToken,
  RESET_TTL_MINUTES,
} from "@/lib/password-reset";
import { err as fail, fieldErr, ok, type Result } from "@/lib/result";
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
 * Write the module rows for one app.
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

  const all = moduleKeysForApp(app);
  if (modules.length >= all.length) return;

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

export type EnableAccessInput = {
  /** An existing account. One of these two is required. */
  userId?: string | null;
  /** An HRMS employee with no account yet — one is created for them. */
  employeeId?: string | null;
  app: string;
  /** The modules ticked in the review table. At least one. */
  modules: string[];
  /** Only read when an account has to be created. */
  account?: {
    email: string;
    phone?: string | null;
    role: "telecaller" | "manager" | "accounts" | "admin";
  };
};

export type EnableAccessResult = {
  userId: string;
  created: boolean;
  /** Said plainly rather than assumed — mail may not be configured. */
  resetLinkSent: boolean;
};

/**
 * Give somebody an app, narrowed to the modules that were left ticked.
 *
 * The employee must be ACTIVE in HRMS. That check is here and not only in the
 * picker, because the picker is a screen and this is the door.
 */
export async function enableAccess(
  input: EnableAccessInput,
): Promise<Result<EnableAccessResult>> {
  let me;
  try {
    me = await actor();
  } catch (e) {
    return fail(e instanceof Error ? e.message : "Not allowed.", "not_permitted");
  }

  const app = input.app as AppId;
  if (!APP_IDS.includes(app)) return fail(`Not an app: ${input.app}`);

  const { ok: modules, bad } = cleanModules(app, input.modules);
  if (bad.length) return fail(`Not a module of ${app}: ${bad.join(", ")}`);
  if (!modules.length) {
    // An app with nothing ticked is an app whose every screen redirects
    // somewhere else. Refused at the door rather than saved and then
    // discovered by the person it was done to.
    return fieldErr(
      "modules",
      "Leave at least one module ticked, or they open the app onto nothing.",
    );
  }

  let userId = input.userId ?? null;
  let created = false;
  let resetLinkSent = false;
  let personName = "";

  if (!userId) {
    if (!input.employeeId) return fail("Nobody was chosen.");
    if (!input.account) return fail("A new account needs a sign-in email and a role.");

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
    if (phone && !/^[6-9]\d{9}$/.test(phone)) {
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
    if (phone && clash.some((c) => c.phone === phone)) {
      return fieldErr("phone", "An account already uses that work number.");
    }

    userId = newId("usr");
    personName = employee.name;
    created = true;

    /*
     * A password nobody knows, and a link that lets them choose one.
     *
     * Typing a password into this dialog would mean somebody reading it out
     * over a phone, and it would be the password on an account that opens
     * salaries. The account is created unusable on purpose and the reset link
     * is what makes it usable — the same single-use, thirty-minute machinery
     * `/login/forgot` uses, reached the other way round.
     */
    const temporary = randomUUID() + randomUUID();
    const passwordHash = await hashPassword(temporary);

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
      await tx.insert(appAccess).values({
        id: newId("acc"),
        userId: userId!,
        app,
        grantedById: me.id,
      });
      await writeModules(tx, userId!, app, modules, me.id);
    });

    resetLinkSent = await mailResetLink(userId, employee.name, email, me.name);

    await audit(
      me.id,
      "create-user",
      userId,
      `${employee.name} · ${employee.code} · ${input.account.role} · ${app} (${modules.length}/${moduleKeysForApp(app).length} modules)`,
    );
  } else {
    const [account] = await db
      .select({ id: users.id, name: users.name, active: users.active })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    if (!account) return fail("That account no longer exists.", "not_found");
    if (!account.active) {
      return fail(`${account.name}'s account is deactivated, so it opens nothing.`);
    }
    personName = account.name;

    // An employee row behind the account has to be active too, where there is
    // one. Where there is not, the account itself is the only authority there
    // is and it is enough — several real accounts predate the employee sheet.
    const blocked = await hrmsBlock(userId);
    if (blocked) return fail(blocked, "rule_violation");

    await db.transaction(async (tx) => {
      await tx
        .insert(appAccess)
        .values({ id: newId("acc"), userId: userId!, app, grantedById: me.id })
        .onConflictDoNothing({ target: [appAccess.userId, appAccess.app] });
      await writeModules(tx, userId!, app, modules, me.id);
    });

    await audit(
      me.id,
      "set-app-access",
      userId,
      `granted ${app} (${modules.length}/${moduleKeysForApp(app).length} modules)`,
    );
  }

  refresh();

  const appName = getApp(app)?.name ?? app;
  const total = moduleKeysForApp(app).length;
  const scope =
    modules.length >= total
      ? `all ${total} modules`
      : `${modules.length} of ${total} modules`;

  return ok(
    { userId, created, resetLinkSent },
    created
      ? resetLinkSent
        ? `${personName} can now open ${appName} — ${scope}. A link to set their password has been emailed to them.`
        : `${personName} can now open ${appName} — ${scope}. No mail is configured on this deployment, so the password link went to the server log instead of to them.`
      : `${personName} can now open ${appName} — ${scope}.`,
  );
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
      `${actorName} has set you up on MahekOne. Your sign-in is ${email}.`,
      `Open this link to choose a password — it works once and expires in ${RESET_TTL_MINUTES} minutes:`,
      "",
      `${await appOrigin()}/login/reset?token=${token}`,
      "",
      "If the link has expired by the time you read this, use Forgot password on the sign-in screen.",
    ].join("\n"),
  });

  return mailConfigured();
}

/**
 * Change which modules of an app somebody holds, leaving the grant itself
 * alone. This is the review table's Save.
 */
export async function setAppModules(
  userId: string,
  appId: string,
  modules: string[],
): Promise<Result<{ modules: string[] }>> {
  let me;
  try {
    me = await actor();
  } catch (e) {
    return fail(e instanceof Error ? e.message : "Not allowed.", "not_permitted");
  }

  const app = appId as AppId;
  if (!APP_IDS.includes(app)) return fail(`Not an app: ${appId}`);

  const { ok: wanted, bad } = cleanModules(app, modules);
  if (bad.length) return fail(`Not a module of ${app}: ${bad.join(", ")}`);
  if (!wanted.length) {
    return fieldErr(
      "modules",
      "Leave at least one module ticked. To take the app away entirely, revoke it.",
    );
  }

  const [account] = await db
    .select({ name: users.name })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (!account) return fail("That account no longer exists.", "not_found");

  const held = await listUserApps(userId);
  if (!held.includes(app)) {
    return fail(`${account.name} does not have ${getApp(app)?.name ?? app}.`);
  }

  const before = await db
    .select({ module: appModuleAccess.module })
    .from(appModuleAccess)
    .where(and(eq(appModuleAccess.userId, userId), eq(appModuleAccess.app, app)));

  const total = moduleKeysForApp(app).length;
  const had = before.length === 0 ? moduleKeysForApp(app) : before.map((b) => b.module);
  const added = wanted.filter((w) => !had.includes(w));
  const removed = had.filter((h) => !wanted.includes(h));
  if (!added.length && !removed.length) return ok({ modules: wanted }, "No change.");

  await db.transaction(async (tx) => {
    await writeModules(tx, userId, app, wanted, me.id);
  });

  await audit(
    me.id,
    "set-module-access",
    userId,
    `${app}: ${had.length}/${total} → ${wanted.length}/${total}` +
      (added.length ? `; added ${added.join(", ")}` : "") +
      (removed.length ? `; removed ${removed.join(", ")}` : ""),
  );
  refresh();

  return ok(
    { modules: wanted },
    wanted.length >= total
      ? `${account.name} now opens all of ${getApp(app)?.name ?? app}.`
      : `${account.name} now opens ${wanted.length} of ${total} modules in ${getApp(app)?.name ?? app}.`,
  );
}

/** Take an app away entirely. Its module rows go with it. */
export async function revokeApp(
  userId: string,
  appId: string,
): Promise<Result<null>> {
  let me;
  try {
    me = await actor();
  } catch (e) {
    return fail(e instanceof Error ? e.message : "Not allowed.", "not_permitted");
  }

  const app = appId as AppId;
  if (!APP_IDS.includes(app)) return fail(`Not an app: ${appId}`);

  const [account] = await db
    .select({ name: users.name })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (!account) return fail("That account no longer exists.", "not_found");

  const held = await listUserApps(userId);
  if (!held.includes(app)) return ok(null, "No change.");

  await db.transaction(async (tx) => {
    await tx
      .delete(appAccess)
      .where(and(eq(appAccess.userId, userId), eq(appAccess.app, app)));
    // The module rows go too. Left behind, they would silently narrow the app
    // the day somebody granted it back.
    await tx
      .delete(appModuleAccess)
      .where(and(eq(appModuleAccess.userId, userId), eq(appModuleAccess.app, app)));
  });

  await audit(me.id, "set-app-access", userId, `revoked ${app}`);
  refresh();

  const left = held.filter((a) => a !== app);
  return ok(
    null,
    left.length
      ? `${account.name} no longer opens ${getApp(app)?.name ?? app}.`
      : `${account.name} no longer opens anything. They can still sign in, and the launcher will say so.`,
  );
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

/** Kept for the bulk paths: revoke several apps from one person at once. */
export async function revokeApps(
  userId: string,
  appIds: string[],
): Promise<Result<null>> {
  const apps = appIds.filter((a): a is AppId => APP_IDS.includes(a as AppId));
  if (!apps.length) return ok(null, "No change.");
  let last: Result<null> = ok(null, "No change.");
  for (const app of apps) {
    last = await revokeApp(userId, app);
    if (!last.ok) return last;
  }
  return last;
}
