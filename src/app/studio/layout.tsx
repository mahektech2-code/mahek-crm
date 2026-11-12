import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { listUserApps, listUserModules } from "@/lib/access";
import { webApps } from "@/lib/apps";
import { initialsOf } from "@/lib/format";
import { hatForHeader } from "@/lib/hat-for-header";
import { listNotifications } from "@/lib/queries";
import { istDateKey } from "@/lib/studio/date";
import { draftsAwaitingApproval, dueFor } from "@/lib/studio/service";
import "@/styles/v4-theme.css";
import { StudioShell, type StudioNav } from "./_ui/studio-shell";

export const metadata: Metadata = { title: { template: "%s · Studio · MahekOne", default: "Studio · MahekOne" } };

/**
 * The Studio's shell. The grant is checked here as well as on the launcher —
 * a bookmarked /studio must not open for somebody never given it — and the
 * sidebar draws only the modules this person holds. Each module folder has
 * its own layout calling `requireModule`, so a bookmark past a withheld one
 * lands on the first one they do hold.
 */
export default async function StudioLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser();
  const apps = await listUserApps(user.id);
  if (!apps.includes("studio")) redirect("/apps");
  const [modules, hat, notifications] = await Promise.all([listUserModules(user.id, "studio"), hatForHeader(user, "studio"), listNotifications(user.id)]);
  if (!modules.length) redirect("/apps");
  const held = new Set(modules.map((m) => m.key));
  const [due, awaiting] = await Promise.all([
    held.has("studio.home") ? dueFor(user.id, istDateKey(new Date())).catch(() => []) : [],
    held.has("studio.approve") ? draftsAwaitingApproval() : [],
  ]);

  const nav: StudioNav = {
    pinned: [
      ...(held.has("studio.home") ? [{ href: "/studio", label: "Home", icon: "dashboard", exact: true }] : []),
      ...(held.has("studio.make") ? [{ href: "/studio/make", label: "Make a poster", icon: "image" }] : []),
      ...(held.has("studio.bulk") ? [{ href: "/studio/bulk", label: "Bulk posters", icon: "grid" }] : []),
      ...(held.has("studio.posters") ? [{ href: "/studio/posters", label: "My posters", icon: "history" }] : []),
      ...(held.has("studio.dates") ? [{ href: "/studio/dates", label: "Dates", icon: "calendar" }] : []),
      /* A group of one is a heading over a single link; without Approve the
         Designs screen sits with the rest. */
      ...(held.has("studio.designs") && !held.has("studio.approve") ? [{ href: "/studio/designs", label: "Designs", icon: "image" }] : []),
    ],
    groups: [
      ...(held.has("studio.approve")
        ? [
            {
              label: "Designs",
              icon: "image",
              items: [
                ...(held.has("studio.designs") ? [{ href: "/studio/designs", label: "Designs", icon: "image" }] : []),
                ...(held.has("studio.approve") ? [{ href: "/studio/approvals", label: "Approve designs", icon: "checkCircle" }] : []),
              ],
            },
          ]
        : []),
    ],
  };

  return (
    <>
      {/* eslint-disable-next-line @next/next/no-page-custom-font */}
      <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600;700;800&display=swap" precedence="default" />
      <StudioShell
        nav={nav}
        counts={{
          "/studio": { n: due.filter((r) => r.unread).length },
          "/studio/approvals": { n: awaiting.length },
        }}
        user={{ name: user.name, email: user.email, phone: user.phone, initials: initialsOf(user.name), role: hat.label }}
        hat={hat}
        notifications={notifications}
        apps={webApps(apps)}
      >
        {children}
      </StudioShell>
    </>
  );
}
