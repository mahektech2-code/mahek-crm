import type { Metadata } from "next";
import Link from "next/link";
import { requireHireScreen } from "@/lib/hire/access";
import { listBlueprints } from "@/lib/hire/services/blueprints";
import { Empty, PageHead, Pill } from "../_ui/kit";
import { StartFrom } from "./start-from";

export const metadata: Metadata = { title: "Library" };
export const dynamic = "force-dynamic";

export default async function LibraryPage() {
  const ctx = await requireHireScreen("library");
  const all = await listBlueprints();
  /* The latest version of each role, grouped by family. */
  const latest = new Map<string, (typeof all)[number]>();
  for (const b of all) if (!latest.has(b.key) || latest.get(b.key)!.version < b.version) latest.set(b.key, b);
  const fams = new Map<string, (typeof all)[number][]>();
  for (const b of latest.values()) fams.set(b.family, [...(fams.get(b.family) ?? []), b]);
  const canStart = ctx.can("editBp") || ctx.can("proposeBp");
  return (
    <>
      <PageHead title="Library" sub="Role families and the blueprints in them. Start a new role from the closest one — the copy is a draft, and the original never changes." />
      {fams.size ? (
        <div className="grid grid-cols-2 gap-4 xl:grid-cols-3">
          {[...fams.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([fam, items]) => (
            <section key={fam} className="rounded-[6px] border border-line bg-surface p-5">
              <div className="text-[15px] font-semibold text-heading">{fam}</div>
              <div className="mt-0.5 text-[13px] text-muted tabular-nums">
                {items.length} role{items.length === 1 ? "" : "s"} · {items.reduce((n, b) => n + b.inFlight, 0)} candidates in flight
              </div>
              <div className="mt-3 flex flex-col">
                {items.map((b) => (
                  <div key={b.id} className="flex items-center gap-3 border-t border-divider py-2.5">
                    <span className="min-w-0 flex-1">
                      <Link href={`/hire/blueprints/${b.id}`} className="block truncate text-sm font-medium text-heading">{b.title}</Link>
                      <span className="flex items-center gap-1.5 text-[13px] text-muted">
                        v{b.version}
                        <Pill tone={b.status === "published" ? "success" : b.status === "draft" ? "warn" : "muted"}>{b.status}</Pill>
                      </span>
                    </span>
                    {canStart ? <StartFrom id={b.id} title={b.title} /> : null}
                  </div>
                ))}
              </div>
            </section>
          ))}
        </div>
      ) : (
        <Empty title="No roles yet">Create the first one from Blueprints.</Empty>
      )}
    </>
  );
}
