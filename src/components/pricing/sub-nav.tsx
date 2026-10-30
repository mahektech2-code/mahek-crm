/* ---------------------------------------------------------------------------
 * THE FIVE DOORS INTO PRICING, drawn once.
 *
 * Lists, Documents, Requests, Coverage and Variance are five screens about one
 * subject, and a person moving between them is not navigating the app — they
 * are turning a page. So they are tabs rather than five sidebar entries, in the
 * same shape the CRM's own `Tabs` draws: a border along the bottom and a brand
 * underline on the one you are reading.
 *
 * It takes `basePath` rather than reading the URL, because the same five
 * screens are mounted under `/crm/price-lists`, `/accounts/price-lists` and
 * `/founder/price-lists`, and a
 * component that worked out which app it was in would be a second answer to a
 * question the page already knows. Links rather than buttons, and no hooks at
 * all, so a server page can render it without shipping a byte of JavaScript.
 * ------------------------------------------------------------------------- */

import Link from "next/link";
import { cx } from "@/components/ui/primitives";

export type PricingTabKey =
  | "today"
  | "books"
  | "lists"
  | "documents"
  | "requests"
  | "overrides"
  | "shops"
  | "coverage"
  | "variance"
  | "watch";

/*
 * PRICE BOOKS joined these tabs rather than replacing any of them. Today,
 * Books, Overrides, Shop prices and Watch are the book workflow; Lists and the
 * four screens after it are every list as it always was, so nothing anybody
 * used before moved.
 */
const TABS: Array<{ key: PricingTabKey; label: string; suffix: string }> = [
  { key: "today", label: "Today", suffix: "/today" },
  { key: "books", label: "Books", suffix: "/books" },
  { key: "lists", label: "Lists", suffix: "" },
  { key: "documents", label: "Documents", suffix: "/documents" },
  { key: "requests", label: "Requests", suffix: "/requests" },
  { key: "overrides", label: "Overrides", suffix: "/overrides" },
  { key: "shops", label: "Shop prices", suffix: "/shops" },
  { key: "coverage", label: "Coverage", suffix: "/coverage" },
  { key: "variance", label: "Variance", suffix: "/variance" },
  { key: "watch", label: "Watch", suffix: "/watch" },
];

export function PricingSubNav({
  basePath,
  current,
}: {
  basePath: string;
  current: PricingTabKey;
}) {
  return (
    <div className="mb-5 flex items-center overflow-x-auto border-b border-line">
      {TABS.map((tab) => {
        const active = tab.key === current;
        return (
          <Link
            key={tab.key}
            href={`${basePath}${tab.suffix}`}
            aria-current={active ? "page" : undefined}
            className={cx(
              "-mb-px border-b-2 px-4 py-2.5 text-sm whitespace-nowrap transition-colors duration-100",
              active
                ? "border-brand font-medium text-ink"
                : "border-transparent text-muted hover:text-body",
            )}
          >
            {tab.label}
          </Link>
        );
      })}
    </div>
  );
}
