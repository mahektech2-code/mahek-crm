import type { Metadata } from "next";
import Link from "next/link";
import { Card, EmptyState, PageHeader, Td, Th, buttonClass } from "@/components/ui/primitives";
import { stamp } from "@/lib/format";
import { LANGUAGE_NAMES, type Language } from "@/lib/studio/domain/language";
import { listBatches } from "@/lib/studio/service";

export const metadata: Metadata = { title: "Bulk posters" };
export const dynamic = "force-dynamic";

export default async function BulkPage() {
  const batches = await listBatches();
  return (
    <div className="mx-auto max-w-[1180px] px-6 py-6">
      <PageHeader title="Bulk posters" subtitle="One design for many people at once." actions={<Link href="/studio/bulk/new" className={buttonClass({ variant: "primary" })}>New bulk run</Link>} />
      <Card>
        {batches.length ? (
          <table className="w-full border-collapse">
            <thead>
              <tr>
                <Th>Design</Th>
                <Th>For</Th>
                <Th>Posters</Th>
                <Th>Made</Th>
              </tr>
            </thead>
            <tbody>
              {batches.map((b) => (
                <tr key={b.id} className="border-t border-divider">
                  <Td>
                    <Link href={`/studio/bulk/${b.id}`} className="font-medium">
                      {b.templateName}
                    </Link>
                    <div className="text-[12.5px] text-muted">{LANGUAGE_NAMES[b.language as Language] ?? b.language}</div>
                  </Td>
                  <Td>{b.audience === "customer" ? "Customers" : "Leads"}</Td>
                  <Td>
                    {b.made} of {b.requested}
                    {b.skipped.length ? <span className="text-warn-ink"> · {b.skipped.length} skipped</span> : null}
                  </Td>
                  <Td>
                    {stamp(b.createdAt)}
                    {b.mine ? null : <div className="text-[12.5px] text-muted">by {b.createdByName}</div>}
                  </Td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <EmptyState title="No bulk runs yet" body="Pick a design and tick up to fifty leads or customers." action={<Link href="/studio/bulk/new" className={buttonClass({ variant: "primary" })}>New bulk run</Link>} />
        )}
      </Card>
    </div>
  );
}
