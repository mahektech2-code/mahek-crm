"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { shiftMonth, monthName } from "./month";

/* ---------------------------------------------------------------------------
 * The month picker — arrows plus a native month input to jump further.
 *
 * `shiftMonth`/`monthName` live in `./month.ts`, deliberately not here: this
 * file is `"use client"`, and every export of a `"use client"` module —
 * including a plain, non-component function — becomes a client reference to
 * the bundler. A Server Component that imported them from here and called
 * them directly (not as JSX) crashed at request time; see `month.ts`'s own
 * comment.
 * ------------------------------------------------------------------------- */

export function MonthNav({
  month,
  basePath,
  paramName = "month",
}: {
  month: string;
  /** The page's own path — the query string is built from `paramName`. */
  basePath: string;
  /** Whatever the caller's own `searchParams` key is — "period" or "month". */
  paramName?: string;
}) {
  const router = useRouter();
  // A plain string pair, not a closure — most of these five callers are
  // Server Components, and a function prop cannot cross into a Client
  // Component: React has no way to serialize it. Every page rendered this
  // fine locally and in isolation and then threw at request time in
  // production, which is exactly the shape of bug a type check cannot see.
  const hrefFor = (m: string) => `${basePath}?${paramName}=${m}`;

  return (
    <div className="flex items-center gap-1 text-[13px]">
      <Link
        href={hrefFor(shiftMonth(month, -1))}
        className="rounded-[4px] border border-line bg-surface px-2.5 py-1.5 text-body no-underline hover:bg-canvas hover:no-underline"
      >
        ←
      </Link>
      <span className="px-2 text-muted">{monthName(month)}</span>
      <input
        type="month"
        value={month}
        onChange={(e) => {
          if (e.target.value) router.push(hrefFor(e.target.value));
        }}
        aria-label="Jump to a month"
        title="Jump to a month"
        className="rounded-[4px] border border-line bg-surface px-1.5 py-[3px] text-[12px] text-body"
      />
      <Link
        href={hrefFor(shiftMonth(month, 1))}
        className="rounded-[4px] border border-line bg-surface px-2.5 py-1.5 text-body no-underline hover:bg-canvas hover:no-underline"
      >
        →
      </Link>
    </div>
  );
}
