"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cx } from "@/components/ui/primitives";

/* ---------------------------------------------------------------------------
 * The Reports shell.
 *
 * A TOP BAR rather than a sidebar, and that is the whole design decision. The
 * CRM and the Manager Console are places somebody works all day and navigate
 * between two dozen destinations; this is four screens read a few times a
 * month, and a two-hundred-pixel sidebar holding four links would take a fifth
 * of the width off tables that are already wide.
 *
 * The four are one funnel read at four points, so they are drawn in that order
 * and never alphabetically: where business comes from, what became of it, what
 * it was worth, and whether the customers it produced are still buying.
 * ------------------------------------------------------------------------- */

type Tab = { href: string; label: string; exact?: boolean };

const TABS: Tab[] = [
  { href: "/reports", label: "Overview", exact: true },
  { href: "/reports/leads", label: "Leads & conversion" },
  { href: "/reports/sales", label: "Bill size & frequency" },
  { href: "/reports/customers", label: "Customer health" },
];

export function ReportsShell({
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
          {/* The switcher opens the header here too — see the note in
              sales-shell.tsx. `items-center` on the outer row rather than the
              inherited `items-baseline`, because a baseline shared between a
              button and a line of text puts the button low. */}
          <div className="flex min-w-0 items-center gap-3">
            {switcher}
            <span className="flex items-baseline gap-3">
              <span className="text-[15px] font-semibold text-ink">Reports</span>
              <span className="text-[13px] text-muted">
                New business, what it is worth, and who is still buying
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
