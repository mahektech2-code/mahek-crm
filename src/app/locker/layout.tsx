import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { and, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { employees, lockerBreakglass, lockerIdentities, lockerReveals, users } from "@/db/schema";
import { requireUser } from "@/lib/auth";
import { listUserApps } from "@/lib/access";
import { webApps } from "@/lib/apps";
import { initialsOf } from "@/lib/format";
import { hatForHeader } from "@/lib/hat-for-header";
import { lockerAccess } from "@/lib/locker/access";
import { CATEGORIES } from "@/lib/locker/catalogue";
import { registerFor } from "@/lib/locker/service";
import { rotationDueCount } from "@/lib/locker/vault-counts";
import { listNotifications } from "@/lib/queries";
import "@/styles/v4-theme.css";
import { LockerShell, type LockerNav } from "./_ui/locker-shell";
import "./locker.css";

export const metadata: Metadata = { title: { template: "%s · Locker · MahekOne", default: "Locker · MahekOne" } };

/**
 * The Locker's shell. The grant is checked here as well as on the launcher —
 * a bookmarked /locker must not open for somebody never given it — and the
 * sidebar draws only the modules this person holds. Each screen's folder has
 * its own layout calling `requireModule`, so a bookmark past a withheld one
 * lands on the first one they do hold.
 */
export default async function LockerLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser();
  const apps = await listUserApps(user.id);
  if (!apps.includes("locker")) redirect("/apps");
  const access = await lockerAccess(user.id);
  if (!access.keys.size) redirect("/apps");
  const has = access.has;

  const [notifications, hat, register, pendingReveals, awaitingBg, activeBg, uncontrolled, rotation, me] = await Promise.all([
    listNotifications(user.id),
    hatForHeader(user, "locker"),
    registerFor(user.id),
    has("locker.approvals") ? db.select({ n: sql<number>`count(*)::int` }).from(lockerReveals).where(eq(lockerReveals.state, "waiting")) : Promise.resolve([{ n: 0 }]),
    has("locker.approvals") ? db.select({ n: sql<number>`count(*)::int` }).from(lockerBreakglass).where(eq(lockerBreakglass.state, "awaiting")) : Promise.resolve([{ n: 0 }]),
    db
      .select({ id: lockerBreakglass.id, by: users.name, until: lockerBreakglass.activeUntil, scope: lockerBreakglass.scope, approvedById: lockerBreakglass.approvedById })
      .from(lockerBreakglass)
      .innerJoin(users, eq(users.id, lockerBreakglass.startedById))
      .where(and(eq(lockerBreakglass.state, "active"), sql`${lockerBreakglass.activeUntil} > now()`))
      .limit(1),
    access.vault ? db.select({ n: sql<number>`count(*)::int` }).from(lockerIdentities).where(and(eq(lockerIdentities.controlled, false), eq(lockerIdentities.active, true))) : Promise.resolve([{ n: 0 }]),
    has("locker.rotation") ? rotationDueCount() : Promise.resolve(0),
    db.select({ position: employees.position }).from(users).leftJoin(employees, eq(employees.id, users.employeeId)).where(eq(users.id, user.id)).limit(1),
  ]);

  const live = register.filter((a) => a.live);
  const mine = live.filter((a) => a.ownerId === user.id || a.backupId === user.id);
  const mineDue = mine.filter((a) => ["renewal_due", "expiring", "in_grace", "expired"].includes(a.status));
  const approvals = (pendingReveals[0]?.n ?? 0) + (awaitingBg[0]?.n ?? 0);
  const hazardousDue = live.filter((a) => a.category === "hazardous" && ["expired", "in_grace", "renewal_due"].includes(a.status)).length;
  const riskN = live.filter((a) => !a.ownerId).length + (uncontrolled[0]?.n ?? 0);

  type Row = LockerNav["groups"][number]["items"][number];
  const counts: Record<string, { n: number; over?: boolean }> = {};
  const item = (key: string, href: string, label: string, icon: string, extra: Partial<Row> & { count?: number; over?: boolean } = {}): Row[] => {
    if (!has(key)) return [];
    const { count, over, ...rest } = extra;
    if (count) counts[href] = { n: count, over };
    return [{ href, label, icon, ...rest }];
  };
  const nav: LockerNav = {
    groups: [
      { label: "Overview", icon: "grid", items: [...item("locker.dashboard", "/locker", "Dashboard", "grid", { exact: true }), ...item("locker.calendar", "/locker/calendar", "Calendar", "cal"), ...item("locker.risk", "/locker/risk", "Risk", "alert", { count: riskN, over: true })] },
      {
        label: "My work",
        icon: "user",
        items: [
          ...item("locker.myassets", "/locker/my-assets", "My assets", "user"),
          ...item("locker.renewals", "/locker/renewals", "Renewals", "refresh", { count: mineDue.length, over: mineDue.some((a) => (a.d ?? 0) < 0) }),
          ...item("locker.approvals", "/locker/approvals", "Approvals", "check", { count: approvals, match: ["/locker/emergency"] }),
        ],
      },
      {
        label: "Register",
        icon: "box",
        items: [
          ...(has("locker.assets") || access.categories.length ? [{ href: "/locker/assets", label: "All assets", icon: "box", exact: true, match: ["/locker/assets/new"] }] : []),
          ...CATEGORIES.filter((c) => c.inNav).flatMap((c) =>
            item(`locker.cat.${c.slug}`, `/locker/assets/c/${c.slug}`, c.slug === "hazardous" ? "Hazardous ⚠" : c.nav, c.icon, c.slug === "hazardous" ? { count: hazardousDue, over: true } : {}),
          ),
        ],
      },
      {
        label: "Vault",
        icon: "key",
        items: [
          ...item("locker.credentials", "/locker/vault", "Passwords & keys", "key", { exact: true, match: ["/locker/vault/new"] }),
          ...item("locker.identities", "/locker/vault/accounts", "Sign-in accounts", "id"),
          ...item("locker.providers", "/locker/vault/providers", "Providers", "layers"),
          ...item("locker.graph", "/locker/vault/connections", "Connections", "share"),
          ...item("locker.rotation", "/locker/vault/change-due", "Change due", "rotate", { count: rotation, over: true }),
        ],
      },
      {
        label: "Operations",
        icon: "list",
        items: [...item("locker.offboard", "/locker/offboard", "Offboard", "exit"), ...item("locker.review", "/locker/review", "Access review", "eye"), ...item("locker.costs", "/locker/costs", "Costs", "coin"), ...item("locker.audit", "/locker/audit", "Audit", "list")],
      },
      {
        label: "Admin",
        icon: "cog",
        items: [
          ...item("locker.types", "/locker/admin/types", "Types", "type"),
          ...item("locker.ladders", "/locker/admin/reminders", "Reminders", "ladder"),
          ...item("locker.entities", "/locker/admin/companies", "Companies", "pin"),
          ...item("locker.access", "/locker/admin/access", "Access", "key"),
          ...item("locker.settings", "/locker/admin/security", "Security", "cog"),
        ],
      },
    ].filter((g) => g.items.length),
  };

  const bg = activeBg[0];
  const banner = bg?.until
    ? { line: `Emergency access active · started by ${bg.by} · ${bg.scope.length} items in scope · until ${new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit", hour12: false }).format(bg.until)} · everyone can see this` }
    : null;

  return (
    <>
      {/* eslint-disable-next-line @next/next/no-page-custom-font */}
      <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600;700;800&display=swap" precedence="default" />
      <LockerShell
        nav={nav}
        counts={counts}
        user={{ name: user.name, email: user.email, phone: user.phone, initials: initialsOf(user.name), role: hat.label, title: me[0]?.position ?? "" }}
        hat={hat}
        apps={webApps(apps)}
        notifications={notifications}
        vault={access.vault}
        banner={banner}
      >
        {children}
      </LockerShell>
    </>
  );
}
