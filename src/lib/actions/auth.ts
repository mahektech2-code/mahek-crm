"use server";

import { redirect } from "next/navigation";
import { eq, or } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { appAccess, users } from "@/db/schema";
import {
  createSession,
  destroySession,
  getCurrentUser,
  hashPassword,
  requireManager,
  verifyPassword,
} from "@/lib/auth";
import { listUserApps, recordSignIn, recordSignOut } from "@/lib/access";
import { getApp, APP_IDS, type AppId } from "@/lib/apps";
import { audit, fail, newId, ok, type ActionResult } from "./core";
import { initialsOf } from "@/lib/format";

/* ---------------------------------------------------------------------------
 * One sign-in for all of MahekOne. Where it lands you depends on what you can
 * open: one app goes straight in, several go to the launcher.
 * ------------------------------------------------------------------------- */

const credentials = z.object({
  identifier: z
    .string()
    .trim()
    .min(1, "Enter your work number or email address."),
  password: z.string().min(1, "Enter your password."),
  remember: z.boolean().default(true),
});

/** Telecallers know their phone number; office staff know their email. */
function normalise(identifier: string) {
  const digits = identifier.replace(/\D/g, "");
  return {
    email: identifier.toLowerCase(),
    phone: digits.length >= 10 ? digits.slice(-10) : null,
  };
}

export async function signIn(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const parsed = credentials.safeParse({
    identifier: formData.get("identifier"),
    password: formData.get("password"),
    remember: formData.get("remember") === "on",
  });
  if (!parsed.success) {
    return fail(parsed.error.issues[0].message);
  }

  const { email, phone } = normalise(parsed.data.identifier);

  const [user] = await db
    .select()
    .from(users)
    .where(phone ? or(eq(users.email, email), eq(users.phone, phone)) : eq(users.email, email))
    .limit(1);

  // Same message either way — never reveal which half was wrong.
  const wrong =
    "That did not match an account. Check the spelling, or ask your manager to reset it.";
  if (!user || !user.active) return fail(wrong);
  if (!(await verifyPassword(parsed.data.password, user.passwordHash))) {
    return fail(wrong);
  }

  await createSession(user.id, parsed.data.remember);
  await recordSignIn(user.id, newId("att"));
  await audit(user, "sign-in", "user", user.id);

  const apps = await listUserApps(user.id);
  if (!apps.length) {
    // Signed in, but nobody has given them an app yet. Say so rather than
    // dropping them on an empty screen.
    redirect("/apps");
  }
  // One app is not a choice — go straight there.
  if (apps.length === 1) {
    redirect(getApp(apps[0])?.href ?? "/apps");
  }
  redirect("/apps");
}

export async function signOut() {
  const user = await getCurrentUser();
  if (user) {
    await recordSignOut(user.id);
    await audit(user, "sign-out", "user", user.id);
  }
  await destroySession();
  redirect("/login");
}

/* ------------------------------------------------------------- accounts */

const newUser = z.object({
  name: z.string().trim().min(2, "Enter the person's full name."),
  email: z.string().trim().toLowerCase().email("Enter a valid email address."),
  phone: z
    .string()
    .trim()
    .optional()
    .transform((v) => (v ? v.replace(/\D/g, "").slice(-10) : undefined)),
  password: z.string().min(8, "Passwords must be at least 8 characters."),
  role: z.enum(["telecaller", "manager"]),
  apps: z.array(z.enum(APP_IDS)).min(1, "Give them at least one app."),
});

/** Managers create accounts — there is no self-signup on an internal tool. */
export async function createTeamMember(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  let manager;
  try {
    manager = await requireManager();
  } catch {
    return fail("Only a manager can add team members.");
  }

  const parsed = newUser.safeParse({
    name: formData.get("name"),
    email: formData.get("email"),
    phone: formData.get("phone"),
    password: formData.get("password"),
    role: formData.get("role"),
    apps: formData.getAll("apps"),
  });
  if (!parsed.success) return fail(parsed.error.issues[0].message);

  const existing = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, parsed.data.email))
    .limit(1);
  if (existing.length) return fail("Somebody already uses that email address.");

  const id = newId("usr");
  await db.transaction(async (tx) => {
    await tx.insert(users).values({
      id,
      name: parsed.data.name,
      email: parsed.data.email,
      phone: parsed.data.phone || null,
      passwordHash: await hashPassword(parsed.data.password),
      role: parsed.data.role,
      initials: initialsOf(parsed.data.name),
    });
    await tx.insert(appAccess).values(
      parsed.data.apps.map((app) => ({
        id: newId("acc"),
        userId: id,
        app,
        grantedById: manager.id,
      })),
    );
  });

  await audit(manager, "create", "user", id, parsed.data.name);
  return ok(`${parsed.data.name} can now sign in.`);
}

export async function setAppAccess(
  userId: string,
  apps: AppId[],
): Promise<ActionResult> {
  let manager;
  try {
    manager = await requireManager();
  } catch {
    return fail("Only a manager can change app access.");
  }

  await db.transaction(async (tx) => {
    await tx.delete(appAccess).where(eq(appAccess.userId, userId));
    if (apps.length) {
      await tx.insert(appAccess).values(
        apps.map((app) => ({
          id: newId("acc"),
          userId,
          app,
          grantedById: manager.id,
        })),
      );
    }
  });

  await audit(manager, "set-app-access", "user", userId, apps.join(", "));
  return ok("App access updated");
}
