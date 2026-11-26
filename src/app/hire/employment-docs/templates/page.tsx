import { requireHireScreen } from "@/lib/hire/access";
import { TEMPLATE_FIELDS } from "@/lib/hire/engines/onboarding";
import { lockedWhy } from "@/lib/hire/roles";
import { listTemplates } from "@/lib/hire/services/onboarding-records";
import { PageHead } from "../../_ui/kit";
import { TemplatesEditor, type TemplateGroup } from "./templates-editor";

export const dynamic = "force-dynamic";
export const metadata = { title: "Employment document templates" };

/** The templates employment documents are prepared from. A version is frozen once published; a prepared document keeps the wording it was prepared with. */
export default async function TemplatesPage({ searchParams }: { searchParams: Promise<{ key?: string }> }) {
  const ctx = await requireHireScreen("empdocs");
  const sp = await searchParams;
  const rows = await listTemplates();
  const keys = [...new Set(rows.map((r) => r.key))];
  const groups: TemplateGroup[] = keys.map((key) => {
    const v = rows.filter((r) => r.key === key);
    const published = v.find((x) => x.status === "published") ?? null;
    const draft = v.find((x) => x.status === "draft") ?? null;
    const base = draft ?? published ?? v[0];
    return { key, title: base.title, body: base.body, editingVersion: draft?.version ?? null, publishedVersion: published?.version ?? null, versions: v.length };
  });
  return (
    <>
      <PageHead
        title="Employment document templates"
        back={{ href: "/hire/employment-docs", label: "Employment documents" }}
        sub="The wording each employment document is prepared from. Placeholders are filled from the accepted offer, so a contract never retypes a figure. Publishing makes a new version; documents already prepared keep theirs."
      />
      <TemplatesEditor groups={groups} fields={TEMPLATE_FIELDS.map(([k, l]) => ({ key: k, label: l }))} initialKey={sp.key ?? groups[0]?.key ?? null} canEdit={ctx.can("employmentDocs")} editWhy={lockedWhy("employmentDocs")} />
    </>
  );
}
