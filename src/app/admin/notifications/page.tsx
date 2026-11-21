import { stamp } from "@/lib/format";
import { notificationLog } from "@/lib/services/admin-platform-service";
import { ADMIN } from "@/lib/admin-routes";
import { AdminPage } from "../_shell/admin-page";
import { requirePlatformAdmin } from "../_shell/context";
import { BtnLink, Card, CardHead, DataTable, ListRow, Mono, Pill, TD, TH, Tabs } from "../_shell/kit";
import { announcementRows, bellByApp, channels, notificationFigures, templateRows, type TemplateRow } from "./data";
import { PreviewButton } from "./preview-button";

/**
 * NOTIFICATIONS & MESSAGING — the bell, the pushes that ride on it, WhatsApp,
 * and the announcements the office sends. Read-only: templates are edited on
 * the CRM's WhatsApp screen and linked to Wati in HQ, and an
 * announcement is sent from the Sales Dashboard or HRMS.
 */

const VIEWS = [
  { slug: "templates", label: "Templates" },
  { slug: "sent", label: "Sent" },
  { slug: "channels", label: "Channels" },
  { slug: "announcements", label: "Announcements" },
] as const;
type View = (typeof VIEWS)[number]["slug"];

const KIND: Record<string, string> = {
  order_confirmation: "Order",
  payment_reminder: "Payment",
  routine_check_in: "Check-in",
  reactivation: "Win back",
  other: "Other",
};

const nf = new Intl.NumberFormat("en-IN");

export default async function NotificationsPage({ searchParams }: { searchParams: Promise<{ view?: string }> }) {
  await requirePlatformAdmin();
  const asked = (await searchParams).view;
  const view: View = (VIEWS.find((v) => v.slug === asked)?.slug ?? "templates") as View;
  const [figures, templates, byApp, chans, sent, announcements] = await Promise.all([
    notificationFigures(),
    view === "templates" ? templateRows() : Promise.resolve([] as TemplateRow[]),
    view === "templates" ? bellByApp() : Promise.resolve([]),
    view === "templates" || view === "channels" ? channels() : Promise.resolve([]),
    view === "sent" ? notificationLog() : Promise.resolve([]),
    view === "announcements" ? announcementRows() : Promise.resolve([]),
  ]);

  const channelsCard = (
    <Card>
      <CardHead title="Channels" />
      {chans.map((c) => (
        <div key={c.name} className="flex items-center gap-3 border-b border-divider px-[18px] py-3.5 last:border-b-0">
          <span className="flex min-w-0 flex-1 flex-col">
            <b className="font-semibold text-ink">{c.name}</b>
            {view === "channels" ? <span className="text-xs text-muted">{c.line}</span> : null}
          </span>
          <span title={c.line}>
            <Pill tone={c.on ? "ok" : "danger"}>{c.on ? "On" : c.name === "WhatsApp" && !c.setHref ? "Off" : "Not set"}</Pill>
          </span>
          {c.setHref ? <BtnLink href={c.setHref} size="sm">Set</BtnLink> : null}
        </div>
      ))}
    </Card>
  );

  const live = templates.filter((t) => t.active);
  const archived = templates.length - live.length;
  const approved = live.filter((t) => t.watiName).length;
  const top = Math.max(1, ...byApp.map((b) => b.n));

  return (
    <AdminPage
      title="Notifications & messaging"
      actions={<BtnLink href="/sales/notify" kind="primary">Send an announcement</BtnLink>}
      figures={[
        { label: "Bell today", value: nf.format(figures.bellToday) },
        { label: "Unread over 2 days", value: nf.format(figures.unreadOld), tone: figures.unreadOld ? "warn" : undefined },
        {
          label: "Push failed · 7 d",
          value: nf.format(figures.pushFailed7d),
          tone: figures.pushFailed7d ? "danger" : undefined,
          sub: figures.pushWaiting ? `${nf.format(figures.pushWaiting)} not confirmed yet` : undefined,
        },
        { label: "WhatsApp sent · 30 d", value: nf.format(figures.waSent30d) },
        { label: "WhatsApp failed · 30 d", value: nf.format(figures.waFailed30d), tone: figures.waFailed30d ? "danger" : undefined },
      ]}
    >
      <Tabs items={VIEWS.map((v) => ({ ...v, href: v.slug === "templates" ? ADMIN.notifications : `${ADMIN.notifications}?view=${v.slug}` }))} active={view} />

      {view === "templates" ? (
        <div className="grid items-start gap-[18px] lg:grid-cols-[minmax(0,1.5fr)_minmax(320px,1fr)]">
          <Card>
            <CardHead
              title="WhatsApp templates"
              actions={
                <>
                  {archived ? <Pill tone="muted">{archived} archived</Pill> : null}
                  <Pill tone={approved ? "ok" : "warn"}>{approved} linked to Wati</Pill>
                </>
              }
            />
            {live.length === 0 ? (
              <div className="px-[18px] py-8 text-center text-muted">No WhatsApp template is in use.</div>
            ) : (
              <DataTable>
                <thead>
                  <tr>
                    <TH className="px-3.5 py-2.5">Template</TH>
                    <TH className="px-3.5 py-2.5">Kind</TH>
                    <TH className="px-3.5 py-2.5">Wati</TH>
                    <TH className="px-3.5 py-2.5">Sent · 30 d</TH>
                    <TH className="px-3.5 py-2.5" />
                  </tr>
                </thead>
                <tbody>
                  {live.map((t) => (
                    <tr key={t.id} className="[&:last-child>td]:border-b-0">
                      <TD className="h-12 px-3.5 py-1.5 whitespace-nowrap">
                        <b className="font-semibold text-ink">{t.name}</b>
                        {t.watiName ? <Mono className="block text-[13px] text-muted">{t.watiName}</Mono> : null}
                      </TD>
                      <TD className="h-12 px-3.5 whitespace-nowrap">{KIND[t.category] ?? t.category}</TD>
                      <TD className="h-12 px-3.5 whitespace-nowrap">
                        {t.watiName ? <Pill tone="ok">Linked</Pill> : <Pill tone="warn">Copy and paste only</Pill>}
                      </TD>
                      <TD className="h-12 px-3.5 whitespace-nowrap tabular-nums">{t.sent30d ? nf.format(t.sent30d) : "—"}</TD>
                      <TD className="h-12 px-3.5">
                        <PreviewButton name={t.name} body={t.body} />
                      </TD>
                    </tr>
                  ))}
                </tbody>
              </DataTable>
            )}
          </Card>
          <div className="flex flex-col gap-[18px]">
            <Card>
              <CardHead title="Bell by app · today" />
              {byApp.length === 0 ? (
                <div className="px-[18px] py-6 text-muted">Nothing has rung a bell today.</div>
              ) : (
                <div className="flex flex-col gap-3 p-[18px]">
                  {byApp.map((b) => (
                    <div key={b.app} className="grid grid-cols-[100px_minmax(0,1fr)_46px] items-center gap-2.5">
                      <span className="truncate">{b.app}</span>
                      <div className="h-2.5 overflow-hidden rounded-[5px] bg-divider">
                        <i className="block h-full bg-brand" style={{ width: `${(b.n / top) * 100}%` }} />
                      </div>
                      <b className="text-right font-bold text-ink tabular-nums">{nf.format(b.n)}</b>
                    </div>
                  ))}
                </div>
              )}
            </Card>
            {channelsCard}
          </div>
        </div>
      ) : null}

      {view === "sent" ? (
        <Card>
          <CardHead title="What the platform has sent" />
          {sent.length === 0 ? (
            <div className="px-[18px] py-8 text-center text-muted">Nothing has been sent.</div>
          ) : (
            <DataTable>
              <thead>
                <tr>
                  <TH>Title</TH>
                  <TH>Detail</TH>
                  <TH>To</TH>
                  <TH>Read</TH>
                  <TH>Sent</TH>
                </tr>
              </thead>
              <tbody>
                {sent.map((n, i) => (
                  <tr key={`${n.to}-${n.at}-${i}`}>
                    <TD className="font-semibold whitespace-nowrap text-ink">{n.title}</TD>
                    <TD className="max-w-[380px] truncate text-muted">
                      <span title={n.body}>{n.body}</span>
                    </TD>
                    <TD className="whitespace-nowrap">{n.to}</TD>
                    <TD>
                      <Pill tone={n.read ? "ok" : "warn"}>{n.read ? "Read" : "Unread"}</Pill>
                    </TD>
                    <TD className="whitespace-nowrap">{stamp(n.at)}</TD>
                  </tr>
                ))}
              </tbody>
            </DataTable>
          )}
        </Card>
      ) : null}

      {view === "channels" ? <div className="max-w-[640px]">{channelsCard}</div> : null}

      {view === "announcements" ? (
        <Card>
          <CardHead title="Announcements" />
          {announcements.length === 0 ? (
            <div className="px-[18px] py-8 text-center text-muted">No announcement has been sent.</div>
          ) : (
            announcements.map((a) => (
              <ListRow key={a.id} className="items-start px-[18px] py-3">
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <b className="font-semibold text-ink">{a.title}</b>
                  <span className="line-clamp-2 text-muted">{a.text}</span>
                  <span className="text-xs text-muted">
                    {a.from} → {a.to} · {stamp(a.at.toISOString())}
                  </span>
                </span>
                <Pill tone={a.source === "sales" ? "brand" : "muted"}>{a.source === "sales" ? "Sales" : "HRMS"}</Pill>
                <Pill tone={a.reached && a.read === a.reached ? "ok" : "muted"}>
                  {a.read} of {a.reached} read
                </Pill>
              </ListRow>
            ))
          )}
        </Card>
      ) : null}
    </AdminPage>
  );
}
