"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useTransition } from "react";
import { cx } from "@/components/ui/primitives";
import {
  REPORT_PERIODS,
  REPORT_PERIOD_LABELS,
  type ReportPeriod,
} from "@/lib/business-date";

/** The Company tab's period picker. No custom range — see `period.ts`. */
export function PeriodBar({ period }: { period: ReportPeriod }) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [pending, start] = useTransition();

  const set = (value: string) => {
    const next = new URLSearchParams(params.toString());
    next.set("period", value);
    start(() => router.push(`${pathname}?${next.toString()}`));
  };

  return (
    <div
      className={cx(
        "mb-4 flex items-end gap-3 rounded-[6px] border border-line bg-surface px-5 py-3.5",
        pending && "opacity-60",
      )}
    >
      <label className="block">
        <span className="mb-1 block text-[11px] font-medium tracking-[0.04em] whitespace-nowrap text-muted uppercase">
          Period
        </span>
        <select
          value={period}
          onChange={(e) => set(e.target.value)}
          className="rounded-[4px] border border-line bg-surface px-2 py-1 text-[13px]"
        >
          {REPORT_PERIODS.filter((p) => p !== "custom").map((p) => (
            <option key={p} value={p}>
              {REPORT_PERIOD_LABELS[p]}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}
