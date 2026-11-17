import Link from "next/link";
import { Card, CardHeader, EmptyState } from "@/components/ui/primitives";
import { ADMIN } from "@/lib/admin-routes";
import { placeSetting } from "@/lib/config/settings-placement";
import { sizeLine, storageSummary } from "@/lib/services/admin-console-service";
import { AdminPage } from "../_shell/admin-page";
import { requirePlatformAdmin } from "../_shell/context";

/**
 * STORAGE & FILES — what the attachment store holds, by kind, and how long
 * each kind is kept. Retention is the settings that already enforce it; this
 * screen says them back and links to where they are changed.
 */
export default async function StoragePage() {
  await requirePlatformAdmin();
  const s = await storageSummary();
  const biggest = Math.max(1, ...s.kinds.map((k) => k.bytes));

  return (
    <AdminPage
      title="Storage & files"
      subtitle="What the attachment store holds, and how long each kind is kept."
      metrics={[
        { label: "Files", value: s.files.toLocaleString("en-IN") },
        { label: "Size", value: sizeLine(s.bytes) },
        { label: "Attached to nothing", value: s.unattached.toLocaleString("en-IN"), tone: s.unattached ? "warn" : undefined },
        { label: "Removed", value: s.removed.toLocaleString("en-IN") },
      ]}
    >
      <div className="grid gap-4 lg:grid-cols-2">
        <Card className="overflow-hidden">
          <CardHeader title="By kind" />
          {s.kinds.length === 0 ? (
            <EmptyState title="Nothing is stored yet" />
          ) : (
            <ul className="flex flex-col gap-3 px-5 py-4">
              {s.kinds.map((k) => (
                <li key={k.kind} className="grid grid-cols-[170px_minmax(0,1fr)_80px] items-center gap-3">
                  <span className="truncate text-sm text-body" title={`${k.files} files`}>
                    {words(k.kind)}
                  </span>
                  <span className="h-2.5 overflow-hidden rounded-full bg-divider">
                    <span className="block h-full bg-brand" style={{ width: `${(k.bytes / biggest) * 100}%` }} />
                  </span>
                  <span className="text-right text-sm font-semibold text-ink tabular-nums">{sizeLine(k.bytes)}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card className="overflow-hidden">
          <CardHeader title="Kept for" />
          <ul className="divide-y divide-divider">
            {s.retention.map((r) => {
              const page = placeSetting(r.key);
              return (
                <li key={r.key} className="flex items-center gap-3 px-5 py-3.5">
                  <span className="flex-1 font-semibold text-ink">{r.label}</span>
                  <span className="text-sm text-body tabular-nums">{r.value}</span>
                  {page ? (
                    <Link href={`${ADMIN.settingsFor(page.page, page.tab)}#${r.key}`} className="text-sm font-semibold">
                      Change
                    </Link>
                  ) : null}
                </li>
              );
            })}
            {s.largest ? (
              <li className="flex items-center gap-3 px-5 py-3.5">
                <span className="flex-1 font-semibold text-ink">Largest file</span>
                <span className="max-w-[220px] truncate text-sm text-muted" title={s.largest.filename}>
                  {s.largest.filename}
                </span>
                <span className="text-sm text-body tabular-nums">{sizeLine(s.largest.bytes)}</span>
              </li>
            ) : null}
          </ul>
        </Card>
      </div>
    </AdminPage>
  );
}

/** `mbos_visit` → "Mbos visit". */
function words(code: string): string {
  const w = code.replace(/_/g, " ");
  return w.charAt(0).toUpperCase() + w.slice(1);
}
