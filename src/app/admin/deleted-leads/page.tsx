import { Card, EmptyState, Td, Th } from "@/components/ui/primitives";
import { ADMIN } from "@/lib/admin-routes";
import { stamp, stampDate } from "@/lib/format";
import { binAnnouncements, binDocuments, binFiles, sizeLine } from "@/lib/services/admin-console-service";
import { BinRestoreButton } from "./restore-button";

const BIN_TABS = [
  { slug: "leads", label: "Leads" },
  { slug: "files", label: "Files" },
  { slug: "documents", label: "Documents" },
  { slug: "announcements", label: "Announcements" },
] as const;
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
  const view = BIN_TABS.find((t) => t.slug === one("view"))?.slug ?? "leads";
  const tabs = {
    items: BIN_TABS,
    active: view,
    href: (s: string) => (s === "leads" ? ADMIN.deletedLeads : `${ADMIN.deletedLeads}?view=${s}`),
  };
  if (view !== "leads") {
    return (
      <AdminPage
        title="Recycle bin"
        subtitle="What somebody deleted, held so it can be put back."
        tabs={tabs}
      >
        <BinList view={view} />
      </AdminPage>
    );
  }
  return (
    <AdminPage
      title="Recycle bin"
      subtitle="Leads deleted from Lead Management. Restored with their owner, stage and every call and note intact."
      tabs={tabs}
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

async function BinList({ view }: { view: "files" | "documents" | "announcements" }) {
  if (view === "files") {
    const files = await binFiles();
    if (!files.length) return <Card><EmptyState title="No removed files are held" /></Card>;
    return (
      <Card className="overflow-hidden">
        <table>
          <thead>
            <tr>
              <Th>File</Th>
              <Th>Was on</Th>
              <Th align="right">Size</Th>
              <Th>Removed</Th>
              <Th>Deleted for good on</Th>
              <Th />
            </tr>
          </thead>
          <tbody>
            {files.map((f) => (
              <tr key={f.id} className="border-b border-divider">
                <Td className="max-w-[320px] truncate font-semibold text-ink" title={f.filename}>{f.filename}</Td>
                <Td className="text-muted">{f.kind.replace(/_/g, " ")}</Td>
                <Td align="right">{sizeLine(f.bytes)}</Td>
                <Td>{stamp(f.removedAt)}</Td>
                <Td>{stampDate(f.purgeOn)}</Td>
                <Td align="right"><BinRestoreButton kind="file" id={f.id} name={f.filename} /></Td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    );
  }
  if (view === "documents") {
    const docs = await binDocuments();
    if (!docs.length) return <Card><EmptyState title="No withdrawn documents" /></Card>;
    return (
      <Card className="overflow-hidden">
        <table>
          <thead>
            <tr>
              <Th>Document</Th>
              <Th>Withdrawn</Th>
              <Th />
            </tr>
          </thead>
          <tbody>
            {docs.map((d) => (
              <tr key={d.id} className="border-b border-divider">
                <Td className="font-semibold text-ink">{d.title}</Td>
                <Td>{stamp(d.updatedAt)}</Td>
                <Td align="right"><BinRestoreButton kind="document" id={d.id} name={d.title} /></Td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    );
  }
  const notes = await binAnnouncements();
  if (!notes.length) return <Card><EmptyState title="No deleted announcements" /></Card>;
  return (
    <Card className="overflow-hidden">
      <table>
        <thead>
          <tr>
            <Th>Announcement</Th>
            <Th>To</Th>
            <Th>From</Th>
            <Th>Deleted</Th>
            <Th />
          </tr>
        </thead>
        <tbody>
          {notes.map((n) => (
            <tr key={n.id} className="border-b border-divider">
              <Td className="max-w-[360px] truncate text-ink" title={n.text}>{n.text}</Td>
              <Td>{n.toLabel} · {n.people}</Td>
              <Td>{n.fromName}</Td>
              <Td>{stamp(n.deletedAt)}{n.deletedBy ? ` · ${n.deletedBy}` : ""}</Td>
              <Td align="right"><BinRestoreButton kind="announcement" id={n.id} name="announcement" /></Td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}
