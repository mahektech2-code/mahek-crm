import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Callout, PageHeader } from "@/components/ui/primitives";
import { requireUser } from "@/lib/auth";
import { resolveScope } from "@/lib/access-control";
import { LANGUAGE_NAMES } from "@/lib/studio/domain/language";
import { offersTo } from "@/lib/studio/domain/audience";
import { POSTER_ONLY_NOTICE } from "@/lib/studio/domain/personalization";
import { DNC_WARNING, LIST_LABEL, getRecipient } from "@/lib/studio/recipients";
import { getStudioRegistry } from "@/lib/studio/registry-service";
import { designCard, designInputs, wordingChoices } from "@/lib/studio/service";
import { PersonalizeForm } from "../../../_ui/personalize-form";

export const metadata: Metadata = { title: "Personalise" };
export const dynamic = "force-dynamic";

export default async function Personalise({ params }: { params: Promise<{ customerId: string; designId: string }> }) {
  const { customerId, designId } = await params;
  const user = await requireUser();
  const { scope } = await resolveScope();
  const r = await getRecipient(scope.userIds, customerId);
  if (!r) notFound();
  const registry = await getStudioRegistry();
  const t = registry.get(designId);
  if (!t || !offersTo(t.manifest, r.audience)) notFound();
  const card = designCard(registry, t, r.audience);
  const languages = registry.languagesFor(t, r.audience);
  const wordings = Object.fromEntries(
    await Promise.all(
      languages.map(async (l) => [l, await wordingChoices({ templateId: t.manifest.id, language: l, audience: r.audience, company: r.company, contact: r.contact, product: r.recipient.product?.name ?? null })] as const),
    ),
  );
  const inputs = designInputs(t);
  return (
    <div className="mx-auto max-w-[1180px] px-6 py-6">
      <div className="mb-1 text-[13px] text-muted">
        <Link href={`/studio/make?list=${r.list}`}>{LIST_LABEL[r.list]}</Link> / <Link href={`/studio/make/${encodeURIComponent(r.id)}`}>{r.company}</Link> / {card.name}
      </div>
      <PageHeader title={card.name} subtitle={`For ${r.contact ? `${r.contact}, ` : ""}${r.company}`} subtitleShown />
      {r.doNotContact ? <Callout tone="danger">{DNC_WARNING}</Callout> : null}
      <PersonalizeForm
        customerId={r.id}
        designId={t.manifest.id}
        designPreview={card.preview}
        languages={languages.map((l) => ({ code: l, label: LANGUAGE_NAMES[l] }))}
        defaultLanguage={languages[0]!}
        wordings={wordings}
        inputs={inputs}
        products={r.products.map((p) => ({ id: p.id, name: p.name }))}
        recipient={{ contact: r.contact, company: r.company }}
        sender={user.name}
        notice={POSTER_ONLY_NOTICE}
      />
    </div>
  );
}
