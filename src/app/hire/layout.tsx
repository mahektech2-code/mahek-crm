import type { Metadata } from "next";
import { listUserApps } from "@/lib/access";
import { webApps } from "@/lib/apps";
import { initialsOf } from "@/lib/format";
import { hatForHeader } from "@/lib/hat-for-header";
import { listNotifications } from "@/lib/queries";
import { requireHire } from "@/lib/hire/access";
import { aiState } from "@/lib/hire/ai/orchestrator";
import { navFor } from "@/lib/hire/roles";
import { navCounts } from "@/lib/hire/services/counts";
import { HireShell } from "./_ui/hire-shell";

export const metadata: Metadata = { title: { template: "%s · Hire · MahekOne", default: "Hire · MahekOne" } };

/**
 * Hire's shell. The grant is checked here as well as on the launcher — a
 * bookmarked /hire must not open for somebody never given it — and the sidebar
 * draws only the groups this person's Hire role holds. Each page checks its
 * own screen again, because a link that is not drawn is not a permission.
 */
export default async function HireLayout({ children }: { children: React.ReactNode }) {
  const ctx = await requireHire();
  const [apps, hat, notifications, counts, ai] = await Promise.all([
    listUserApps(ctx.user.id),
    hatForHeader(ctx.user, "hire"),
    listNotifications(ctx.user.id),
    navCounts(ctx),
    aiState(),
  ]);
  return (
    <HireShell
      nav={navFor(ctx.role)}
      counts={counts}
      user={{ name: ctx.user.name, email: ctx.user.email, phone: ctx.user.phone, initials: initialsOf(ctx.user.name), role: ctx.roleLabel }}
      hat={{ ...hat, label: `${ctx.roleLabel} · Hire` }}
      notifications={notifications}
      apps={webApps(apps)}
      aiDown={ai.on ? null : `AI is unavailable — ${ai.reason}`}
    >
      {children}
    </HireShell>
  );
}
