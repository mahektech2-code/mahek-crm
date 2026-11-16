import React from 'react';
import { Pressable, TextInput, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';

import { AppFrame, useCameFrom } from '../src/components/shell/AppFrame';
import { Badge, Card, T } from '../src/components/ui/primitives';
import { Icon, type IconName } from '../src/components/ui/Icon';
import { Chip, ChipRow, Figure, Tabs } from '../src/components/ui/account-parts';
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
import { typedFromPaise } from '../src/lib/money-input';
import { color as C, tabular, weight } from '../src/theme/tokens';
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

/* V3 colours a filter by what it means. Keyed on the words so a filter the
   engine adds later simply draws in ink. */
const FILTER_INK: Record<string, string | undefined> = {
  Overdue: C.danger,
  Settled: C.success,
  Confirmed: C.success,
  'With accounts': C.warnInk,
  'On hold': C.warnInk,
  Refused: C.danger,
  Reversed: C.danger,
  'Never arrived': C.danger,
  Disputed: C.danger,
};

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
      <AppFrame title="Account" activeTab={null} tone="navy" onBack={back.go} contentStyle={{ padding: 14 }}>
        <Empty head={missing ? 'This account is not on your phone' : 'Opening the account…'} body={missing && problem ? problem : ''} />
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

  const use = creditUse(c.outstandingPaise, c.creditLimitPaise);
  const owes = c.outstandingPaise > 0;

  return (
    <AppFrame
      title="Account"
      activeTab={null}
      tone="navy"
      onBack={back.go}
      showTitle={false}
      contentStyle={{ padding: 14, paddingBottom: 40 }}
      hero={
        <View style={{ marginTop: 16 }}>
          {/* ---- who ---- */}
          <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 10 }}>
            <View style={{ flex: 1, minWidth: 0 }}>
              <T style={[{ fontSize: 24, lineHeight: 30, letterSpacing: -0.4, color: '#FFFFFF' }, weight(800)]}>{shopName(c.name)}</T>
              <T style={{ fontSize: 12, lineHeight: 16, color: C.onNavyMuted, marginTop: 2 }}>
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
              hitSlop={6}
              style={({ pressed }) => ({
                height: 36,
                paddingHorizontal: 12,
                borderRadius: 18,
                backgroundColor: C.navySoft,
                opacity: pressed ? 0.85 : 1,
                flexDirection: 'row',
                alignItems: 'center',
                gap: 6,
              })}>
              <Icon name="doc" size={14} color={C.lime} strokeWidth={2} />
              <T style={[{ fontSize: 13, color: C.lime }, weight(700)]}>Record</T>
            </Pressable>
          </View>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 10 }}>
            <HeroTag text={accountWord(view)} bg={C.navySoft} />
            {c.creditBlocked ? <HeroTag text="Supply stopped" bg={C.danger} /> : null}
            {c.slowPayer ? <HeroTag text="Slow payer" bg={C.warnInk} /> : null}
            {view.followUp && view.followUp.stage > 0 ? (
              <HeroTag
                text={'Follow-up ' + view.followUp.stage}
                a11y={'Follow-up stage ' + view.followUp.stage}
                bg={view.followUp.stage >= 3 ? C.danger : C.warnInk}
              />
            ) : null}
          </View>

          {/* ---- the one number ---- */}
          <View
            accessible
            accessibilityLabel="Outstanding now. The office's figure for the whole account. It counts only money the accounts team has found in the bank."
            style={{ marginTop: 14 }}>
            <T style={{ fontSize: 12, lineHeight: 16, color: C.onNavyMuted }}>Outstanding now · office figure, bank-seen money</T>
          </View>
          <T style={[{ fontSize: 40, lineHeight: 46, letterSpacing: -0.8, color: owes ? '#FF8A80' : '#FFFFFF' }, weight(800), tabular]}>
            {owes ? inrFromPaise(c.outstandingPaise) : 'Nothing owed'}
          </T>
          {use != null ? (
            <>
              <View style={{ height: 8, borderRadius: 4, backgroundColor: C.navySoft, marginTop: 8, overflow: 'hidden' }}>
                <View
                  style={{
                    width: `${Math.min(100, use)}%`,
                    height: 8,
                    backgroundColor: use > 100 ? '#FF8A80' : use >= 80 ? '#FFD27A' : C.lime,
                  }}
                />
              </View>
              <T style={{ fontSize: 12, color: C.onNavyMuted, marginTop: 6 }}>
                {use}% of {inrFromPaise(c.creditLimitPaise ?? 0)} limit
              </T>
            </>
          ) : null}

          {/* ---- whose answer this is ---- */}
          <SourceLine origin={origin} view={view} nowMs={nowMs} loading={loading} onRetry={() => void load()} />
        </View>
      }>
      <View>
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
        gap: 8,
        paddingHorizontal: 12,
        paddingVertical: 8,
        borderRadius: 16,
        backgroundColor: C.navySoft,
      }}>
      <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: live ? C.lime : '#FFD27A' }} />
      <T style={{ flex: 1, fontSize: 12, lineHeight: 16, color: '#DCE3EE' }}>{text}</T>
      {!loading && !live ? (
        <Pressable
          onPress={onRetry}
          accessibilityRole="button"
          hitSlop={8}
          style={({ pressed }) => ({
            height: 32,
            paddingHorizontal: 12,
            borderRadius: 16,
            backgroundColor: C.lime,
            opacity: pressed ? 0.85 : 1,
            justifyContent: 'center',
          })}>
          <T style={[{ fontSize: 12, color: C.navy }, weight(700)]}>Try again</T>
        </Pressable>
      ) : null}
    </View>
  );
}

/** A tag in the navy hero: account type, supply stopped, slow payer, follow-up. */
function HeroTag({ text, bg, a11y }: { text: string; bg: string; a11y?: string }) {
  return (
    <View
      accessible
      accessibilityLabel={a11y ?? text}
      style={{ height: 26, paddingHorizontal: 10, borderRadius: 13, backgroundColor: bg, justifyContent: 'center' }}>
      <T style={[{ fontSize: 12, color: '#FFFFFF' }, weight(700)]}>{text}</T>
    </View>
  );
}

/* =============================================================== summary */

function Summary({ view, onTab }: { view: AccountView; onTab: (i: number) => void }) {
  const c = view.customer;
  const headroom = c.creditLimitPaise != null && c.creditLimitPaise > 0 ? c.creditLimitPaise - c.outstandingPaise : null;
  const openBills = view.bills.filter((b) => billMatches(b, 'open'));
  const overdueBills = view.bills.filter((b) => billMatches(b, 'overdue'));
  const overduePaise = overdueBills.reduce((s, b) => s + b.balancePaise, 0);
  const oldest = overdueBills.reduce((m, b) => Math.max(m, b.overdueDays), 0);
  const lastPaid = view.receipts.find((r) => r.status === 'confirmed');
  const lastBill = view.bills[0];

  return (
    <View style={{ gap: 12 }}>
      {/* ---- the money ----
          The one number and the limit bar are in the hero now; these are the
          rest of it, two to a row as V3 draws them. */}
      <View style={{ gap: 8 }}>
        <View style={{ flexDirection: 'row', gap: 8 }}>
          <Figure
            tile
            label="Credit limit"
            value={c.creditLimitPaise ? inrFromPaise(c.creditLimitPaise) : 'Not set'}
          />
          <Figure
            tile
            label={headroom != null && headroom < 0 ? 'Over limit by' : 'Can still take'}
            value={headroom == null ? '—' : inrFromPaise(Math.abs(headroom))}
            tone={headroom != null && headroom < 0 ? C.danger : undefined}
          />
        </View>
        <View style={{ flexDirection: 'row', gap: 8 }}>
          <Figure
            tile
            label="Credit term"
            value={c.creditDays != null ? c.creditDays + ' d' : '—'}
            sub={c.creditDaysIsDefault ? 'the usual term — none agreed for this shop' : 'agreed for this shop'}
          />
          <Figure
            tile
            label="Overdue"
            value={overduePaise ? inrFromPaise(overduePaise) : 'Nothing'}
            sub={overdueBills.length ? `${plural(overdueBills.length, 'bill')} · oldest ${oldest} d` : null}
            tone={overduePaise ? C.danger : undefined}
          />
        </View>
        <View style={{ flexDirection: 'row', gap: 8 }}>
          <Figure
            tile
            label="On account"
            value={view.ledger.onAccountPaise == null ? 'Needs signal' : view.ledger.onAccountPaise ? inrFromPaise(view.ledger.onAccountPaise) : 'Nothing'}
            sub={view.ledger.onAccountPaise ? 'paid, not set to a bill' : null}
          />
          <Figure
            tile
            label="With accounts"
            value={view.ledger.awaitingCount ? inrFromPaise(view.ledger.awaitingPaise) : 'Nothing'}
            sub={view.ledger.awaitingCount ? `${plural(view.ledger.awaitingCount, 'payment')} unconfirmed` : null}
            tone={view.ledger.awaitingCount ? C.warnInk : undefined}
          />
        </View>
        <View style={{ flexDirection: 'row', gap: 8 }}>
          <Figure tile label="Open bills" value={String(openBills.length)} />
          <Figure
            tile
            label="Not stated"
            value={view.unstated.count ? inrFromPaise(view.unstated.amountPaise) : 'None'}
            sub={view.unstated.count ? `${plural(view.unstated.count, 'bill')}, nobody said paid or owed` : null}
          />
        </View>
      </View>

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
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <Icon name="clock" size={16} color={C.ink} strokeWidth={2} />
          <T style={[{ fontSize: 14, color: C.ink }, weight(700)]}>Age of debt</T>
        </View>
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
      <View style={{ backgroundColor: C.surface, borderRadius: 22, paddingVertical: 6, paddingHorizontal: 16 }}>
        <GlanceRow first icon="doc" label="Last bill" value={lastBill ? `${lastBill.billNo} · ${longDay(lastBill.billDate)}` : 'None'} />
        <GlanceRow
          icon="wallet"
          iconInk={C.success}
          label="Last paid"
          a11y="Last payment confirmed"
          value={lastPaid ? `${inrFromPaise(lastPaid.amountPaise)} · ${longDay(lastPaid.receivedAt)}` : 'None'}
        />
        <GlanceRow icon="order" label="Last order" value={longDay(c.lastOrderDate)} />
        {view.followUp && view.followUp.oldestOverdueBillDate ? (
          <GlanceRow
            icon="cal"
            iconInk={C.danger}
            label="Oldest overdue"
            a11y="Oldest overdue bill"
            value={longDay(view.followUp.oldestOverdueBillDate)}
          />
        ) : null}
        {c.salesPersonName || c.backOfficeName ? (
          <GlanceRow
            icon="person"
            label={[c.salesPersonName ? 'Salesperson' : null, c.backOfficeName ? 'Back office' : null].filter(Boolean).join(' · ')}
            value={[c.salesPersonName, c.backOfficeName].filter(Boolean).join(' · ')}
          />
        ) : null}
        {c.phone ? <GlanceRow icon="call" label="Phone" value={c.phone} /> : null}
      </View>

      <View style={{ flexDirection: 'row', gap: 8 }}>
        <JumpButton label="Statement" onPress={() => onTab(1)} />
        <JumpButton label="Open bills" onPress={() => onTab(2)} />
        <JumpButton label="Payments" onPress={() => onTab(3)} />
      </View>
    </View>
  );
}

function AgingStrip({ buckets, totalPaise }: { buckets: { label: string; from: number; amountPaise: number }[]; totalPaise: number }) {
  /* Not due is calm, the oldest band is loud, the ones between climb. */
  const tones = [C.success, '#D9A400', '#D9822B', C.danger];
  const toneOf = (i: number) => tones[Math.min(i, tones.length - 1)];
  return (
    <View style={{ marginTop: 10 }}>
      <View style={{ flexDirection: 'row', height: 12, borderRadius: 6, overflow: 'hidden', backgroundColor: C.hairline }}>
        {buckets.map((b, i) =>
          b.amountPaise > 0 ? (
            <View key={b.label} style={{ flex: b.amountPaise / totalPaise, backgroundColor: toneOf(i) }} />
          ) : null,
        )}
      </View>
      <View style={{ marginTop: 10, flexDirection: 'row', flexWrap: 'wrap', rowGap: 8 }}>
        {buckets.map((b, i) => (
          <View
            key={b.label}
            accessible
            accessibilityLabel={b.label + ' ' + (b.amountPaise ? inrFromPaise(b.amountPaise) : 'nothing')}
            style={{ width: '50%', paddingRight: i % 2 === 0 ? 14 : 0, flexDirection: 'row', alignItems: 'center', gap: 6 }}>
            <View style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: toneOf(i) }} />
            <T style={{ flex: 1, fontSize: 13, color: C.body }} numberOfLines={1}>
              {b.label}
            </T>
            <T style={[{ fontSize: 13, color: b.amountPaise ? C.ink : C.faint }, weight(700), tabular]}>
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
    <View style={{ borderRadius: 20, backgroundColor: palette.bg, padding: 14, flexDirection: 'row', gap: 10 }}>
      <Icon name={tone === 'danger' ? 'lock' : tone === 'warn' ? 'clock' : 'route'} size={20} color={palette.fg} strokeWidth={2} />
      <View style={{ flex: 1, minWidth: 0 }}>
        <T style={[{ fontSize: 14, lineHeight: 20, color: palette.fg }, weight(700)]}>{head}</T>
        <T style={{ fontSize: 13, lineHeight: 18, color: palette.fg, marginTop: 1 }}>{children}</T>
      </View>
    </View>
  );
}

function JumpButton({ label, onPress }: { label: string; onPress: () => void }) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      style={({ pressed }) => ({ flex: 1, height: 52, borderRadius: 26, backgroundColor: pressed ? C.primaryTint : C.surface, alignItems: 'center', justifyContent: 'center' })}>
      <T style={[{ fontSize: 14, color: C.primaryDeep }, weight(700)]}>{label}</T>
    </Pressable>
  );
}

/** One "at a glance" line: a glyph, what it is, and the answer. */
function GlanceRow({
  icon,
  iconInk = C.muted,
  label,
  value,
  a11y,
  first = false,
}: {
  icon: IconName;
  iconInk?: string;
  label: string;
  value: string;
  a11y?: string;
  first?: boolean;
}) {
  return (
    <View
      accessible
      accessibilityLabel={(a11y ?? label) + ': ' + value}
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: 10,
        minHeight: 44,
        paddingVertical: 6,
        borderTopWidth: first ? 0 : 1,
        borderTopColor: C.hairline,
      }}>
      <Icon name={icon} size={16} color={iconInk} strokeWidth={2} />
      <T style={{ fontSize: 14, color: C.muted, flexShrink: 0 }}>{label}</T>
      <T numberOfLines={2} style={[{ flex: 1, fontSize: 14, color: C.ink, textAlign: 'right' }, weight(700)]}>
        {value}
      </T>
    </View>
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

      {/* Before + billed − received = owed at the end, as one sum. */}
      <View
        accessible
        accessibilityLabel={
          'Owed before these dates ' +
          (range.from ? inrFromPaise(w.openingPaise) : 'not shown') +
          ', billed ' +
          inrFromPaise(w.billedPaise) +
          ', received ' +
          inrFromPaise(w.receivedPaise) +
          ', owed at the end ' +
          (w.entries.length ? signed(w.entries[0].balancePaise) : range.from ? signed(w.openingPaise) : 'not shown') +
          '. Newest first. The balance after each line counts only confirmed money, so the top one is what was owed at that point.'
        }
        style={{ backgroundColor: C.navy, borderRadius: 22, padding: 16, flexDirection: 'row', alignItems: 'center', gap: 6 }}>
        <SumCell label="Before" value={range.from ? inrFromPaise(w.openingPaise) : '—'} />
        <T style={{ fontSize: 12, color: C.onNavyMuted }}>+</T>
        <SumCell label="Billed" value={inrFromPaise(w.billedPaise)} />
        <T style={{ fontSize: 12, color: C.onNavyMuted }}>−</T>
        <SumCell label="Received" value={inrFromPaise(w.receivedPaise)} tone={C.lime} />
        <T style={{ fontSize: 12, color: C.onNavyMuted }}>=</T>
        <SumCell
          label="At end"
          value={w.entries.length ? signed(w.entries[0].balancePaise) : range.from ? signed(w.openingPaise) : '—'}
          tone="#FF8A80"
        />
      </View>

      {w.entries.length === 0 ? (
        <Empty
          head="Nothing in these dates"
          body={view.ledger.entries.length ? 'No bill or payment falls in these dates. Pick a longer time.' : 'This account has never been billed.'}
        />
      ) : (
        <View style={{ backgroundColor: C.surface, borderRadius: 22, overflow: 'hidden' }}>
          {w.entries.slice(0, shown).map((e, i) => (
            <Stagger key={`${e.kind}-${e.ref}-${e.at}-${i}`} index={i}>
              <EntryRow e={e} first={i === 0} />
            </Stagger>
          ))}
          {range.from && shown >= w.entries.length ? (
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', paddingHorizontal: 16, paddingVertical: 12, backgroundColor: C.canvas }}>
              <T style={[{ fontSize: 13, color: C.body }, weight(700)]}>Opening · {longDay(range.from)}</T>
              <T style={[{ fontSize: 13, color: C.body }, weight(700), tabular]}>{signed(w.openingPaise)}</T>
            </View>
          ) : null}
        </View>
      )}
      <More shown={shown} total={w.entries.length} onMore={() => setShown(shown + STEP)} />
    </View>
  );
}

function EntryRow({ e, first }: { e: AccountEntry; first: boolean }) {
  const st = e.kind === 'receipt' ? receiptStatus(e.status) : null;
  const dead = e.status === 'rejected' || e.status === 'reversed';
  const amountInk = e.kind === 'bill' ? C.ink : dead ? C.faint : st?.counts ? C.success : C.warnInk;
  return (
    <View style={{ flexDirection: 'row', gap: 10, paddingHorizontal: 16, paddingVertical: 12, borderTopWidth: first ? 0 : 1, borderTopColor: C.hairline }}>
      <View
        style={{
          width: 32,
          height: 32,
          borderRadius: 16,
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: e.kind === 'bill' ? C.infoBg : dead ? C.dangerBg : st?.counts ? C.successBg : C.warnBg,
        }}>
        <Icon
          name={e.kind === 'bill' ? 'doc' : 'wallet'}
          size={15}
          color={e.kind === 'bill' ? C.info : dead ? C.danger : st?.counts ? C.success : C.warnInk}
          strokeWidth={2}
        />
      </View>
      <View style={{ flex: 1, minWidth: 0 }}>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 8 }}>
          <T style={[{ fontSize: 14, lineHeight: 20, color: dead ? C.muted : C.ink, flexShrink: 1 }, weight(700)]} numberOfLines={1}>
            {e.kind === 'bill' ? e.ref : e.ref === '—' ? 'Payment' : e.ref}
          </T>
          <T
            style={[
              { fontSize: 14, lineHeight: 20, color: amountInk, textDecorationLine: dead ? 'line-through' : 'none' },
              weight(700),
              tabular,
            ]}>
            {e.kind === 'bill' ? '+' + inrFromPaise(e.debitPaise) : '−' + inrFromPaise(e.creditPaise || 0)}
          </T>
        </View>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 6, marginTop: 2 }}>
          <T style={{ fontSize: 12, lineHeight: 16, color: C.muted, flexShrink: 1 }} numberOfLines={2}>
            {longDay(e.at)} · {e.detail}
          </T>
          {st && st.label !== 'Confirmed' ? <Badge tone={st.tone}>{st.label}</Badge> : null}
          {e.kind === 'bill' && e.claimedPaise > 0 ? (
            <Badge tone="amber">{inrFromPaise(e.claimedPaise) + ' claimed, on hold'}</Badge>
          ) : null}
          <View style={{ flex: 1 }} />
          <T style={[{ fontSize: 12, color: C.muted }, tabular]}>= {signed(e.balancePaise)}</T>
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
  );
}

/** One term of the statement's sum on the navy card. */
function SumCell({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <View style={{ flex: 1, minWidth: 0 }}>
      <T style={{ fontSize: 12, color: C.onNavyMuted }} numberOfLines={1}>
        {label}
      </T>
      <T style={[{ fontSize: 15, color: tone ?? '#FFFFFF' }, weight(800), tabular]} numberOfLines={1}>
        {value}
      </T>
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
    (b) => billMatches(b, filter) && matchesText([b.billNo, b.billDate, typedFromPaise(b.amountPaise), ...b.lines.map((l) => l.product)], q),
  );
  const balance = list.filter((b) => b.paymentPosition !== 'unstated').reduce((s, b) => s + Math.max(0, b.balancePaise), 0);
  const billed = list.reduce((s, b) => s + b.amountPaise, 0);

  return (
    <View style={{ gap: 12 }}>
      <Search value={q} onChange={setQ} placeholder="Bill no., product or amount" />
      <ChipRow>
        {BILL_FILTERS.map((f) => (
          <Chip
            key={f.key}
            label={f.label}
            ink={FILTER_INK[f.label]}
            count={view.bills.filter((b) => billMatches(b, f.key)).length}
            on={filter === f.key}
            onPress={() => {
              setFilter(f.key);
              setShown(STEP);
            }}
          />
        ))}
      </ChipRow>
      <View style={{ flexDirection: 'row', gap: 8 }}>
        <Figure tile label={plural(list.length, 'bill') + ' billed'} value={inrFromPaise(billed)} />
        <Figure tile label="Still open · stated only" value={inrFromPaise(balance)} tone={balance ? C.danger : undefined} />
      </View>

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
        style={({ pressed }) => [{ paddingVertical: 14, paddingHorizontal: 16 }, pressed && { backgroundColor: C.wash }]}>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', gap: 10 }}>
          <View style={{ flex: 1, minWidth: 0 }}>
            <T style={[{ fontSize: 15, lineHeight: 21, color: C.ink }, weight(700)]} numberOfLines={1}>
              {b.billNo}
            </T>
            <T s="caption">
              {longDay(b.billDate)}
              {b.dueDate ? ' · due ' + longDay(b.dueDate) : ''}
            </T>
          </View>
          <View style={{ alignItems: 'flex-end' }}>
            <T style={[{ fontSize: 16, lineHeight: 21, color: C.ink }, weight(800), tabular]}>{inrFromPaise(b.amountPaise)}</T>
            <T style={[{ fontSize: 12, lineHeight: 16 }, weight(700), tabular, { color: unstated ? C.muted : b.balancePaise > 0 ? C.danger : C.success }]}>
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
          <T style={{ fontSize: 12, color: C.faint }}>{b.lines.length ? plural(b.lines.length, 'item') : ''}</T>
          <T style={{ fontSize: 12, color: C.faint }}>{open ? '▴' : '▾'}</T>
        </View>
      </Pressable>

      {open ? (
        <View style={{ paddingHorizontal: 16, paddingBottom: 14, borderTopWidth: 1, borderTopColor: C.hairline, paddingTop: 10, gap: 10 }}>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
            <MiniTile label="Billed" value={inrFromPaise(b.amountPaise)} />
            <MiniTile label="Paid ✓" a11y="Paid, confirmed" value={inrFromPaise(b.paidPaise)} tone={b.paidPaise ? C.success : undefined} />
            <MiniTile
              label="Balance"
              value={unstated ? 'Not stated' : inrFromPaise(Math.max(0, b.balancePaise))}
              tone={!unstated && b.balancePaise > 0 ? C.danger : undefined}
            />
            {b.overdueDays > 0 && !unstated ? (
              <MiniTile label="Overdue" a11y="Overdue by" value={b.overdueDays + ' d'} tone={C.danger} />
            ) : null}
            {b.claimedPaise > 0 ? (
              <MiniTile label="Claimed" a11y="Claimed, not yet confirmed" value={inrFromPaise(b.claimedPaise)} tone={C.warnInk} />
            ) : null}
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
    (r) => receiptMatches(r, filter) && matchesText([r.reference, r.receiptNo, r.mode, r.receivedAt, typedFromPaise(r.amountPaise)], q),
  );
  const confirmed = list.filter((r) => r.status === 'confirmed').reduce((s, r) => s + r.amountPaise, 0);

  return (
    <View style={{ gap: 12 }}>
      <Search value={q} onChange={setQ} placeholder="Reference, receipt no. or amount" />
      <ChipRow>
        {RECEIPT_FILTERS.map((f) => (
          <Chip
            key={f.key}
            label={f.label}
            ink={FILTER_INK[f.label]}
            count={view.receipts.filter((r) => receiptMatches(r, f.key)).length}
            on={filter === f.key}
            onPress={() => {
              setFilter(f.key);
              setShown(STEP);
            }}
          />
        ))}
      </ChipRow>
      <View style={{ flexDirection: 'row', gap: 8 }}>
        <Figure tile label={plural(list.length, 'payment') + ' · confirmed'} value={inrFromPaise(confirmed)} tone={confirmed ? C.success : undefined} />
        <Figure
          tile
          label="With accounts"
          value={inrFromPaise(list.filter((r) => r.status === 'reported' || r.status === 'held').reduce((s, r) => s + r.amountPaise, 0))}
          sub="not yet counted"
          tone={C.warnInk}
        />
      </View>

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
        style={({ pressed }) => [{ paddingVertical: 14, paddingHorizontal: 16 }, pressed && { backgroundColor: C.wash }]}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
          <View
            style={{
              width: 32,
              height: 32,
              borderRadius: 16,
              alignItems: 'center',
              justifyContent: 'center',
              backgroundColor: dead ? C.dangerBg : st.counts ? C.successBg : C.warnBg,
            }}>
            <Icon name="wallet" size={15} color={dead ? C.danger : st.counts ? C.success : C.warnInk} strokeWidth={2} />
          </View>
          <View style={{ flex: 1, minWidth: 0 }}>
            <T
              style={[{ fontSize: 17, lineHeight: 22, color: dead ? C.muted : C.ink, textDecorationLine: dead ? 'line-through' : 'none' }, weight(800), tabular]}>
              {inrFromPaise(r.amountPaise)}
            </T>
            <T s="caption" numberOfLines={1}>
              {longDay(r.receivedAt)} · {r.mode === 'Not stated' ? 'method not recorded' : r.mode}
              {r.reference ? ' · ' + r.reference : ''}
              {r.receiptNo ? ' · Receipt ' + r.receiptNo : ''}
            </T>
          </View>
          <Badge tone={st.tone}>{st.label}</Badge>
        </View>
      </Pressable>

      {open ? (
        <View style={{ paddingHorizontal: 16, paddingBottom: 14, borderTopWidth: 1, borderTopColor: C.hairline, paddingTop: 10, gap: 10 }}>
          <T s="small">{r.sentence}</T>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
            <MiniTile half label="Received" value={longDay(r.receivedAt)} />
            {r.instrumentDate ? <MiniTile half label="Cheque date" a11y="Date on the cheque" value={longDay(r.instrumentDate)} /> : null}
            {r.reportedBy ? <MiniTile half label="Written by" a11y="Written down by" value={r.reportedBy} /> : null}
            {r.confirmedBy ? (
              <MiniTile half label="Confirmed by" value={r.confirmedBy + (r.confirmedAt ? ' · ' + longDay(r.confirmedAt) : '')} />
            ) : null}
            {r.onAccountPaise > 0 ? <MiniTile full label="On account" value={inrFromPaise(r.onAccountPaise)} /> : null}
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
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
              <Icon name="doc" size={20} color={C.primaryDeep} strokeWidth={2} />
              <T style={[{ fontSize: 17, color: C.ink, flex: 1 }, weight(800), tabular]}>
                {n.amountPaise != null ? inrFromPaise(n.amountPaise) : 'Amount not set yet'}
              </T>
              <Badge tone={st.tone}>{st.label}</Badge>
            </View>
            <T s="caption">
              Asked {longDay(n.at)}
              {n.raisedBy ? ' · ' + n.raisedBy : ''}
              {n.billNo ? ' · bill ' + n.billNo : ' · no bill named'}
            </T>
            <T s="small">{n.description}</T>
            {n.reference || n.cnDate ? (
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', columnGap: 14, rowGap: 2 }}>
                {n.reference ? (
                  <T style={{ fontSize: 12, color: C.muted }}>
                    {'CN '}
                    <T style={[{ fontSize: 12, color: C.ink }, weight(700)]}>{n.reference}</T>
                  </T>
                ) : null}
                {n.cnDate ? (
                  <T style={{ fontSize: 12, color: C.muted }}>
                    {'Dated '}
                    <T style={[{ fontSize: 12, color: C.ink }, weight(700)]}>{longDay(n.cnDate)}</T>
                  </T>
                ) : null}
              </View>
            ) : null}
          </Card>
        );
      })}
    </View>
  );
}

/* ================================================================ shared */

/** A small wash tile inside an opened card: Paid ✓ / Overdue / Received / Written by… */
function MiniTile({
  label,
  value,
  tone,
  a11y,
  half = false,
  full = false,
}: {
  label: string;
  value: string;
  tone?: string;
  a11y?: string;
  half?: boolean;
  full?: boolean;
}) {
  return (
    <View
      accessible
      accessibilityLabel={(a11y ?? label) + ': ' + value}
      style={{
        width: full ? '100%' : half ? '48.9%' : '32.2%',
        backgroundColor: C.canvas,
        borderRadius: 12,
        padding: 8,
      }}>
      <T style={{ fontSize: 11, lineHeight: 14, color: C.muted }} numberOfLines={1}>
        {label}
      </T>
      <T style={[{ fontSize: 14, lineHeight: 19, color: tone ?? C.ink }, weight(800), tabular]} numberOfLines={1}>
        {value}
      </T>
    </View>
  );
}

function signed(paise: number): string {
  if (paise < 0) return inrFromPaise(-paise) + ' in credit';
  return inrFromPaise(paise);
}

function Empty({ head, body }: { head: string; body: string }) {
  return (
    <View style={{ backgroundColor: C.surface, borderRadius: 24, paddingVertical: 24, paddingHorizontal: 18 }}>
      <T style={[{ fontSize: 17, lineHeight: 22, color: C.ink, textAlign: 'center' }, weight(800)]}>{head}</T>
      {body ? (
        <T style={{ fontSize: 13, lineHeight: 18, color: C.muted, textAlign: 'center', marginTop: 6 }}>{body}</T>
      ) : null}
    </View>
  );
}

function More({ shown, total, onMore }: { shown: number; total: number; onMore: () => void }) {
  if (shown >= total) return null;
  return (
    <Pressable
      onPress={onMore}
      accessibilityRole="button"
      style={({ pressed }) => ({ height: 52, borderRadius: 26, backgroundColor: pressed ? C.primaryTint : C.surface, alignItems: 'center', justifyContent: 'center' })}>
      <T style={[{ fontSize: 14, color: C.primaryDeep }, weight(700)]}>Show more · {total - shown} left</T>
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
        paddingHorizontal: 16,
        borderRadius: 24,
        backgroundColor: C.surface,
      }}>
      <Icon name="search" size={18} color={C.muted} strokeWidth={2} />
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
        <Pressable
          onPress={() => onChange('')}
          accessibilityRole="button"
          accessibilityLabel="Clear"
          hitSlop={10}
          style={{ width: 28, height: 28, borderRadius: 14, backgroundColor: C.canvas, alignItems: 'center', justifyContent: 'center' }}>
          <Icon name="close" size={12} color={C.ink} strokeWidth={2.4} />
        </Pressable>
      ) : null}
    </View>
  );
}
