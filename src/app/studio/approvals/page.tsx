import type { Metadata } from "next";
import Link from "next/link";
import { Card, EmptyState, PageHeader, Td, Th, buttonClass } from "@/components/ui/primitives";
import { stamp } from "@/lib/format";
import { approvedUploads, draftsAwaitingApproval } from "@/lib/studio/service";

export const metadata: Metadata = { title: "Approve designs" };
export const dynamic = "force-dynamic";

/* Every uploaded draft waiting to be published, whoever made it. Opening one
   shows the placement and the renderer's own preview; approving publishes it
   to everybody holding the Studio and can never be undone, so it is a module
   somebody is given rather than something a whole-app grant carries. */
export default async function Approvals() {
  const [waiting, done] = await Promise.all([draftsAwaitingApproval(), approvedUploads()]);
  return (
    <div className="mx-auto max-w-[1180px] px-6 py-6">
      <PageHeader title="Approve designs" subtitle="Uploaded designs waiting to be published. Open one to preview it with sample values, then approve it or send it back with a note." />
      <Card>
        {waiting.length ? (
          <table className="w-full border-collapse">
            <thead>
              <tr>
                <Th>Design</Th>
                <Th>Uploaded by</Th>
                <Th>Last edited</Th>
                <Th> </Th>
              </tr>
            </thead>
            <tbody>
              {waiting.map((d) => (
                <tr key={d.id} className="border-t border-divider">
                  <Td className="font-medium text-ink">{d.name}</Td>
                  <Td>{d.createdByName}</Td>
                  <Td>{stamp(d.updatedAt)}</Td>
                  <Td align="right">
                    <Link href={`/studio/designs/${d.id}`} className={buttonClass({ size: "sm", variant: "primary" })}>
                      Review
                    </Link>
                  </Td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <EmptyState title="Nothing waiting" body="When somebody uploads a design, it is listed here." />
        )}
      </Card>
      {done.length ? (
        <>
          <h2 className="mt-6 mb-2 text-base font-semibold text-ink">Published uploads</h2>
          <Card>
            <ul className="divide-y divide-divider">
              {done.map((d) => (
                <li key={d.id} className="px-5 py-2 text-sm">
                  <span className="font-medium text-ink">{d.name}</span> <span className="text-muted">· by {d.createdByName} · approved {stamp(d.approvedAt)}</span>
                </li>
              ))}
            </ul>
          </Card>
        </>
      ) : null}
    </div>
  );
}
