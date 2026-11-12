import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Callout, Card, CardHeader, PageHeader, Td, Th, buttonClass } from "@/components/ui/primitives";
import { stamp } from "@/lib/format";
import { LANGUAGE_NAMES, type Language } from "@/lib/studio/domain/language";
import { designPreviewUrl, getBatch } from "@/lib/studio/service";
import { plural } from "../../_ui/parts";

export const metadata: Metadata = { title: "Bulk run" };
export const dynamic = "force-dynamic";

export default async function BatchPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const batch = await getBatch(id);
  if (!batch) notFound();
  const zip = `/api/studio/batches/${encodeURIComponent(id)}/zip`;
  return (
    <div className="mx-auto max-w-[1180px] px-6 py-6">
      <div className="mb-1 text-[13px] text-muted">
        <Link href="/studio/bulk">Bulk posters</Link> / {batch.templateName}
      </div>
      <PageHeader
        title={batch.templateName}
        subtitle={`${plural(batch.posters.length, "poster")} · ${LANGUAGE_NAMES[batch.language as Language] ?? batch.language} · ${stamp(batch.createdAt)} by ${batch.createdByName}`}
        subtitleShown
        actions={
          <>
            <a href={`${zip}?format=jpeg`} className={buttonClass({ variant: "secondary" })}>
              ZIP of JPGs
            </a>
            <a href={`${zip}?format=png`} className={buttonClass({ variant: "primary" })}>
              ZIP of PNGs
            </a>
          </>
        }
      />
      <Callout tone="info">The ZIP draws every poster as it is downloaded, one at a time, so a large run takes a minute or two to start.</Callout>
      {batch.skipped.length ? (
        <Card className="mb-4">
          <CardHeader title={`${plural(batch.skipped.length, "person", "people")} skipped`} hint="Each with the reason, so nobody is left out without anybody knowing." />
          <ul className="divide-y divide-divider">
            {batch.skipped.map((s) => (
              <li key={s.customerId} className="px-5 py-2 text-sm">
                <span className="font-medium text-ink">{s.name}</span> — <span className="text-muted">{s.reason}</span>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}
      <div className="grid gap-4 lg:grid-cols-[240px_minmax(0,1fr)]">
        <Card className="self-start p-3">
          {/* eslint-disable-next-line @next/next/no-img-element -- the design's stored preview */}
          <img src={designPreviewUrl(batch.templateId, batch.templateVersion)} alt="The design" className="w-full rounded-control" />
        </Card>
        <Card>
          <table className="w-full border-collapse">
            <thead>
              <tr>
                <Th>For</Th>
                <Th>Place</Th>
                <Th> </Th>
              </tr>
            </thead>
            <tbody>
              {batch.posters.map((p) => (
                <tr key={p.id} className="border-t border-divider">
                  <Td>
                    <span className="font-medium text-ink">{p.recipient.company}</span>
                    {p.recipient.contact ? <div className="text-[12.5px] text-muted">{p.recipient.contact}</div> : null}
                  </Td>
                  <Td>{[p.recipient.city, p.recipient.state].filter(Boolean).join(", ")}</Td>
                  <Td align="right">
                    <Link href={`/studio/posters/${p.id}`} className={buttonClass({ size: "sm" })}>
                      Open
                    </Link>
                  </Td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      </div>
    </div>
  );
}
