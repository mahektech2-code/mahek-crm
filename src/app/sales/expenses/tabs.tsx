import Link from "next/link";
import { cx } from "@/components/ui/primitives";
import { hrefWith, type Query } from "./query";

/**
 * The two halves of Expenses: deciding claims, and the ledger of what each
 * salesman claimed, was allowed, was refused and has been paid. Links, not
 * buttons — each is its own address somebody can send. The period and the
 * salesman ride across, so switching tab keeps what somebody was looking at.
 */
export function ExpenseTabs({
  current,
  query,
}: {
  current: "claims" | "ledger";
  query: Query;
}) {
  const keep: Query = {
    period: query.period,
    on: query.on,
    from: query.from,
    to: query.to,
    month: query.month,
    who: query.who,
  };
  const tabs = [
    { key: "claims", label: "Claims", href: hrefWith("/sales/expenses", keep) },
    {
      key: "ledger",
      label: "Ledger",
      href: hrefWith("/sales/expenses/ledger", keep),
    },
  ] as const;
  return (
    <div className="mb-4 flex items-center border-b border-line">
      {tabs.map((t) => (
        <Link
          key={t.key}
          href={t.href}
          className={cx(
            "-mb-px border-b-2 px-4 py-2.5 text-sm whitespace-nowrap no-underline",
            current === t.key
              ? "border-brand font-medium text-ink"
              : "border-transparent text-muted hover:text-body",
          )}
        >
          {t.label}
        </Link>
      ))}
    </div>
  );
}
