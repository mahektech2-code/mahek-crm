import { Card, EmptyState } from "@/components/ui/primitives";
import { canFor } from "@/lib/access-control";
import { AdminPage } from "../_shell/admin-page";
import { requirePlatformAdmin } from "../_shell/context";
import { TrashSection } from "../trash-section";

/** Deleted leads, and the one place they come back from. Administrators only — the API refuses anybody else. */
export default async function DeletedLeadsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const ctx = await requirePlatformAdmin();
  const query = await searchParams;
  const one = (k: string) => {
    const v = query[k];
    return Array.isArray(v) ? v[0] : v;
  };
  const canRestore = await canFor(ctx.user, "lead.restore");
  return (
    <AdminPage
      title="Deleted leads"
      subtitle="Leads deleted from Lead Management. Off every screen until restored here — with their owner, stage and every call and note intact."
    >
      {canRestore ? (
        <TrashSection
          initial={{
            // Where the address left the filters, so the server and the browser agree on the first render.
            q: one("tq") ?? "",
            by: one("tby") ?? "",
            from: one("tfrom") ?? "",
            to: one("tto") ?? "",
            sort: one("tsort") ?? "",
            page: Number(one("tpage")) || 1,
            per: Number(one("tper")) || 25,
          }}
        />
      ) : (
        <Card className="mt-5">
          <EmptyState
            title="Restoring a lead is an administrator's"
            body="Ask an administrator if a lead was deleted by mistake."
          />
        </Card>
      )}
    </AdminPage>
  );
}
