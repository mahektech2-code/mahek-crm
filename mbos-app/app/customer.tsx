import React from 'react';
import { View, Text, Pressable, ScrollView, TextInput } from 'react-native';
import { router, useFocusEffect } from 'expo-router';
import { BADGE, color as C, weight, tabular, type BadgeTone } from '../src/theme/tokens';
import { Icon, type IconName } from '../src/components/ui/Icon';
import { DashedAdd, Pill, PillButton } from '../src/components/ui/v3';
import { HERO } from '../src/components/shell/Chrome';
import { Badge, HealthPill } from '../src/components/ui/primitives';
import { BottomSheet } from '../src/components/ui/overlays';
import { getFix } from '../src/native/location';
import { SkuChip } from '../src/components/ui/sku';
import { AppFrame } from '../src/components/shell/AppFrame';
import { useCustomer, useStore } from '../src/state/store';
import { getLead, type Lead } from '../src/data/leads';
import { stageOf } from '../src/data/lead-funnel';
import { stageLabel } from '../src/engines/funnel';
import { complaintsFor, customerSamples, type Complaint, type Sample } from '../src/data/requests';
import { writeInternalNote } from '../src/data/internal-notes';
import {
  billLines,
  competitorRecords,
  customerBills,
  customerOrders,
  customerPayments,
  customerTimeline,
  editShop,
  OUTSTANDING_ALERT_PAISE,
  recordCompetitor,
  statementReach,
  type CustomerBill,
  type CustomerOrder,
  type CustomerPayment,
  type TimelineEvent,
} from '../src/data/customers';
import { accountType, FILED_LEAD_WORD, isFiledLead, isLiveLead } from '../src/lib/account-label';
import {
  buildStatement,
  countsAsMoney,
  periodRange,
  PERIODS,
  type PeriodKey,
} from '../src/engines/statement';
import { TIMELINE_PAGE } from '../src/data/customer-query';
import { getConfig } from '../src/data/config';
import { inr, inrFromPaise, isoDate, pretty, shopName } from '../src/lib/format';
import { callNumber, openWhatsApp } from '../src/lib/messaging';
import { cleanAmount, paiseFromTyped } from '../src/lib/money-input';
import { Appear, DUR, Stagger, animateLayoutFor } from '../src/components/ui/motion';
import { feedback } from '../src/components/ui/feedback';
import { shopRefusalLine } from '../src/data/shop-refusal';

/**
 * The customer record.
 *
 * The timeline is the important tab and it is deliberately read-only: every
 * entry was written by the screen that caused it, so there is nothing to add
 * here. The Telecaller rows come from the CRM on the same stream, which is the
 * whole reason a salesman walking in knows what the desk team was told.
 *
 * The outstanding block carries the age of the figure. It is a cache of what
 * MahekOne holds, and a credit limit read four hours ago is a different thing
 * to bet an order on than one read a minute ago — the salesman is entitled to
 * know which he has.
 */

/*
 * "Payments" IS "Account" NOW, in the same position, which is why nothing had
 * to be done about `pTab` — it is an index in the store and a salesman who
 * left the record on that tab comes back to the tab that replaced it.
 *
 * The old one listed receipts alone, and a list of payments with no bills
 * beside them cannot answer the question it is opened for. A shopkeeper with
 * his own file open asks what was billed in July and what he has paid against
 * it, in one breath; two tabs made the salesman hold one half in his head
 * while he read the other. It is the same shape the Accounts app has for the
 * same reason — a customer account, not a payments list.
 */
const TABS = ['Overview', 'Timeline', 'Orders', 'Account', 'Samples', 'Complaints', 'Other brands'];
const TL_FILTERS = ['All', 'Visits', 'Orders', 'Payments', 'Calls', 'Complaints'];

/** The stream's own event types, in the words the design puts on the badge. */
/*
 * EVERY KIND THE OFFICE WRITES, and a neutral word for one it adds later.
 *
 * This named eight, and the fallback was "Visit" — so a lead created, a
 * sample dispatched, a validation call, an internal note and a change of
 * owner all wore a teal Visit badge, and a shop's history read as a salesman
 * who had been there twenty times. The vocabulary is `CRM_EVENT` and
 * `MBOS_EVENT` in MahekOne's `lib/timeline.ts`; anything not listed reads as
 * an update rather than as a visit nobody made.
 */
const KIND_LABEL: Record<string, string> = {
  visit: 'Visit',
  gps: 'Visit',
  order: 'Order',
  payment: 'Payment',
  payment_bounced: 'Payment',
  complaint: 'Complaint',
  whatsapp: 'WhatsApp',
  call: 'Telecaller',
  telecaller_call: 'Telecaller',
  hrms_call: 'Call',
  hrms_call_planned: 'Call',
  validation_call: 'Call',
  sample: 'Sample',
  sample_dispatched: 'Sample',
  sample_received: 'Sample',
  sample_review: 'Sample',
  lead_created: 'Lead',
  lead_assigned: 'Lead',
  lead_converted: 'Lead',
  lead_stage: 'Lead',
  requirement: 'Lead',
  negotiation: 'Lead',
  sales_opportunity: 'Lead',
  competitor: 'Other brand',
  delivery: 'Delivery',
  owner_change: 'Change',
  relationship_handover: 'Change',
  internal_note: 'Note',
};
const KIND_FALLBACK = 'Update';

/** The disc each kind of entry wears on the timeline. */
const KIND_ICON: Partial<Record<string, IconName>> = {
  Visit: 'shop',
  Order: 'order',
  Payment: 'wallet',
  Complaint: 'warn',
  WhatsApp: 'chat',
  Telecaller: 'call',
  Call: 'call',
  Sample: 'sample',
  Lead: 'person',
  Delivery: 'route',
  'Other brand': 'shield',
  Change: 'people',
  Note: 'note',
};

/* V3's Visit is a teal of its own rather than the primary tint `teal` badges wear. */
function kindLook(kind: string): { bg: string; fg: string } {
  const tone = TONES[kind] ?? 'neutral';
  if (tone === 'teal') return { bg: '#E3F4F4', fg: '#0E6E6E' };
  return BADGE[tone];
}

const TAB_ICON: Partial<Record<string, IconName>> = {
  Timeline: 'clock',
  Orders: 'order',
  Account: 'wallet',
  Samples: 'sample',
};

/** An order's status word as a badge colour. */
function orderTone(status: string): BadgeTone {
  const s = status.toLowerCase();
  if (s.includes('cancel') || s.includes('declin') || s.includes('reject')) return 'danger';
  if (s.includes('deliver') || s.includes('approved') || s.includes('accepted')) return 'success';
  if (s.includes('dispatch') || s.includes('transit')) return 'info';
  return 'amber';
}

const TONES: Record<string, BadgeTone> = {
  Visit: 'teal',
  Order: 'info',
  Payment: 'success',
  Complaint: 'danger',
  WhatsApp: 'success',
  Telecaller: 'amber',
  Call: 'amber',
  Sample: 'info',
  Lead: 'teal',
  Delivery: 'info',
};

/**
 * "a minute ago", "4 hours ago" — how old the cached figures are.
 *
 * THE CLOCK IS PASSED IN rather than read here, which is the repo's rule and,
 * on this particular line, the whole point of it. This read `Date.now()` in the
 * render body of a screen that re-renders only when something else changes, so
 * "From the office 4 min ago" stayed "4 min ago" for as long as he sat on the
 * screen — the one line on which he decides whether to trust the credit limit
 * and the outstanding above it was the line lying about its own age.
 */
function freshness(at: number, nowMs: number): string {
  if (!at) return 'not sent yet';
  const mins = Math.max(0, Math.round((nowMs - at) / 60_000));
  if (mins < 1) return 'just now';
  if (mins < 60) return mins + ' min ago';
  const hours = Math.round(mins / 60);
  if (hours < 24) return hours === 1 ? 'an hour ago' : hours + ' hours ago';
  const days = Math.round(hours / 24);
  return days === 1 ? 'yesterday' : days + ' days ago';
}

export default function CustomerRecord() {
  const c = useCustomer();
  /*
   * IS THIS SHOP ALSO A LEAD, and where is it standing?
   *
   * Asked of the `leads` table rather than read off `c.kind`, which is the
   * rule `customer-query.ts` states: the office keeps one `customers` row for
   * both and the lead arrives down its own channel keyed on the same id.
   *
   * `getCustomer` selects from `customers` alone, so the row in the store
   * cannot answer this — hence a second read rather than another column.
   */
  const [lead, setLead] = React.useState<Lead | null>(null);
  /* Whether the phone holds ANY lead row for this shop, live or not. */
  const [leadRowHeld, setLeadRowHeld] = React.useState(false);
  /* A lead filed away on this phone — `isFiledLead`, the list's own rule. */
  const [filedLead, setFiledLead] = React.useState(false);
  const pTab = useStore((s) => s.pTab);
  const tlFilter = useStore((s) => s.tlFilter);
  const set = useStore((s) => s.set);
  const notify = useStore((s) => s.notify);
  const askTravel = useStore((s) => s.askTravel);

  const [events, setEvents] = React.useState<TimelineEvent[]>([]);
  const [orders, setOrders] = React.useState<CustomerOrder[]>([]);
  const [receipts, setReceipts] = React.useState<CustomerPayment[]>([]);
  const [bills, setBills] = React.useState<CustomerBill[]>([]);
  /* The oldest day this handset actually holds something for — see
     `statementReach`. Not the window the office sent: what is HERE. */
  const [reach, setReach] = React.useState<string | null>(null);
  const [period, setPeriod] = React.useState<PeriodKey>('three_months');
  /* Which bill is open to show what was on it. One at a time: a list of
     twenty bills each unfolded into four lines is a screen nobody scrolls. */
  const [openBillId, setOpenBillId] = React.useState<string | null>(null);
  /* Whether a tab has been switched HERE. The record opening on a tab is the
     route arriving, which already moved; only a switch fades the body. */
  const [tabMoved, setTabMoved] = React.useState(false);
  const [samples, setSamples] = React.useState<Sample[]>([]);
  const [gripes, setGripes] = React.useState<Complaint[]>([]);
  const [note, setNote] = React.useState('');
  const [noteBusy, setNoteBusy] = React.useState(false);
  const [competitors, setCompetitors] = React.useState<Awaited<ReturnType<typeof competitorRecords>>>([]);
  const [compForm, setCompForm] = React.useState(false);
  const [comp, setComp] = React.useState({ name: '', rate: '', note: '', credit: '', delivery: '', strengths: '', weaknesses: '' });
  const [compBusy, setCompBusy] = React.useState(false);
  /* The shop correction sheet, and what it saved — drawn over the record at
     once, since the record itself is re-read only when the screen is next
     opened. */
  const [editing, setEditing] = React.useState(false);
  const [fixed, setFixed] = React.useState<{ contactPerson?: string; phone?: string; pinned?: boolean } | null>(null);
  /*
   * WHETHER THE SIX READS HAVE ANSWERED YET.
   *
   * Every list above starts empty and the six queries are awaited together, so
   * each tab drew its terminal verdict over a query still in flight — Orders
   * and Payments both instructing him to "sign out and in once", which is the
   * one action that is genuinely risky with a full outbox, about a shop whose
   * orders were a moment from appearing. Nothing terminal is claimed until
   * `loaded`, and a read that fails says so rather than leaving a placeholder
   * that never resolves.
   */
  const [loaded, setLoaded] = React.useState(false);
  const [failed, setFailed] = React.useState(false);
  /*
   * THE CLOCK, READ OUTSIDE RENDER and refreshed while the screen is open —
   * see `freshness`. A minute is the resolution the sentence is written in, so
   * it is the interval: anything finer is work nobody can read the result of.
   */
  const [nowMs, setNowMs] = React.useState(() => Date.now());

  const id = c?.id ?? null;

  /* ONE READ, and both callers go through it. There were two copies of this
     `Promise.all`, and only one of them checked `live` — on two of the six
     setters. */
  const read = React.useCallback(() => {
    if (!id) return null;
    return Promise.all([
      customerTimeline(id, tlFilter),
      competitorRecords(id),
      customerOrders(id),
      customerPayments(id),
      customerSamples(id),
      complaintsFor(id),
      customerBills(id),
      statementReach(id),
    ]);
  }, [id, tlFilter]);

  const apply = React.useCallback(
    ([t, k, o, r, sm, g, b, from]: Awaited<NonNullable<ReturnType<typeof read>>>) => {
      setOrders(o);
      setReceipts(r);
      setBills(b);
      setReach(from);
      setSamples(sm);
      setGripes(g);
      setEvents(t);
      setCompetitors(k);
      setFailed(false);
      setLoaded(true);
    },
    [],
  );

  const reload = React.useCallback(() => {
    void read()?.then(apply);
  }, [read, apply]);

  useFocusEffect(
    React.useCallback(() => {
      let live = true;
      void read()
        ?.then((r) => {
          if (live) apply(r);
        })
        .catch(() => {
          if (!live) return;
          setFailed(true);
          setLoaded(true);
        });
      return () => {
        live = false;
      };
    }, [read, apply]),
  );

  /* Coming back to the screen is the moment the figure above is most likely to
     be wrong, so the clock is re-read on focus as well as on the tick. */
  useFocusEffect(
    React.useCallback(() => {
      setNowMs(Date.now());
      const t = setInterval(() => setNowMs(Date.now()), 60_000);
      return () => clearInterval(t);
    }, []),
  );

  /* The two health thresholds, from configuration — the same two keys the
     book's list reads. The pill's own defaults are 70/40, so taking them here
     gave one shop two colours one tap apart on a team that had set its own. */
  const [healthWatch, setHealthWatch] = React.useState(40);
  const [healthStrong, setHealthStrong] = React.useState(70);
  React.useEffect(() => {
    let live = true;
    void Promise.all([
      getConfig<number>('mbos.health.atRiskBelow', 40),
      getConfig<number>('mbos.health.strongAtOrAbove', 70),
    ]).then(([w, st]) => {
      if (!live) return;
      setHealthWatch(w);
      setHealthStrong(st);
    });
    return () => {
      live = false;
    };
  }, []);

  const saveCompetitor = async () => {
    if (!id) return;
    if (!comp.name.trim()) return notify('Write the brand name first.', 'error');
    setCompBusy(true);
    const ratePaise = paiseFromTyped(comp.rate);
    try {
      await recordCompetitor({
        customerId: id,
        competitorName: comp.name.trim(),
        ratePaise: ratePaise > 0 ? ratePaise : null,
        rateNote: comp.note.trim() || null,
        creditTerms: comp.credit.trim() || null,
        delivery: comp.delivery.trim() || null,
        strengths: comp.strengths.trim() || null,
        weaknesses: comp.weaknesses.trim() || null,
      });
    } catch (e) {
      /* A failed save used to leave the button saying "Saving…" for good. */
      setCompBusy(false);
      return notify(e instanceof Error && e.message ? e.message : 'Could not save. Try again.', 'error');
    }
    setCompBusy(false);
    setComp({ name: '', rate: '', note: '', credit: '', delivery: '', strengths: '', weaknesses: '' });
    setCompForm(false);
    notify('Saved · ' + comp.name.trim());
    reload();
  };

  React.useEffect(() => {
    let live = true;
    if (!c?.id) return;
    /* Still a lead by the ONE rule the list's chips use — `isLiveLead`, the
       JavaScript twin of `leadCustomerClause` — so the record cannot call a
       shop a lead that the list filed under Customers, or the other way. */
    const facts = { kind: c.kind ?? null, thirdParty: c.thirdParty };
    void getLead(c.id).then((row) => {
      if (!live) return;
      setLeadRowHeld(!!row);
      setLead(row && isLiveLead(facts, row) ? row : null);
      setFiledLead(isFiledLead(facts, row ?? null));
    });
    return () => {
      live = false;
    };
  }, [c?.id, c?.kind, c?.thirdParty]);

  /* A record that has not arrived on this handset yet is said plainly rather
     than rendered as somebody else's figures under a blank name. */
  if (!c) {
    return (
      <AppFrame title="Customer" activeTab="customers" onBack={() => router.back()} contentStyle={{ padding: 16 }}>
        <Empty head="Not on this phone yet" body="This customer will come with the next update from the office." />
      </AppFrame>
    );
  }

  const dues = c.outstandingPaise / 100;
  const refusedLine = shopRefusalLine(c);
  const owner = c.contactPerson ?? c.name;

  /* WHAT KIND OF ACCOUNT THIS IS, from the shared pure rule rather than from
     `c.kind` — the office keeps one row for a lead and a customer, and the
     lead arrives down its own channel. See `lib/account-label.ts`. */
  const accountKind = accountType({
    ...c,
    /* A live lead row, or — where the phone holds no lead row at all — the
       office's own `kind = 'lead'`, exactly as the list reads it. */
    isLead: lead || (!leadRowHeld && isLiveLead({ kind: c.kind ?? null, thirdParty: c.thirdParty }, null)) ? 1 : 0,
    isFiledLead: filedLead ? 1 : 0,
  });

  /* The statement for the window on screen. Derived rather than held in state:
     it is a pure function of three things already here, and a copy in state is
     a copy that can be stale by exactly one render — on a screen showing money
     to a customer. */
  const window = periodRange(period, isoDate(new Date(nowMs)));
  const statement = buildStatement(bills, receipts, window, c.outstandingPaise);
  const billsInWindow = statement.entries.filter((e) => e.kind === 'bill').length;

  /*
   * THREE REASONS A TAB IS BLANK, and only the last is the one those sentences
   * were written about. Still reading, could not read, and genuinely nothing
   * here are different facts, and the terminal one tells him to sign out and in
   * — which is the one action that is genuinely risky with a full outbox. So it
   * is not said until the read has actually answered.
   */
  const nothingYet = (head: string, body: string) => {
    if (!loaded) {
      return <Empty head="Loading…" body="Getting this shop's history." />;
    }
    if (failed) {
      return (
        <Empty
          head="Could not load it"
          body="Nothing is lost. Go back and open it again. If this keeps happening, tell the office."
        />
      );
    }
    return <Empty head={head} body={body} />;
  };

  const heroInk = HERO.lavender.ink;
  const heroMuted = HERO.lavender.muted;
  const outstandingRed = c.outstandingPaise > OUTSTANDING_ALERT_PAISE;

  return (
    <AppFrame
      title={shopName(c.name)}
      activeTab="customers"
      onBack={() => router.back()}
      showTitle={false}
      contentStyle={{ paddingBottom: 24 }}
      hero={
        /* ---- the head ---- */
        <View style={{ marginTop: 16 }}>
          <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 10 }}>
            <Text
              accessibilityRole="header"
              style={[{ flex: 1, minWidth: 0, fontSize: 26, lineHeight: 34, letterSpacing: -0.5, color: heroInk }, weight(800)]}>
              {shopName(c.name)}
            </Text>
            {c.healthScore != null || c.healthBand ? (
              <View style={{ marginTop: 2 }}>
                <HealthPill
                  value={c.healthScore ?? null}
                  band={c.healthBand ?? null}
                  /* The configured pair, never the primitive's defaults — this is
                     the same shop the list one screen back has just coloured. */
                  strongAtOrAbove={healthStrong}
                  watchBelow={healthWatch}
                  large
                />
              </View>
            ) : null}
          </View>
          {c.contactPerson || c.city || c.phone ? (
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', columnGap: 12, rowGap: 4, marginTop: 8 }}>
              {c.contactPerson ? (
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
                  <Icon name="person" size={14} color={heroMuted} strokeWidth={2} />
                  <Text style={{ fontSize: 13, lineHeight: 18, color: heroMuted }}>{c.contactPerson}</Text>
                </View>
              ) : null}
              {c.city ? (
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
                  <Icon name="pin" size={14} color={heroMuted} strokeWidth={2} />
                  <Text numberOfLines={1} style={{ fontSize: 13, color: heroMuted, maxWidth: 200 }}>
                    {c.city}
                  </Text>
                </View>
              ) : null}
              {c.phone ? <Text style={{ fontSize: 13, lineHeight: 18, color: heroMuted }}>{c.phone}</Text> : null}
            </View>
          ) : null}

          {/* A SHOP HE ADDED THAT THE OFFICE REFUSED, said at the top — it used
              to look like every other shop for ever, and the order he opened it
              for would be saved and then blocked. `order.tsx` refuses a new
              order against it in the same words; see `shop-refusal.ts`. */}
          {refusedLine ? (
            <View style={{ marginTop: 12, backgroundColor: C.dangerBg, borderRadius: 20, paddingHorizontal: 16, paddingVertical: 14, flexDirection: 'row', alignItems: 'center', gap: 10 }}>
              <Icon name="warn" size={20} color={C.danger} strokeWidth={2.2} />
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text style={[{ fontSize: 14, lineHeight: 19, color: C.danger }, weight(700)]}>Office did not accept this shop</Text>
                <Text style={[{ marginTop: 2, fontSize: 12, lineHeight: 17, color: C.danger }, weight(400)]}>{refusedLine}</Text>
              </View>
              <Pressable
                onPress={() => router.push('/rejections?from=customers')}
                accessibilityRole="button"
                accessibilityLabel="Open Not accepted"
                hitSlop={6}
                style={({ pressed }) => ({ minHeight: 36, paddingVertical: 6, paddingHorizontal: 12, borderRadius: 18, backgroundColor: pressed ? C.wash : C.surface, justifyContent: 'center' })}>
                <Text style={[{ fontSize: 12, lineHeight: 17, color: C.danger }, weight(700)]}>Open</Text>
              </Pressable>
            </View>
          ) : null}

          {/*
            THE WAY TO THE FUNNEL, from the record.

            The ladder, the §28 gates and both forms live on `/lead`, and `/leads`
            was the only door to any of them — so this screen, which a salesman
            reaches from search, from a journey stop and from a visit, could show
            him a lead and give him no way to see which rung it was on, let alone
            move it. It says the rung rather than just "Lead" because the rung is
            the thing he is deciding about, and because a link whose label is a
            category teaches nobody that there is a funnel behind it.
          */}
          {lead ? (
            <Pressable
              onPress={() => router.push(`/lead?id=${lead.id}&from=customer`)}
              accessibilityRole="button"
              accessibilityLabel={'Lead · ' + stageLabel(stageOf(lead))}
              accessibilityHint="Tap to move it to the next stage, or see what is pending"
              style={({ pressed }) => ({
                flexDirection: 'row',
                alignItems: 'center',
                gap: 10,
                marginTop: 12,
                minHeight: 48,
                paddingVertical: 6,
                paddingHorizontal: 16,
                borderRadius: 24,
                backgroundColor: pressed ? C.primaryTint : C.surface,
              })}>
              <Icon name="person" size={16} color={C.primaryDeep} strokeWidth={2} />
              <Text numberOfLines={1} style={[{ flex: 1, minWidth: 0, fontSize: 14, color: C.primaryDeep }, weight(700)]}>
                {'Lead · ' + stageLabel(stageOf(lead))}
                <Text style={[{ color: C.muted }, weight(500)]}>{' · next stage / pending'}</Text>
              </Text>
              <Text style={[{ fontSize: 18, lineHeight: 20, color: C.primaryDeep }, weight(700)]}>›</Text>
            </Pressable>
          ) : filedLead && c ? (
            /* A lead filed away: its history and its way back are on the lead
               record, not in these ledgers — the same door the list opens. */
            <Pressable
              onPress={() => router.push(`/lead?id=${c.id}&from=customer`)}
              accessibilityRole="button"
              accessibilityLabel={FILED_LEAD_WORD + ' · open the lead'}
              style={({ pressed }) => ({
                flexDirection: 'row',
                alignItems: 'center',
                gap: 10,
                marginTop: 12,
                minHeight: 48,
                paddingVertical: 6,
                paddingHorizontal: 16,
                borderRadius: 24,
                backgroundColor: pressed ? C.primaryTint : C.surface,
              })}>
              <Icon name="person" size={16} color={C.primaryDeep} strokeWidth={2} />
              <Text numberOfLines={1} style={[{ flex: 1, minWidth: 0, fontSize: 14, color: C.primaryDeep }, weight(700)]}>
                {FILED_LEAD_WORD}
                <Text style={[{ color: C.muted }, weight(500)]}>{' · open the lead'}</Text>
              </Text>
              <Text style={[{ fontSize: 18, lineHeight: 20, color: C.primaryDeep }, weight(700)]}>›</Text>
            </Pressable>
          ) : null}

          <View style={{ flexDirection: 'row', gap: 8, marginTop: 12 }}>
            <View
              accessible
              accessibilityLabel={'Outstanding ' + (dues ? inr(dues) : 'nothing due')}
              style={{ flex: 1, backgroundColor: C.surface, borderRadius: 18, paddingVertical: 12, paddingHorizontal: 14 }}>
              <Icon name="wallet" size={18} color={outstandingRed ? C.danger : C.ink} strokeWidth={2} />
              {/* Compared in PAISE against the one shared threshold, so the
                  record and the list card cannot turn red at two figures. */}
              <Text
                style={[
                  { fontSize: 20, letterSpacing: -0.4, color: outstandingRed ? C.danger : C.ink, marginTop: 4 },
                  weight(800),
                  tabular,
                ]}>
                {dues ? inr(dues) : 'Nothing due'}
              </Text>
              <Text style={{ fontSize: 12, lineHeight: 17, color: C.muted }}>outstanding</Text>
            </View>
            <View
              accessible
              accessibilityLabel={'Credit ' + (c.creditDays != null ? c.creditDays + ' days' : 'not set')}
              style={{ flex: 1, backgroundColor: C.surface, borderRadius: 18, paddingVertical: 12, paddingHorizontal: 14 }}>
              <Icon name="cal" size={18} color={C.ink} strokeWidth={2} />
              <Text style={[{ fontSize: 20, lineHeight: 26, letterSpacing: -0.4, color: C.ink, marginTop: 4 }, weight(800)]}>
                {c.creditDays != null ? c.creditDays + ' d' : '—'}
              </Text>
              <Text style={{ fontSize: 12, lineHeight: 17, color: C.muted }}>credit</Text>
            </View>
          </View>

          {/* The age of the figures above, in the caption slot the design already
              uses for exactly this kind of aside. */}
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 8 }}>
            <Icon name="synced" size={14} color={heroMuted} strokeWidth={2} />
            <Text style={{ fontSize: 12, lineHeight: 17, color: heroMuted }}>{'From office ' + freshness(c.lastSyncedAt, nowMs)}</Text>
          </View>

          <View style={{ flexDirection: 'row', gap: 8, marginTop: 14 }}>
            <Pressable
              /* Asks how he is getting there first — see `TravelGate`. The
                 shop's name goes with it so the question can name what it is
                 about; a sheet asking "how are you getting there?" with no
                 destination on it is a sheet somebody dismisses. */
              onPress={() => askTravel({ customerId: c.id, customerName: c.name })}
              accessibilityRole="button"
              accessibilityLabel="Visit"
              style={({ pressed }) => ({
                flex: 1,
                minHeight: 56,
                paddingVertical: 8,
                borderRadius: 28,
                backgroundColor: C.navy,
                opacity: pressed ? 0.88 : 1,
                flexDirection: 'row',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 8,
              })}>
              <Icon name="shop" size={18} color={C.lime} strokeWidth={2} />
              <Text style={[{ fontSize: 16, lineHeight: 22, color: '#FFFFFF' }, weight(700)]}>Visit</Text>
            </Pressable>
            {(
              [
                {
                  g: 'call',
                  l: 'Call ' + owner,
                  ink: C.primaryDeep,
                  bg: C.surface,
                  run: () => (c.phone ? void callNumber(c.phone) : notify('No number on this customer', 'error')),
                },
                {
                  g: 'chat',
                  l: 'WhatsApp ' + owner,
                  ink: C.success,
                  bg: C.surface,
                  run: async () => {
                    if (!c.phone) return notify('No number on this customer', 'error');
                    const out = await openWhatsApp(c.phone, '');
                    if (out.status !== 'handed_off') notify(out.reason, 'warn');
                  },
                },
                { g: 'order', l: 'New order', ink: '#FFFFFF', bg: C.primary, run: () => router.push('/order?from=customer') },
              ] as const
            ).map((b) => (
              <Pressable
                key={b.g}
                onPress={b.run}
                accessibilityRole="button"
                accessibilityLabel={b.l}
                style={({ pressed }) => ({
                  width: 56,
                  height: 56,
                  borderRadius: 28,
                  backgroundColor: b.bg,
                  opacity: pressed ? 0.85 : 1,
                  alignItems: 'center',
                  justifyContent: 'center',
                })}>
                <Icon name={b.g} size={20} color={b.ink} strokeWidth={2} />
              </Pressable>
            ))}
          </View>
        </View>
      }>
      {/* ---- tabs ---- */}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        style={{ flexGrow: 0 }}
        contentContainerStyle={{ gap: 8, paddingHorizontal: 14, paddingTop: 14 }}>
        {TABS.map((t, i) => {
          const on = pTab === i;
          const icon = TAB_ICON[t];
          return (
            <Pressable
              key={t}
              onPress={() => {
                if (!on) {
                  feedback('select');
                  setTabMoved(true);
                }
                set({ pTab: i });
              }}
              accessibilityRole="tab"
              accessibilityState={{ selected: on }}
              accessibilityLabel={t}
              hitSlop={{ top: 6, bottom: 6 }}
              style={{
                minHeight: 36,
                paddingVertical: 6,
                paddingHorizontal: on ? 14 : 12,
                borderRadius: 18,
                backgroundColor: on ? C.navy : C.surface,
                flexDirection: 'row',
                alignItems: 'center',
                gap: 6,
              }}>
              {icon && !on ? <Icon name={icon} size={14} color={C.ink} strokeWidth={2} /> : null}
              <Text style={[{ fontSize: 13, lineHeight: 18, color: on ? '#FFFFFF' : C.ink }, weight(700)]}>{t}</Text>
            </Pressable>
          );
        })}
      </ScrollView>

      {/* THE TAB BODY FADES IN PLACE, keyed on the tab. Not `Swap`: Swap eases
          the layout with it, and the Account tab can hold thirteen months of
          bills — moving every one of those frames is the cost
          `animateLayoutFor` exists to refuse. Siblings fade rather than slide,
          because there is no direction between Orders and Samples. */}
      <Appear
        key={pTab}
        distance={tabMoved ? 4 : 0}
        duration={tabMoved ? DUR.quick + 20 : 0}
        style={{ padding: 14 }}>
        {/* ---- overview ---- */}
        {pTab === 0 ? (
          <View style={{ gap: 12 }}>
            <View style={{ backgroundColor: C.surface, borderRadius: 22, padding: 16 }}>
              {/* Outstanding first. It is the fact that changes what he says
                  when the door opens, and it was on the card and not here —
                  so the record, which is the screen you open to prepare, was
                  the one place it could not be read. */}
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', rowGap: 8 }}>
                {[
                  { label: 'Outstanding', value: c.outstandingPaise ? inrFromPaise(c.outstandingPaise) : 'Nothing outstanding' },
                  { label: 'Credit limit', value: c.creditLimitPaise != null ? inrFromPaise(c.creditLimitPaise) : 'Not set' },
                  { label: 'Credit days', value: c.creditDays != null ? c.creditDays + ' d' : '—' },
                  { label: 'Can buy', value: c.potential ?? '—' },
                  { label: 'Orders every', value: c.cycleDays != null ? c.cycleDays + ' d' : '—' },
                  { label: 'Price list', value: c.priceTag ?? '—' },
                ].map((b) => (
                  <View
                    key={b.label}
                    accessible
                    accessibilityLabel={b.label + ' ' + b.value}
                    style={{ width: '31.8%', backgroundColor: C.canvas, borderRadius: 16, padding: 10 }}>
                    <Text style={{ fontSize: 11, color: C.muted }}>{b.label}</Text>
                    <Text numberOfLines={1} adjustsFontSizeToFit style={[{ fontSize: 16, color: C.ink }, weight(800), tabular]}>
                      {b.value}
                    </Text>
                  </View>
                ))}
              </View>

              <View style={{ marginTop: 12 }}>
                <InfoRow first icon="person" a11y="Contact">
                  <Text numberOfLines={1} style={{ flex: 1, minWidth: 0, fontSize: 14, color: C.ink }}>
                    {(fixed?.contactPerson ?? c.contactPerson) || '—'}
                  </Text>
                  <Text style={{ fontSize: 14, lineHeight: 20, color: C.muted }}>{(fixed?.phone ?? c.phone) || 'No phone'}</Text>
                </InfoRow>
                <InfoRow icon="pin" a11y="Where">
                  <Text numberOfLines={1} style={{ flex: 1, minWidth: 0, fontSize: 14, color: C.ink }}>
                    {[c.area, c.city].filter(Boolean).join(', ') || '—'}
                  </Text>
                  {fixed?.pinned || (c.gpsLat != null && c.gpsLng != null) ? (
                    <Pill text="Pin saved" height={24} bg={C.successBg} fg={C.success} a11y="Map pin saved" />
                  ) : (
                    <Pill text="Not pinned yet" height={24} bg={C.warnBg} fg={C.warnInk} a11y="Map pin not pinned yet" />
                  )}
                </InfoRow>
                {/* The written address, which a lead carried down its own
                    channel and lost the day it converted — for the half of the
                    book with no pin, it is the way to the door. */}
                {c.address ? (
                  <InfoRow word="Address">
                    <Text numberOfLines={3} style={{ flex: 1, minWidth: 0, fontSize: 14, lineHeight: 20, color: C.ink }}>{c.address}</Text>
                  </InfoRow>
                ) : null}
                <InfoRow word="Beat">
                  <Text numberOfLines={1} style={{ flex: 1, minWidth: 0, fontSize: 14, color: C.ink }}>{c.beat ?? '—'}</Text>
                </InfoRow>
                <InfoRow word="GST">
                  <Text numberOfLines={1} style={{ flex: 1, minWidth: 0, fontSize: 14, color: C.ink }}>{c.gstin ?? '—'}</Text>
                  <Text style={[{ fontSize: 11, color: C.muted }, weight(700)]}>Dealer</Text>
                  <Text style={{ fontSize: 14, lineHeight: 20, color: C.ink }}>{c.dealerCode ?? '—'}</Text>
                </InfoRow>
                <InfoRow icon="shop" a11y="Last visit">
                  <Text style={{ flex: 1, fontSize: 14, lineHeight: 20, color: C.ink }}>{pretty(c.lastVisitDate)}</Text>
                  <View accessible accessibilityLabel={'Last order ' + pretty(c.lastOrderDate)} style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                    <Icon name="order" size={16} color={C.muted} strokeWidth={2} />
                    <Text style={{ fontSize: 14, lineHeight: 20, color: C.ink }}>{pretty(c.lastOrderDate)}</Text>
                  </View>
                </InfoRow>
              </View>

              <TintButton
                label="Correct contact, phone or pin"
                icon="note"
                onPress={() => setEditing(true)}
                style={{ marginTop: 10 }}
              />
            </View>

            {/* ---- a private note for the office ----

                §R. `mbos_internal_notes` has had a table, a role list and a
                bootstrap that narrows by role since the MBOS module shipped,
                and `handleInternalNote` has been waiting on the server for a
                payload no handset ever sent — a read path over a table nothing
                could put a row in, exactly the shape competitor records were
                in before they got a write path.

                IT IS WRITE-ONLY HERE, and that is the feature rather than an
                omission. `services/mbos-service.ts` never selects the table at
                all, on its own stated reasoning: a note that could leak is not
                on the device to leak, and a filter in the app is a filter
                somebody can turn off. So nothing is stored locally either —
                the note sits in the outbox until it goes, and after that this
                phone has no copy. The screen says so rather than leaving him
                to discover it by looking for a list that will never appear. */}
            <View style={{ backgroundColor: C.navy, borderRadius: 22, padding: 16 }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                <Icon name="lock" size={16} color={C.lime} strokeWidth={2} />
                <Text style={[{ fontSize: 14, lineHeight: 20, color: C.lime }, weight(700)]}>Private note for the office</Text>
              </View>
              <Text
                accessibilityLabel="Write something the customer must never see. It goes to the office only. It is not kept on this phone, so you will not see it here later."
                style={{ fontSize: 12, lineHeight: 17, color: C.onNavyMuted, marginTop: 4 }}>
                Customer never sees it. Not kept on this phone.
              </Text>
              <TextInput
                value={note}
                onChangeText={setNote}
                placeholder="Pays on time but fights every rate…"
                placeholderTextColor={C.onNavyMuted}
                multiline
                textAlignVertical="top"
                accessibilityLabel="Private note for the office"
                style={{
                  marginTop: 10,
                  minHeight: 84,
                  padding: 12,
                  borderRadius: 16,
                  backgroundColor: C.navySoft,
                  color: '#FFFFFF',
                  fontSize: 15,
                }}
              />
              <Pressable
                accessibilityRole="button"
                accessibilityState={{ disabled: noteBusy || !note.trim() }}
                disabled={noteBusy || !note.trim()}
                onPress={() => {
                  if (!id) return;
                  setNoteBusy(true);
                  void writeInternalNote({ customerId: id, body: note })
                    .then((r) => {
                      if (!r.ok) return notify(r.message, 'error');
                      setNote('');
                      notify('Sent to office · not kept on this phone');
                    })
                    .finally(() => setNoteBusy(false));
                }}
                style={({ pressed }) => ({
                  alignItems: 'center',
                  justifyContent: 'center',
                  minHeight: 48,
                  paddingVertical: 8,
                  marginTop: 10,
                  borderRadius: 24,
                  backgroundColor: note.trim() ? C.lime : '#2A3858',
                  opacity: noteBusy ? 0.6 : pressed ? 0.88 : 1,
                })}>
                <Text style={[{ fontSize: 14, lineHeight: 20, color: note.trim() ? C.navy : C.onNavyMuted }, weight(700)]}>
                  {noteBusy ? 'Sending…' : 'Send to office'}
                </Text>
              </Pressable>
            </View>
          </View>
        ) : null}

        {/* ---- timeline ---- */}
        {pTab === 1 ? (
          <View>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, paddingBottom: 12 }}>
              {TL_FILTERS.map((f) => (
                <ChipButton
                  key={f}
                  label={f}
                  on={tlFilter === f}
                  onPress={() => {
                    if (tlFilter !== f) feedback('select');
                    set({ tlFilter: f });
                  }}
                />
              ))}
            </View>

            {/* AN EMPTY TIMELINE HAD NOTHING TO SAY, which is not the same as
                having nothing to show. The two causes are worth telling apart
                in the words, because only one of them is the salesman's to act
                on: a filter that excludes everything is undone by pressing
                All, and an empty stream is the office's to fill. And the
                filtered sentence says only what is on this phone under this
                chip — it has not asked what else is here. */}
            {events.length === 0
              ? nothingYet(
                  tlFilter === 'All' ? 'Nothing recorded yet' : 'Nothing under ' + tlFilter,
                  tlFilter === 'All'
                    ? 'Visits, calls, orders and payments will show here. A new shop has nothing yet.'
                    : 'No ' + tlFilter.toLowerCase() + ' for this shop on this phone. Tap All to see everything.',
                )
              : null}

            {events.length ? (
              <View style={{ backgroundColor: C.surface, borderRadius: 22, paddingVertical: 6, paddingHorizontal: 16 }}>
                {events.map((e, i) => {
                  const kind = KIND_LABEL[e.eventType] ?? KIND_FALLBACK;
                  const look = kindLook(kind);
                  const office = e.sourceApp !== 'mbos';
                  return (
                    <Stagger key={e.id} index={i}>
                      <View
                        style={{
                          flexDirection: 'row',
                          gap: 12,
                          paddingVertical: 12,
                          borderTopWidth: i ? 1 : 0,
                          borderTopColor: C.hairline,
                        }}>
                        <View
                          accessible
                          accessibilityRole="image"
                          accessibilityLabel={kind}
                          style={{
                            width: 34,
                            height: 34,
                            borderRadius: 17,
                            backgroundColor: look.bg,
                            alignItems: 'center',
                            justifyContent: 'center',
                          }}>
                          {KIND_ICON[kind] ? (
                            <Icon name={KIND_ICON[kind]!} size={16} color={look.fg} strokeWidth={2} />
                          ) : (
                            <Text style={[{ fontSize: 11, color: look.fg }, weight(800)]}>i</Text>
                          )}
                        </View>
                        <View style={{ flex: 1, minWidth: 0 }}>
                          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                            <Text style={[{ fontSize: 12, lineHeight: 17, color: look.fg }, weight(700)]}>{kind}</Text>
                            <Text style={{ fontSize: 12, lineHeight: 17, color: C.muted }}>
                              {[pretty(isoDate(new Date(e.occurredAt))), e.actor].filter(Boolean).join(' · ')}
                            </Text>
                            {office ? (
                              <View
                                accessible
                                accessibilityLabel="From the office team"
                                style={{ minHeight: 18, paddingVertical: 2, paddingHorizontal: 6, borderRadius: 9, backgroundColor: C.lavender, justifyContent: 'center' }}>
                                <Text style={[{ fontSize: 11, color: C.primaryDeep }, weight(700)]}>Office</Text>
                              </View>
                            ) : null}
                          </View>
                          <Text style={{ fontSize: 14, lineHeight: 19, color: C.ink, marginTop: 2 }}>{e.summary}</Text>
                        </View>
                      </View>
                    </Stagger>
                  );
                })}
              </View>
            ) : null}

            {/* A CAPPED LIST ADMITS IT, the same rule Orders and Payments
                follow one tab along. A full page means the read hit its cap,
                not that this is the whole story — and a salesman who reads a
                hundred entries as everything tells a customer so. */}
            {events.length >= TIMELINE_PAGE ? (
              <Text style={{ fontSize: 12, lineHeight: 17, color: C.muted, marginTop: 10 }}>
                {'Newest ' +
                  TIMELINE_PAGE +
                  (tlFilter === 'All' ? ' shown' : ' under ' + tlFilter + ' shown') +
                  '. Older history is not shown.'}
              </Text>
            ) : null}

            <Text
              accessibilityLabel="This is a record of what happened. You cannot add to it here. Each entry comes from the screen where it was done."
              style={{ fontSize: 12, color: C.muted, marginTop: 8 }}>
              Read-only: each entry comes from the screen where it was done.
            </Text>
          </View>
        ) : null}

        {/* ---- what they bought ---- */}
        {pTab === 2 ? (
          <View style={{ gap: 8 }}>
            {orders.length === 0 ? (
              nothingYet(
                'No orders on this phone',
                "Orders come from the office every day. If this shop has ordered and you see nothing, open More, then Send to office, and press Send now.",
              )
            ) : (
              <>
                {orders.map((o, i) => (
                  <Stagger key={o.id} index={i}>
                    <View
                      accessible
                      accessibilityLabel={[
                        o.valuePaise != null ? inrFromPaise(o.valuePaise) : 'Value not recorded',
                        pretty(o.orderedAt),
                        o.orderNo ? 'No. ' + o.orderNo : null,
                        o.lines ? o.lines + (o.lines === 1 ? ' line' : ' lines') : null,
                        o.status,
                      ]
                        .filter(Boolean)
                        .join(', ')}
                      style={{ backgroundColor: C.surface, borderRadius: 20, paddingVertical: 14, paddingHorizontal: 16, flexDirection: 'row', alignItems: 'center', gap: 12 }}>
                      <Icon name="order" size={20} color={C.ink} strokeWidth={2} />
                      <View style={{ flex: 1, minWidth: 0 }}>
                        {o.valuePaise != null ? (
                          <Text style={[{ fontSize: 17, lineHeight: 24, color: C.ink }, weight(800), tabular]}>{inrFromPaise(o.valuePaise)}</Text>
                        ) : (
                          <Text style={[{ fontSize: 15, lineHeight: 21, color: C.muted }, weight(700)]}>Value not recorded</Text>
                        )}
                        <Text numberOfLines={1} style={{ fontSize: 12, color: C.muted }}>
                          {[o.orderNo, o.lines ? o.lines + (o.lines === 1 ? ' line' : ' lines') : null]
                            .filter(Boolean)
                            .join(' · ') || 'No lines listed'}
                        </Text>
                      </View>
                      <View style={{ alignItems: 'flex-end', gap: 4 }}>
                        <Text style={{ fontSize: 12, lineHeight: 17, color: C.muted }}>{pretty(o.orderedAt)}</Text>
                        {o.status ? <Badge tone={orderTone(o.status)}>{o.status}</Badge> : null}
                      </View>
                    </View>
                  </Stagger>
                ))}
                <Slice n={orders.length} noun="order" />
              </>
            )}
          </View>
        ) : null}

        {/* ---- the account: what was billed, what came in ---- */}
        {pTab === 3 ? (
          <View style={{ gap: 10 }}>
            {/*
              A STATEMENT IS FOR AN ACCOUNT WE INVOICE, and the two that are
              not say so rather than showing an empty list.

              A lead has never ordered — that is the whole definition — and a
              third-party shop is one we deliver to and do not bill, so its
              invoices are the distributor's and always will be. Both would
              draw a correct, empty screen, and an empty screen with nothing
              saying why reads as a sync that has not finished. It is the same
              sentence the Accounts app puts above its own ledger for the same
              account, one screen over.
            */}
            {accountKind === 'Lead' ? (
              <Empty
                head="Nothing billed to a lead"
                body="A lead has never ordered from us. When the first order is billed, it will show here."
              />
            ) : accountKind === 'Third party' && bills.length === 0 ? (
              <Empty
                head="We deliver here but bill the distributor"
                body="The bill goes to the distributor, so this shop has no bills. See what it took under Orders."
              />
            ) : (
              <>
                {/* ---- the window ---- */}
                <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
                  {PERIODS.map((p) => (
                    <ChipButton
                      key={p.key}
                      label={p.label}
                      on={period === p.key}
                      onPress={() => {
                        if (period !== p.key) feedback('select');
                        setPeriod(p.key);
                      }}
                    />
                  ))}
                </View>

                {/* ---- the four figures ----

                    OUTSTANDING IS THE OFFICE'S OWN and is not added up here.
                    Everything else on this card describes the window; that one
                    describes the account, and a second total computed on a
                    phone from thirteen months of rows is exactly how a salesman
                    and an accounts clerk come to quote a shopkeeper two
                    different debts with him listening. */}
                <View style={{ backgroundColor: C.navy, borderRadius: 22, padding: 16 }}>
                  <View style={{ flexDirection: 'row', flexWrap: 'wrap', rowGap: 14 }}>
                    <Figure label="Billed" value={inrFromPaise(statement.billedPaise)} />
                    <Figure label="Received" value={inrFromPaise(statement.receivedPaise)} tone={C.lime} />
                    <Figure
                      label="Outstanding now · office"
                      value={c.outstandingPaise ? inrFromPaise(c.outstandingPaise) : 'Nothing'}
                      tone={c.outstandingPaise ? '#FF8A80' : undefined}
                    />
                    {statement.awaitingCount ? (
                      <Figure label="With accounts" value={inrFromPaise(statement.awaitingPaise)} tone="#FFD27A" />
                    ) : (
                      <Figure label="Bills" value={String(billsInWindow)} />
                    )}
                  </View>
                  <Text
                    accessibilityLabel="Billed and received are for the dates above. Outstanding is the office's figure for the whole account. It counts only money the accounts team has seen in the bank."
                    style={{ fontSize: 12, lineHeight: 17, color: C.onNavyMuted, marginTop: 10 }}>
                    {'Billed and received are for these dates. Outstanding is the whole account, bank-seen money only.' +
                      (statement.openingPaise !== 0
                        ? ' Before these dates: ' + inrFromPaise(statement.openingPaise) + '.'
                        : '')}
                  </Text>
                </View>

                {/* ---- the lines ---- */}
                {statement.entries.length === 0 ? (
                  nothingYet(
                    bills.length || receipts.length
                      ? 'Nothing in these dates'
                      : 'No bills on this phone',
                    bills.length || receipts.length
                      ? 'No bill or payment in these dates. Pick a longer time.'
                      : "Bills and payments come from the office every day. If this shop has a bill and you see nothing, open More, then Send to office, and press Send now.",
                  )
                ) : (
                  statement.entries.map((e) =>
                    e.kind === 'bill' ? (
                      <BillCard
                        key={'b' + e.bill.id}
                        bill={e.bill}
                        balanceAfterPaise={e.balancePaise}
                        open={openBillId === e.bill.id}
                        onToggle={() => {
                          /* The cards under it move down; eased on an account
                             short enough to move cheaply, a jump otherwise. */
                          animateLayoutFor(statement.entries.length);
                          setOpenBillId(openBillId === e.bill.id ? null : e.bill.id);
                        }}
                      />
                    ) : (
                      <ReceiptCard
                        key={'r' + e.receipt.id}
                        receipt={e.receipt}
                        balanceAfterPaise={e.balancePaise}
                      />
                    ),
                  )
                )}

                {/* HOW FAR BACK THIS PHONE GOES, said plainly. A capped list
                    has to admit what it is a slice of — otherwise a salesman
                    reads "This year" over eight months of bills and tells a
                    shopkeeper that is all there was. */}
                {reach ? (
                  <View
                    accessible
                    accessibilityLabel={'This phone has this account from ' + pretty(reach) + '. Older records are with the office.'}
                    style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 2 }}>
                    <Icon name="cal" size={14} color={C.muted} strokeWidth={2} />
                    <Text style={{ flex: 1, fontSize: 12, lineHeight: 17, color: C.muted }}>
                      {'This phone holds from ' + pretty(reach) + ' · older with the office'}
                    </Text>
                  </View>
                ) : null}
              </>
            )}
          </View>
        ) : null}

        {/* ---- what they were given to try ---- */}
        {pTab === 4 ? (
          <View style={{ gap: 8 }}>
            {samples.length === 0 ? (
              nothingYet(
                'No samples for this shop',
                'Samples you ask for here show up at once. The office sends only open samples. A sample closed by the office will not show here.',
              )
            ) : (
              <>
                {samples.map((sm) => (
                  <View key={sm.id} style={{ backgroundColor: C.surface, borderRadius: 20, paddingVertical: 14, paddingHorizontal: 16 }}>
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                      <Icon name="sample" size={20} color={C.primaryDeep} strokeWidth={2} />
                      <View style={{ flex: 1, minWidth: 0 }}>
                        <Text style={[{ fontSize: 15, lineHeight: 21, color: C.ink }, weight(700)]}>
                          {sm.productName ?? 'Product not recorded'}
                        </Text>
                        <SkuChip sku={sm.sku} />
                      </View>
                      <Badge tone={sampleTone(sm.state)}>{sm.state}</Badge>
                    </View>
                    <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', columnGap: 10, rowGap: 2, marginTop: 8 }}>
                      {sm.cans ? <Text style={{ fontSize: 12, lineHeight: 17, color: C.muted }}>{sm.cans + (sm.cans === 1 ? ' can' : ' cans')}</Text> : null}
                      <Text style={{ fontSize: 12, lineHeight: 17, color: C.muted }}>{'asked ' + pretty(isoDate(new Date(sm.requestedAt)))}</Text>
                      <Text style={{ fontSize: 12, lineHeight: 17, color: C.muted }}>
                        {sm.trialOutcome && sm.trialOutcome !== 'pending' ? 'result: ' + sm.trialOutcome : 'result pending'}
                      </Text>
                      {/* The promise, and only while it is still a promise. A
                          follow-up date on a trial that is already converted or
                          rejected is a date nobody is going to keep. */}
                      {sm.followUpDate && sm.state !== 'Converted' && sm.state !== 'Rejected' ? (
                        <View
                          accessible
                          accessibilityLabel={'Ask again ' + pretty(sm.followUpDate)}
                          style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                          <Icon name="refresh" size={12} color={C.ink} strokeWidth={2.2} />
                          <Text style={[{ fontSize: 12, lineHeight: 17, color: C.ink }, weight(700)]}>{pretty(sm.followUpDate)}</Text>
                        </View>
                      ) : null}
                    </View>
                    {sm.reason ? <Text style={{ fontSize: 12, lineHeight: 17, color: C.muted, marginTop: 4 }}>{sm.reason}</Text> : null}
                  </View>
                ))}
              </>
            )}
          </View>
        ) : null}

        {/* ---- complaints ----

            A complaint was WRITE-ONLY for as long as it has existed.
            `logComplaint` wrote the row from the visit drawer and sent it to
            the desk team, and nothing on this handset ever selected one back —
            so the next time the salesman walked into the same shop and was
            asked what had happened about it, the record could not tell him
            even that it had been sent.

            `status` is the office's word and arrives on the sync, so an answer
            appears here without anybody on this end doing anything. */}
        {pTab === 5 ? (
          <View>
            {gripes.length === 0 ? (
              nothingYet(
                'No complaints for this shop',
                'To add a complaint, start a visit and pick Complaint.',
              )
            ) : (
              <View style={{ gap: 8 }}>
                {gripes.map((g) => (
                  <View key={g.id} style={{ backgroundColor: C.surface, borderRadius: 20, paddingVertical: 14, paddingHorizontal: 16 }}>
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                      <Icon name="warn" size={20} color={C.danger} strokeWidth={2} />
                      {/* The stored value is already the word on the button.
                          `logComplaint` writes the design's own label locally
                          and only translates to MahekOne's enum on the WIRE —
                          see `wireComplaintCategory` — so there is nothing to
                          map back here. */}
                      <Text style={[{ flex: 1, minWidth: 0, fontSize: 15, lineHeight: 21, color: C.ink }, weight(700)]}>
                        {g.category}
                      </Text>
                      <Badge tone={g.syncState === 'queued' ? 'neutral' : g.status === 'open' ? 'amber' : 'success'}>
                        {g.syncState === 'queued' ? 'Not sent' : g.status === 'open' ? 'Open' : 'Closed'}
                      </Badge>
                    </View>
                    <Text style={{ fontSize: 14, lineHeight: 20, color: C.body, marginTop: 6 }}>
                      {g.description}
                    </Text>
                    <Text style={{ fontSize: 12, lineHeight: 17, color: C.muted, marginTop: 2 }}>{pretty(isoDate(new Date(g.clientCreatedAt)))}</Text>
                  </View>
                ))}
                {/* No `Slice` here, unlike Orders. Complaints are only ever
                    raised on this handset and there is no pull channel bringing
                    others down, so this list is the whole history and saying
                    otherwise would be a false sentence. */}
              </View>
            )}
          </View>
        ) : null}

        {/* ---- competitors ---- */}
        {pTab === 6 ? (
          <View style={{ gap: 8 }}>
            {!compForm ? (
              <>
                <DashedAdd label="+ Add what you heard" onPress={() => setCompForm(true)} />
                <Text style={{ fontSize: 12, lineHeight: 17, color: C.muted }}>
                  Fill this in from your talk with the shop. A name and a rate is enough.
                </Text>
              </>
            ) : (
              <View style={{ backgroundColor: C.surface, borderRadius: 22, padding: 16, gap: 8 }}>
                <Text style={[{ fontSize: 17, lineHeight: 24, color: C.ink }, weight(800)]}>What you heard</Text>
                <WashInput
                  value={comp.name}
                  onChangeText={(v) => setComp((s) => ({ ...s, name: v }))}
                  placeholder="Brand name *"
                  a11y="Other brand's name, needed"
                />
                <View style={{ flexDirection: 'row', gap: 8 }}>
                  <WashInput
                    value={comp.rate}
                    onChangeText={(v) => setComp((s) => ({ ...s, rate: cleanAmount(v) }))}
                    keyboardType="decimal-pad"
                    placeholder="₹ rate"
                    a11y="Rate quoted, rupees, optional"
                    style={{ flex: 1 }}
                  />
                  <WashInput
                    value={comp.credit}
                    onChangeText={(v) => setComp((s) => ({ ...s, credit: v }))}
                    placeholder="Credit days"
                    a11y="Credit days they give, optional"
                    style={{ flex: 1 }}
                  />
                </View>
                <WashInput
                  value={comp.note}
                  onChangeText={(v) => setComp((s) => ({ ...s, note: v }))}
                  placeholder="Which product, note on rate"
                  a11y="Which product, and any note on the rate"
                />
                {/* THE BOX THAT WAS NEVER DRAWN. `delivery` is carried on the
                    wire and printed on the saved card, and had no input until
                    this one — a column the record shows is one the salesman
                    standing in the shop has to be able to fill in. */}
                <WashInput
                  value={comp.delivery}
                  onChangeText={(v) => setComp((s) => ({ ...s, delivery: v }))}
                  placeholder="How fast they deliver"
                  a11y="How quickly they deliver, optional"
                />
                <WashInput
                  value={comp.strengths}
                  onChangeText={(v) => setComp((s) => ({ ...s, strengths: v }))}
                  placeholder="Good at"
                  a11y="What they are doing well, optional"
                />
                <WashInput
                  value={comp.weaknesses}
                  onChangeText={(v) => setComp((s) => ({ ...s, weaknesses: v }))}
                  placeholder="Where we can win"
                  a11y="Where we can win, optional"
                />
                <View style={{ flexDirection: 'row', gap: 8, marginTop: 4 }}>
                  <PillButton label="Cancel" variant="outline" height={52} onPress={() => setCompForm(false)} style={{ flex: 1 }} />
                  <PillButton
                    label={compBusy ? 'Saving…' : 'Save'}
                    variant="navy"
                    height={52}
                    onPress={() => void saveCompetitor()}
                    disabled={compBusy}
                    style={{ flex: 2 }}
                  />
                </View>
                <Text style={{ fontSize: 12, lineHeight: 17, color: C.muted }}>A name and a rate is enough.</Text>
              </View>
            )}

            {competitors.map((k) => (
              <View key={k.id} style={{ backgroundColor: C.surface, borderRadius: 20, paddingVertical: 14, paddingHorizontal: 16 }}>
                <View style={{ flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', gap: 12 }}>
                  <Text style={[{ fontSize: 15, lineHeight: 21, color: C.ink, flexShrink: 1 }, weight(700)]}>{k.competitorName}</Text>
                  <Text style={[{ fontSize: 16, lineHeight: 22, color: C.ink }, weight(800), tabular]}>
                    {k.ratePaise != null ? inrFromPaise(k.ratePaise) : (k.rateNote ?? '')}
                  </Text>
                </View>
                {k.creditTerms || k.delivery ? (
                  <Text style={{ fontSize: 12, lineHeight: 17, color: C.muted, marginTop: 2 }}>
                    {[k.creditTerms, k.delivery].filter(Boolean).join(' · ')}
                  </Text>
                ) : null}
                {/* Both, when both were said: the half that used to be
                    dropped was the weakness — the one a salesman sells
                    against. */}
                {k.strengths || k.weaknesses ? (
                  <View style={{ gap: 4, marginTop: 8 }}>
                    {k.strengths ? (
                      <Text accessibilityLabel={'Good at: ' + k.strengths} style={{ fontSize: 13, lineHeight: 18, color: C.success }}>
                        {'+ ' + k.strengths}
                      </Text>
                    ) : null}
                    {k.weaknesses ? (
                      <Text accessibilityLabel={'Weak on: ' + k.weaknesses} style={{ fontSize: 13, lineHeight: 18, color: C.danger }}>
                        {'− ' + k.weaknesses}
                      </Text>
                    ) : null}
                  </View>
                ) : null}
                <Text style={{ fontSize: 12, lineHeight: 17, color: C.faint, marginTop: 6 }}>
                  {'Noted ' + pretty(isoDate(new Date(k.capturedAt)))}
                </Text>
              </View>
            ))}
          </View>
        ) : null}
      </Appear>

      <EditShopSheet
        key={editing ? 'open' : 'shut'}
        open={editing}
        onClose={() => setEditing(false)}
        customerId={c.id}
        contactPerson={(fixed?.contactPerson ?? c.contactPerson) || ''}
        phone={(fixed?.phone ?? c.phone) || ''}
        pinned={fixed?.pinned || (c.gpsLat != null && c.gpsLng != null)}
        onSaved={(f) => {
          setFixed((cur) => ({ ...(cur ?? {}), ...f }));
          setEditing(false);
          notify('Saved · the office will see it on the next send');
        }}
      />
    </AppFrame>
  );
}

/**
 * Correcting a shop: who runs it, the number that answers, and — only where
 * the shop has never been pinned — a pin where he stands. See `editShop` for
 * why an existing pin is never moved from here.
 */
function EditShopSheet(props: {
  open: boolean;
  onClose: () => void;
  customerId: string;
  contactPerson: string;
  phone: string;
  pinned: boolean;
  onSaved: (fixed: { contactPerson?: string; phone?: string; pinned?: boolean }) => void;
}) {
  const [contact, setContact] = React.useState(props.contactPerson);
  const [phone, setPhone] = React.useState(props.phone);
  const [pin, setPin] = React.useState<{ lat: number; lng: number; accuracyM: number } | null>(null);
  const [finding, setFinding] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);

  const findMe = async () => {
    if (finding) return;
    setFinding(true);
    setErr(null);
    try {
      const threshold = await getConfig<number>('mbos.location.gpsAccuracyThresholdM', 100);
      /* The careful reading, as the check-in takes: a city-block fix dropped
         as a pin would refuse every honest check-in afterwards. */
      const r = await getFix({ accuracyThresholdM: threshold, precise: true });
      if (r.status === 'ok') {
        setPin({ lat: r.fix.lat, lng: r.fix.lng, accuracyM: r.fix.accuracyM });
        return;
      }
      setErr(r.status === 'coarse' ? 'The reading is not close enough yet. Step outside and try again.' : r.reason);
    } finally {
      setFinding(false);
    }
  };

  const save = async () => {
    if (busy) return;
    const edit: { contactPerson?: string; phone?: string; pin?: { lat: number; lng: number; accuracyM: number } } = {};
    if (contact.trim() !== props.contactPerson.trim()) edit.contactPerson = contact;
    if (phone.trim() !== props.phone.trim()) edit.phone = phone;
    if (pin) edit.pin = pin;
    setBusy(true);
    try {
      const r = await editShop(props.customerId, edit);
      if (!r.ok) return setErr(r.message);
      props.onSaved({
        contactPerson: edit.contactPerson?.trim(),
        phone: edit.phone?.trim(),
        pinned: pin ? true : undefined,
      });
    } catch (e) {
      setErr(e instanceof Error && e.message ? e.message : 'Could not save. Try again.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <BottomSheet open={props.open} onClose={props.onClose} scroll>
      <Text style={[{ fontSize: 20, lineHeight: 26, color: C.ink, marginTop: 6 }, weight(800)]}>Correct this shop</Text>
      <Text
        accessibilityLabel="What you change here goes to the office."
        style={{ fontSize: 13, color: C.muted, marginTop: 2 }}>
        Goes to the office.
      </Text>
      <WashInput
        icon="person"
        value={contact}
        onChangeText={setContact}
        placeholder="Owner or manager"
        a11y="Who runs it. Name of the owner or manager"
        style={{ marginTop: 14 }}
      />
      <WashInput
        icon="call"
        value={phone}
        onChangeText={setPhone}
        placeholder="10 digits"
        keyboardType="phone-pad"
        a11y="Phone"
        style={{ marginTop: 10 }}
      />
      {props.pinned ? (
        <Text style={{ fontSize: 12, lineHeight: 17, color: C.muted, marginTop: 10 }}>
          This shop already has a pin. If it is in the wrong place, say so when you check in here, and your manager
          will move it.
        </Text>
      ) : (
        <>
          <TintButton
            icon="locate"
            height={56}
            label={
              finding ? 'Finding where you are…' : pin ? 'Pinned here · ±' + Math.round(pin.accuracyM) + ' m' : 'Pin where I stand'
            }
            a11y={pin ? undefined : 'Map pin. Pin it where I am standing'}
            onPress={() => void findMe()}
            style={{ marginTop: 10 }}
          />
          <Text style={{ fontSize: 12, lineHeight: 17, color: C.muted, marginTop: 6 }}>
            Only press this while you are standing in the shop.
          </Text>
        </>
      )}
      {err ? <Text style={{ fontSize: 13, lineHeight: 18, color: C.danger, marginTop: 10 }}>{err}</Text> : null}
      <View style={{ flexDirection: 'row', gap: 10, marginTop: 16 }}>
        <PillButton label="Cancel" variant="outline" height={56} onPress={props.onClose} style={{ flex: 1 }} />
        <PillButton
          label={busy ? 'Saving…' : 'Save'}
          variant="navy"
          height={56}
          onPress={() => void save()}
          disabled={busy}
          style={{ flex: 2 }}
        />
      </View>
    </BottomSheet>
  );
}

/**
 * Nothing here, and WHY.
 *
 * An empty list on an offline-first app has two causes a salesman can tell
 * apart and act on differently: this shop has never done it, or this handset
 * has not been told. Drawing the same blank card for both leaves him to guess,
 * and the guess he makes is that the app is broken.
 */
function Empty({ head, body }: { head: string; body: string }) {
  return (
    <View style={{ backgroundColor: C.surface, borderRadius: 24, paddingVertical: 26, paddingHorizontal: 20, alignItems: 'center' }}>
      <Text style={[{ fontSize: 17, lineHeight: 24, color: C.ink, textAlign: 'center' }, weight(800)]}>{head}</Text>
      <Text style={{ fontSize: 13, lineHeight: 18, color: C.muted, textAlign: 'center', marginTop: 6 }}>{body}</Text>
    </View>
  );
}

/**
 * A capped list admits it.
 *
 * The server sends ten of each per customer. Without this line a salesman
 * reads ten orders as the whole history and tells the customer so — which is
 * the same failure the web app's timeline had, and it was fixed there by
 * saying what the list is a slice of.
 */
function Slice({ n, noun }: { n: number; noun: string }) {
  if (n < 10) return null;
  return (
    <Text style={{ fontSize: 12, lineHeight: 17, color: C.muted, textAlign: 'center', marginTop: 2 }}>
      {'Last ' + n + ' ' + noun + 's · older ones are with the office.'}
    </Text>
  );
}

/** One figure on the navy account card — two to a row. */
function Figure({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <View accessible accessibilityLabel={label + ' ' + value} style={{ width: '50%', paddingRight: 8 }}>
      <Text numberOfLines={1} style={{ fontSize: 12, color: C.onNavyMuted }}>{label}</Text>
      <Text
        numberOfLines={1}
        adjustsFontSizeToFit
        style={[{ fontSize: 22, letterSpacing: -0.4, color: tone ?? '#FFFFFF' }, weight(800), tabular]}>
        {value}
      </Text>
    </View>
  );
}

/** The 36-high pill chip V3 uses for every filter on the record. */
function ChipButton({ label, on, onPress }: { label: string; on: boolean; onPress: () => void }) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="radio"
      accessibilityState={{ selected: on }}
      accessibilityLabel={label}
      hitSlop={{ top: 6, bottom: 6 }}
      style={{
        minHeight: 36,
        paddingVertical: 6,
        paddingHorizontal: on ? 14 : 12,
        borderRadius: 18,
        backgroundColor: on ? C.navy : C.surface,
        alignItems: 'center',
        justifyContent: 'center',
      }}>
      <Text style={[{ fontSize: 13, lineHeight: 18, color: on ? '#FFFFFF' : C.ink }, weight(700)]}>{label}</Text>
    </Pressable>
  );
}

/** A tinted pill action — "Correct contact, phone or pin", "Pin where I stand". */
function TintButton({
  label,
  icon,
  onPress,
  height = 48,
  a11y,
  style,
}: {
  label: string;
  icon: IconName;
  onPress: () => void;
  height?: number;
  a11y?: string;
  style?: object;
}) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={a11y ?? label}
      style={({ pressed }) => [
        {
          height,
          borderRadius: height / 2,
          backgroundColor: pressed ? C.primaryEdge : C.primaryTint,
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 8,
          paddingHorizontal: 16,
        },
        style,
      ]}>
      <Icon name={icon} size={height >= 56 ? 18 : 16} color={C.primaryDeep} strokeWidth={2} />
      <Text numberOfLines={1} style={[{ fontSize: height >= 56 ? 15 : 14, color: C.primaryDeep }, weight(700)]}>
        {label}
      </Text>
    </Pressable>
  );
}

/** A wash-filled box with an optional glyph — V3's form field. */
function WashInput({
  icon,
  value,
  onChangeText,
  placeholder,
  keyboardType,
  a11y,
  style,
}: {
  icon?: IconName;
  value: string;
  onChangeText: (v: string) => void;
  placeholder: string;
  keyboardType?: 'phone-pad' | 'decimal-pad';
  a11y: string;
  style?: object;
}) {
  return (
    <View
      style={[
        {
          height: icon ? 52 : 48,
          borderRadius: 16,
          backgroundColor: C.canvas,
          flexDirection: 'row',
          alignItems: 'center',
          gap: 10,
          paddingHorizontal: 14,
        },
        style,
      ]}>
      {icon ? <Icon name={icon} size={18} color={C.muted} strokeWidth={2} /> : null}
      <TextInput
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={C.faint}
        keyboardType={keyboardType}
        accessibilityLabel={a11y}
        style={{ flex: 1, minWidth: 0, height: '100%', fontSize: 15, color: C.ink }}
      />
    </View>
  );
}

/** One line of the Overview's facts: a glyph (or a short word) and its values. */
function InfoRow({
  icon,
  word,
  a11y,
  first = false,
  children,
}: {
  icon?: IconName;
  word?: string;
  a11y?: string;
  first?: boolean;
  children: React.ReactNode;
}) {
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: 10,
        minHeight: 40,
        paddingVertical: 4,
        borderTopWidth: first ? 0 : 1,
        borderTopColor: C.hairline,
      }}>
      {icon ? (
        <View accessible accessibilityRole="image" accessibilityLabel={a11y}>
          <Icon name={icon} size={16} color={C.muted} strokeWidth={2} />
        </View>
      ) : (
        <Text style={[{ fontSize: 11, color: C.muted, minWidth: 30 }, weight(700)]}>{word}</Text>
      )}
      {children}
    </View>
  );
}

/**
 * ONE BILL, and what was on it.
 *
 * The number, the date and the amount are what a shopkeeper reads off his own
 * copy, so they are what the card leads with — an invoice conversation starts
 * with "MMI/26-27/1119" and not with a balance.
 *
 * WHAT IT WAS FOR IS FOLDED AWAY until he taps. Half these bills are one line
 * and half are eight, and unfolding every one of them turns a year's statement
 * into a scroll nobody reaches the bottom of. The count is on the closed card,
 * because "4 items" is usually the whole answer.
 *
 * AN UNSTATED BILL SAYS SO INSTEAD OF SHOWING A BALANCE. Its balance is the
 * full amount purely because nobody has recorded anything against it either
 * way — the office keeps it out of the outstanding figure, and drawing it
 * beside real balances is the imported-book mistake arriving on a phone.
 */
function BillCard({
  bill,
  balanceAfterPaise,
  open,
  onToggle,
}: {
  bill: CustomerBill;
  balanceAfterPaise: number;
  open: boolean;
  onToggle: () => void;
}) {
  const lines = open ? billLines(bill) : [];
  const unstated = bill.paymentPosition === 'unstated';
  const settled = !unstated && (bill.balancePaise ?? 0) <= 0;
  const count = bill.lineCount ?? 0;

  const late = !settled && !unstated && (bill.overdueDays ?? 0) > 0;

  return (
    <View style={{ backgroundColor: C.surface, borderRadius: 20, paddingVertical: 14, paddingHorizontal: 16 }}>
      <Pressable
        onPress={onToggle}
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        accessibilityLabel={'What was on bill ' + (bill.billNo ?? '')}
        accessibilityHint={count ? count + (count === 1 ? ' item' : ' items') + (open ? '' : ', tap to see them') : 'No items listed'}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
          <View style={{ width: 30, height: 30, borderRadius: 15, backgroundColor: C.infoBg, alignItems: 'center', justifyContent: 'center' }}>
            <Icon name="doc" size={15} color={C.info} strokeWidth={2} />
          </View>
          <Text style={[{ flex: 1, minWidth: 0, fontSize: 15, color: C.ink }, weight(700)]} numberOfLines={1}>
            {bill.billNo ?? 'Bill'}
          </Text>
          <Text style={[{ fontSize: 16, lineHeight: 22, color: C.ink }, weight(800), tabular]}>
            {bill.amountPaise != null ? inrFromPaise(bill.amountPaise) : '—'}
          </Text>
        </View>

        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap', marginTop: 8 }}>
          <Text style={{ fontSize: 12, lineHeight: 17, color: C.muted }}>
            {pretty(bill.billDate) + (bill.dueDate ? ' · due ' + pretty(bill.dueDate) : '')}
          </Text>
          {settled ? (
            <Badge tone="success">Paid</Badge>
          ) : unstated ? (
            <Badge tone="neutral">No info</Badge>
          ) : late ? (
            <Badge tone="danger">{bill.overdueDays + ' d late'}</Badge>
          ) : (
            <Badge tone="amber">Open</Badge>
          )}
          {bill.disputed ? <Badge tone="danger">Disputed</Badge> : null}
          <View style={{ flex: 1 }} />
          <Text style={[{ fontSize: 12, lineHeight: 17, color: unstated || settled ? C.muted : C.danger }, weight(unstated || settled ? 500 : 700)]}>
            {unstated
              ? 'No payment info yet'
              : settled
                ? 'Paid in full'
                : inrFromPaise(bill.balancePaise ?? 0) + ' open'}
          </Text>
        </View>

        {open ? (
          lines.length ? (
            <View style={{ borderTopWidth: 1, borderTopColor: C.hairline, paddingTop: 8, marginTop: 10, gap: 6 }}>
              {lines.map((l, i) => (
                <View key={l.product + i} style={{ flexDirection: 'row', alignItems: 'baseline', gap: 10 }}>
                  <Text style={{ flex: 1, minWidth: 0, fontSize: 13, lineHeight: 18, color: C.body }}>{l.product}</Text>
                  <Text style={[{ fontSize: 13, lineHeight: 18, color: C.ink }, weight(700), tabular]}>
                    {/* CANS, which is what the customer says and what the office
                        stores. Litres are derived from the pack size and are not
                        on the wire, so naming a unit we were not sent would be
                        the screen inventing one. */}
                    {l.qty}
                  </Text>
                  <Text style={[{ width: 84, textAlign: 'right', fontSize: 13, lineHeight: 18, color: C.body }, tabular]}>
                    {l.amountPaise != null ? inrFromPaise(l.amountPaise) : '—'}
                  </Text>
                </View>
              ))}
            </View>
          ) : (
            <Text style={{ fontSize: 12, lineHeight: 17, color: C.muted, borderTopWidth: 1, borderTopColor: C.hairline, paddingTop: 8, marginTop: 10 }}>
              The office has no items listed for this bill.
            </Text>
          )
        ) : null}

        <Text style={{ fontSize: 12, lineHeight: 17, color: C.muted, marginTop: 8 }}>
          {'Balance after · ' +
            inrFromPaise(balanceAfterPaise) +
            ' · ' +
            (count ? count + (count === 1 ? ' item' : ' items') + (open ? ' ▴' : ' ▾') : 'no items listed')}
        </Text>
      </Pressable>
    </View>
  );
}

/**
 * ONE PAYMENT, with what it was and whether it has counted.
 *
 * A REJECTED OR REVERSED receipt is drawn rather than hidden: the shopkeeper
 * will say "we paid that" and the salesman has to be able to answer. It is
 * drawn muted with its own word, because the one thing it must not read like
 * is money in the bank.
 */
function ReceiptCard({
  receipt,
  balanceAfterPaise,
}: {
  receipt: CustomerPayment;
  balanceAfterPaise: number;
}) {
  const counted = countsAsMoney(receipt.status);
  const tone: BadgeTone =
    receipt.status === 'confirmed'
      ? 'success'
      : receipt.status === 'rejected' || receipt.status === 'reversed'
        ? 'danger'
        : 'amber';
  const word =
    receipt.status === 'confirmed'
      ? 'Received'
      : receipt.status === 'reported'
        ? 'With accounts'
        : receipt.status === 'held'
          ? 'Being checked'
          : receipt.status === 'rejected'
            ? 'Never arrived'
            : receipt.status === 'reversed'
              ? 'Reversed'
              : (receipt.status ?? 'Unknown');

  return (
    <View
      accessible
      accessibilityLabel={[
        receipt.amountPaise != null ? inrFromPaise(receipt.amountPaise) : 'No amount',
        word,
        pretty(receipt.receivedAt),
        receipt.mode,
        receipt.reference,
        counted ? inrFromPaise(balanceAfterPaise) + ' outstanding after this' : 'Not taken off the balance yet',
      ]
        .filter(Boolean)
        .join(', ')}
      style={{ backgroundColor: C.surface, borderRadius: 20, paddingVertical: 14, paddingHorizontal: 16, flexDirection: 'row', alignItems: 'center', gap: 10 }}>
      <View
        style={{
          width: 30,
          height: 30,
          borderRadius: 15,
          backgroundColor: counted ? C.successBg : C.warnBg,
          alignItems: 'center',
          justifyContent: 'center',
        }}>
        <Icon name="wallet" size={15} color={counted ? C.success : C.warnInk} strokeWidth={2} />
      </View>
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text style={[{ fontSize: 16, lineHeight: 22, color: counted ? C.success : C.muted }, weight(800), tabular]}>
          {receipt.amountPaise != null ? inrFromPaise(receipt.amountPaise) : '—'}
        </Text>
        <Text style={{ marginTop: 2, fontSize: 12, lineHeight: 17, color: C.muted }}>
          {[
            pretty(receipt.receivedAt),
            receipt.mode,
            receipt.reference,
            counted ? 'after ' + inrFromPaise(balanceAfterPaise) : 'not off balance yet',
          ]
            .filter(Boolean)
            .join(' · ')}
        </Text>
      </View>
      <Badge tone={tone}>{word}</Badge>
    </View>
  );
}

/**
 * A trial's state as a colour.
 *
 * Converted is the only good ending and reads as one; Rejected is a real
 * answer rather than a failure, so it is neutral rather than red — a shop that
 * tried the drum and said no has told the salesman something worth knowing,
 * and colouring it like a fault is how that stops being recorded.
 */
function sampleTone(state: string): BadgeTone {
  if (state === 'Converted') return 'success';
  if (state === 'Awaiting feedback') return 'amber';
  if (state === 'Rejected') return 'neutral';
  return 'info';
}
