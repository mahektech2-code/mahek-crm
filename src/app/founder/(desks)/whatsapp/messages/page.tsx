import Link from "next/link";
import { Card, CardHeader, MetricStrip, PageHeader, Td, Th, Tr } from "@/components/ui/primitives";
import { DeliveryStatus } from "@/components/whatsapp/delivery-status";
import { stamp } from "@/lib/format";
import { trackerPage } from "@/lib/services/whatsapp-tracker-service";
import { WhatsappTabs } from "../whatsapp-tabs";

export const metadata = { title: "WhatsApp messages - Founder Dashboard - MahekOne" };

const STATUSES: Array<[string, string]> = [
  ["", "Any status"],
  ["read", "Read"],
  ["delivered", "Delivered, not read"],
  ["sent", "Sent, not delivered yet"],
  ["sent_manually", "Confirmed by hand"],
  ["copied", "Copied, not confirmed"],
  ["failed", "Failed"],
];

/**
 * Every WhatsApp message in a period and how far it got — the founder's
 * answer to "are these reminders actually being seen". Filters are a plain
 * GET form, so a view can be bookmarked or sent to somebody as a link.
 */
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ days?: string; status?: string; source?: string; template?: string; q?: string }>;
}) {
  const sp = await searchParams;
  const days = [1, 7, 30, 90].includes(Number(sp.days)) ? Number(sp.days) : 7;
  const source = sp.source === "rule" || sp.source === "person" ? sp.source : undefined;
  const data = await trackerPage({
    days,
    status: sp.status || undefined,
    source,
    template: sp.template || undefined,
    q: sp.q?.trim() || undefined,
  });
  const f = data.funnel;
  const pct = (n: number, of: number) => (of ? `${Math.round((n / of) * 100)}%` : "—");

  return (
    <div className="p-6">
      <PageHeader
        title="WhatsApp"
        subtitle="Every message, and how far it got — sent, delivered, read and replied. Receipts come from WhatsApp itself for messages sent through the API; a message pasted by hand only has the person's confirmation."
      />
      <WhatsappTabs current="messages" />

      <form className="mb-4 flex flex-wrap items-end gap-3" method="get">
        <Filter label="Period">
          <select name="days" defaultValue={String(days)} className="h-9 rounded-[4px] border border-line bg-surface px-2 text-sm">
            <option value="1">Today</option>
            <option value="7">7 days</option>
            <option value="30">30 days</option>
            <option value="90">90 days</option>
          </select>
        </Filter>
        <Filter label="Status">
          <select name="status" defaultValue={sp.status ?? ""} className="h-9 rounded-[4px] border border-line bg-surface px-2 text-sm">
            {STATUSES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        </Filter>
        <Filter label="Sent by">
          <select name="source" defaultValue={source ?? ""} className="h-9 rounded-[4px] border border-line bg-surface px-2 text-sm">
            <option value="">Anyone</option>
            <option value="rule">Automatic rules</option>
            <option value="person">People</option>
          </select>
        </Filter>
        <Filter label="Template">
          <select name="template" defaultValue={sp.template ?? ""} className="h-9 rounded-[4px] border border-line bg-surface px-2 text-sm">
            <option value="">Any template</option>
            {data.templates.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
        </Filter>
        <Filter label="Customer">
          <input name="q" defaultValue={sp.q ?? ""} placeholder="Name" className="h-9 w-44 rounded-[4px] border border-line bg-surface px-2 text-sm" />
        </Filter>
        <button className="h-9 cursor-pointer rounded-[4px] border border-brand bg-brand px-3 text-sm font-medium text-white">Apply</button>
        <Link href="/founder/whatsapp/messages" className="h-9 px-1 text-sm leading-9 text-muted">Reset</Link>
      </form>

      <MetricStrip
        metrics={[
          { label: "Messages", value: String(f.total), sub: `${f.reached} reached the customer` },
          { label: "Through the API", value: String(f.api), sub: "these carry WhatsApp receipts" },
          { label: "Delivered", value: String(f.delivered), sub: `${pct(f.delivered, f.api)} of API sends` },
          { label: "Read", value: String(f.read), sub: `${pct(f.read, f.api)} of API sends` },
          { label: "Replied", value: String(f.replied), sub: "within 3 days" },
          { label: "Failed", value: String(f.failed), sub: f.failed ? "reasons in the list" : undefined },
        ]}
      />

      <Card className="overflow-hidden">
        <CardHeader
          title="Messages"
          hint={data.capped ? "Showing the newest 200 — narrow the filters to see further back." : `${data.rows.length} in this view`}
        />
        {data.rows.length ? (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr>
                  <Th>Written</Th>
                  <Th>Customer</Th>
                  <Th>Template</Th>
                  <Th>Sent by</Th>
                  <Th>Status</Th>
                  <Th>Delivered</Th>
                  <Th>Read</Th>
                  <Th>Replied</Th>
                </tr>
              </thead>
              <tbody>
                {data.rows.map((m) => (
                  <Tr key={m.id}>
                    <Td className="whitespace-nowrap">{stamp(m.preparedAt)}</Td>
                    <Td>
                      <Link href={`/crm/customers/${m.customerId}`} className="font-medium text-ink">{m.customerName}</Link>
                      <span className="block text-[12px] text-muted">{m.destination}</span>
                    </Td>
                    <Td>{m.templateName ?? "—"}</Td>
                    <Td>{m.viaRule ? "Automatic rule" : m.sentBy}</Td>
                    <Td>
                      <DeliveryStatus m={m} showTime={false} />
                      {m.status === "failed" && m.failureReason ? (
                        <span className="mt-0.5 block max-w-[280px] text-[12px] text-danger">{m.failureReason}</span>
                      ) : null}
                    </Td>
                    <Td className="whitespace-nowrap text-[13px]">{m.deliveredAt ? stamp(m.deliveredAt) : "—"}</Td>
                    <Td className="whitespace-nowrap text-[13px]">{m.readAt ? stamp(m.readAt) : "—"}</Td>
                    <Td className="whitespace-nowrap text-[13px]">{m.repliedAt ? stamp(m.repliedAt) : "—"}</Td>
                  </Tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="px-5 py-4 text-[13px] text-muted">No messages in this view.</p>
        )}
      </Card>
    </div>
  );
}

function Filter({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-[12px] font-medium text-muted">{label}</span>
      {children}
    </label>
  );
}
