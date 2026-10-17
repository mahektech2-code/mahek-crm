import Link from "next/link";
import { Badge, Button, Card, CardHeader, EmptyState, Input, MetricStrip, Select } from "@/components/ui/primitives";
import { ADMIN, ADMIN_TABS, tabIndexOf, type TabsOf } from "@/lib/admin-routes";
import { stamp } from "@/lib/format";
import {
  OTP_ATTEMPT_LABELS,
  OTP_PROVIDER_LABELS,
  OTP_PURPOSE_LABELS,
  OTP_REFUSAL_LABELS,
  OTP_STATUSES,
  OTP_STATUS_LABELS,
  OTP_SURFACE_LABELS,
  deliveryChannel,
  deviceOf,
  labelOf,
  numberForReading,
} from "@/lib/otp-history";
import { otpByPerson, otpHistory, type OtpHistoryFilters, type OtpHistoryRow } from "@/lib/services/otp-history-service";
import { AdminPage } from "../../_shell/admin-page";
import { requirePlatformAdmin } from "../../_shell/context";

/**
 * THE OTP HISTORY — every one-time code MahekOne sent through MiniMoth or
 * Wati, and every request it turned down, with who asked, from where, to
 * which number, and what became of the code.
 *
 * Platform administrators only: it names people and their personal mobiles.
 * The filters ride on the address, so a filtered history is a link one
 * administrator can send another. The digits themselves are not here and
 * cannot be: a Wati code is stored as a salted hash, and MiniMoth makes and
 * checks its codes without MahekOne ever seeing them.
 */
export default async function OtpHistoryPage({
  params,
  searchParams,
}: {
  params: Promise<{ tab?: string[] }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requirePlatformAdmin();
  const { tab } = await params;
  const slug = ADMIN_TABS.otp[tabIndexOf(ADMIN_TABS.otp, tab?.[0])].slug;
  const query = await searchParams;
  const one = (k: string) => {
    const v = query[k];
    const s = Array.isArray(v) ? v[0] : v;
    return s && s.trim() ? s.trim() : undefined;
  };
  const filters: OtpHistoryFilters = {
    q: one("q"),
    purpose: one("purpose"),
    status: one("status"),
    provider: one("provider"),
    surface: one("surface"),
    userId: one("user"),
    from: one("from"),
    to: one("to"),
    page: Number(one("page") ?? 1),
    perPage: Number(one("per") ?? 50),
  };

  const history = await otpHistory(filters);
  const people = slug === "people" ? await otpByPerson(filters) : [];
  const s = history.summary;

  /** The same address with one parameter changed — every link keeps the filters. */
  const hrefWith = (changes: Record<string, string | number | undefined>, toTab: TabsOf<"otp"> = slug) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) {
      const val = Array.isArray(v) ? v[0] : v;
      if (val) p.set(k, val);
    }
    for (const [k, v] of Object.entries(changes)) {
      if (v === undefined || v === "") p.delete(k);
      else p.set(k, String(v));
    }
    const qs = p.toString();
    return `${ADMIN.otp(toTab)}${qs ? `?${qs}` : ""}`;
  };
  const filtered = ["q", "purpose", "status", "provider", "surface", "user", "from", "to"].some((k) => one(k));

  return (
    <AdminPage
      title="OTP history"
      subtitle="Every one-time code sent through MiniMoth or Wati, and every request turned down: who asked, from where, to which number, how many times, and what became of each code."
      tabs={{ items: ADMIN_TABS.otp, active: slug, href: (t) => hrefWith({ page: undefined }, t as TabsOf<"otp">) }}
    >
      <div className="mt-5">
        <MetricStrip
          metrics={[
            { label: "Requests", value: s.total.toLocaleString("en-IN"), sub: `${s.people} people · ${s.numbers} numbers` },
            { label: "Sent", value: s.sent.toLocaleString("en-IN"), sub: s.requested ? `${Math.round((s.sent / s.requested) * 100)}% of those not refused` : "—" },
            { label: "Used", value: s.verified.toLocaleString("en-IN"), sub: s.sent ? `${Math.round((s.verified / s.sent) * 100)}% of those sent` : "—" },
            { label: "Not delivered", value: s.sendFailed.toLocaleString("en-IN"), tone: s.sendFailed ? "danger" : undefined },
            { label: "Refused", value: s.refused.toLocaleString("en-IN"), sub: "cooldown, limit, no HRMS mobile" },
            { label: "Wrong tries", value: s.wrongTries.toLocaleString("en-IN"), sub: `${s.locked} locked · ${s.expired} expired unused` },
          ]}
        />
      </div>

      <Card className="mt-4">
        <form method="get" className="flex flex-wrap items-end gap-3 px-5 py-4">
          <label className="block min-w-[240px] flex-1">
            <span className="mb-1 block text-xs font-medium tracking-[0.04em] text-muted uppercase">Search</span>
            <Input name="q" defaultValue={one("q") ?? ""} placeholder="Name, email, employee code, number, MiniMoth id, IP" />
          </label>
          <FilterSelect name="purpose" label="For" value={one("purpose")} options={OTP_PURPOSE_LABELS} />
          <FilterSelect
            name="status"
            label="What happened"
            value={one("status")}
            options={Object.fromEntries(OTP_STATUSES.map((k) => [k, OTP_STATUS_LABELS[k].label]))}
          />
          <FilterSelect name="provider" label="Sent by" value={one("provider")} options={OTP_PROVIDER_LABELS} />
          <FilterSelect name="surface" label="Asked from" value={one("surface")} options={OTP_SURFACE_LABELS} />
          <label className="block">
            <span className="mb-1 block text-xs font-medium tracking-[0.04em] text-muted uppercase">From</span>
            <Input type="date" name="from" defaultValue={one("from") ?? ""} />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium tracking-[0.04em] text-muted uppercase">To</span>
            <Input type="date" name="to" defaultValue={one("to") ?? ""} />
          </label>
          {one("user") ? <input type="hidden" name="user" value={one("user")} /> : null}
          <Button variant="primary" type="submit">Apply</Button>
          {filtered ? (
            <Link href={ADMIN.otp(slug)} className="self-center text-[13px] text-muted hover:text-body">
              Clear all
            </Link>
          ) : null}
        </form>
        {one("user") ? (
          <div className="border-t border-divider px-5 py-2 text-[13px] text-body">
            Showing one person only.{" "}
            <Link href={hrefWith({ user: undefined, page: undefined })} className="text-brand">
              Show everybody
            </Link>
          </div>
        ) : null}
      </Card>

      {slug === "people" ? (
        <PeopleTable rows={people} hrefFor={(userId) => hrefWith({ user: userId, page: undefined }, "requests")} />
      ) : (
        <Card className="mt-4 overflow-hidden">
          <CardHeader
            title="Requests"
            hint="Newest first. Open a row for the provider's answer, the device and every timestamp."
          />
          {history.rows.length ? (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[1180px] text-left text-[13px]">
                <thead className="bg-canvas text-[11px] font-medium tracking-[0.04em] text-muted uppercase">
                  <tr>
                    <th className="px-4 py-2.5">When</th>
                    <th className="px-4 py-2.5">Person</th>
                    <th className="px-4 py-2.5">For · from</th>
                    <th className="px-4 py-2.5">Sent to</th>
                    <th className="px-4 py-2.5">Provider</th>
                    <th className="px-4 py-2.5">What happened</th>
                    <th className="px-4 py-2.5">Tries</th>
                    <th className="px-4 py-2.5">IP · device</th>
                  </tr>
                </thead>
                <tbody>
                  {history.rows.map((r) => (
                    <RequestRow key={r.id} row={r} maxAttempts={history.maxAttempts} personHref={hrefWith({ user: r.userId, page: undefined })} />
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <EmptyState
              title={filtered ? "No OTP requests match these filters" : "No OTPs have been asked for yet"}
              body={filtered ? "Widen the dates or clear a filter." : "Every code sent from the sign-in page, the handset or account settings will be listed here."}
            />
          )}
          <LinkPager
            page={history.page}
            pageCount={history.pageCount}
            total={history.total}
            perPage={history.perPage}
            hrefFor={(p) => hrefWith({ page: p })}
            perHref={(n) => hrefWith({ per: n, page: undefined })}
          />
        </Card>
      )}
    </AdminPage>
  );
}

function FilterSelect({
  name,
  label,
  value,
  options,
}: {
  name: string;
  label: string;
  value: string | undefined;
  options: Record<string, string>;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium tracking-[0.04em] text-muted uppercase">{label}</span>
      <Select name={name} defaultValue={value ?? ""}>
        <option value="">All</option>
        {Object.entries(options).map(([k, v]) => (
          <option key={k} value={k}>
            {v}
          </option>
        ))}
      </Select>
    </label>
  );
}

function RequestRow({ row: r, maxAttempts, personHref }: { row: OtpHistoryRow; maxAttempts: number; personHref: string }) {
  const status = OTP_STATUS_LABELS[r.status];
  const channel = deliveryChannel(r.providerResponse);
  const why =
    r.status === "refused"
      ? labelOf(OTP_REFUSAL_LABELS, r.refusedReason)
      : r.status === "send_failed"
        ? (r.failureReason ?? "No reason recorded")
        : r.status === "verified"
          ? `at ${stamp(r.consumedAt)}`
          : r.status === "waiting" || r.status === "expired"
            ? `${r.status === "waiting" ? "expires" : "expired"} ${stamp(r.expiresAt)}`
            : null;
  return (
    <>
    <tr className="border-t border-divider align-top">
      <td className="px-4 py-3 whitespace-nowrap text-body">{stamp(r.createdAt)}</td>
      <td className="px-4 py-3">
        <Link href={personHref} className="font-medium text-ink hover:text-brand" title="Only this person's requests">
          {r.userName ?? "Account deleted"}
        </Link>
        <div className="text-[12px] text-muted">
          {[r.employeeName && r.employeeName !== r.userName ? r.employeeName : null, r.employeeCode, r.userEmail]
            .filter(Boolean)
            .join(" · ") || "No HRMS link"}
        </div>
        <Link href={ADMIN.person(r.userId)} className="text-[12px] text-brand">
          Open account
        </Link>
      </td>
      <td className="px-4 py-3">
        <div className="text-ink">{labelOf(OTP_PURPOSE_LABELS, r.purpose)}</div>
        <div className="text-[12px] text-muted">{labelOf(OTP_SURFACE_LABELS, r.surface)}</div>
        {r.requestedWith ? (
          <div className="text-[12px] text-muted" title="Exactly what was typed at the screen">
            typed “{r.requestedWith}”
          </div>
        ) : null}
      </td>
      <td className="px-4 py-3 whitespace-nowrap tabular-nums text-ink">
        {numberForReading(r.destination)}
        {channel ? <div className="text-[12px] text-muted">via {channel}</div> : null}
      </td>
      <td className="px-4 py-3">
        <div className="text-ink">{labelOf(OTP_PROVIDER_LABELS, r.provider)}</div>
        {r.providerRef ? (
          <div className="max-w-[180px] truncate font-mono text-[11px] text-muted" title={r.providerRef}>
            {r.providerRef}
          </div>
        ) : null}
      </td>
      <td className="px-4 py-3">
        <Badge tone={status.tone} title={status.meaning}>
          {status.label}
        </Badge>
        {why ? <div className="mt-1 max-w-[220px] text-[12px] text-muted">{why}</div> : null}
      </td>
      <td className="px-4 py-3 whitespace-nowrap">
        <span className="tabular-nums text-ink">
          {r.attempts} wrong / {maxAttempts}
        </span>
        {r.lastAttemptAt ? (
          <div className="text-[12px] text-muted">
            last: {labelOf(OTP_ATTEMPT_LABELS, r.lastAttemptResult)}, {stamp(r.lastAttemptAt)}
          </div>
        ) : r.sentAt ? (
          <div className="text-[12px] text-muted">never entered</div>
        ) : null}
      </td>
      <td className="px-4 py-3">
        <div className="font-mono text-[12px] text-body">{r.requestIp ?? "—"}</div>
        <div className="text-[12px] text-muted">{deviceOf(r.userAgent)}</div>
      </td>
    </tr>
    <tr>
      <td colSpan={8} className="px-4 pb-3">
        <details>
          <summary className="cursor-pointer text-[12px] text-brand">Every detail</summary>
          <dl className="mt-2 grid grid-cols-[auto_1fr_auto_1fr] gap-x-4 gap-y-1 text-[12px]">
            <dt className="text-muted">Request id</dt>
            <dd className="font-mono break-all">{r.id}</dd>
            <dt className="text-muted">Asked at</dt>
            <dd>{stamp(r.createdAt)}</dd>
            <dt className="text-muted">Sent at</dt>
            <dd>{r.sentAt ? stamp(r.sentAt) : "Not sent"}</dd>
            <dt className="text-muted">Expires</dt>
            <dd>{r.status === "refused" ? "—" : stamp(r.expiresAt)}</dd>
            <dt className="text-muted">Used at</dt>
            <dd>{r.consumedAt ? stamp(r.consumedAt) : "Not used"}</dd>
            <dt className="text-muted">Account phone</dt>
            <dd>{numberForReading(r.userPhone)}</dd>
            <dt className="text-muted">Account</dt>
            <dd>{r.userActive === false ? "Closed" : r.userActive ? "Open" : "—"}</dd>
            <dt className="text-muted">Device</dt>
            <dd className="break-all">{r.userAgent ?? "Not recorded"}</dd>
            {r.failureReason ? (
              <>
                <dt className="text-muted">Failure</dt>
                <dd className="break-all">{r.failureReason}</dd>
              </>
            ) : null}
            <dt className="text-muted">Provider answer</dt>
            <dd className="col-span-3">
              {r.providerResponse ? (
                <pre className="max-h-40 overflow-auto rounded-[4px] bg-canvas p-2 font-mono text-[11px] whitespace-pre-wrap break-all">
                  {JSON.stringify(r.providerResponse, null, 2)}
                </pre>
              ) : (
                "Not recorded"
              )}
            </dd>
          </dl>
        </details>
      </td>
    </tr>
    </>
  );
}

function PeopleTable({
  rows,
  hrefFor,
}: {
  rows: Awaited<ReturnType<typeof otpByPerson>>;
  hrefFor: (userId: string) => string;
}) {
  return (
    <Card className="mt-4 overflow-hidden">
      <CardHeader title="By person" hint="Busiest first, over the same filters. Open a name for every request they made." />
      {rows.length ? (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[1000px] text-left text-[13px]">
            <thead className="bg-canvas text-[11px] font-medium tracking-[0.04em] text-muted uppercase">
              <tr>
                <th className="px-4 py-2.5">Person</th>
                <th className="px-4 py-2.5">Numbers</th>
                <th className="px-4 py-2.5 text-right">Requests</th>
                <th className="px-4 py-2.5 text-right">Last 24 h</th>
                <th className="px-4 py-2.5 text-right">Sent</th>
                <th className="px-4 py-2.5 text-right">Used</th>
                <th className="px-4 py-2.5 text-right">Not delivered</th>
                <th className="px-4 py-2.5 text-right">Refused</th>
                <th className="px-4 py-2.5 text-right">Wrong tries</th>
                <th className="px-4 py-2.5">First · last</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((p) => (
                <tr key={p.userId} className="border-t border-divider align-top">
                  <td className="px-4 py-3">
                    <Link href={hrefFor(p.userId)} className="font-medium text-ink hover:text-brand">
                      {p.name ?? "Account deleted"}
                    </Link>
                    <div className="text-[12px] text-muted">
                      {[p.employeeCode, p.email].filter(Boolean).join(" · ") || "No HRMS link"}
                    </div>
                  </td>
                  <td className="px-4 py-3 tabular-nums">
                    {p.numbers.length ? p.numbers.map((n) => <div key={n}>{numberForReading(n)}</div>) : <span className="text-muted">—</span>}
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums font-medium text-ink">{p.requests}</td>
                  <td className="px-4 py-3 text-right tabular-nums">{p.last24h}</td>
                  <td className="px-4 py-3 text-right tabular-nums">{p.sent}</td>
                  <td className="px-4 py-3 text-right tabular-nums">{p.verified}</td>
                  <td className={`px-4 py-3 text-right tabular-nums ${p.sendFailed ? "text-danger" : ""}`}>{p.sendFailed}</td>
                  <td className={`px-4 py-3 text-right tabular-nums ${p.refused ? "text-warn-ink" : ""}`}>{p.refused}</td>
                  <td className="px-4 py-3 text-right tabular-nums">{p.wrongTries}</td>
                  <td className="px-4 py-3 whitespace-nowrap text-[12px] text-muted">
                    {stamp(p.firstAt)}
                    <br />
                    {stamp(p.lastAt)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <EmptyState title="Nobody has asked for an OTP in this range" body="Widen the dates or clear a filter." />
      )}
    </Card>
  );
}

function LinkPager({
  page,
  pageCount,
  total,
  perPage,
  hrefFor,
  perHref,
}: {
  page: number;
  pageCount: number;
  total: number;
  perPage: number;
  hrefFor: (p: number) => string;
  perHref: (n: number) => string;
}) {
  const from = (page - 1) * perPage;
  return (
    <div className="flex flex-wrap items-center gap-3 border-t border-divider bg-canvas px-5 py-2.5 text-[13px]">
      <span className="text-muted">
        {total ? `Showing ${from + 1}–${Math.min(total, from + perPage)} of ${total.toLocaleString("en-IN")}` : "No rows"}
      </span>
      <span className="ml-auto flex items-center gap-2 text-muted">
        Per page
        {[25, 50, 100].map((n) =>
          n === perPage ? (
            <span key={n} className="font-medium text-ink">{n}</span>
          ) : (
            <Link key={n} href={perHref(n)} className="text-brand">{n}</Link>
          ),
        )}
      </span>
      <span className="flex items-center gap-2">
        {page > 1 ? <Link href={hrefFor(page - 1)} className="text-brand">← Newer</Link> : <span className="text-line-strong">← Newer</span>}
        <span className="text-muted">Page {page} of {pageCount}</span>
        {page < pageCount ? <Link href={hrefFor(page + 1)} className="text-brand">Older →</Link> : <span className="text-line-strong">Older →</span>}
      </span>
    </div>
  );
}
