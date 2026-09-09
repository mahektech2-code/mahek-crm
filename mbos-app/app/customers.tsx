import React from 'react';
import { View, Text, Pressable, TextInput } from 'react-native';
import { router, useFocusEffect } from 'expo-router';
import { color as C, HIT, radius, type, weight } from '../src/theme/tokens';
import { Icon } from '../src/components/ui/Icon';
import { Card, HealthPill, PrimaryButton } from '../src/components/ui/primitives';
import { BottomSheet } from '../src/components/ui/overlays';
import { AppFrame } from '../src/components/shell/AppFrame';
import { useStore } from '../src/state/store';
import { distanceLabel, inr, isoDate, plural, pretty, shopName } from '../src/lib/format';
import { reorderLabel, reorderState } from '../src/engines/leads';
import { callNumber, openMaps, openWhatsApp } from '../src/lib/messaging';
import {
  accountType,
  addFieldShop,
  billableCustomers,
  cityOrigins,
  customerStage,
  daysSince,
  listCustomersPage,
  type Customer,
} from '../src/data/customers';
import {
  CUSTOMER_PAGE,
  metresFromDist2,
  type BookView,
  type Origin,
} from '../src/data/customer-query';
import { ShopMap } from '../src/components/ui/shop-map';
import { whereNow } from '../src/native/where';

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
  const [newShopName, setNewShopName] = React.useState('');
  const [shopPhone, setShopPhone] = React.useState('');
  const [shopCity, setShopCity] = React.useState('');
  const [billers, setBillers] = React.useState<Customer[]>([]);
  const [billerId, setBillerId] = React.useState<string | null>(null);
  const [billerQ, setBillerQ] = React.useState('');
  const [saving, setSaving] = React.useState(false);
  const [rows, setRows] = React.useState<Customer[]>([]);
  const [total, setTotal] = React.useState(0);
  const [hasMore, setHasMore] = React.useState(false);
  const [loadingMore, setLoadingMore] = React.useState(false);
  const [today] = React.useState(() => isoDate(new Date()));
  /*
   * WHICH HALF OF THE BOOK. Customers, leads, or both.
   *
   * It is a VIEW and not a scope: all three show only his own, and a territory
   * has already narrowed them to where he works. Nothing here reaches another
   * salesman's book.
   */
  const [view, setView] = React.useState<BookView>('all');
  /*
   * LIST OR MAP, and the tap means a different thing on each SCREEN rather than
   * on each mode: here it opens the record, and on the journey screen the same
   * component adds a stop. The component takes the handler rather than deciding,
   * so neither screen has to know about the other.
   */
  const [asMap, setAsMap] = React.useState(false);

  /* ------------------------------------------------- where to measure from
   *
   * Three answers, and the screen says which one it is using. `me` is the
   * trail's own freshest fix — `whereNow()` never waits on the radio, so
   * choosing it costs nothing and returns instantly. A city is the mean of the
   * shops pinned in it, read out of the book. `null` is the honest third
   * answer: no fix, no city, so the book is alphabetical and nobody is being
   * told a distance that was never measured.
   */
  const [originMode, setOriginMode] = React.useState<'me' | 'name' | string>('me');
  const [origin, setOrigin] = React.useState<Origin>(null);
  const [cities, setCities] = React.useState<{ city: string; lat: number; lng: number; n: number }[]>([]);
  const [pickingCity, setPickingCity] = React.useState(false);
  const [noFix, setNoFix] = React.useState(false);

  /* The search runs in SQLite, not over a list held in memory — the book is a
     territory, not six rows, and the query reaches the owner, the city, the
     phone and the GST number because that is whichever one the customer just
     said on the phone. */
  /* The towns, once. They change when the book does, not while he reads it. */
  React.useEffect(() => {
    void cityOrigins().then(setCities);
  }, []);

  /* Resolving the origin is separate from reading the page, because it can
     answer "there is no fix" — which is a thing the screen has to SAY rather
     than silently fall back from. */
  React.useEffect(() => {
    let live = true;
    if (originMode === 'name') {
      setOrigin(null);
      setNoFix(false);
      return;
    }
    if (originMode === 'me') {
      void whereNow().then((w) => {
        if (!live) return;
        const has = typeof w?.lat === 'number' && typeof w?.lng === 'number';
        setOrigin(has ? { lat: w!.lat!, lng: w!.lng! } : null);
        setNoFix(!has);
      });
      return () => {
        live = false;
      };
    }
    const city = cities.find((c) => c.city === originMode);
    setOrigin(city ? { lat: city.lat, lng: city.lng } : null);
    setNoFix(false);
    return () => {
      live = false;
    };
  }, [originMode, cities]);

  /* THE FIRST PAGE ONLY. A changed search or a changed origin is a different
     question, so the answer starts again from the top rather than appending to
     the last one. */
  useFocusEffect(
    React.useCallback(() => {
      let live = true;
      void listCustomersPage({ query: custQ, origin, view }).then((p) => {
        if (!live) return;
        setRows(p.rows);
        setTotal(p.total);
        setHasMore(p.hasMore);
      });
      return () => {
        live = false;
      };
    }, [custQ, origin, view]),
  );

  /* Load more APPENDS, and asks for the page after what is on screen — never
     a page number, which would skip or repeat a row the moment the book
     changed underneath. */
  const loadMore = async () => {
    if (loadingMore || !hasMore) return;
    setLoadingMore(true);
    try {
      const p = await listCustomersPage({ query: custQ, origin, view, offset: rows.length });
      setRows((prev) => [...prev, ...p.rows]);
      setTotal(p.total);
      setHasMore(p.hasMore);
    } finally {
      setLoadingMore(false);
    }
  };

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
    setNewShopName(custQ.trim());
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
        name: newShopName,
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

      {/* LIST OR MAP. One tap, always visible, and the state is obvious from
          which side is filled — a map hidden behind a menu is one nobody finds. */}
      <View style={{ flexDirection: 'row', gap: 8, marginTop: 12, alignItems: 'center' }}>
        {([
          { key: false, label: 'List' },
          { key: true, label: 'Map' },
        ] as const).map((chip) => {
          const on = asMap === chip.key;
          return (
            <Pressable
              key={String(chip.key)}
              onPress={() => setAsMap(chip.key)}
              style={{
                paddingHorizontal: 14,
                paddingVertical: 7,
                borderRadius: radius.sm,
                borderWidth: 1,
                borderColor: on ? C.ink : C.border,
                backgroundColor: on ? C.ink : C.surface,
              }}>
              <Text style={[{ fontSize: 13, color: on ? C.surface : C.body }, weight(500)]}>
                {chip.label}
              </Text>
            </Pressable>
          );
        })}
      </View>

      {/* WHICH HALF. A view, never a scope — all three show only his own book,
          already narrowed to the territory he works. Drawn beside "where from"
          rather than buried in the filter sheet because it changes what the
          list IS, and a list whose subject is hidden behind a menu is one people
          misread. */}
      <View style={{ flexDirection: 'row', gap: 8, marginTop: 12, alignItems: 'center' }}>
        {([
          { key: 'all', label: 'Everything' },
          { key: 'customers', label: 'Customers' },
          { key: 'leads', label: 'Leads' },
        ] as const).map((chip) => {
          const on = view === chip.key;
          return (
            <Pressable
              key={chip.key}
              onPress={() => setView(chip.key)}
              style={{
                paddingHorizontal: 12,
                paddingVertical: 7,
                borderRadius: radius.sm,
                borderWidth: 1,
                borderColor: on ? C.ink : C.border,
                backgroundColor: on ? C.ink : C.surface,
              }}>
              <Text style={[{ fontSize: 13, color: on ? C.surface : C.body }, weight(500)]}>
                {chip.label}
              </Text>
            </Pressable>
          );
        })}
      </View>

      {/* WHERE FROM. Three chips rather than a menu: it is one tap, it is
          always visible, and the one in use is the answer to "why is this shop
          at the top". */}
      <View style={{ flexDirection: 'row', gap: 8, marginTop: 12, alignItems: 'center' }}>
        {[
          { key: 'me', label: 'Near me' },
          { key: 'city', label: cities.some((c) => c.city === originMode) ? originMode : 'By city' },
          { key: 'name', label: 'A\u2013Z' },
        ].map((chip) => {
          const on =
            chip.key === 'city'
              ? cities.some((c) => c.city === originMode)
              : originMode === chip.key;
          return (
            <Pressable
              key={chip.key}
              onPress={() => (chip.key === 'city' ? setPickingCity(true) : setOriginMode(chip.key))}
              style={{
                paddingHorizontal: 12,
                paddingVertical: 7,
                borderRadius: radius.sm,
                borderWidth: 1,
                borderColor: on ? C.ink : C.border,
                backgroundColor: on ? C.ink : C.surface,
              }}>
              <Text style={[{ fontSize: 13, color: on ? C.surface : C.body }, weight(500)]}>
                {chip.label}
              </Text>
            </Pressable>
          );
        })}
      </View>

      {/* A CAPPED LIST SAYS WHAT IT IS A SLICE OF, and the count comes from
          SQL rather than from what happens to be loaded — otherwise the first
          page of a book of six hundred reads as a book of fifteen. */}
      <Text style={[type.caption, { marginTop: 10 }]}>
        {total === 0
          ? 'Nothing in your book yet'
          : rows.length < total
            ? `Showing ${rows.length} of ${plural(total, 'customer')}`
            : plural(total, 'customer') + ' \u00b7 your territory'}
        {origin && originMode === 'me' ? ' \u00b7 nearest first' : ''}
        {origin && originMode !== 'me' && originMode !== 'name' ? ` \u00b7 nearest ${originMode} first` : ''}
      </Text>

      {/* Asked and could not is a different fact from never asked, and the
          salesman is the one who can do something about it. */}
      {noFix && originMode === 'me' ? (
        <Text style={[type.caption, { marginTop: 4, color: C.muted }]}>
          {'No location fix yet, so this is A\u2013Z for now. Check in, or pick a city.'}
        </Text>
      ) : null}

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

      {/* THE MAP. Only the loaded page is drawn, deliberately: the list pages
          fifteen at a time and a map that quietly showed the whole book would
          disagree with the count above it. The sentence under the map says what
          could not be placed. */}
      {asMap && rows.length ? (
        <View style={{ marginTop: 12 }}>
          <ShopMap
            pins={rows.map((x) => ({
              id: x.id,
              name: x.name,
              lat: x.gpsLat ?? NaN,
              lng: x.gpsLng ?? NaN,
            }))}
            /* HERE a tap opens the record. On the journey screen the same
               component adds a stop — the difference lives in the caller, so
               neither screen knows about the other. */
            onPress={(pin) => {
              set({ custId: pin.id, pTab: 0 });
              router.push('/customer');
            }}
          />
        </View>
      ) : null}

      <View style={{ gap: 12, marginTop: 8 }}>
        {asMap ? null : rows.map((x) => {
          /* Rupees at the point of display, paise everywhere behind it. */
          const dues = x.outstandingPaise / 100;
          const stage = customerStage(x);
          const seenDays = daysSince(x.lastVisitDate, today);
          const type_ = accountType(x);
          /* Only where the origin is the salesman himself. A distance from the
             middle of a town he picked is not how far HE has to walk, and
             printing it as though it were would be a lie of the most useful
             kind — believable, and acted on. */
          const away = originMode === 'me' ? distanceLabel(metresFromDist2(x.dist2)) : null;
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
                    {shopName(x.name)}
                  </Text>
                  <Text numberOfLines={1} style={[type.caption, { marginTop: 2 }]}>
                    {/* How far, first and in ink: standing in a street it is
                        the one fact on the card he acts on immediately. */}
                    {away ? (
                      <Text style={[{ color: C.ink }, weight(500)]}>{away}</Text>
                    ) : null}
                    {away && (x.contactPerson || x.city) ? '  ·  ' : ''}
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

              {/* §P — due to reorder, on the customer's OWN measured rhythm.
                  Derived on the phone from two columns every row already
                  carries, so it is right in a market lane with no signal.
                  Above the status row rather than inside it: the status is what
                  the account IS, this is what to do about it today. */}
              {reorderLabel(x.lastOrderDate, x.cycleDays, today) ? (
                <Text
                  style={[
                    {
                      fontSize: 14,
                      lineHeight: 20,
                      marginTop: 4,
                      color:
                        reorderState(x.lastOrderDate, x.cycleDays, today) === 'overdue'
                          ? C.danger
                          : C.warnInk,
                    },
                    weight(500),
                  ]}>
                  {reorderLabel(x.lastOrderDate, x.cycleDays, today)}
                </Text>
              ) : null}

              <View
                style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  marginTop: 8,
                }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
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

                {/* Quiet, and on the other side of the row: it is a fact about
                    the account rather than about today, so it should be
                    findable without competing with the one that is. */}
                {type_ ? (
                  <View
                    style={{
                      paddingHorizontal: 8,
                      paddingVertical: 3,
                      borderRadius: radius.sm,
                      borderWidth: 1,
                      borderColor: C.border,
                      backgroundColor: C.wash,
                    }}>
                    <Text style={[{ fontSize: 11, color: C.muted, letterSpacing: 0.3 }, weight(500)]}>
                      {type_}
                    </Text>
                  </View>
                ) : null}
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
                {
                  /* `pin`, not `nav`. The two glyphs were the wrong way round:
                     `visit` and `pin` are the SAME path — a map pin — so the
                     button that checks you in was drawn as the universal symbol
                     for "show me on a map", and the one that opens maps was a
                     compass nobody reads that way. Tapping the pin expecting
                     directions checked you into the shop instead. */
                  g: 'pin',
                  l: 'Navigate',
                  run: async () => {
                    const out = await openMaps({
                      lat: x.gpsLat,
                      lng: x.gpsLng,
                      name: x.name,
                      city: x.city,
                    });
                    if (out.status !== 'opened') notify(out.reason);
                  },
                },
                { g: 'shop', l: 'Visit', run: () => { beginVisit(x.id); router.push('/visit'); } },
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

      {/* MORE, ON REQUEST. A button rather than infinite scroll: the next
          fifteen cost a query and a render, and a salesman scrolling to find
          one shop should not silently pull his whole territory onto the JS
          thread — which is the fault this whole screen was rebuilt around. */}
      {hasMore ? (
        <Pressable
          onPress={loadMore}
          disabled={loadingMore}
          style={({ pressed }) => [
            {
              marginTop: 12,
              height: 48,
              alignItems: 'center',
              justifyContent: 'center',
              borderWidth: 1,
              borderColor: C.border,
              borderRadius: radius.sm,
              backgroundColor: C.surface,
            },
            pressed && { backgroundColor: C.wash },
          ]}>
          <Text style={[{ fontSize: 14, color: C.ink }, weight(500)]}>
            {loadingMore
              ? 'Loading\u2026'
              : `Load ${Math.min(CUSTOMER_PAGE, total - rows.length)} more`}
          </Text>
        </Pressable>
      ) : null}

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

      {/* THE TOWNS COME OUT OF THE BOOK, never a list typed into a screen —
          the day somebody sells into a new town a hardcoded list is wrong and
          nothing says so. A town with no pinned shop cannot be measured from,
          so it is not offered. */}
      <BottomSheet open={pickingCity} onClose={() => setPickingCity(false)} scroll>
        <Text style={[{ fontSize: 17, color: C.ink, marginBottom: 4 }, weight(600)]}>
          Nearest to which town?
        </Text>
        <Text style={[type.caption, { marginBottom: 12 }]}>
          The book is sorted outwards from the middle of the town you pick.
        </Text>
        {cities.length === 0 ? (
          <Text style={[type.caption, { paddingVertical: 12 }]}>
            No shop in your book has been pinned yet, so there is nowhere to measure from.
          </Text>
        ) : (
          cities.map((c) => (
            <Pressable
              key={c.city}
              onPress={() => {
                setOriginMode(c.city);
                setPickingCity(false);
              }}
              style={({ pressed }) => [
                {
                  flexDirection: 'row',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  paddingVertical: 13,
                  borderBottomWidth: 1,
                  borderBottomColor: C.border,
                },
                pressed && { backgroundColor: C.wash },
              ]}>
              <Text style={[{ fontSize: 15, color: C.ink }, weight(500)]}>{c.city}</Text>
              <Text style={type.caption}>{plural(c.n, 'shop')}</Text>
            </Pressable>
          ))
        )}
      </BottomSheet>

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

        <Field label="Shop name" value={newShopName} onChange={setNewShopName} placeholder="As it is written on the board" />
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
