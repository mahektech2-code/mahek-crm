import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Callout, PageHeader } from "@/components/ui/primitives";
import { resolveScope } from "@/lib/access-control";
import { DNC_WARNING, LIST_LABEL, getRecipient } from "@/lib/studio/recipients";
import { prepareRecipe } from "@/lib/studio/render-service";
import { designsFor, occasionsFor } from "@/lib/studio/service";
import { DesignGrid, DesignTile, Tabs } from "../../_ui/parts";

export const metadata: Metadata = { title: "Choose a design" };
export const dynamic = "force-dynamic";

export default async function ChooseDesign({ params, searchParams }: { params: Promise<{ customerId: string }>; searchParams: Promise<{ occasion?: string }> }) {
  const { customerId } = await params;
  const sp = await searchParams;
  const { scope } = await resolveScope();
  const r = await getRecipient(scope.userIds, customerId);
  if (!r) notFound();
  const [designs, occasions] = await Promise.all([designsFor(r.audience), occasionsFor(r.audience)]);
  /* Each design is asked whether it can be made for THIS record — no drawing,
     just the same checks Make runs — so a design that needs a product picture
     nobody has, or data this record lacks, says so here rather than after
     somebody has filled in the form. */
  const blocked = new Map(
    await Promise.all(
      designs.map(async (d) => {
        const p = await prepareRecipe({ audience: r.audience, recipient: r.recipient, senderName: "Sender", templateId: d.id, language: d.languages[0]!.code, showProduct: true, personal: {} });
        return [d.id, p.ok ? null : p.error] as const;
      }),
    ),
  );
  const occasion = occasions.some((o) => o.id === sp.occasion) ? sp.occasion : null;
  const shown = occasion ? designs.filter((d) => d.occasion === occasion) : designs;
  const base = `/studio/make/${encodeURIComponent(r.id)}`;
  return (
    <div className="mx-auto max-w-[1180px] px-6 py-6">
      <div className="mb-1 text-[13px] text-muted">
        <Link href={`/studio/make?list=${r.list}`}>{LIST_LABEL[r.list]}</Link> / {r.company}
      </div>
      <PageHeader title="Choose a design" subtitle={`For ${r.contact ? `${r.contact}, ` : ""}${r.company}${r.city ? ` · ${r.city}` : ""}`} subtitleShown />
      {r.doNotContact ? <Callout tone="danger">{DNC_WARNING}</Callout> : null}
      <Tabs
        items={[
          { href: base, label: "All", count: designs.length, active: !occasion },
          ...occasions.map((o) => ({ href: `${base}?occasion=${o.id}`, label: o.label, count: designs.filter((d) => d.occasion === o.id).length, active: o.id === occasion })),
        ]}
      />
      <DesignGrid>
        {shown.map((d) => (
          <DesignTile key={d.id} design={d} href={blocked.get(d.id) ? undefined : `${base}/${encodeURIComponent(d.id)}`} note={blocked.get(d.id) ?? null} dim={Boolean(blocked.get(d.id))} />
        ))}
      </DesignGrid>
      {shown.length === 0 ? <p className="text-sm text-muted">No designs for this occasion yet.</p> : null}
    </div>
  );
}
