import { ADMIN } from "@/lib/admin-routes";
import { canFor } from "@/lib/access-control";
import { APP_TIMEZONE, addDays, type BusinessDate } from "@/lib/business-date";
import { nowMs, shortDate, stamp, stampDate } from "@/lib/format";
import { binAnnouncements, binDocuments, binFiles, sizeLine } from "@/lib/services/admin-console-service";
import { listTrash } from "@/lib/services/lead-trash-service";
import { AdminPage } from "../_shell/admin-page";
import { requirePlatformAdmin } from "../_shell/context";
import { Card } from "../_shell/kit";
import { BIN_ACTIONS_SLOT, TrashSection } from "../trash-section";
import { BinRestoreButton } from "./restore-button";

const BIN_TABS = [
  { slug: "leads", label: "Leads" },
  { slug: "files", label: "Files" },
  { slug: "documents", label: "Documents" },
  { slug: "announcements", label: "Announcements" },
] as const;

/* The canvas's table: navy 12px heads, 48px rows, a hairline between. */
const HEAD: React.CSSProperties = { fontSize: 12, fontWeight: 600, letterSpacing: 0 };
const head = "bg-ink px-3.5 py-2.5 text-left whitespace-nowrap text-white normal-case";
const cell = "h-12 border-b border-divider px-3.5 py-0 align-middle text-sm";

/**
 * What somebody deleted, held so it can be put back: leads, removed files,
 * withdrawn documents and deleted announcements. Administrators only — the
 * API and every restore refuse anybody else.
 *
 * Price list drafts are not here: a draft deleted from the Price Desk is
 * deleted, and nothing holds it to come back from.
 */
export default async function RecycleBinPage({
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
  const [leads, files, docs, notes] = await Promise.all([
    canRestore ? listTrash({ perPage: 25 }).then((t) => t.total) : Promise.resolve(null),
    binFiles(),
    binDocuments(),
    binAnnouncements(),
  ]);
  const counts: Record<(typeof BIN_TABS)[number]["slug"], number | null> = {
    leads,
    files: files.length,
    documents: docs.length,
    announcements: notes.length,
  };
  const tabs = {
    items: BIN_TABS.map((t) => ({ ...t, count: counts[t.slug] })),
    active: view,
    href: (s: string) => (s === "leads" ? ADMIN.deletedLeads : `${ADMIN.deletedLeads}?view=${s}`),
  };
  const today = new Date(nowMs()).toLocaleDateString("en-CA", { timeZone: APP_TIMEZONE });
  const q = (one("q") ?? "").trim().toLowerCase();
  const has = (...v: Array<string | null | undefined>) => !q || v.some((x) => x?.toLowerCase().includes(q));

  const searchForm = (
    <form method="get" className="flex items-center gap-2.5">
      <input type="hidden" name="view" value={view} />
      <input
        name="q"
        defaultValue={one("q") ?? ""}
        aria-label="Find"
        placeholder={view === "files" ? "File name, what it was on" : view === "documents" ? "Document title" : "What it said, who sent it"}
        className="h-[38px] w-[260px] rounded-control border border-line-strong bg-surface px-3 text-sm text-ink placeholder:text-muted focus:border-brand focus:outline-none"
      />
    </form>
  );

  return (
    <AdminPage
      title="Recycle bin"
      subtitle="What somebody deleted, held so it can be put back."
      actions={view === "leads" ? <div id={BIN_ACTIONS_SLOT} className="flex items-center gap-2.5" /> : searchForm}
      tabs={tabs}
    >
      {view === "leads" ? (
        canRestore ? (
          <TrashSection
            today={today}
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
          <Card>
            <p className="m-0 px-[18px] py-6 text-muted">Restoring a lead is an administrator&rsquo;s. Ask one if a lead was deleted by mistake.</p>
          </Card>
        )
      ) : view === "files" ? (
        <BinTable
          empty="No removed files are held."
          heads={["File", "Was on", "Size", "Removed", "Deleted for good on", ""]}
          rows={files
            .filter((f) => has(f.filename, f.kind))
            .map((f) => ({
              id: f.id,
              cells: [
                <b key="n" className="font-semibold text-ink" title={f.filename}>{f.filename}</b>,
                <span key="k" className="text-muted">{f.kind.replace(/_/g, " ")}</span>,
                sizeLine(f.bytes),
                <span key="r" title={stamp(f.removedAt)}>{dayWord(f.removedAt, today)}</span>,
                stampDate(f.purgeOn),
                <BinRestoreButton key="b" kind="file" id={f.id} name={f.filename} />,
              ],
            }))}
        />
      ) : view === "documents" ? (
        <BinTable
          empty="No withdrawn documents."
          heads={["Document", "Withdrawn", ""]}
          rows={docs
            .filter((d) => has(d.title))
            .map((d) => ({
              id: d.id,
              cells: [
                <b key="n" className="font-semibold text-ink">{d.title}</b>,
                <span key="w" title={stamp(d.updatedAt)}>{dayWord(d.updatedAt, today)}</span>,
                <BinRestoreButton key="b" kind="document" id={d.id} name={d.title} />,
              ],
            }))}
        />
      ) : (
        <BinTable
          empty="No deleted announcements."
          heads={["Announcement", "To", "From", "Deleted by", "When", ""]}
          rows={notes
            .filter((n) => has(n.text, n.fromName, n.deletedBy))
            .map((n) => ({
              id: n.id,
              cells: [
                <span key="t" className="text-ink" title={n.text}>{n.text.length > 80 ? `${n.text.slice(0, 80)}…` : n.text}</span>,
                `${n.toLabel} · ${n.people}`,
                n.fromName,
                n.deletedBy ?? <span className="text-muted">—</span>,
                <span key="w" title={stamp(n.deletedAt)}>{dayWord(n.deletedAt, today)}</span>,
                <BinRestoreButton key="b" kind="announcement" id={n.id} name="announcement" />,
              ],
            }))}
        />
      )}
    </AdminPage>
  );
}

function BinTable({ heads, rows, empty }: { heads: string[]; rows: Array<{ id: string; cells: React.ReactNode[] }>; empty: string }) {
  return (
    <Card>
      {rows.length === 0 ? (
        <p className="m-0 px-[18px] py-6 text-muted">{empty}</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse">
            <thead>
              <tr>
                {heads.map((h, i) => (
                  <th key={i} className={head} style={HEAD}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="last:[&>td]:border-b-0">
                  {r.cells.map((c, i) => (
                    <td key={i} className={cell} align={i === r.cells.length - 1 ? "right" : undefined}>
                      {c}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

/** Today, Yesterday, or the day — in IST. */
function dayWord(at: string | Date, today: string): string {
  const day = new Date(at).toLocaleDateString("en-CA", { timeZone: APP_TIMEZONE });
  if (day === today) return "Today";
  return day === addDays(today as BusinessDate, -1) ? "Yesterday" : shortDate(at);
}
