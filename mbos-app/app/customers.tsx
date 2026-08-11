import React from 'react';
import { View, Text, Pressable, TextInput } from 'react-native';
import { router, useFocusEffect } from 'expo-router';
import { color as C, HIT, radius, type, weight } from '../src/theme/tokens';
import { Icon } from '../src/components/ui/Icon';
import { Card, HealthPill, PrimaryButton } from '../src/components/ui/primitives';
import { BottomSheet } from '../src/components/ui/overlays';
import { AppFrame } from '../src/components/shell/AppFrame';
import { useStore } from '../src/state/store';
import { inr, isoDate, plural, pretty } from '../src/lib/format';
import { callNumber, openWhatsApp } from '../src/lib/messaging';
import { customerStage, daysSince, listCustomers, type Customer } from '../src/data/customers';

/**
 * The book. Search reaches the name, the owner, the city, the phone and the
 * GST number, because a salesman looking someone up mid-conversation has
 * whichever of those the customer just said.
 */

const FILTERS = [
  { glyph: 'visit', label: 'Area', sub: 'Nagpur, Pune, Nashik…' },
  { glyph: 'money', label: 'Outstanding', sub: 'Only those who owe' },
  { glyph: 'clock', label: 'Not seen recently', sub: '30 days or more' },
  { glyph: 'spark', label: 'New customers', sub: 'Added this quarter' },
];

export default function Customers() {
  const custQ = useStore((s) => s.custQ);
  const set = useStore((s) => s.set);
  const notify = useStore((s) => s.notify);
  const beginVisit = useStore((s) => s.beginVisit);
  const sheet = useStore((s) => s.sheet);

  const [rowMore, setRowMore] = React.useState<Customer | null>(null);
  const [rows, setRows] = React.useState<Customer[]>([]);
  const [today] = React.useState(() => isoDate(new Date()));

  /* The search runs in SQLite, not over a list held in memory — the book is a
     territory, not six rows, and the query reaches the owner, the city, the
     phone and the GST number because that is whichever one the customer just
     said on the phone. */
  useFocusEffect(
    React.useCallback(() => {
      let live = true;
      void listCustomers(custQ).then((r) => {
        if (live) setRows(r);
      });
      return () => {
        live = false;
      };
    }, [custQ]),
  );

  return (
    <AppFrame title="Customers" activeTab="customers" contentStyle={{ paddingHorizontal: 16, paddingTop: 12, paddingBottom: 24 }}>
      <View style={{ position: 'relative' }}>
        <View style={{ position: 'absolute', left: 14, top: 16, zIndex: 1 }}>
          <Icon name="search" size={20} color={C.muted} strokeWidth={1.5} />
        </View>
        <TextInput
          value={custQ}
          onChangeText={(v) => set({ custQ: v })}
          placeholder="Name, phone, GST, city or code"
          placeholderTextColor={C.faint}
          style={{
            width: '100%',
            height: 52,
            paddingLeft: 42,
            paddingRight: 56,
            borderWidth: 1,
            borderColor: C.border,
            borderRadius: radius.sm,
            fontSize: 15,
            color: C.ink,
            backgroundColor: C.surface,
          }}
        />
        <Pressable
          onPress={() => set({ sheet: 'filters' })}
          accessibilityLabel="Filter customers"
          style={{ position: 'absolute', right: 2, top: 2, width: HIT, height: HIT, alignItems: 'center', justifyContent: 'center' }}>
          <Icon name="filter" size={22} color={C.body} strokeWidth={1.5} />
        </Pressable>
      </View>

      <Text style={[type.caption, { marginTop: 12 }]}>{plural(rows.length, 'customer') + ' · your territory'}</Text>

      <View style={{ gap: 12, marginTop: 8 }}>
        {rows.map((x) => {
          /* Rupees at the point of display, paise everywhere behind it. */
          const dues = x.outstandingPaise / 100;
          const stage = customerStage(x);
          const seenDays = daysSince(x.lastVisitDate, today);
          return (
          <Card key={x.id} padded={false} style={{ overflow: 'hidden' }}>
            <Pressable
              onPress={() => {
                set({ custId: x.id, pTab: 0 });
                router.push('/customer');
              }}
              style={{ padding: 16 }}>
              <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 12 }}>
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Text numberOfLines={1} style={[{ fontSize: 14, lineHeight: 20, color: C.ink }, weight(500)]}>
                    {x.name}
                  </Text>
                  <Text style={[type.caption, { marginTop: 2 }]}>
                    {[x.contactPerson, x.city].filter(Boolean).join(' · ')}
                  </Text>
                </View>
                {/* A customer the office has not scored yet gets no pill at all —
                    a zero would read as the worst score there is. */}
                {x.healthScore != null ? <HealthPill value={x.healthScore} /> : null}
              </View>

              <Text
                style={[
                  { fontSize: 15, marginTop: 10, color: dues > 300000 ? C.danger : dues ? C.ink : C.success },
                  weight(500),
                ]}>
                {dues ? inr(dues) + ' outstanding' : 'Nothing outstanding'}
              </Text>
              <Text style={[type.caption, { marginTop: 2 }]}>
                {(seenDays == null ? 'Not seen yet' : 'Seen ' + seenDays + 'd ago') +
                  ' · ordered ' +
                  pretty(x.lastOrderDate)}
              </Text>

              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 8 }}>
                <View
                  style={{
                    width: 8,
                    height: 8,
                    borderRadius: 4,
                    backgroundColor: stage === 'Overdue' ? C.danger : stage === 'At risk' ? C.warn : C.success,
                  }}
                />
                <Text style={{ fontSize: 14, color: C.body }}>{stage}</Text>
              </View>
            </Pressable>

            {/* Six one-tap actions. The whole point of the card is that the
                common thing does not require opening the record first. */}
            <View style={{ flexDirection: 'row', borderTopWidth: 1, borderTopColor: C.hairline }}>
              {[
                {
                  g: 'call',
                  l: 'Call',
                  run: () => {
                    if (!x.phone) return notify('No number on this customer');
                    void callNumber(x.phone);
                  },
                },
                {
                  g: 'chat',
                  l: 'WhatsApp',
                  run: async () => {
                    if (!x.phone) return notify('No number on this customer');
                    /* Handed to his own WhatsApp — nothing is sent on the
                       company's behalf, and nothing is recorded as sent. */
                    const out = await openWhatsApp(x.phone, '');
                    if (out.status !== 'handed_off') notify(out.reason);
                  },
                },
                { g: 'nav', l: 'Navigate', run: () => notify('Maps to ' + x.name) },
                { g: 'visit', l: 'Visit', run: () => { beginVisit(x.id); router.push('/visit'); } },
                { g: 'order', l: 'Order', run: () => { set({ custId: x.id }); router.push('/order?from=customers'); } },
                { g: 'dots', l: 'More', run: () => { set({ custId: x.id }); setRowMore(x); } },
              ].map((a) => (
                <Pressable
                  key={a.l}
                  onPress={a.run}
                  accessibilityLabel={a.l}
                  style={({ pressed }) => [
                    { flex: 1, height: 52, alignItems: 'center', justifyContent: 'center' },
                    pressed && { backgroundColor: C.wash },
                  ]}>
                  <Icon name={a.g} size={20} color={C.body} />
                </Pressable>
              ))}
            </View>
          </Card>
          );
        })}
      </View>

      {rows.length === 0 ? (
        <Card style={{ marginTop: 8, paddingVertical: 40, paddingHorizontal: 20, alignItems: 'center' }}>
          <Text style={[{ fontSize: 15, color: C.ink }, weight(600)]}>Nothing matches that</Text>
          <Text style={[type.small, { color: C.muted, textAlign: 'center', marginTop: 6 }]}>
            Try a shorter word, or clear the filters.
          </Text>
          <PrimaryButton
            label="Clear filters"
            fullWidth={false}
            onPress={() => set({ custQ: '' })}
            style={{ marginTop: 16, borderRadius: radius.sm }}
          />
        </Card>
      ) : null}

      <BottomSheet open={sheet === 'filters'} onClose={() => set({ sheet: null })}>
        <Text style={[{ fontSize: 15, color: C.ink, marginBottom: 4 }, weight(600)]}>Narrow it down</Text>
        {FILTERS.map((f) => (
          <Pressable
            key={f.label}
            onPress={() => { set({ sheet: null }); notify(f.label + ' filter'); }}
            style={{ flexDirection: 'row', alignItems: 'center', gap: 14, height: 60 }}>
            <View style={{ width: HIT, height: HIT, borderRadius: radius.sm, backgroundColor: C.primaryTint, alignItems: 'center', justifyContent: 'center' }}>
              <Icon name={f.glyph} size={18} color={C.body} />
            </View>
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text style={[{ fontSize: 15, color: C.ink }, weight(500)]}>{f.label}</Text>
              <Text style={type.caption}>{f.sub}</Text>
            </View>
          </Pressable>
        ))}
      </BottomSheet>

      <BottomSheet open={!!rowMore} onClose={() => setRowMore(null)}>
        <Text style={[{ fontSize: 15, color: C.ink, marginBottom: 4 }, weight(600)]}>{rowMore?.name ?? ''}</Text>
        {[
          { g: 'sample', l: 'Request sample', s: 'Sent for approval' },
          { g: 'note', l: 'Log complaint', s: 'Goes to the desk team' },
          { g: 'doc', l: 'Send quotation', s: 'From the price list' },
          { g: 'doc', l: 'Documents', s: 'Agreements and KYC' },
        ].map((i) => (
          <Pressable
            key={i.l}
            onPress={() => {
              const name = rowMore?.name ?? '';
              setRowMore(null);
              notify(i.l === 'Documents' ? 'Documents' : i.l.replace('Request sample', 'Sample for ' + name).replace('Log complaint', 'Complaint for ' + name).replace('Send quotation', 'Quotation for ' + name));
            }}
            style={{ flexDirection: 'row', alignItems: 'center', gap: 14, height: 60 }}>
            <View style={{ width: HIT, height: HIT, borderRadius: radius.sm, backgroundColor: C.primaryTint, alignItems: 'center', justifyContent: 'center' }}>
              <Icon name={i.g} size={18} color={C.body} />
            </View>
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text style={[{ fontSize: 15, color: C.ink }, weight(500)]}>{i.l}</Text>
              <Text style={type.caption}>{i.s}</Text>
            </View>
          </Pressable>
        ))}
      </BottomSheet>
    </AppFrame>
  );
}
