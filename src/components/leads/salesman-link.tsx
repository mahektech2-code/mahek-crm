"use client";

import Link from "next/link";
import type { LeadWorkspace } from "@/lib/lead-workspace";

/* ---------------------------------------------------------------------------
 * A SALESMAN'S NAME, which is a link in one app and a name in the other.
 *
 * Six screens in this workspace show whose lead it is and let somebody open
 * that person — `/sales/people/[id]`, the Manager Console's Salesmen screen.
 * The CRM has no such screen and is not getting one: a telecaller has no
 * business opening a colleague's salary, attendance and territory, and
 * `sales.people` is a grant they do not hold.
 *
 * So the name is drawn either way and only the LINK is conditional. The
 * alternative — dropping the name in the CRM — loses the one fact a telecaller
 * most needs off these rows, which is who is already working this shop; the
 * other alternative, linking anyway, sends them to a route whose layout
 * redirects them to `/apps`, which reads as the row being broken.
 *
 * It is a component rather than a `hrefOrNull` helper because the two shapes
 * are different elements, and six call sites each writing their own ternary is
 * six chances for one of them to render an underlined span that looks like a
 * link and does nothing.
 * ------------------------------------------------------------------------- */

export function SalesmanLink({
  workspace,
  id,
  name,
  className,
}: {
  workspace: LeadWorkspace;
  /** Null where the lead has no salesman — the name is then all there is. */
  id: string | null | undefined;
  name: React.ReactNode;
  className?: string;
}) {
  if (workspace !== "sales" || !id) {
    return <span className={className}>{name}</span>;
  }
  return (
    <Link href={`/sales/people/${id}`} className={className}>
      {name}
    </Link>
  );
}
