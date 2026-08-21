"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useTransition } from "react";
import { cx } from "@/components/ui/primitives";
import {
  REPORT_PERIODS,
  REPORT_PERIOD_LABELS,
  type ReportPeriod,
} from "@/lib/business-date";

/* ---------------------------------------------------------------------------
 * One filter bar, read by all four screens.
 *
 * It lives in the URL rather than in component state, and every one of these
 * pages is a server component that reads it. Three things fall out of that and
 * all of them matter here: a filtered view can be sent to somebody, the back
 * button works, and the four screens cannot drift into four different ideas of
 * what "this quarter" means — they all parse the same parameters through the
 * same pure `reportRange`.
 * ------------------------------------------------------------------------- */

export type FilterOptions = {
  regions: string[];
  cities: string[];
  salesmen: { id: string; name: string }[];
  salesManagers: { id: string; name: string }[];
  customerTypes: string[];
};

export function FilterBar({
  options,
  period,
  from,
  to,
}: {
  options: FilterOptions;
  period: ReportPeriod;
  from: string;
  to: string;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [pending, start] = useTransition();

  const set = (patch: Record<string, string | null>) => {
    const next = new URLSearchParams(params.toString());
    for (const [k, v] of Object.entries(patch)) {
      if (v === null || v === "") next.delete(k);
      else next.set(k, v);
    }
    start(() => router.push(`${pathname}?${next.toString()}`));
  };

  const current = params.get("period") ?? period;

  return (
    <div
      className={cx(
        "mb-4 flex flex-wrap items-end gap-x-4 gap-y-3 rounded-[6px] border border-line bg-surface px-5 py-3.5",
        pending && "opacity-60",
      )}
    >
      <Field label="Period">
        <select
          value={current}
          onChange={(e) => set({ period: e.target.value })}
          className="rounded-[4px] border border-line bg-surface px-2 py-1 text-[13px]"
        >
          {REPORT_PERIODS.map((p) => (
            <option key={p} value={p}>
              {REPORT_PERIOD_LABELS[p]}
            </option>
          ))}
        </select>
      </Field>

      {/* Only where a custom range is actually chosen. Two date boxes sitting
          permanently beside a period picker invite somebody to fill them in and
          wonder why nothing moved. */}
      {current === "custom" ? (
        <>
          <Field label="From">
            <input
              type="date"
              value={from}
              onChange={(e) => set({ from: e.target.value })}
              className="rounded-[4px] border border-line bg-surface px-2 py-1 text-[13px]"
            />
          </Field>
          <Field label="To">
            <input
              type="date"
              value={to}
              onChange={(e) => set({ to: e.target.value })}
              className="rounded-[4px] border border-line bg-surface px-2 py-1 text-[13px]"
            />
          </Field>
        </>
      ) : null}

      <Picker
        label="Salesperson"
        value={params.get("salesman")}
        onChange={(v) => set({ salesman: v })}
        options={options.salesmen.map((s) => ({ value: s.id, label: s.name }))}
      />
      <Picker
        label="Sales manager"
        value={params.get("salesManager")}
        onChange={(v) => set({ salesManager: v })}
        options={options.salesManagers.map((s) => ({ value: s.id, label: s.name }))}
      />
      <Picker
        label="Region"
        value={params.get("region")}
        onChange={(v) => set({ region: v })}
        options={options.regions.map((r) => ({ value: r, label: r }))}
      />
      <Picker
        label="City"
        value={params.get("city")}
        onChange={(v) => set({ city: v })}
        options={options.cities.map((c) => ({ value: c, label: c }))}
      />
      <Picker
        label="Customer type"
        value={params.get("customerType")}
        onChange={(v) => set({ customerType: v })}
        options={options.customerTypes.map((t) => ({ value: t, label: titleCase(t) }))}
      />

      {[...params.keys()].some((k) => FILTER_KEYS.includes(k)) ? (
        <button
          type="button"
          onClick={() =>
            set(Object.fromEntries(FILTER_KEYS.map((k) => [k, null])))
          }
          className="ml-auto rounded-[4px] border border-line bg-surface px-2.5 py-1 text-[12px] text-body hover:bg-canvas"
        >
          Clear filters
        </button>
      ) : null}
    </div>
  );
}

const FILTER_KEYS = ["salesman", "salesManager", "region", "city", "customerType"];

function Picker({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string | null;
  onChange: (v: string | null) => void;
  options: { value: string; label: string }[];
}) {
  // A picker with nothing to pick is not drawn. An empty dropdown reads as a
  // broken filter rather than as a book with one region in it.
  if (!options.length) return null;
  return (
    <Field label={label}>
      <select
        value={value ?? ""}
        onChange={(e) => onChange(e.target.value || null)}
        className="max-w-[190px] rounded-[4px] border border-line bg-surface px-2 py-1 text-[13px]"
      >
        <option value="">All</option>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </Field>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-[11px] font-medium tracking-[0.04em] whitespace-nowrap text-muted uppercase">
        {label}
      </span>
      {children}
    </label>
  );
}

function titleCase(v: string) {
  return v.charAt(0).toUpperCase() + v.slice(1);
}
