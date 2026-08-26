"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cx } from "@/components/ui/primitives";

/* ---------------------------------------------------------------------------
 * The Founder Dashboard shell — a top bar, exactly like Reports and for the
 * same reason: this is five screens read a few times a week, not a place
 * somebody works all day, so a sidebar would take width off tables that are
 * already wide for four links.
 *
 * Company comes first because it is the headline; Team, Money and People are
 * the three things that make it up; CRM is last because the Reports app
 * already owns that detail and this tab only points at it.
 * ------------------------------------------------------------------------- */

type Tab = { href: string; label: string; exact?: boolean };

const TABS: Tab[] = [
  { href: "/founder", label: "Company", exact: true },
  { href: "/founder/team", label: "Team performance" },
  { href: "/founder/money", label: "Money" },
  { href: "/founder/people", label: "People" },
  { href: "/founder/crm", label: "CRM" },
];

export function FounderShell({
  allowed,
  switcher,
  feedback,
  user,
  children,
}: {
  /** Module hrefs this person holds. A link they cannot open is not drawn. */
  allowed: readonly string[];
  switcher: React.ReactNode;
  feedback: React.ReactNode;
  user: { name: string; initials: string };
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const visible = TABS.filter((t) => allowed.includes(t.href));

  return (
    <div className="min-h-screen bg-canvas">
      <header className="border-b border-line bg-surface">
        <div className="flex items-center justify-between gap-4 px-6 pt-4">
          <div className="flex min-w-0 items-center gap-3">
            {switcher}
            <span className="flex items-baseline gap-3">
              <span className="text-[15px] font-semibold text-ink">Founder Dashboard</span>
              <span className="text-[13px] text-muted">
                Every app, one reading of the company
              </span>
            </span>
          </div>
          <div className="flex items-center gap-2.5">
            {feedback}
            <span
              className="flex h-7 w-7 items-center justify-center rounded-full bg-divider text-[11px] font-medium text-body"
              title={user.name}
            >
              {user.initials}
            </span>
          </div>
        </div>

        <nav className="flex gap-1 px-6 pt-3">
          {visible.map((tab) => {
            const active = tab.exact
              ? pathname === tab.href
              : pathname.startsWith(tab.href);
            return (
              <Link
                key={tab.href}
                href={tab.href}
                className={cx(
                  "-mb-px border-b-2 px-3 py-2 text-[13px] no-underline hover:no-underline",
                  active
                    ? "border-brand font-medium text-ink"
                    : "border-transparent text-muted hover:text-body",
                )}
              >
                {tab.label}
              </Link>
            );
          })}
        </nav>
      </header>

      <main>{children}</main>
    </div>
  );
}
