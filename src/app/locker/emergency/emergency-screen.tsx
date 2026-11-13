"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { decideBreakglass, endBreakglass, reviewBreakglass, startBreakglass } from "@/lib/actions/locker-vault";
import { TIER, type Tier } from "@/lib/locker/engine";
import { Button, Field, Textarea, cx } from "@/components/ui/primitives";
import { Pill, TierPill, useToast } from "../_ui/kit";
import { RevealButton } from "../_ui/reveal-dialog";
import { Alert, Block, Cell, GTable, Grid, LList, when } from "../_ui/vault-parts";

type Cand = { id: string; title: string; tier: string; provider: string; fields: string[] };
type Session = {
  id: string;
  state: string;
  by: string;
  startedById: string;
  approvedBy: string | null;
  reason: string;
  minutes: number;
  startedAt: string;
  activeUntil: string | null;
  closedAt: string | null;
  reviewNote: string | null;
  reviewOverdue: boolean;
  scope: { id: string; title: string; tier: Tier; used: number; by: string; fields: string[] }[];
};

const mmss = (ms: number) => {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

export function EmergencyScreen({ me, canInvoke, minutes, reviewHours, candidates, sessions }: { me: string; canInvoke: boolean; minutes: number; reviewHours: number; candidates: Cand[]; sessions: Session[] }) {
  const router = useRouter();
  const toast = useToast();
  const [scope, setScope] = useState<string[]>([]);
  const [why, setWhy] = useState("");
  const [review, setReview] = useState("");
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const open = sessions.find((s) => s.state === "awaiting" || s.state === "active");
  const unreviewed = sessions.find((s) => (s.state === "ended" || s.state === "declined") && !s.reviewNote && s.approvedBy && s.state !== "declined");
  const ok = scope.length > 0 && why.trim().length >= 30 && canInvoke;
  const act = async (p: Promise<{ ok: boolean; error?: string }>, msg: string) => {
    setBusy(true);
    const r = await p;
    setBusy(false);
    toast(r.ok ? msg : (r.error ?? "Something went wrong."));
    router.refresh();
  };

  return (
    <div className="flex flex-col gap-5 px-6 pb-12">
      {open?.state === "awaiting" ? (
        <Alert tone="amber" t={`Waiting for a second person · started by ${open.by}`} m={`“${open.reason}” · ${open.scope.length} items. The same person cannot start and approve.`}>
          {open.startedById !== me ? (
            <>
              <Button size="sm" variant="danger" disabled={busy} onClick={() => act(decideBreakglass(open.id, true), "Emergency access is active — everybody has been told")}>
                Approve
              </Button>
              <Button size="sm" disabled={busy} onClick={() => act(decideBreakglass(open.id, false), "Declined")}>
                Deny
              </Button>
            </>
          ) : (
            <Button size="sm" disabled={busy} onClick={() => act(endBreakglass(open.id), "Withdrawn")}>
              Withdraw
            </Button>
          )}
        </Alert>
      ) : null}
      {open?.state === "active" ? (
        <>
          <Alert tone="red" t={`Emergency access active · ${mmss(new Date(open.activeUntil!).getTime() - (now || new Date(open.startedAt).getTime()))} remaining`} m={`Started by ${open.by}, approved by ${open.approvedBy}. “${open.reason}”`}>
            <Button size="sm" variant="danger" disabled={busy} onClick={() => act(endBreakglass(open.id), "Emergency access ended")}>
              End now
            </Button>
          </Alert>
          <Block vault title="Items in scope" sub="Reveal works on these without the usual approval — still with your password and a reason — and every access is recorded.">
            <LList
              items={open.scope.map((x) => ({
                key: x.id,
                t: x.title,
                sub: `${TIER[x.tier].label}${x.used ? ` · accessed ${x.used}× by ${x.by}` : ""}`,
                badge: x.used ? <Pill label="Accessed" tone="danger" /> : undefined,
                extra: x.fields.length ? (
                  <span className="mt-2 flex flex-wrap gap-2">
                    {x.fields.map((f) => (
                      <RevealButton key={f} credentialId={x.id} title={x.title} tier={x.tier} field={f} label={`Reveal ${f}`} />
                    ))}
                  </span>
                ) : (
                  <span className="mt-1 block text-xs text-muted">No value stored for this login.</span>
                ),
              }))}
            />
          </Block>
        </>
      ) : null}
      {!open && unreviewed ? (
        <>
          <Alert tone={unreviewed.reviewOverdue ? "red" : "amber"} t={unreviewed.reviewOverdue ? `The after-emergency review is overdue — it was due within ${reviewHours} hours` : `After-emergency review due within ${reviewHours} hours`} m="Every access during the window is listed. Somebody other than the person who used it must record the review." />
          <Block vault title="What was accessed" sub={`Started by ${unreviewed.by} · approved by ${unreviewed.approvedBy} · “${unreviewed.reason}” · closed ${when(unreviewed.closedAt, true)}`}>
            <GTable
              vault
              cols={[
                ["Item", "minmax(240px,2fr)"],
                ["Level", "100px"],
                ["Accessed", "120px"],
                ["By", "150px"],
              ]}
              rows={unreviewed.scope.map((x) => ({ key: x.id, href: `/locker/vault/${x.id}`, cells: [<Cell key="a" t={x.title} className="text-ink" />, <TierPill key="b" tier={x.tier} />, <Cell key="c" t={x.used ? `Yes · ${x.used}×` : "Not used"} className={cx("font-medium", x.used ? "text-danger" : "text-muted")} />, <Cell key="d" t={x.by || "—"} />] }))}
            />
          </Block>
          {unreviewed.startedById !== me ? (
            <Block title="Record the review">
              <div className="flex flex-col gap-3 px-5 py-4">
                <Field label="Findings">
                  <Textarea value={review} onChange={(e) => setReview(e.target.value)} rows={3} placeholder="Was the access reasonable? Should the accessed items be changed now?" />
                </Field>
                <div className="flex justify-end">
                  <Button size="sm" variant="primary" disabled={busy || review.trim().length < 10} onClick={() => act(reviewBreakglass(unreviewed.id, review), "Review recorded")}>
                    Record review
                  </Button>
                </div>
              </div>
            </Block>
          ) : (
            <Alert tone="grey" t="You used it, so somebody else records the review" m="Ask another person with Approvals to read this report and record it." />
          )}
        </>
      ) : null}
      {!open ? (
        <>
          <Alert tone="red" t="Emergency access is loud by design" m="When it is approved every Locker admin and approver is notified, a red banner shows across the Locker for everyone, every item accessed is recorded, and a review is required afterwards." />
          <Grid cols={2}>
            <Block vault title="Scope · choose named items" sub="Never “everything”. Pick only what the emergency needs.">
              <LList items={candidates.map((x) => ({ key: x.id, t: x.title, sub: `${TIER[x.tier as Tier].label} · ${x.provider || "—"}`, check: true, on: scope.includes(x.id), flip: () => setScope(scope.includes(x.id) ? scope.filter((i) => i !== x.id) : [...scope, x.id]) }))} empty="No sensitive or restricted logins are recorded." />
            </Block>
            <Block title="Start emergency access" sub={`For when the normal path is unavailable. ${minutes} minutes. Approved by one other person — never unilateral.`}>
              <div className="flex flex-col gap-3.5 px-5 py-4">
                <label className="block">
                  <span className="ui-field-label mb-1 block text-xs font-medium tracking-label text-muted uppercase">Reason · at least 30 characters</span>
                  <Textarea value={why} onChange={(e) => setWhy(e.target.value)} rows={3} placeholder="Production CRM is down; the IT Lead is unreachable and we need the DigitalOcean console now." />
                  <span className="mt-1 block text-xs text-muted">{why.trim().length >= 30 ? "Recorded word for word in the after-emergency report." : `${30 - why.trim().length} more characters`}</span>
                </label>
                <div className="flex justify-end">
                  <Button
                    variant="danger"
                    title={!canInvoke ? "Starting needs both Approvals and Passwords & keys" : ok ? "" : "Choose items and give a reason"}
                    disabled={!ok || busy}
                    onClick={() => act(startBreakglass(scope, why), "Requested — every approver has been told")}
                  >
                    Start emergency access
                  </Button>
                </div>
              </div>
            </Block>
          </Grid>
        </>
      ) : null}
      {sessions.length ? (
        <Block title="Earlier emergency access" sub="Kept with the audit log.">
          <GTable
            cols={[
              ["Started", "140px"],
              ["By", "150px"],
              ["Approved by", "150px"],
              ["Reason", "minmax(200px,2fr)"],
              ["Items used", "100px"],
              ["Review", "minmax(160px,1fr)"],
            ]}
            rows={sessions.map((s) => ({
              key: s.id,
              cells: [
                <Cell key="a" t={when(s.startedAt, true)} />,
                <Cell key="b" t={s.by} />,
                <Cell key="c" t={s.approvedBy ?? (s.state === "declined" ? "Declined" : "—")} />,
                <Cell key="d" t={`“${s.reason}”`} />,
                <Cell key="e" t={`${s.scope.filter((x) => x.used).length} of ${s.scope.length}`} />,
                s.reviewNote ? <Cell key="f" t={s.reviewNote} /> : s.reviewOverdue ? <Pill key="f" label="Review overdue" tone="danger" /> : <Cell key="f" t={s.state === "declined" ? "—" : "Not yet"} />,
              ],
            }))}
          />
        </Block>
      ) : null}
    </div>
  );
}
