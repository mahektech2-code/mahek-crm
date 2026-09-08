import React from 'react';
import { View, Text, Pressable, ScrollView } from 'react-native';
import { router, useFocusEffect } from 'expo-router';
import { color as C, HIT, radius, type, weight, tabular, type BadgeTone } from '../src/theme/tokens';
import { Icon } from '../src/components/ui/Icon';
import { Badge, Card, HealthPill, Input, PrimaryButton } from '../src/components/ui/primitives';
import { AppFrame } from '../src/components/shell/AppFrame';
import { useCustomer, useStore } from '../src/state/store';
import { customerSamples, type Sample } from '../src/data/requests';
import {
  competitorRecords,
  customerOrders,
  customerPayments,
  customerTimeline,
  recordCompetitor,
  type CustomerOrder,
  type CustomerPayment,
  type TimelineEvent,
} from '../src/data/customers';
import { inr, isoDate, pretty, shopName } from '../src/lib/format';
import { callNumber, openWhatsApp } from '../src/lib/messaging';

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

const TABS = ['Overview', 'Timeline', 'Orders', 'Payments', 'Samples', 'Competitors'];
const TL_FILTERS = ['All', 'Visits', 'Orders', 'Payments', 'Calls', 'Complaints'];

/** The stream's own event types, in the words the design puts on the badge. */
const KIND_LABEL: Record<string, string> = {
  visit: 'Visit',
  order: 'Order',
  payment: 'Payment',
  payment_bounced: 'Payment',
  complaint: 'Complaint',
  whatsapp: 'WhatsApp',
  call: 'Telecaller',
  telecaller_call: 'Telecaller',
};

const TONES: Record<string, BadgeTone> = {
  Visit: 'teal',
  Order: 'info',
  Payment: 'success',
  Complaint: 'danger',
  WhatsApp: 'success',
  Telecaller: 'amber',
};

/** "a minute ago", "4 hours ago" — how old the cached figures are. */
function freshness(at: number): string {
  if (!at) return 'not synced yet';
  const mins = Math.max(0, Math.round((Date.now() - at) / 60_000));
  if (mins < 1) return 'just now';
  if (mins < 60) return mins + ' min ago';
  const hours = Math.round(mins / 60);
  if (hours < 24) return hours === 1 ? 'an hour ago' : hours + ' hours ago';
  const days = Math.round(hours / 24);
  return days === 1 ? 'yesterday' : days + ' days ago';
}

export default function CustomerRecord() {
  const c = useCustomer();
  const pTab = useStore((s) => s.pTab);
  const tlFilter = useStore((s) => s.tlFilter);
  const set = useStore((s) => s.set);
  const notify = useStore((s) => s.notify);
  const beginVisit = useStore((s) => s.beginVisit);

  const [events, setEvents] = React.useState<TimelineEvent[]>([]);
  const [orders, setOrders] = React.useState<CustomerOrder[]>([]);
  const [receipts, setReceipts] = React.useState<CustomerPayment[]>([]);
  const [samples, setSamples] = React.useState<Sample[]>([]);
  const [competitors, setCompetitors] = React.useState<Awaited<ReturnType<typeof competitorRecords>>>([]);
  const [compForm, setCompForm] = React.useState(false);
  const [comp, setComp] = React.useState({ name: '', rate: '', note: '', credit: '', delivery: '', strengths: '', weaknesses: '' });
  const [compBusy, setCompBusy] = React.useState(false);

  const id = c?.id ?? null;

  const reload = React.useCallback(() => {
    if (!id) return;
    void Promise.all([
      customerTimeline(id, tlFilter),
      competitorRecords(id),
      customerOrders(id),
      customerPayments(id),
      customerSamples(id),
    ]).then(([t, k, o, r, sm]) => {
      setOrders(o);
      setReceipts(r);
      setSamples(sm);
      setEvents(t);
      setCompetitors(k);
    });
  }, [id, tlFilter]);

  useFocusEffect(
    React.useCallback(() => {
      let live = true;
      if (!id) return;
      void Promise.all([
      customerTimeline(id, tlFilter),
      competitorRecords(id),
      customerOrders(id),
      customerPayments(id),
      customerSamples(id),
    ]).then(([t, k, o, r, sm]) => {
      setOrders(o);
      setReceipts(r);
      setSamples(sm);
        if (!live) return;
        setEvents(t);
        setCompetitors(k);
      });
      return () => {
        live = false;
      };
    }, [id, tlFilter]),
  );

  const saveCompetitor = async () => {
    if (!id) return;
    if (!comp.name.trim()) return notify('A name is enough to start — who is it?');
    setCompBusy(true);
    const rateRupees = Number(comp.rate.replace(/[^\d]/g, ''));
    await recordCompetitor({
      customerId: id,
      competitorName: comp.name.trim(),
      ratePaise: rateRupees > 0 ? rateRupees * 100 : null,
      rateNote: comp.note.trim() || null,
      creditTerms: comp.credit.trim() || null,
      delivery: comp.delivery.trim() || null,
      strengths: comp.strengths.trim() || null,
      weaknesses: comp.weaknesses.trim() || null,
    });
    setCompBusy(false);
    setComp({ name: '', rate: '', note: '', credit: '', delivery: '', strengths: '', weaknesses: '' });
    setCompForm(false);
    notify('Noted · ' + comp.name.trim());
    reload();
  };

  /* A record that has not arrived on this handset yet is said plainly rather
     than rendered as somebody else's figures under a blank name. */
  if (!c) {
    return (
      <AppFrame title="Customer" activeTab="customers" onBack={() => router.back()} contentStyle={{ padding: 16 }}>
        <Card style={{ paddingVertical: 32, paddingHorizontal: 20, alignItems: 'center' }}>
          <Text style={[{ fontSize: 15, color: C.ink }, weight(600)]}>Not on this phone yet</Text>
          <Text style={[type.small, { color: C.muted, textAlign: 'center', marginTop: 6 }]}>
            This customer arrives with the next sync.
          </Text>
        </Card>
      </AppFrame>
    );
  }

  const dues = c.outstandingPaise / 100;
  const owner = c.contactPerson ?? c.name;

  return (
    <AppFrame title={shopName(c.name)} activeTab="customers" onBack={() => router.back()} contentStyle={{ paddingBottom: 24 }}>
      {/* ---- the head ---- */}
      <View style={{ backgroundColor: C.surface, borderBottomWidth: 1, borderBottomColor: C.hairline, padding: 16 }}>
        <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 12 }}>
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text style={type.h2}>{shopName(c.name)}</Text>
            <Text style={[type.caption, { marginTop: 2 }]}>
              {[c.contactPerson, c.city, c.phone].filter(Boolean).join(' · ')}
            </Text>
          </View>
          {c.healthScore != null ? <HealthPill value={c.healthScore} large /> : null}
        </View>

        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 16, marginTop: 12, paddingTop: 12, borderTopWidth: 1, borderTopColor: C.hairline }}>
          <View>
            <Text style={type.label}>Outstanding</Text>
            <Text style={[{ fontSize: 15, color: dues > 300000 ? C.danger : C.ink }, weight(500), tabular]}>
              {dues ? inr(dues) : 'Nothing due'}
            </Text>
          </View>
          <View style={{ width: 1, height: 28, backgroundColor: C.hairline }} />
          <View>
            <Text style={type.label}>Credit</Text>
            <Text style={[{ fontSize: 15, color: C.ink }, weight(500)]}>
              {c.creditDays != null ? c.creditDays + ' days' : '—'}
            </Text>
          </View>
        </View>

        {/* The age of the figures above, in the caption slot the design already
            uses for exactly this kind of aside. */}
        <Text style={[type.caption, { marginTop: 6 }]}>{'From the office ' + freshness(c.lastSyncedAt)}</Text>

        <View style={{ flexDirection: 'row', gap: 8, marginTop: 14 }}>
          <Pressable
            onPress={() => { beginVisit(c.id); router.push('/visit'); }}
            style={{ flex: 1, height: 52, borderRadius: radius.md, backgroundColor: C.primary, alignItems: 'center', justifyContent: 'center' }}>
            <Text style={[{ fontSize: 15, color: '#FFFFFF' }, weight(600)]}>Visit</Text>
          </Pressable>
          {[
            {
              g: 'call',
              l: 'Call ' + owner,
              run: () => (c.phone ? void callNumber(c.phone) : notify('No number on this customer')),
            },
            {
              g: 'chat',
              l: 'WhatsApp ' + owner,
              run: async () => {
                if (!c.phone) return notify('No number on this customer');
                const out = await openWhatsApp(c.phone, '');
                if (out.status !== 'handed_off') notify(out.reason);
              },
            },
            { g: 'order', l: 'New order', run: () => router.push('/order?from=customer') },
          ].map((b) => (
            <Pressable
              key={b.g}
              onPress={b.run}
              accessibilityLabel={b.l}
              style={{ width: 56, height: 52, borderRadius: radius.md, borderWidth: 1, borderColor: C.border, backgroundColor: C.surface, alignItems: 'center', justifyContent: 'center' }}>
              <Icon name={b.g} size={18} color={C.body} />
            </Pressable>
          ))}
        </View>
      </View>

      {/* ---- tabs ---- */}
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ backgroundColor: C.surface, borderBottomWidth: 1, borderBottomColor: C.hairline, flexGrow: 0 }}>
        {TABS.map((t, i) => {
          const on = pTab === i;
          return (
            <Pressable
              key={t}
              onPress={() => set({ pTab: i })}
              style={{ height: HIT, paddingHorizontal: 16, borderBottomWidth: 2, borderBottomColor: on ? C.primary : 'transparent', alignItems: 'center', justifyContent: 'center' }}>
              <Text style={[{ fontSize: 15, color: on ? C.primaryDeep : C.muted }, weight(on ? 500 : 400)]}>{t}</Text>
            </Pressable>
          );
        })}
      </ScrollView>

      <View style={{ padding: 16 }}>
        {/* ---- overview ---- */}
        {pTab === 0 ? (
          <View style={{ gap: 12 }}>
            <Card>
              <Text style={[type.label, { marginBottom: 10 }]}>Basics</Text>
              {[
                /* Outstanding first. It is the fact that changes what he says
                   when the door opens, and it was on the card and not here —
                   so the record, which is the screen you open to prepare, was
                   the one place it could not be read. */
                {
                  label: 'Outstanding',
                  value: c.outstandingPaise ? inr(c.outstandingPaise / 100) : 'Nothing outstanding',
                },
                { label: 'Contact', value: c.contactPerson ?? '—' },
                { label: 'Phone', value: c.phone ?? '—' },
                { label: 'Where', value: [c.area, c.city].filter(Boolean).join(', ') || '—' },
                { label: 'Beat', value: c.beat ?? '—' },
                { label: 'GST', value: c.gstin ?? '—' },
                { label: 'Dealer code', value: c.dealerCode ?? '—' },
                {
                  label: 'Credit limit',
                  value: c.creditLimitPaise != null ? inr(c.creditLimitPaise / 100) : 'Not set',
                },
                { label: 'Credit days', value: c.creditDays != null ? c.creditDays + ' days' : '—' },
                { label: 'Price list', value: c.priceTag ?? '—' },
                { label: 'Potential', value: c.potential ?? '—' },
                { label: 'Orders every', value: c.cycleDays != null ? c.cycleDays + ' days' : '—' },
                { label: 'Last visit', value: pretty(c.lastVisitDate) },
                { label: 'Last order', value: pretty(c.lastOrderDate) },
              ].map((b) => (
                <View key={b.label} style={{ flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', gap: 16, paddingVertical: 8, borderTopWidth: 1, borderTopColor: C.wash }}>
                  <Text style={{ fontSize: 13, color: C.muted }}>{b.label}</Text>
                  <Text style={{ fontSize: 15, color: C.ink, textAlign: 'right', flexShrink: 1 }}>{b.value}</Text>
                </View>
              ))}
            </Card>

            {/* The last six bills, as the office scored them. Nothing is derived
                here — payment behaviour is the server's to compute. */}
            <PayBehaviour raw={c.payBehaviour} />
          </View>
        ) : null}

        {/* ---- timeline ---- */}
        {pTab === 1 ? (
          <View>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8, paddingBottom: 10 }}>
              {TL_FILTERS.map((f) => {
                const on = tlFilter === f;
                return (
                  <Pressable
                    key={f}
                    onPress={() => set({ tlFilter: f })}
                    style={{ height: HIT, paddingHorizontal: 14, borderRadius: 20, borderWidth: 1, borderColor: on ? C.primary : C.border, backgroundColor: on ? C.primaryTint : C.surface, alignItems: 'center', justifyContent: 'center' }}>
                    <Text style={[{ fontSize: 14, color: on ? C.primaryDeep : C.body }, weight(on ? 500 : 400)]}>{f}</Text>
                  </Pressable>
                );
              })}
            </ScrollView>

            {events.map((e, i) => {
              const last = i === events.length - 1;
              const kind = KIND_LABEL[e.eventType] ?? 'Visit';
              return (
                <View
                  key={e.id}
                  style={{
                    position: 'relative',
                    paddingLeft: 20,
                    paddingBottom: last ? 0 : 18,
                    marginLeft: 4,
                    borderLeftWidth: 1,
                    borderLeftColor: last ? 'transparent' : C.border,
                  }}>
                  <View
                    style={{
                      position: 'absolute',
                      left: -5,
                      top: 4,
                      width: 10,
                      height: 10,
                      borderRadius: 5,
                      borderWidth: 2,
                      borderColor: C.wash,
                      backgroundColor: kind === 'Telecaller' ? C.warn : C.faint,
                    }}
                  />
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                    <Badge tone={TONES[kind] ?? 'teal'}>{kind}</Badge>
                    <Text style={{ fontSize: 12, color: C.muted }}>
                      {pretty(isoDate(new Date(e.occurredAt))) + ' · ' + (e.actor ?? '')}
                    </Text>
                  </View>
                  <Text style={[type.small, { color: C.ink, marginTop: 4 }]}>{e.summary}</Text>
                  {e.sourceApp !== 'mbos' ? (
                    <Text style={[type.caption, { marginTop: 2 }]}>From the desk team</Text>
                  ) : null}
                </View>
              );
            })}

            <Text style={[type.caption, { marginTop: 8 }]}>
              This is a record of what happened, so nothing can be added here — every entry comes from the screen that
              created it.
            </Text>
          </View>
        ) : null}

        {/* ---- orders / payments / samples ---- */}
        {/* ---- what they bought ---- */}
        {pTab === 2 ? (
          <View style={{ gap: 10 }}>
            {orders.length === 0 ? (
              <Empty
                head="No orders on this handset"
                body="The office's order history arrives with the day's sync. If this shop has ordered and nothing is here, sign out and in once."
              />
            ) : (
              <>
                {orders.map((o) => (
                  <Card key={o.id} style={{ gap: 4 }}>
                    <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline', gap: 12 }}>
                      <Text style={[{ fontSize: 15, color: C.ink }, weight(600)]}>
                        {o.valuePaise != null ? inr(o.valuePaise / 100) : 'Value not recorded'}
                      </Text>
                      <Text style={type.caption}>{pretty(o.orderedAt)}</Text>
                    </View>
                    <Text style={type.caption}>
                      {[
                        o.orderNo ? 'No. ' + o.orderNo : null,
                        o.lines ? o.lines + (o.lines === 1 ? ' line' : ' lines') : null,
                        o.status,
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                    </Text>
                  </Card>
                ))}
                <Slice n={orders.length} noun="order" />
              </>
            )}
          </View>
        ) : null}

        {/* ---- what they paid ---- */}
        {pTab === 3 ? (
          <View style={{ gap: 10 }}>
            {receipts.length === 0 ? (
              <Empty
                head="No payments on this handset"
                body="Receipts the office has recorded arrive with the day's sync. If this shop has paid and nothing is here, sign out and in once."
              />
            ) : (
              <>
                {receipts.map((r) => (
                  <Card key={r.id} style={{ gap: 4 }}>
                    <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline', gap: 12 }}>
                      <Text
                        style={[
                          {
                            fontSize: 15,
                            /* Only confirmed money has moved anything. A
                               rejected or reversed receipt is shown rather than
                               hidden — the customer will say "we paid that",
                               and he needs an answer — but it must not read
                               like money in the bank. */
                            color: r.status === 'confirmed' ? C.ink : C.muted,
                          },
                          weight(600),
                        ]}>
                        {r.amountPaise != null ? inr(r.amountPaise / 100) : '—'}
                      </Text>
                      <Text style={type.caption}>{pretty(r.receivedAt)}</Text>
                    </View>
                    <Text style={type.caption}>
                      {[r.mode, r.reference, r.status].filter(Boolean).join(' · ')}
                    </Text>
                  </Card>
                ))}
                <Slice n={receipts.length} noun="payment" />
              </>
            )}
          </View>
        ) : null}

        {/* ---- what they were given to try ---- */}
        {pTab === 4 ? (
          <View style={{ gap: 10 }}>
            {samples.length === 0 ? (
              <Empty
                head="No trials on this shop"
                body="Samples you raise here show up straight away. The office only sends down the ones still open, so a trial closed at a desk stays there."
              />
            ) : (
              <>
                {samples.map((sm) => (
                  <Card key={sm.id} style={{ gap: 4 }}>
                    <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline', gap: 12 }}>
                      <Text style={[{ fontSize: 15, color: C.ink, flexShrink: 1 }, weight(600)]}>
                        {sm.productName ?? 'Product not recorded'}
                      </Text>
                      <Badge tone={sampleTone(sm.state)}>{sm.state}</Badge>
                    </View>
                    <Text style={type.caption}>
                      {[
                        sm.cans ? sm.cans + (sm.cans === 1 ? ' can' : ' cans') : null,
                        'given ' + pretty(isoDate(new Date(sm.requestedAt))),
                        sm.trialOutcome && sm.trialOutcome !== 'pending' ? 'outcome: ' + sm.trialOutcome : null,
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                    </Text>
                    {/* The promise, and only while it is still a promise. A
                        follow-up date on a trial that is already converted or
                        rejected is a date nobody is going to keep. */}
                    {sm.followUpDate && sm.state !== 'Converted' && sm.state !== 'Rejected' ? (
                      <Text style={[type.caption, { color: C.body }]}>
                        {'Ask again ' + pretty(sm.followUpDate)}
                      </Text>
                    ) : null}
                    {sm.reason ? <Text style={type.caption}>{sm.reason}</Text> : null}
                  </Card>
                ))}
              </>
            )}
          </View>
        ) : null}

        {/* ---- competitors ---- */}
        {pTab === 5 ? (
          <View>
            {!compForm ? (
              <Pressable
                onPress={() => setCompForm(true)}
                style={{ width: '100%', height: 52, borderRadius: radius.sm, borderWidth: 1, borderStyle: 'dashed', borderColor: C.faint, backgroundColor: C.surface, alignItems: 'center', justifyContent: 'center' }}>
                <Text style={[{ fontSize: 15, color: C.primary }, weight(500)]}>+ Add what you heard</Text>
              </Pressable>
            ) : (
              <Card style={{ gap: 10 }}>
                <Text style={[{ fontSize: 15, color: C.ink }, weight(600)]}>What you heard</Text>
                <Input
                  value={comp.name}
                  onChangeText={(v) => setComp((s) => ({ ...s, name: v }))}
                  placeholder="Competitor's name"
                />
                <Input
                  value={comp.rate}
                  onChangeText={(v) => setComp((s) => ({ ...s, rate: v.replace(/[^0-9]/g, '') }))}
                  keyboardType="number-pad"
                  placeholder="Rate quoted, ₹ (optional)"
                />
                <Input
                  value={comp.note}
                  onChangeText={(v) => setComp((s) => ({ ...s, note: v }))}
                  placeholder="Which product, and any note on the rate"
                />
                <Input
                  value={comp.credit}
                  onChangeText={(v) => setComp((s) => ({ ...s, credit: v }))}
                  placeholder="Credit terms they offer (optional)"
                />
                <Input
                  value={comp.strengths}
                  onChangeText={(v) => setComp((s) => ({ ...s, strengths: v }))}
                  placeholder="What they are doing well (optional)"
                />
                <Input
                  value={comp.weaknesses}
                  onChangeText={(v) => setComp((s) => ({ ...s, weaknesses: v }))}
                  placeholder="Where we can win (optional)"
                />
                <View style={{ flexDirection: 'row', gap: 8, marginTop: 4 }}>
                  <Pressable
                    onPress={() => setCompForm(false)}
                    style={{ flex: 1, height: 48, borderRadius: radius.sm, alignItems: 'center', justifyContent: 'center' }}>
                    <Text style={{ fontSize: 15, color: C.muted }}>Cancel</Text>
                  </Pressable>
                  <View style={{ flex: 1 }}>
                    <PrimaryButton label={compBusy ? 'Saving…' : 'Save'} onPress={saveCompetitor} disabled={compBusy} />
                  </View>
                </View>
              </Card>
            )}
            <Text style={[type.caption, { marginTop: 10 }]}>
              Fill this in from the conversation — a name and a rate is enough to be useful.
            </Text>

            <View style={{ gap: 12, marginTop: 12 }}>
              {competitors.map((k) => (
                <Card key={k.id}>
                  <View style={{ flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', gap: 12 }}>
                    <Text style={[{ fontSize: 15, color: C.ink, flexShrink: 1 }, weight(500)]}>{k.competitorName}</Text>
                    <Text style={[{ fontSize: 15, color: C.ink }, weight(500), tabular]}>
                      {k.ratePaise != null ? inr(k.ratePaise / 100) : (k.rateNote ?? '')}
                    </Text>
                  </View>
                  <Text style={[type.caption, { marginTop: 2 }]}>
                    {[k.creditTerms, k.delivery].filter(Boolean).join(' · ')}
                  </Text>
                  <Text style={[type.caption, { color: C.body, marginTop: 8 }]}>{k.strengths ?? k.weaknesses ?? ''}</Text>
                  <Text style={{ fontSize: 12, color: C.muted, marginTop: 8 }}>
                    {'Heard on the visit, ' + pretty(isoDate(new Date(k.capturedAt)))}
                  </Text>
                </Card>
              ))}
            </View>
          </View>
        ) : null}
      </View>
    </AppFrame>
  );
}

/**
 * Six bills, oldest left. The height IS the verdict — a short red bar reads as
 * trouble before the legend is read.
 *
 * `payBehaviour` is the server's own scoring, carried as JSON. A row that has
 * never been scored shows nothing rather than six green bars nobody earned.
 */
function PayBehaviour({ raw }: { raw: string | null }) {
  const pay = React.useMemo<number[]>(() => {
    if (!raw) return [];
    try {
      const parsed: unknown = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed.map((v) => Number(v) || 0).slice(-6) : [];
    } catch {
      return [];
    }
  }, [raw]);

  if (pay.length === 0) return null;
  const lateCount = pay.filter((v) => v > 0).length;

  return (
    <Card>
      <Text style={type.label}>How they pay</Text>
      <View style={{ flexDirection: 'row', alignItems: 'flex-end', gap: 6, height: 48, marginTop: 12 }}>
        {pay.map((v, i) => (
          <View
            key={i}
            accessibilityLabel={['On time', 'Late', 'Very late'][v] ?? 'On time'}
            style={{
              flex: 1,
              height: v === 0 ? 44 : v === 1 ? 30 : 18,
              borderRadius: 3,
              backgroundColor: v === 0 ? C.success : v === 1 ? C.warn : C.danger,
            }}
          />
        ))}
      </View>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 16, marginTop: 10, flexWrap: 'wrap' }}>
        {[
          ['On time', C.success],
          ['Late', C.warn],
          ['Very late', C.danger],
        ].map(([l, col]) => (
          <View key={l} style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
            <View style={{ width: 10, height: 10, borderRadius: 2, backgroundColor: col }} />
            <Text style={{ fontSize: 13, color: C.muted }}>{l}</Text>
          </View>
        ))}
      </View>
      <Text style={[type.caption, { color: C.body, marginTop: 10 }]}>
        {lateCount === 0
          ? 'Paid on time every one of the last six bills.'
          : lateCount + ' of the last six bills went past the due date.'}
      </Text>
    </Card>
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
    <Card style={{ paddingVertical: 32, paddingHorizontal: 20, alignItems: 'center' }}>
      <Text style={[{ fontSize: 15, color: C.ink, textAlign: 'center' }, weight(600)]}>{head}</Text>
      <Text style={[type.small, { color: C.muted, textAlign: 'center', marginTop: 6 }]}>{body}</Text>
    </Card>
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
    <Text style={[type.caption, { textAlign: 'center', marginTop: 2 }]}>
      {'The last ' + n + ' ' + noun + 's. Older ones stay in the office.'}
    </Text>
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
