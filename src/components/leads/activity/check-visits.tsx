"use client";

import * as React from "react";

import { Modal } from "@/components/ui/overlays";
import { Badge, Select, cx } from "@/components/ui/primitives";
import { Button } from "@/components/console/parts";
import { checkVisitsAction } from "@/lib/actions/check-visits";
import type { TeamVisit } from "@/lib/services/visit-oversight-service";
import { stamp, stampDate } from "@/lib/format";

/* ---------------------------------------------------------------------------
 * CHECK VISITS — the button beside Call, and the window it opens.
 *
 * Drawn only for somebody the server has already said has salesmen reporting
 * to them, and the action asks again. It shows what a visit RECORDED and
 * nothing it did not: a place is a coordinate the handset took at check-in, a
 * visit typed in at a desk has none and says so. No tracking, no trail.
 * ------------------------------------------------------------------------- */

export function CheckVisitsButton({ customerId, leadName }: { customerId: string; leadName: string }) {
  const [open, setOpen] = React.useState(false);
  return (
    <>
      <Button tone="default" onClick={() => setOpen(true)} title="Visits made by the salesmen who report to you">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true" className="mr-1.5">
          <path d="M12 21s-7-6.2-7-11a7 7 0 0 1 14 0c0 4.8-7 11-7 11z" />
          <circle cx="12" cy="10" r="2.5" />
        </svg>
        Check Visits
      </Button>
      {open ? <CheckVisitsDialog customerId={customerId} leadName={leadName} onClose={() => setOpen(false)} /> : null}
    </>
  );
}

function CheckVisitsDialog({ customerId, leadName, onClose }: { customerId: string; leadName: string; onClose: () => void }) {
  const [thisLead, setThisLead] = React.useState(true);
  const [salesmanId, setSalesmanId] = React.useState("");
  /* Empty = the server's default (the last 30 days). */
  const [from, setFrom] = React.useState("");
  const [to, setTo] = React.useState("");
  const [visits, setVisits] = React.useState<TeamVisit[] | null>(null);
  const [team, setTeam] = React.useState<{ id: string; name: string }[]>([]);
  const [range, setRange] = React.useState<{ fromDay: string; toDay: string } | null>(null);
  const [more, setMore] = React.useState(false);
  const [page, setPage] = React.useState(0);
  const [loadingMore, setLoadingMore] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const query = React.useMemo(
    () => ({ customerId: thisLead ? customerId : undefined, salesmanId: salesmanId || undefined, from: from || undefined, to: to || undefined }),
    [customerId, thisLead, salesmanId, from, to],
  );

  /* A new question starts again from the first page. */
  React.useEffect(() => {
    let live = true;
    void checkVisitsAction({ ...query, page: 0 }).then((r) => {
      if (!live) return;
      if (r.ok) {
        setVisits(r.data.visits);
        setTeam(r.data.team);
        setRange({ fromDay: r.data.fromDay, toDay: r.data.toDay });
        setMore(r.data.more);
        setPage(0);
        setError(null);
      } else {
        setVisits([]);
        setMore(false);
        setError(r.error);
      }
    });
    return () => {
      live = false;
    };
  }, [query]);

  async function loadMore() {
    setLoadingMore(true);
    const r = await checkVisitsAction({ ...query, page: page + 1 });
    setLoadingMore(false);
    if (!r.ok) return setError(r.error);
    setVisits((v) => [...(v ?? []), ...r.data.visits]);
    setMore(r.data.more);
    setPage(page + 1);
  }

  const data = visits === null ? null : { visits, team };

  return (
    <Modal
      open
      onClose={onClose}
      width={760}
      title={
        <div>
          <div>Check Visits</div>
          <div className="mt-0.5 text-[13px] font-normal text-muted">Visits by the salesmen who report to you</div>
        </div>
      }
      footer={
        <Button tone="default" onClick={onClose}>
          Close
        </Button>
      }
    >
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="inline-flex rounded-[6px] border border-line p-0.5 text-[13px]">
          {[
            { v: true, label: leadName.length > 24 ? "This lead" : leadName },
            { v: false, label: "All their visits" },
          ].map((o) => (
            <button
              key={String(o.v)}
              type="button"
              onClick={() => setThisLead(o.v)}
              className={cx(
                "rounded-[5px] px-3 py-1 font-medium",
                thisLead === o.v ? "bg-brand text-white" : "text-body hover:bg-canvas",
              )}
            >
              {o.label}
            </button>
          ))}
        </div>
        <Select value={salesmanId} onChange={(e) => setSalesmanId(e.target.value)} className="w-[200px]" aria-label="Salesman">
          <option value="">All my salesmen</option>
          {(data?.team ?? []).map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </Select>
      </div>
      <div className="mb-3 flex flex-wrap items-center gap-2 text-[13px] text-muted">
        <label className="flex items-center gap-1.5">
          From
          <input type="date" value={from || range?.fromDay || ""} max={to || range?.toDay || undefined} onChange={(e) => setFrom(e.target.value)} className="h-9 rounded-[6px] border border-line bg-surface px-2 text-sm text-ink" />
        </label>
        <label className="flex items-center gap-1.5">
          To
          <input type="date" value={to || range?.toDay || ""} min={from || range?.fromDay || undefined} onChange={(e) => setTo(e.target.value)} className="h-9 rounded-[6px] border border-line bg-surface px-2 text-sm text-ink" />
        </label>
        {from || to ? (
          <button type="button" className="text-brand" onClick={() => { setFrom(""); setTo(""); }}>
            Last 30 days
          </button>
        ) : null}
        {data ? <span className="ml-auto text-[12px]">{data.visits.length} shown{more ? " · more below" : ""}</span> : null}
      </div>

      {error ? (
        <p className="m-0 text-sm text-danger">{error}</p>
      ) : data !== null && data.team.length === 0 ? (
        <p className="m-0 rounded-[8px] border border-line px-4 py-6 text-center text-sm text-muted">
          No salesmen report to you, so there are no visits to show here. Visits appear for the salesmen who report to you
          in the Org Chart.
        </p>
      ) : data === null ? (
        <p className="m-0 text-sm text-muted">Loading…</p>
      ) : data.visits.length === 0 ? (
        <p className="m-0 rounded-[8px] border border-line px-4 py-6 text-center text-sm text-muted">
          No visits recorded {range ? `between ${range.fromDay} and ${range.toDay}` : "in this range"}{thisLead ? " on this lead" : ""} by your salesmen.
        </p>
      ) : (
        <ul className="m-0 flex max-h-[60vh] list-none flex-col gap-2 overflow-y-auto p-0">
          {data.visits.map((v) => (
            <VisitRow key={v.id} v={v} />
          ))}
          {more ? (
            <li className="list-none text-center">
              <Button tone="default" disabled={loadingMore} onClick={() => void loadMore()}>
                {loadingMore ? "Loading…" : "Load older visits"}
              </Button>
            </li>
          ) : null}
        </ul>
      )}
    </Modal>
  );
}

function VisitRow({ v }: { v: TeamVisit }) {
  return (
    <li className="rounded-[8px] border border-line bg-surface px-4 py-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="text-sm font-semibold text-ink">{v.salesmanName}</span>
        <span className="text-[13px] text-body">visited {v.customerName}</span>
        <span className="ml-auto text-[12px] text-muted">{stamp(v.at)}</span>
      </div>
      <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
        {v.outcome ? <Badge tone="brand">{v.outcome}</Badge> : null}
        <Badge tone={v.source === "handset" ? "success" : "neutral"}>{v.source === "handset" ? "Salesman App" : "Logged by hand"}</Badge>
        {v.planned ? <Badge tone="neutral">Planned</Badge> : null}
        {v.activities.map((a) => (
          <Badge key={a} tone="neutral">{a}</Badge>
        ))}
      </div>
      {v.notes ? <p className="mt-2 mb-0 text-[13px] whitespace-pre-wrap text-body">{v.notes}</p> : null}
      {v.deviationReason ? <p className="mt-1 mb-0 text-[12.5px] text-muted">Off plan: {v.deviationReason}</p> : null}
      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[12.5px] text-muted">
        {v.nextFollowUpDate ? <span>Next follow-up: {stampDate(v.nextFollowUpDate)}</span> : null}
        {v.location ? (
          <a
            className="text-brand"
            target="_blank"
            rel="noreferrer"
            href={`https://www.google.com/maps?q=${v.location.lat},${v.location.lng}`}
          >
            Check-in location{v.location.distanceFromShopM != null ? ` · ${v.location.distanceFromShopM} m from the shop` : ""}
          </a>
        ) : (
          <span>No location recorded</span>
        )}
        {v.source === "handset" ? <span>{v.verified ? "Verified on arrival" : "Not verified"}</span> : null}
      </div>
    </li>
  );
}
