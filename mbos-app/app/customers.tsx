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
import {
  addFieldShop,
  billableCustomers,
  customerStage,
  daysSince,
  listCustomers,
  type Customer,
} from '../src/data/customers';

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

  /* ------------------------------------- a shop that is not on the book yet
   *
   * He is standing in an outlet nobody has recorded, with an order his
   * distributor will be invoiced for. Without somewhere to put it he either
   * abandons the order or files it as though the distributor received the
   * goods, and where the lorry actually went is lost.
   *
   * It hangs off the EMPTY SEARCH, because that is the moment he finds out —
   * he types the name, nothing comes back, and the answer to "it is not here"
   * should be in the same place as the question.
   */
  const [adding, setAdding] = React.useState(false);
  const [shopName, setShopName] = React.useState('');
  const [shopPhone, setShopPhone] = React.useState('');
  const [shopCity, setShopCity] = React.useState('');
  const [billers, setBillers] = React.useState<Customer[]>([]);
  const [billerId, setBillerId] = React.useState<string | null>(null);
  const [billerQ, setBillerQ] = React.useState('');
  const [saving, setSaving] = React.useState(false);
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

  /* Only while the sheet is open, and re-read as he narrows it: the book is a
     territory, not six rows, so this is a query rather than a filter. */
  React.useEffect(() => {
    if (!adding) return;
    let live = true;
    void billableCustomers(billerQ).then((r) => {
      if (live) setBillers(r);
    });
    return () => {
      live = false;
    };
  }, [adding, billerQ]);

  const openAdd = () => {
    /* Seeded with what he already typed. He has just searched for the shop by
       name; asking him to type it again is the sort of thing that gets a
       feature left unused. */
    setShopName(custQ.trim());
    setShopPhone('');
    setShopCity('');
    setBillerId(null);
    setBillerQ('');
    setAdding(true);
  };

  const saveShop = async () => {
    const biller = billers.find((b) => b.id === billerId);
    if (!biller) return notify('Say who is billed for this shop.');
    setSaving(true);
    try {
      const r = await addFieldShop({
        name: shopName,
        phone: shopPhone,
        city: shopCity,
        distributorCustomerId: biller.id,
        distributorName: biller.name,
      });
      if (!r.ok) return notify(r.message);
      setAdding(false);
      notify('Shop added · queued, syncs when you have signal');
      /* Straight into it, because he opened it to do something — take the
         order he is holding. */
      set({ custId: r.customerId, pTab: 0 });
      router.push('/customer');
    } finally {
      setSaving(false);
    }
  };

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

      {/* Nothing matched. The one thing worth offering is the thing he is
          about to need — and the sentence says which kind of shop this opens,
          because a record we bill is the office's to create. */}
      {rows.length === 0 ? (
        <Card style={{ marginTop: 12, alignItems: 'center', paddingVertical: 28 }}>
          <Text style={[{ fontSize: 15, color: C.ink, textAlign: 'center' }, weight(500)]}>
            {custQ.trim() ? 'No shop matches that' : 'Nothing in your book yet'}
          </Text>
          <Text style={[type.caption, { marginTop: 4, textAlign: 'center', paddingHorizontal: 24 }]}>
            If you are standing in a shop we deliver to on somebody else&apos;s bill, open it
            here and take the order.
          </Text>
          <View style={{ marginTop: 14, alignSelf: 'stretch', paddingHorizontal: 24 }}>
            <PrimaryButton label="Add a delivery shop" onPress={openAdd} />
          </View>
        </Card>
      ) : null}

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

      {/* --------------------------------------- opening a shop from inside it
          Four answers and no more. Every field here is one he can give without
          leaving the counter he is standing at; credit, terms and health are
          the office's to decide and the record arrives without them rather
          than with a confident zero. */}
      <BottomSheet open={adding} onClose={() => setAdding(false)} scroll>
        <Text style={[{ fontSize: 15, color: C.ink, marginBottom: 2 }, weight(600)]}>
          Add a delivery shop
        </Text>
        <Text style={[type.caption, { marginBottom: 12 }]}>
          Goods go here; the bill goes to whoever you pick below.
        </Text>

        <Field label="Shop name" value={shopName} onChange={setShopName} placeholder="As it is written on the board" />
        <Field
          label="Phone"
          value={shopPhone}
          onChange={setShopPhone}
          placeholder="10 digits"
          keyboard="phone-pad"
        />
        <Field label="Town" value={shopCity} onChange={setShopCity} placeholder="Nashik" />

        <Text style={[type.caption, { marginTop: 14, marginBottom: 6 }]}>WHO IS BILLED FOR IT</Text>
        <TextInput
          value={billerQ}
          onChangeText={setBillerQ}
          placeholder="Search your accounts"
          placeholderTextColor={C.faint}
          style={{
            height: 44,
            paddingHorizontal: 12,
            borderWidth: 1,
            borderColor: C.border,
            borderRadius: radius.sm,
            fontSize: 15,
            color: C.ink,
            backgroundColor: C.surface,
          }}
        />
        <View style={{ gap: 6, marginTop: 8 }}>
          {billers.slice(0, 6).map((b) => (
            <Pressable
              key={b.id}
              onPress={() => setBillerId(b.id)}
              style={{
                borderWidth: 1,
                borderColor: b.id === billerId ? C.primaryDeep : C.border,
                borderRadius: radius.sm,
                paddingHorizontal: 12,
                paddingVertical: 10,
              }}>
              <Text style={[{ fontSize: 14, color: C.ink }, weight(b.id === billerId ? 500 : 400)]}>
                {b.name}
              </Text>
              <Text style={type.caption}>{[b.contactPerson, b.city].filter(Boolean).join(' · ')}</Text>
            </Pressable>
          ))}
          {billers.length === 0 ? (
            <Text style={type.caption}>
              {billerQ.trim() ? 'No account of yours matches that.' : 'You have no accounts to bill yet.'}
            </Text>
          ) : null}
        </View>

        <View style={{ marginTop: 16 }}>
          <PrimaryButton
            label={saving ? 'Adding…' : 'Add the shop'}
            onPress={() => void saveShop()}
          />
        </View>
      </BottomSheet>
    </AppFrame>
  );
}

/**
 * One labelled box.
 *
 * Local to this screen rather than a primitive: three fields is not a design
 * system, and the app's `Input` is built for the taller, icon-bearing boxes
 * the rest of the flows use.
 */
function Field({
  label,
  value,
  onChange,
  placeholder,
  keyboard,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  keyboard?: 'phone-pad';
}) {
  return (
    <View style={{ marginBottom: 10 }}>
      <Text style={[type.caption, { marginBottom: 4 }]}>{label.toUpperCase()}</Text>
      <TextInput
        value={value}
        onChangeText={onChange}
        placeholder={placeholder}
        placeholderTextColor={C.faint}
        keyboardType={keyboard}
        style={{
          height: 44,
          paddingHorizontal: 12,
          borderWidth: 1,
          borderColor: C.border,
          borderRadius: radius.sm,
          fontSize: 15,
          color: C.ink,
          backgroundColor: C.surface,
        }}
      />
    </View>
  );
}
