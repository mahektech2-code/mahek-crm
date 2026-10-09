import Link from "next/link";
import { cx } from "@/components/ui/primitives";

/**
 * The two halves of Expenses: deciding claims, and the ledger of what each
 * salesman claimed, was allowed, was refused and has been paid. Links, not
 * buttons — each is its own address somebody can send.
 */
export function ExpenseTabs({
  current,
  month,
}: {
  current: "claims" | "ledger";
  month: string;
}) {
  const tabs = [
    { key: "claims", label: "Claims", href: `/sales/expenses?month=${month}` },
    {
      key: "ledger",
      label: "Ledger",
      href: `/sales/expenses/ledger?month=${month}`,
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
