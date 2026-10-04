import React from 'react';
import { Pressable, TextInput, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';

import { AppFrame, BackLink, useCameFrom } from '../src/components/shell/AppFrame';
import { Badge, Card, ListCard, T } from '../src/components/ui/primitives';
import { Icon } from '../src/components/ui/Icon';
import { Chip, ChipRow, Figure, Line, Tabs } from '../src/components/ui/account-parts';
import { freshAccount, phoneAccount, rememberedAccount } from '../src/data/customer-account';
import {
  BILL_FILTERS,
  RECEIPT_FILTERS,
  billMatches,
  billStatus,
  creditNoteStatus,
  creditUse,
  longDay,
  matchesText,
  receiptMatches,
  receiptStatus,
  windowOf,
  type AccountBill,
  type AccountEntry,
  type AccountReceipt,
  type AccountView,
  type BillFilter,
  type ReceiptFilter,
} from '../src/engines/account-view';
import { PERIODS, periodRange, type PeriodKey } from '../src/engines/statement';
import { useStore } from '../src/state/store';
import { inrFromPaise, isoDate, plural, shopName } from '../src/lib/format';
import { color as C, radius, tabular, weight } from '../src/theme/tokens';
import { Stagger, Swap, animateLayoutFor } from '../src/components/ui/motion';

/**
 * ONE CUSTOMER'S ACCOUNT, in full — the Accounts app's customer account on
 * the handset, read-only.
 *
 * Five tabs, each the answer to a question a shopkeeper asks across a
 * counter:
 *
 *   Summary     — what do I owe, how much more can I take, how late am I
 *   Statement   — everything billed and received, with the balance after each
 *   Bills       — this bill: what was on it, what has been paid against it
 *   Payments    — that payment: did it arrive, which bills did it clear
 *   Credit notes — the claim I made: where has it got to
 *
 * WHICH ANSWER IS ON THE SCREEN IS SAID AT THE TOP, every time. The office's
 * answer today, the office's answer from earlier (no signal now), or the
 * thirteen months this phone holds (never opened online). A salesman reading
 * a balance to a customer is entitled to know which of the three he is
 * reading, and the customer is entitled to have him know.
 *
 * Every rupee here is the office's. The running balance, the aging, the
 * outstanding: computed by the same functions the Accounts app draws from, and
 * only cut into windows and filtered on the phone.
 */

type Origin = 'office' | 'remembered' | 'phone';

const TAB_NAMES = ['Summary', 'Statement', 'Bills', 'Payments', 'Credit notes'] as const;
const STEP = 40;

export default function AccountScreen() {
  const back = useCameFrom('accounts');
  const params = useLocalSearchParams<{ id?: string }>();
  const id = params.id ?? '';
  const set = useStore((s) => s.set);

  const [view, setView] = React.useState<AccountView | null>(null);
  const [origin, setOrigin] = React.useState<Origin | null>(null);
  const [problem, setProblem] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [missing, setMissing] = React.useState(false);
  /* One reading of the clock per answer, so "read 4 min ago" is decided when
     the answer lands rather than whenever React happens to re-render. */
  const [nowMs, setNowMs] = React.useState(() => Date.now());
  const [tab, setTab] = React.useState(0);

  const load = React.useCallback(async () => {
    if (!id) return;
    setLoading(true);
    setProblem(null);
    /* What is already here first — instant, with no signal. */
    const [remembered, phone] = await Promise.all([rememberedAccount(id), phoneAccount(id)]);
    if (remembered) {
      setView(remembered);
      setOrigin('remembered');
    } else if (phone) {
      setView(phone);
      setOrigin('phone');
    }
    const fresh = await freshAccount(id);
    setNowMs(Date.now());
    if (fresh.ok) {
      setView(fresh.view);
      setOrigin('office');
    } else {
      setProblem(fresh.error);
      if (!remembered && !phone) setMissing(true);
    }
    setLoading(false);
  }, [id]);

  React.useEffect(() => {
    void load();
  }, [load]);

  if (!view) {
    return (
      <AppFrame title="Account" activeTab={null} onBack={back.go} contentStyle={{ padding: 16 }}>
        <BackLink label={back.label} onPress={back.go} />
        <Card style={{ marginTop: 8, paddingVertical: 28 }}>
          <T style={{ fontSize: 15, color: C.ink, textAlign: 'center' }}>
            {missing ? 'This account is not on your phone' : 'Opening the account…'}
          </T>
          {missing && problem ? (
            <T s="small" style={{ color: C.muted, textAlign: 'center', marginTop: 6 }}>
              {problem}
            </T>
          ) : null}
        </Card>
      </AppFrame>
    );
  }

  const c = view.customer;
  const counts = [
    null,
    view.ledger.entries.length,
    view.bills.length,
    view.receipts.length,
    view.creditNotes ? view.creditNotes.length : null,
  ];

  return (
    <AppFrame title="Account" activeTab={null} onBack={back.go} contentStyle={{ padding: 16, paddingBottom: 40 }}>
      <BackLink label={back.label} onPress={back.go} />

      {/* ---- who ---- */}
      <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 12 }}>
        <View style={{ flex: 1, minWidth: 0 }}>
          <T s="h1">{shopName(c.name)}</T>
          <T s="caption" style={{ marginTop: 2 }}>
            {[c.city, c.gstin ? 'GST ' + c.gstin : null].filter(Boolean).join(' · ') || '—'}
          </T>
        </View>
        <Pressable
          onPress={() => {
            set({ custId: c.id, pTab: 0 });
            router.push('/customer');
          }}
          accessibilityRole="button"
          accessibilityLabel="Open the customer record"
          style={{ height: 36, paddingHorizontal: 12, borderRadius: radius.sm, borderWidth: 1, borderColor: C.border, backgroundColor: C.surface, justifyContent: 'center' }}>
          <T style={[{ fontSize: 13, color: C.primary }, weight(500)]}>Record</T>
        </Pressable>
      </View>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 8 }}>
        <Badge tone="info">{accountWord(view)}</Badge>
        {c.creditBlocked ? <Badge tone="danger">Supply stopped</Badge> : null}
        {c.slowPayer ? <Badge tone="amber">Slow payer</Badge> : null}
        {view.followUp && view.followUp.stage > 0 ? (
          <Badge tone={view.followUp.stage >= 3 ? 'danger' : 'amber'}>Follow-up stage {view.followUp.stage}</Badge>
        ) : null}
      </View>

      {/* ---- whose answer this is ---- */}
      <SourceLine origin={origin} view={view} nowMs={nowMs} loading={loading} onRetry={() => void load()} />

      <View style={{ marginTop: 12 }}>
        <Tabs
          tabs={TAB_NAMES.map((label, i) => ({ label, count: counts[i] }))}
          active={tab}
          onPick={setTab}
        />
      </View>

      {/* Siblings, so the new tab's body settles in place rather than sliding:
          there is no direction between Bills and Payments. The tick is in
          `Tabs` itself. */}
      <Swap id={tab} style={{ marginTop: 14 }}>
        {tab === 0 ? <Summary view={view} onTab={setTab} /> : null}
        {tab === 1 ? <Statement view={view} /> : null}
        {tab === 2 ? <Bills view={view} /> : null}
        {tab === 3 ? <Payments view={view} /> : null}
        {tab === 4 ? <CreditNotes view={view} /> : null}
      </Swap>
    </AppFrame>
  );
}

/* ================================================================ header */

function accountWord(v: AccountView): string {
  if (v.serving?.thirdParty || v.customer.thirdParty) return 'Third-party customer';
  if (v.serving && v.serving.shops > 0) return 'Distributor';
  if (v.customer.kind === 'lead') return 'Lead';
  return 'Direct customer';
}

function ago(at: number, nowMs: number): string {
  if (!at) return 'never';
  const mins = Math.max(0, Math.round((nowMs - at) / 60_000));
  if (mins < 1) return 'just now';
  if (mins < 60) return mins + ' min ago';
  const hours = Math.round(mins / 60);
  if (hours < 24) return hours === 1 ? 'an hour ago' : hours + ' hours ago';
  const days = Math.round(hours / 24);
  return days === 1 ? 'yesterday' : days + ' days ago';
}

function SourceLine({
  origin,
  view,
  nowMs,
  loading,
  onRetry,
}: {
  origin: Origin | null;
  view: AccountView;
  nowMs: number;
  loading: boolean;
  onRetry: () => void;
}) {
  const live = origin === 'office';
  const text =
    origin === 'office'
      ? 'From the accounts team, just now. Full history.'
      : origin === 'remembered'
        ? `From the accounts team, ${ago(view.readAtMs, nowMs)}. ${loading ? 'Checking for newer…' : 'Could not reach the office for newer.'}`
        : `What this phone holds — about the last 13 months. ${loading ? 'Asking the office for the full account…' : 'Open it again with signal for the full account.'}`;
  return (
    <View
      style={{
        marginTop: 12,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 10,
        paddingHorizontal: 12,
        paddingVertical: 10,
        borderRadius: radius.md,
        backgroundColor: live ? C.successBg : C.warnBg,
      }}>
      <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: live ? C.success : C.warn }} />
      <T s="caption" style={{ flex: 1, color: live ? C.success : C.warnInk }}>
        {text}
      </T>
      {!loading && !live ? (
        <Pressable onPress={onRetry} accessibilityRole="button" hitSlop={10}>
          <T style={[{ fontSize: 13, color: C.primary }, weight(500)]}>Try again</T>
        </Pressable>
      ) : null}
    </View>
  );
}

/* =============================================================== summary */

function Summary({ view, onTab }: { view: AccountView; onTab: (i: number) => void }) {
  const c = view.customer;
  const use = creditUse(c.outstandingPaise, c.creditLimitPaise);
  const headroom = c.creditLimitPaise != null && c.creditLimitPaise > 0 ? c.creditLimitPaise - c.outstandingPaise : null;
  const openBills = view.bills.filter((b) => billMatches(b, 'open'));
  const overdueBills = view.bills.filter((b) => billMatches(b, 'overdue'));
  const overduePaise = overdueBills.reduce((s, b) => s + b.balancePaise, 0);
  const oldest = overdueBills.reduce((m, b) => Math.max(m, b.overdueDays), 0);
  const lastPaid = view.receipts.find((r) => r.status === 'confirmed');
  const lastBill = view.bills[0];

  return (
    <View style={{ gap: 12 }}>
      {/* ---- the one number ---- */}
      <Card style={{ borderLeftWidth: 3, borderLeftColor: c.outstandingPaise > 0 ? C.danger : C.success }}>
        <T s="label">Outstanding now</T>
        <T style={[{ fontSize: 30, lineHeight: 36, color: c.outstandingPaise > 0 ? C.danger : C.ink, marginTop: 2 }, weight(600), tabular]}>
          {c.outstandingPaise > 0 ? inrFromPaise(c.outstandingPaise) : 'Nothing owed'}
        </T>
        <T s="caption" style={{ marginTop: 2 }}>
          The office&apos;s figure for the whole account. It counts only money the accounts team has
          found in the bank.
        </T>

        {use != null ? (
          <View style={{ marginTop: 12 }}>
            <View style={{ height: 6, borderRadius: 3, backgroundColor: C.hairline, overflow: 'hidden' }}>
              <View
                style={{
                  width: `${Math.min(100, use)}%`,
                  height: 6,
                  backgroundColor: use > 100 ? C.danger : use >= 80 ? C.warn : C.success,
                }}
              />
            </View>
            <T s="caption" style={{ marginTop: 6 }}>
              {use}% of the {inrFromPaise(c.creditLimitPaise ?? 0)} credit limit used
            </T>
          </View>
        ) : null}
      </Card>

      {/* ---- the rest of the money ---- */}
      <Card style={{ gap: 14 }}>
        <View style={{ flexDirection: 'row', gap: 12 }}>
          <Figure
            label="Credit limit"
            value={c.creditLimitPaise ? inrFromPaise(c.creditLimitPaise) : 'Not set'}
          />
          <Figure
            label={headroom != null && headroom < 0 ? 'Over the limit by' : 'Can still take'}
            value={headroom == null ? '—' : inrFromPaise(Math.abs(headroom))}
            tone={headroom != null && headroom < 0 ? C.danger : undefined}
          />
        </View>
        <View style={{ flexDirection: 'row', gap: 12 }}>
          <Figure
            label="Credit term"
            value={c.creditDays != null ? plural(c.creditDays, 'day') : '—'}
            sub={c.creditDaysIsDefault ? 'the usual term — none agreed for this shop' : 'agreed for this shop'}
          />
          <Figure
            label="Overdue"
            value={overduePaise ? inrFromPaise(overduePaise) : 'Nothing'}
            sub={overdueBills.length ? `${plural(overdueBills.length, 'bill')} · oldest ${oldest} days` : null}
            tone={overduePaise ? C.danger : undefined}
          />
        </View>
        <View style={{ flexDirection: 'row', gap: 12 }}>
          <Figure
            label="On account"
            value={view.ledger.onAccountPaise == null ? 'Needs signal' : view.ledger.onAccountPaise ? inrFromPaise(view.ledger.onAccountPaise) : 'Nothing'}
            sub={view.ledger.onAccountPaise ? 'paid, not yet set against a bill' : null}
          />
          <Figure
            label="With accounts"
            value={view.ledger.awaitingCount ? inrFromPaise(view.ledger.awaitingPaise) : 'Nothing'}
            sub={view.ledger.awaitingCount ? `${plural(view.ledger.awaitingCount, 'payment')} not yet confirmed` : null}
            tone={view.ledger.awaitingCount ? C.warnInk : undefined}
          />
        </View>
        <View style={{ flexDirection: 'row', gap: 12 }}>
          <Figure label="Open bills" value={String(openBills.length)} />
          <Figure
            label="Not stated"
            value={view.unstated.count ? inrFromPaise(view.unstated.amountPaise) : 'None'}
            sub={view.unstated.count ? `${plural(view.unstated.count, 'bill')} nobody has said is paid or owed` : null}
          />
        </View>
      </Card>

      {/* ---- warnings, in words ---- */}
      {c.creditBlocked ? (
        <Notice tone="danger" head="The office has stopped supply to this shop">
          {c.creditBlockReason ?? 'No reason recorded. Ask accounts before taking an order.'}
        </Notice>
      ) : null}
      {view.ledger.awaitingCount ? (
        <Notice tone="warn" head={`${inrFromPaise(view.ledger.awaitingPaise)} is waiting for accounts`}>
          {`${plural(view.ledger.awaitingCount, 'payment')} reported and not yet found in the bank. It is not in the outstanding above, and will not be until accounts confirm it.`}
        </Notice>
      ) : null}
      {view.followUp?.held ? (
        <Notice tone="warn" head="Collections are paused on this account">
          {view.followUp.heldReason ?? 'Accounts are checking something. Do not chase payment until they finish.'}
        </Notice>
      ) : null}
      {view.serving?.thirdParty ? (
        <Notice tone="info" head="Billed to the distributor">
          {`We deliver here and bill ${view.serving.distributors.length ? view.serving.distributors.map((d) => d.name).join(', ') : 'a distributor nobody has recorded yet'}. Bills on this account are the exceptions, not the rule.`}
        </Notice>
      ) : view.serving && view.serving.shops > 0 ? (
        <Notice tone="info" head="Distributor">
          {`${plural(view.serving.shops, 'shop')} are delivered to on this account's bills.`}
        </Notice>
      ) : null}

      {/* ---- the aging strip ---- */}
      <Card>
        <T s="label">How old the debt is</T>
        {view.aging ? (
          view.aging.totalPaise > 0 ? (
            <AgingStrip buckets={view.aging.buckets} totalPaise={view.aging.totalPaise} />
          ) : (
            <T s="small" style={{ marginTop: 6 }}>
              No open bills. Nothing is ageing.
            </T>
          )
        ) : (
          <T s="small" style={{ color: C.muted, marginTop: 6 }}>
            Needs signal — the age bands come from the office.
          </T>
        )}
      </Card>

      {/* ---- the dates and the people ---- */}
      <Card>
        <T s="label">At a glance</T>
        <View style={{ marginTop: 6 }}>
          <Line label="Last bill" value={lastBill ? `${lastBill.billNo} · ${longDay(lastBill.billDate)}` : 'None'} />
          <Line label="Last payment confirmed" value={lastPaid ? `${inrFromPaise(lastPaid.amountPaise)} · ${longDay(lastPaid.receivedAt)}` : 'None'} />
          <Line label="Last order" value={longDay(c.lastOrderDate)} />
          {view.followUp && view.followUp.oldestOverdueBillDate ? (
            <Line label="Oldest overdue bill" value={longDay(view.followUp.oldestOverdueBillDate)} />
          ) : null}
          {c.salesPersonName ? <Line label="Salesperson" value={c.salesPersonName} /> : null}
          {c.backOfficeName ? <Line label="Back office" value={c.backOfficeName} /> : null}
          {c.phone ? <Line label="Phone" value={c.phone} /> : null}
        </View>
      </Card>

      <View style={{ flexDirection: 'row', gap: 10 }}>
        <JumpButton label="Statement" onPress={() => onTab(1)} />
        <JumpButton label="Open bills" onPress={() => onTab(2)} />
        <JumpButton label="Payments" onPress={() => onTab(3)} />
      </View>
    </View>
  );
}

function AgingStrip({ buckets, totalPaise }: { buckets: { label: string; from: number; amountPaise: number }[]; totalPaise: number }) {
  /* Not due is calm, the oldest band is loud, the ones between climb. */
  const tones = [C.success, C.warn, '#D9822B', C.danger];
  const toneOf = (i: number) => tones[Math.min(i, tones.length - 1)];
  return (
    <View style={{ marginTop: 10 }}>
      <View style={{ flexDirection: 'row', height: 10, borderRadius: 5, overflow: 'hidden', backgroundColor: C.hairline }}>
        {buckets.map((b, i) =>
          b.amountPaise > 0 ? (
            <View key={b.label} style={{ flex: b.amountPaise / totalPaise, backgroundColor: toneOf(i) }} />
          ) : null,
        )}
      </View>
      <View style={{ marginTop: 10, gap: 2 }}>
        {buckets.map((b, i) => (
          <View key={b.label} style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 3 }}>
            <View style={{ width: 10, height: 10, borderRadius: 2, backgroundColor: toneOf(i) }} />
            <T s="small" style={{ flex: 1 }}>
              {b.label}
            </T>
            <T style={[{ fontSize: 14, color: b.amountPaise ? C.ink : C.faint }, weight(500), tabular]}>
              {b.amountPaise ? inrFromPaise(b.amountPaise) : '—'}
            </T>
          </View>
        ))}
      </View>
    </View>
  );
}

function Notice({ tone, head, children }: { tone: 'danger' | 'warn' | 'info'; head: string; children: React.ReactNode }) {
  const palette =
    tone === 'danger'
      ? { bg: C.dangerBg, fg: C.danger }
      : tone === 'warn'
        ? { bg: C.warnBg, fg: C.warnInk }
        : { bg: C.infoBg, fg: C.info };
  return (
    <View style={{ borderRadius: radius.lg, backgroundColor: palette.bg, padding: 14 }}>
      <T style={[{ fontSize: 14, lineHeight: 20, color: palette.fg }, weight(600)]}>{head}</T>
      <T s="small" style={{ color: palette.fg, marginTop: 2 }}>
        {children}
      </T>
    </View>
  );
}

function JumpButton({ label, onPress }: { label: string; onPress: () => void }) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      style={{ flex: 1, height: 44, borderRadius: radius.md, borderWidth: 1, borderColor: C.border, backgroundColor: C.surface, alignItems: 'center', justifyContent: 'center' }}>
      <T style={[{ fontSize: 14, color: C.primary }, weight(500)]}>{label}</T>
    </Pressable>
  );
}

/* ============================================================= statement */

function Statement({ view }: { view: AccountView }) {
  const [period, setPeriod] = React.useState<PeriodKey>('all');
  const [shown, setShown] = React.useState(STEP);
  const today = view.asOf || isoDate(new Date());
  const range = periodRange(period, today);
  const w = windowOf(view.ledger.entries, range);

  return (
    <View style={{ gap: 12 }}>
      <ChipRow>
        {PERIODS.map((p) => (
          <Chip
            key={p.key}
            /* "Everything here" is the phone's wording for the window it
               holds. From the office it IS everything, and says so. */
            label={p.key === 'all' ? (view.source === 'office' ? 'All time' : 'Everything here') : p.label}
            on={period === p.key}
            onPress={() => {
              setPeriod(p.key);
              setShown(STEP);
            }}
          />
        ))}
      </ChipRow>

      <Card style={{ gap: 12 }}>
        <View style={{ flexDirection: 'row', gap: 12 }}>
          <Figure label="Billed" value={inrFromPaise(w.billedPaise)} />
          <Figure label="Received" value={inrFromPaise(w.receivedPaise)} tone={w.receivedPaise ? C.success : undefined} />
        </View>
        <View style={{ flexDirection: 'row', gap: 12, borderTopWidth: 1, borderTopColor: C.wash, paddingTop: 10 }}>
          <Figure label="Owed before these dates" value={range.from ? inrFromPaise(w.openingPaise) : '—'} />
          <Figure
            label="Owed at the end"
            value={w.entries.length ? signed(w.entries[0].balancePaise) : range.from ? signed(w.openingPaise) : '—'}
          />
        </View>
        <T s="caption">
          Newest first. The balance after each line counts only confirmed money, so the top one is what was owed at
          that point.
        </T>
      </Card>

      {w.entries.length === 0 ? (
        <Empty
          head="Nothing in these dates"
          body={view.ledger.entries.length ? 'No bill or payment falls in these dates. Pick a longer time.' : 'This account has never been billed.'}
        />
      ) : (
        <ListCard>
          {w.entries.slice(0, shown).map((e, i) => (
            <Stagger key={`${e.kind}-${e.ref}-${e.at}-${i}`} index={i}>
              <EntryRow e={e} first={i === 0} />
            </Stagger>
          ))}
          {range.from && shown >= w.entries.length ? (
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', paddingHorizontal: 16, paddingVertical: 12, borderTopWidth: 1, borderTopColor: C.wash, backgroundColor: C.wash }}>
              <T s="small">Opening balance · {longDay(range.from)}</T>
              <T style={[{ fontSize: 14, color: C.body }, weight(500), tabular]}>{signed(w.openingPaise)}</T>
            </View>
          ) : null}
        </ListCard>
      )}
      <More shown={shown} total={w.entries.length} onMore={() => setShown(shown + STEP)} />
    </View>
  );
}

function EntryRow({ e, first }: { e: AccountEntry; first: boolean }) {
  const st = e.kind === 'receipt' ? receiptStatus(e.status) : null;
  const dead = e.status === 'rejected' || e.status === 'reversed';
  return (
    <View style={{ paddingHorizontal: 16, paddingVertical: 12, borderTopWidth: first ? 0 : 1, borderTopColor: C.wash }}>
      <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 10 }}>
        <View
          style={{
            width: 28,
            height: 28,
            borderRadius: 14,
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: e.kind === 'bill' ? C.infoBg : dead ? C.dangerBg : st?.counts ? C.successBg : C.warnBg,
          }}>
          <Icon
            name={e.kind === 'bill' ? 'doc' : 'money'}
            size={15}
            color={e.kind === 'bill' ? C.info : dead ? C.danger : st?.counts ? C.success : C.warnInk}
            strokeWidth={1.7}
          />
        </View>
        <View style={{ flex: 1, minWidth: 0 }}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 8 }}>
            <T
              style={[{ fontSize: 14, lineHeight: 20, color: dead ? C.muted : C.ink, textDecorationLine: dead ? 'line-through' : 'none', flexShrink: 1 }, weight(500)]}
              numberOfLines={1}>
              {e.kind === 'bill' ? 'Bill ' + e.ref : e.ref === '—' ? 'Payment' : e.ref}
            </T>
            <T
              style={[
                { fontSize: 14, lineHeight: 20, color: e.kind === 'bill' ? C.ink : dead ? C.muted : st?.counts ? C.success : C.warnInk, textDecorationLine: dead ? 'line-through' : 'none' },
                weight(600),
                tabular,
              ]}>
              {e.kind === 'bill' ? '+ ' + inrFromPaise(e.debitPaise) : '− ' + inrFromPaise(e.creditPaise || 0)}
            </T>
          </View>
          <T s="caption" numberOfLines={2}>
            {longDay(e.at)} · {e.detail}
          </T>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 6, marginTop: 4 }}>
            {st && st.label !== 'Confirmed' ? <Badge tone={st.tone}>{st.label}</Badge> : null}
            {e.kind === 'bill' && e.claimedPaise > 0 ? (
              <Badge tone="amber">{inrFromPaise(e.claimedPaise)} claimed, on hold</Badge>
            ) : null}
            <View style={{ flex: 1 }} />
            <T s="micro" style={tabular}>
              Balance {signed(e.balancePaise)}
            </T>
          </View>
          {/* A receipt that has not counted shows what it WOULD have been —
              the line itself carries nothing, because nothing has arrived. */}
          {e.kind === 'receipt' && !e.creditPaise && !dead && st && !st.counts ? (
            <T s="micro" style={{ marginTop: 2 }}>
              Not in the balance until accounts confirm it.
            </T>
          ) : null}
        </View>
      </View>
    </View>
  );
}

/* ================================================================= bills */

function Bills({ view }: { view: AccountView }) {
  const [filter, setFilter] = React.useState<BillFilter>('all');
  const [q, setQ] = React.useState('');
  const [open, setOpen] = React.useState<string | null>(null);
  const [shown, setShown] = React.useState(STEP);

  const list = view.bills.filter(
    (b) => billMatches(b, filter) && matchesText([b.billNo, b.billDate, Math.round(b.amountPaise / 100), ...b.lines.map((l) => l.product)], q),
  );
  const balance = list.filter((b) => b.paymentPosition !== 'unstated').reduce((s, b) => s + Math.max(0, b.balancePaise), 0);
  const billed = list.reduce((s, b) => s + b.amountPaise, 0);

  return (
    <View style={{ gap: 12 }}>
      <Search value={q} onChange={setQ} placeholder="Bill number, product or amount" />
      <ChipRow>
        {BILL_FILTERS.map((f) => (
          <Chip
            key={f.key}
            label={f.label}
            count={view.bills.filter((b) => billMatches(b, f.key)).length}
            on={filter === f.key}
            onPress={() => {
              setFilter(f.key);
              setShown(STEP);
            }}
          />
        ))}
      </ChipRow>
      <Card style={{ flexDirection: 'row', gap: 12 }}>
        <Figure label={plural(list.length, 'bill')} value={inrFromPaise(billed)} sub="billed" />
        <Figure label="Still open on these" value={inrFromPaise(balance)} tone={balance ? C.danger : undefined} sub="stated bills only" />
      </Card>

      {list.length === 0 ? (
        <Empty
          head={view.bills.length ? 'No bill matches' : 'No bills'}
          body={view.bills.length ? 'Try another filter, or clear the search.' : accountWord(view) === 'Third-party customer' ? 'The bill goes to the distributor, so this shop has none.' : 'This account has not been billed yet.'}
        />
      ) : (
        list.slice(0, shown).map((b, i) => (
          <Stagger key={b.id} index={i}>
            <BillCard
              b={b}
              open={open === b.id}
              onToggle={() => {
                /* Opening a bill pushes the cards under it down; animated, the
                   eye stays on the one that opened. */
                animateLayoutFor(Math.min(shown, list.length));
                setOpen(open === b.id ? null : b.id);
              }}
            />
          </Stagger>
        ))
      )}
      <More shown={shown} total={list.length} onMore={() => setShown(shown + STEP)} />
      {view.source !== 'office' ? (
        <T s="caption">Only bills this phone holds. Open with signal for every bill.</T>
      ) : null}
    </View>
  );
}

function BillCard({ b, open, onToggle }: { b: AccountBill; open: boolean; onToggle: () => void }) {
  const st = billStatus(b);
  const unstated = b.paymentPosition === 'unstated';
  return (
    <Card padded={false} style={{ overflow: 'hidden' }}>
      <Pressable
        onPress={onToggle}
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        style={({ pressed }) => [{ padding: 14 }, pressed && { backgroundColor: C.wash }]}>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', gap: 10 }}>
          <View style={{ flex: 1, minWidth: 0 }}>
            <T style={[{ fontSize: 15, lineHeight: 21, color: C.ink }, weight(600)]} numberOfLines={1}>
              {b.billNo}
            </T>
            <T s="caption">
              {longDay(b.billDate)}
              {b.dueDate ? ' · due ' + longDay(b.dueDate) : ''}
            </T>
          </View>
          <View style={{ alignItems: 'flex-end' }}>
            <T style={[{ fontSize: 15, lineHeight: 21, color: C.ink }, weight(600), tabular]}>{inrFromPaise(b.amountPaise)}</T>
            <T s="micro" style={[tabular, { color: unstated ? C.muted : b.balancePaise > 0 ? C.danger : C.success }]}>
              {unstated ? 'not stated' : b.balancePaise > 0 ? inrFromPaise(b.balancePaise) + ' open' : 'paid in full'}
            </T>
          </View>
        </View>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 6, marginTop: 8 }}>
          <Badge tone={st.tone}>{st.label}</Badge>
          {b.disputed ? <Badge tone="danger">Disputed</Badge> : null}
          {b.claimedPaise > 0 ? <Badge tone="amber">{inrFromPaise(b.claimedPaise)} claimed</Badge> : null}
          {b.bucket && b.balancePaise > 0 && !unstated ? <Badge tone="neutral">{b.bucket}</Badge> : null}
          <View style={{ flex: 1 }} />
          <T s="micro">{b.lines.length ? plural(b.lines.length, 'item') : ''}</T>
          <Icon name={open ? 'close' : 'forward'} size={14} color={C.faint} strokeWidth={1.6} />
        </View>
      </Pressable>

      {open ? (
        <View style={{ paddingHorizontal: 14, paddingBottom: 14, borderTopWidth: 1, borderTopColor: C.wash, paddingTop: 10, gap: 10 }}>
          <View>
            <Line label="Billed" value={inrFromPaise(b.amountPaise)} />
            <Line label="Paid (confirmed)" value={inrFromPaise(b.paidPaise)} tone={b.paidPaise ? C.success : undefined} />
            <Line
              label="Balance"
              value={unstated ? 'Not stated' : inrFromPaise(Math.max(0, b.balancePaise))}
              tone={!unstated && b.balancePaise > 0 ? C.danger : undefined}
            />
            {b.overdueDays > 0 && !unstated ? <Line label="Overdue by" value={plural(b.overdueDays, 'day')} tone={C.danger} /> : null}
            {b.claimedPaise > 0 ? <Line label="Claimed, not yet confirmed" value={inrFromPaise(b.claimedPaise)} tone={C.warnInk} /> : null}
          </View>

          {unstated ? (
            <T s="caption">
              Nobody has said whether this bill is paid or owed. It is not counted in the outstanding, and
              nobody chases it until somebody does.
            </T>
          ) : null}

          <View>
            <T s="label">What was on it</T>
            {b.lines.length ? (
              b.lines.map((l, i) => (
                <View key={i} style={{ flexDirection: 'row', gap: 10, paddingVertical: 5, borderTopWidth: i ? 1 : 0, borderTopColor: C.wash }}>
                  <T s="small" style={{ flex: 1 }}>
                    {l.product}
                  </T>
                  <T s="small" style={tabular}>
                    × {l.qty}
                  </T>
                  <T style={[{ fontSize: 14, color: C.ink, minWidth: 80, textAlign: 'right' }, tabular]}>
                    {l.amountPaise != null ? inrFromPaise(l.amountPaise) : '—'}
                  </T>
                </View>
              ))
            ) : (
              <T s="caption" style={{ marginTop: 4 }}>
                No lines recorded for this bill.
              </T>
            )}
          </View>

          <View>
            <T s="label">Payments against it</T>
            {b.payments === null ? (
              <T s="caption" style={{ marginTop: 4 }}>
                Needs signal — which payment cleared which bill comes from the office.
              </T>
            ) : b.payments.length ? (
              b.payments.map((p, i) => {
                const st2 = receiptStatus(p.status);
                return (
                  <View key={p.receiptId + i} style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 5 }}>
                    <T s="small" style={{ flex: 1 }}>
                      {longDay(p.at)} · {p.mode}
                    </T>
                    {st2.label !== 'Confirmed' ? <Badge tone={st2.tone}>{st2.label}</Badge> : null}
                    <T style={[{ fontSize: 14, color: st2.counts ? C.success : C.muted }, weight(500), tabular]}>
                      {inrFromPaise(p.amountPaise)}
                    </T>
                  </View>
                );
              })
            ) : (
              <T s="caption" style={{ marginTop: 4 }}>
                No payment has been set against this bill.
              </T>
            )}
          </View>
        </View>
      ) : null}
    </Card>
  );
}

/* ============================================================== payments */

function Payments({ view }: { view: AccountView }) {
  const [filter, setFilter] = React.useState<ReceiptFilter>('all');
  const [q, setQ] = React.useState('');
  const [open, setOpen] = React.useState<string | null>(null);
  const [shown, setShown] = React.useState(STEP);

  const list = view.receipts.filter(
    (r) => receiptMatches(r, filter) && matchesText([r.reference, r.receiptNo, r.mode, r.receivedAt, Math.round(r.amountPaise / 100)], q),
  );
  const confirmed = list.filter((r) => r.status === 'confirmed').reduce((s, r) => s + r.amountPaise, 0);

  return (
    <View style={{ gap: 12 }}>
      <Search value={q} onChange={setQ} placeholder="Reference, receipt number or amount" />
      <ChipRow>
        {RECEIPT_FILTERS.map((f) => (
          <Chip
            key={f.key}
            label={f.label}
            count={view.receipts.filter((r) => receiptMatches(r, f.key)).length}
            on={filter === f.key}
            onPress={() => {
              setFilter(f.key);
              setShown(STEP);
            }}
          />
        ))}
      </ChipRow>
      <Card style={{ flexDirection: 'row', gap: 12 }}>
        <Figure label={plural(list.length, 'payment')} value={inrFromPaise(confirmed)} sub="confirmed of these" tone={confirmed ? C.success : undefined} />
        <Figure
          label="With accounts"
          value={inrFromPaise(list.filter((r) => r.status === 'reported' || r.status === 'held').reduce((s, r) => s + r.amountPaise, 0))}
          sub="not yet counted"
        />
      </Card>

      {list.length === 0 ? (
        <Empty
          head={view.receipts.length ? 'No payment matches' : 'No payments'}
          body={view.receipts.length ? 'Try another filter, or clear the search.' : 'Nothing has been received on this account yet.'}
        />
      ) : (
        list.slice(0, shown).map((r, i) => (
          <Stagger key={r.id} index={i}>
            <ReceiptCard
              r={r}
              open={open === r.id}
              onToggle={() => {
                animateLayoutFor(Math.min(shown, list.length));
                setOpen(open === r.id ? null : r.id);
              }}
            />
          </Stagger>
        ))
      )}
      <More shown={shown} total={list.length} onMore={() => setShown(shown + STEP)} />
      {view.source !== 'office' ? (
        <T s="caption">Only payments this phone holds. Open with signal for every payment.</T>
      ) : null}
    </View>
  );
}

function ReceiptCard({ r, open, onToggle }: { r: AccountReceipt; open: boolean; onToggle: () => void }) {
  const st = receiptStatus(r.status);
  const dead = r.status === 'rejected' || r.status === 'reversed';
  return (
    <Card padded={false} style={{ overflow: 'hidden' }}>
      <Pressable
        onPress={onToggle}
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        style={({ pressed }) => [{ padding: 14 }, pressed && { backgroundColor: C.wash }]}>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', gap: 10 }}>
          <View style={{ flex: 1, minWidth: 0 }}>
            <T
              style={[{ fontSize: 16, lineHeight: 22, color: dead ? C.muted : C.ink, textDecorationLine: dead ? 'line-through' : 'none' }, weight(600), tabular]}>
              {inrFromPaise(r.amountPaise)}
            </T>
            <T s="caption" numberOfLines={1}>
              {longDay(r.receivedAt)} · {r.mode === 'Not stated' ? 'method not recorded' : r.mode}
              {r.reference ? ' · ' + r.reference : ''}
            </T>
          </View>
          <Badge tone={st.tone}>{st.label}</Badge>
        </View>
        {r.receiptNo ? (
          <T s="micro" style={{ marginTop: 4 }}>
            Receipt {r.receiptNo}
          </T>
        ) : null}
      </Pressable>

      {open ? (
        <View style={{ paddingHorizontal: 14, paddingBottom: 14, borderTopWidth: 1, borderTopColor: C.wash, paddingTop: 10, gap: 10 }}>
          <T s="small">{r.sentence}</T>
          <View>
            <Line label="Received" value={longDay(r.receivedAt)} />
            {r.instrumentDate ? <Line label="Date on the cheque" value={longDay(r.instrumentDate)} /> : null}
            {r.reportedBy ? <Line label="Written down by" value={r.reportedBy} /> : null}
            {r.confirmedBy ? (
              <Line label="Confirmed by" value={r.confirmedBy + (r.confirmedAt ? ' · ' + longDay(r.confirmedAt) : '')} />
            ) : null}
            {r.onAccountPaise > 0 ? <Line label="On account" value={inrFromPaise(r.onAccountPaise)} /> : null}
          </View>
          {r.holdReason && r.status === 'held' ? (
            <Notice tone="warn" head="Why it is on hold">
              {r.holdReason}
            </Notice>
          ) : null}
          {r.rejectReason && dead ? (
            <Notice tone="danger" head={r.status === 'reversed' ? 'Why it was reversed' : 'Why it was refused'}>
              {r.rejectReason}
            </Notice>
          ) : null}
          {r.note ? <T s="caption">“{r.note}”</T> : null}

          <View>
            <T s="label">Bills it cleared</T>
            {r.allocations === null ? (
              <T s="caption" style={{ marginTop: 4 }}>
                Needs signal — which bills it cleared comes from the office.
              </T>
            ) : r.allocations.length ? (
              r.allocations.map((a, i) => (
                <View key={i} style={{ flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 4 }}>
                  <T s="small">Bill {a.billNo}</T>
                  <T style={[{ fontSize: 14, color: C.ink }, weight(500), tabular]}>{inrFromPaise(a.amountPaise)}</T>
                </View>
              ))
            ) : (
              <T s="caption" style={{ marginTop: 4 }}>
                {st.counts ? 'Not set against any bill — it is held on account.' : 'Not set against a bill.'}
              </T>
            )}
          </View>
        </View>
      ) : null}
    </Card>
  );
}

/* ========================================================== credit notes */

function CreditNotes({ view }: { view: AccountView }) {
  if (view.creditNotes === null) {
    return (
      <Empty head="Needs signal" body="Credit notes come from the office. Open this account again when you have signal." />
    );
  }
  if (view.creditNotes.length === 0) {
    return <Empty head="No credit notes" body="Nobody has asked for a credit note on this account." />;
  }
  return (
    <View style={{ gap: 10 }}>
      {view.creditNotes.map((n) => {
        const st = creditNoteStatus(n.status);
        return (
          <Card key={n.id} style={{ gap: 6 }}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 10 }}>
              <T style={[{ fontSize: 15, color: C.ink, flex: 1 }, weight(600), tabular]}>
                {n.amountPaise != null ? inrFromPaise(n.amountPaise) : 'Amount not set yet'}
              </T>
              <Badge tone={st.tone}>{st.label}</Badge>
            </View>
            <T s="caption">
              Asked {longDay(n.at)}
              {n.raisedBy ? ' by ' + n.raisedBy : ''}
              {n.billNo ? ' · against bill ' + n.billNo : ' · no bill named'}
            </T>
            <T s="small">{n.description}</T>
            {n.reference || n.cnDate ? (
              <View>
                {n.reference ? <Line label="Credit note" value={n.reference} /> : null}
                {n.cnDate ? <Line label="Dated" value={longDay(n.cnDate)} /> : null}
              </View>
            ) : null}
          </Card>
        );
      })}
    </View>
  );
}

/* ================================================================ shared */

function signed(paise: number): string {
  if (paise < 0) return inrFromPaise(-paise) + ' in credit';
  return inrFromPaise(paise);
}

function Empty({ head, body }: { head: string; body: string }) {
  return (
    <Card style={{ paddingVertical: 24 }}>
      <T style={{ fontSize: 15, lineHeight: 22, color: C.ink, textAlign: 'center' }}>{head}</T>
      <T s="small" style={{ color: C.muted, textAlign: 'center', marginTop: 6 }}>
        {body}
      </T>
    </Card>
  );
}

function More({ shown, total, onMore }: { shown: number; total: number; onMore: () => void }) {
  if (shown >= total) return null;
  return (
    <Pressable
      onPress={onMore}
      accessibilityRole="button"
      style={{ height: 48, borderRadius: radius.lg, borderWidth: 1, borderColor: C.border, backgroundColor: C.surface, alignItems: 'center', justifyContent: 'center' }}>
      <T style={[{ fontSize: 15, color: C.primary }, weight(500)]}>Show more · {total - shown} left</T>
    </Pressable>
  );
}

function Search({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder: string }) {
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        height: 48,
        paddingHorizontal: 14,
        borderRadius: radius.lg,
        borderWidth: 1,
        borderColor: C.border,
        backgroundColor: C.surface,
      }}>
      <Icon name="search" size={18} color={C.muted} strokeWidth={1.6} />
      <TextInput
        value={value}
        onChangeText={onChange}
        placeholder={placeholder}
        placeholderTextColor={C.faint}
        autoCorrect={false}
        autoCapitalize="none"
        style={{ flex: 1, fontSize: 15, color: C.ink, height: '100%' }}
      />
      {value ? (
        <Pressable onPress={() => onChange('')} accessibilityRole="button" accessibilityLabel="Clear" hitSlop={12}>
          <Icon name="close" size={16} color={C.muted} strokeWidth={1.6} />
        </Pressable>
      ) : null}
    </View>
  );
}
