import type { TargetRow } from "@/lib/services/sales-target-service";

/**
 * A month's person-level targets as spreadsheet rows — the table both target
 * screens draw, Sales' and Accounts', in the same order. One copy, so the two
 * doors onto one feature cannot export two different files.
 */
export function targetsCsv(rows: TargetRow[], existing: Record<string, number>) {
  const rupees = (p: number | null) => (p === null ? "" : Math.round(p / 100));
  const pct = (bp: number | null) => (bp === null ? "" : Math.round(bp / 100));
  return [
    [
      "Person",
      "Status",
      "Revenue excl. GST (Rs)",
      "From existing customers (Rs)",
      "Volume (L)",
      "New customers",
      "Collection (%)",
      "Activity (%)",
      "Product mix (min / target / stretch %)",
    ],
    ...rows.map((r) => [
      r.userName,
      r.status === "published" && r.carriedForward
        ? "Carried forward"
        : r.status === "published"
          ? "Published"
          : r.status === "draft"
            ? "Draft"
            : "Not set",
      rupees(r.revenueTargetPaise),
      rupees(existing[r.userId] ?? 0),
      r.volumeTargetMl === null ? "" : Math.round(r.volumeTargetMl / 1000),
      r.newCustomerTarget ?? "",
      pct(r.collectionTargetBp),
      pct(r.activityTargetBp),
      r.bands
        .map((b) => `${b.name} ${pct(b.minimumBp)}/${pct(b.targetBp)}/${pct(b.stretchBp)}`)
        .join("; "),
    ]),
  ];
}
