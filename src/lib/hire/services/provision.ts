import "server-only";
import { randomUUID } from "node:crypto";
import { and, eq, isNull, or, sql } from "drizzle-orm";
import { db } from "@/db";
import { appAccess, hireApplications, hireCandidates, hireDecisions, hireDocuments, hireOnboardingItems, hireStageExecutions, passwordResets, users } from "@/db/schema";
import { APP_IDS, getApp, type AppId } from "@/lib/apps";
import { initialsOf } from "@/lib/format";
import { sendMail } from "@/lib/mailer";
import { notifyUsers } from "@/lib/notify";
import { hashPassword } from "@/lib/password";
import { appOrigin, hashResetToken, newResetToken, RESET_TTL_MINUTES } from "@/lib/password-reset";
import { err, ok, type Result } from "@/lib/result";
import { grantAppWithDefaultModules, rederiveAccountLevel } from "@/lib/services/app-provisioning";
import type { HireContext } from "../access";
import { hireTrail, ensureExecution, getApplication, type AppBundle } from "./core";
import { courierArrived, currentOffer } from "./offers";

/* ---------------------------------------------------------------------------
 * PROVISIONING — the terminal action (spec §7.2, PRD P8).
 *
 * Hired is not a status somebody types. It is set HERE, in the same
 * transaction that creates the MahekOne account and grants the apps the
 * role's blueprint names, which is the "missing final status" (D9) and the
 * first day of the person's working life in the suite.
 *
 * The account is created UNUSABLE — a password nobody knows — exactly as the
 * Admin Console's Access dialog creates one: a password read out over a phone
 * is a password chosen badly. A reset link goes to a work email when there is
 * one; otherwise the screen says to issue a password from Admin Console →
 * Access. A phone number that already belongs to an account LINKS to it.
 * ------------------------------------------------------------------------- */

const last10 = (e164: string) => e164.replace(/\D/g, "").slice(-10);

export type ProvisionPlan = {
  apps: { id: AppId; name: string }[];
  skipped: string[];
  level: "associate" | "manager";
  roleLabel: string;
  device: boolean;
  existingUser: { id: string; name: string } | null;
  phone: string;
  email: string | null;
  emailTaken: boolean;
  blockers: string[];
};

export async function provisionPlan(b: AppBundle): Promise<ProvisionPlan> {
  const p = b.def.provisioning;
  const apps = p.apps.filter((a): a is AppId => (APP_IDS as readonly string[]).includes(a)).map((id) => ({ id, name: getApp(id)?.name ?? id }));
  const skipped = p.apps.filter((a) => !(APP_IDS as readonly string[]).includes(a));
  const phone = last10(b.candidate.primaryPhone);
  const email = b.candidate.email?.trim().toLowerCase() || null;
  const [byPhone] = await db.select({ id: users.id, name: users.name, email: users.email }).from(users).where(or(eq(users.phone, phone), eq(users.phone, b.candidate.primaryPhone))).limit(1);
  const [byEmail] = email ? await db.select({ id: users.id }).from(users).where(sql`lower(${users.email}) = ${email}`).limit(1) : [];
  return {
    apps,
    skipped,
    level: p.level,
    roleLabel: p.roleLabel,
    device: p.device,
    existingUser: byPhone ? { id: byPhone.id, name: byPhone.name } : null,
    phone,
    email,
    emailTaken: Boolean(byEmail && byEmail.id !== byPhone?.id),
    blockers: b.app.status === "hired" ? [] : await provisionBlockers(b),
  };
}

/** Everything that still stands between this candidate and a working account. */
export async function provisionBlockers(b: AppBundle): Promise<string[]> {
  const out: string[] = [];
  if (b.app.status !== "in_progress") return [`The application is ${b.app.status.replace("_", " ")}.`];
  const stage = b.def.stages.find((s) => s.key === b.app.stageKey);
  if (stage?.type !== "system_setup") out.push(`They are at ${stage?.name ?? b.app.stageKey}, not field setup — every stage before it has to be passed.`);
  const items = await db.select().from(hireOnboardingItems).where(and(eq(hireOnboardingItems.applicationId, b.app.id), eq(hireOnboardingItems.done, true)));
  const done = new Set(items.map((i) => `${i.kind}:${i.groupKey}:${i.itemKey}`));
  const steps = b.def.onboarding.setup.flatMap((g) => g.steps.map((s) => ({ k: `setup:${g.key}:${s.key}`, l: `${g.system} · ${s.label}` })));
  const openSteps = steps.filter((s) => !done.has(s.k));
  if (openSteps.length) out.push(`${openSteps.length} setup step${openSteps.length === 1 ? "" : "s"} still open: ${openSteps.slice(0, 3).map((s) => s.l).join("; ")}${openSteps.length > 3 ? "…" : ""}.`);
  const kit = [...b.def.onboarding.assets.map((a) => `asset:assets:${a.key}`), ...b.def.onboarding.modules.flatMap((m) => m.topics.map((t) => `topic:${m.key}:${t.key}`))];
  const kitLeft = kit.filter((k) => !done.has(k)).length;
  if (kitLeft) out.push(`${kitLeft} work-kit item${kitLeft === 1 ? "" : "s"} or training topic${kitLeft === 1 ? "" : "s"} not ticked.`);
  const docs = await db.select({ key: hireDocuments.requirementKey, st: hireDocuments.verificationStatus }).from(hireDocuments).where(and(eq(hireDocuments.applicationId, b.app.id), isNull(hireDocuments.supersededById)));
  const okDocs = new Set(docs.filter((d) => d.st === "verified" || d.st === "waived").map((d) => d.key));
  const missing = b.def.documents.filter((d) => d.mandatory && !okDocs.has(d.key));
  if (missing.length) out.push(`Mandatory documents not verified: ${missing.map((d) => d.label).join(", ")}.`);
  const offer = await currentOffer(b.app.id);
  if (offer?.status !== "accepted") out.push("There is no accepted offer.");
  else if (!courierArrived(offer)) out.push("The signed offer has not come back by courier.");
  return out;
}

export type Provisioned = { userId: string; created: boolean; granted: string[]; alreadyHeld: string[]; resetSent: boolean; emailUsed: string | null };

export async function provision(ctx: HireContext, applicationId: string, note: string): Promise<Result<Provisioned>> {
  const b = await getApplication(ctx, applicationId);
  if (!b) return err("That candidate is not on your list.", "not_found");
  if (b.app.status === "hired") return err(`${b.candidate.fullName} is already hired.`, "rule_violation");
  const plan = await provisionPlan(b);
  if (plan.blockers.length) return err(`Not yet: ${plan.blockers[0]}`, "rule_violation");
  if (!plan.apps.length) return err("The blueprint grants no MahekOne app, so there is nothing to provision. Fix its Provisioning section.", "rule_violation");
  const reasoning = note.trim().length >= 20 ? note.trim() : `Onboarding complete: documents verified, offer accepted, work kit and every training topic and setup step done. ${note.trim()}`.trim();

  const now = new Date();
  let userId = plan.existingUser?.id ?? null;
  let created = false;
  const emailUsed = plan.email && !plan.emailTaken && !plan.existingUser ? plan.email : null;
  const granted: string[] = [];
  const alreadyHeld: string[] = [];

  await db.transaction(async (tx) => {
    if (!userId) {
      userId = `usr_${randomUUID()}`;
      created = true;
      await tx.insert(users).values({
        id: userId,
        name: b.candidate.fullName,
        email: emailUsed,
        phone: plan.phone,
        /* A password nobody knows: unusable until one is issued. */
        passwordHash: await hashPassword(randomUUID() + randomUUID()),
        role: plan.level,
        initials: initialsOf(b.candidate.fullName),
        active: true,
      });
    }
    const held = await tx.select({ app: appAccess.app }).from(appAccess).where(eq(appAccess.userId, userId));
    for (const a of plan.apps) {
      if (held.some((h) => h.app === a.id)) {
        alreadyHeld.push(a.name);
        continue;
      }
      await grantAppWithDefaultModules(tx, { userId, app: a.id, grantedById: ctx.user.id, level: plan.level });
      granted.push(a.name);
    }
    await rederiveAccountLevel(tx, userId);

    const setup = b.def.stages.find((s) => s.type === "system_setup");
    if (setup) {
      const ex = await ensureExecution(applicationId, setup, ctx.user.id, tx);
      await tx.update(hireStageExecutions).set({ status: "completed", outcome: "pass", completedAt: now, conductedById: ctx.user.id, updatedAt: now }).where(eq(hireStageExecutions.id, ex.id));
    }
    await tx
      .update(hireApplications)
      .set({ status: "hired", hiredAt: now, employeeUserId: userId, closedAt: now, decisionReason: reasoning, updatedAt: now, updatedById: ctx.user.id })
      .where(eq(hireApplications.id, applicationId));
    await tx.update(hireCandidates).set({ talentPoolStatus: "archived", updatedAt: now }).where(eq(hireCandidates.id, b.candidate.id));
    await tx.insert(hireDecisions).values({
      id: `hde_${randomUUID()}`,
      applicationId,
      decisionPoint: "provision",
      decidedById: ctx.user.id,
      decidedByRole: ctx.roleLabel,
      decision: "hire",
      reasoning,
      agreedWithAi: null,
      evidenceReviewed: ["documents", "offer", "induction", "setup"],
    });
    await hireTrail(
      ctx,
      {
        applicationId,
        candidateId: b.candidate.id,
        entityType: "application",
        entityId: applicationId,
        event: "provisioned",
        summary: `Provisioned MahekOne account ${created ? "(created)" : `(linked to ${plan.existingUser?.name})`} · ${granted.length ? `granted ${granted.join(", ")}` : "no new apps"}${alreadyHeld.length ? ` · already held ${alreadyHeld.join(", ")}` : ""} as ${plan.level} — ${plan.roleLabel} · status Hired`,
        after: { userId, apps: plan.apps.map((a) => a.id), level: plan.level },
      },
      tx,
    );
    await hireTrail(
      ctx,
      {
        applicationId,
        candidateId: b.candidate.id,
        entityType: "application",
        entityId: applicationId,
        event: "training_portal_handoff",
        summary: `Handed off to the Training Portal with employee account ${userId}. Hire recorded which topics were taught; the portal records what is learned.`,
      },
      tx,
    );
  });

  let resetSent = false;
  if (created && emailUsed) {
    try {
      const token = newResetToken();
      await db.insert(passwordResets).values({ id: `rst_${randomUUID()}`, userId: userId!, tokenHash: hashResetToken(token), expiresAt: new Date(Date.now() + RESET_TTL_MINUTES * 60_000) });
      const link = `${await appOrigin()}/login/reset?token=${token}`;
      const r = await sendMail({
        to: emailUsed,
        subject: "Welcome to MahekOne — set your password",
        text: [`Hello ${b.candidate.fullName.split(" ")[0]},`, "", `Your MahekOne account is ready. Open this link to set a password — it works once and expires in ${RESET_TTL_MINUTES} minutes:`, link, "", `You sign in with ${plan.phone} or this email.`].join("\n"),
      });
      resetSent = r.delivered;
    } catch (e) {
      console.error("hire provision: reset mail failed:", e instanceof Error ? e.message : e);
    }
  }

  const tell = [b.app.hiringManagerId, b.app.recruiterId].filter((x): x is string => Boolean(x) && x !== ctx.user.id);
  if (tell.length)
    await notifyUsers(
      [...new Set(tell)].map((u) => ({
        userId: u,
        title: `${b.candidate.fullName} is hired`,
        body: `${b.blueprint.title} · their MahekOne account is ${created ? "created" : "linked"} with ${plan.apps.map((a) => a.name).join(", ")}.`,
        href: `/hire/provision?app=${applicationId}`,
      })),
    ).catch(() => []);

  return ok({ userId: userId!, created, granted, alreadyHeld, resetSent, emailUsed }, `${b.candidate.fullName} is hired. Their MahekOne account is ${created ? "created" : "linked"}.`);
}

/** For the Hired confirmation: what was made, read back from the records. */
export async function hiredSummary(b: AppBundle) {
  if (!b.app.employeeUserId) return null;
  const [u] = await db.select({ id: users.id, name: users.name, email: users.email, phone: users.phone, role: users.role, passwordSet: sql<boolean>`false` }).from(users).where(eq(users.id, b.app.employeeUserId)).limit(1);
  const apps = await db.select({ app: appAccess.app, role: appAccess.role }).from(appAccess).where(eq(appAccess.userId, b.app.employeeUserId));
  const [d] = await db
    .select({ by: users.name, at: hireDecisions.decidedAt, reasoning: hireDecisions.reasoning })
    .from(hireDecisions)
    .innerJoin(users, eq(users.id, hireDecisions.decidedById))
    .where(and(eq(hireDecisions.applicationId, b.app.id), eq(hireDecisions.decision, "hire")))
    .limit(1);
  const [reset] = await db.select({ id: passwordResets.id }).from(passwordResets).where(eq(passwordResets.userId, b.app.employeeUserId)).limit(1);
  return { user: u ?? null, apps: apps.map((a) => ({ name: getApp(a.app)?.name ?? a.app, level: a.role ?? "associate" })), decision: d ?? null, resetIssued: Boolean(reset) };
}

