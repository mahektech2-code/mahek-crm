import React from 'react';
import { View, Text, Pressable, TextInput, FlatList } from 'react-native';
import { router, useFocusEffect } from 'expo-router';
import { color as C, HIT, radius, shadow, type, weight } from '../src/theme/tokens';
import { Icon } from '../src/components/ui/Icon';
import { Card, HealthPill, PrimaryButton } from '../src/components/ui/primitives';
import { BottomSheet } from '../src/components/ui/overlays';
import { AppFrame } from '../src/components/shell/AppFrame';
import { useStore } from '../src/state/store';
import { getConfig } from '../src/data/config';
import { distanceLabel, inr, isoDate, plural, pretty, shopName } from '../src/lib/format';
import { reorderLabel, reorderState } from '../src/engines/leads';
import { callNumber, openMaps, openWhatsApp } from '../src/lib/messaging';
import {
  accountLine,
  addFieldShop,
  billableCustomers,
  cityOrigins,
  customerStage,
  daysSince,
  listCustomersPage,
  OUTSTANDING_ALERT_PAISE,
  type Customer,
} from '../src/data/customers';
import {
  CUSTOMER_PAGE,
  metresFromDist2,
  type BookView,
  type Origin,
} from '../src/data/customer-query';
import { ShopMap } from '../src/components/ui/shop-map';
import { territoryState } from '../src/sync/pull';
import type { TerritoryState } from '../src/sync/api';
import { whereNow } from '../src/native/where';

/**
 * The book. Search reaches the name, the owner, the city, the phone and the
 * GST number, because a salesman looking someone up mid-conversation has
 * whichever of those the customer just said.
 *
 * IT IS A `FlatList`, and that is not a preference. The rows were `rows.map()`
 * inside the frame's own `ScrollView`, so every shop loaded was mounted at
 * once — a book of a couple of thousand is a couple of thousand cards, six
 * pressables each, built on the JS thread while somebody waits with a customer
 * in front of them. The frame is told `scroll={false}` and the list owns the
 * scrolling: a `FlatList` nested inside a `ScrollView` virtualises nothing and
 * warns about it, which is the one way to get the cost of both and the benefit
 * of neither.
 */

/** How long a typed name waits before it becomes a query. See `typed` below. */
const SEARCH_PAUSE_MS = 250;

/** Held out of the render so the map mode never hands the list a fresh array. */
const NO_ROWS: Customer[] = [];

/** The gap the old wrapping `View` carried as `gap: 12`. */
function RowGap() {
  return <View style={{ height: 12 }} />;
}

/**
 * A town, short enough to sit on a chip.
 *
 * `customers.city` holds whatever the office typed, and on the real book that
 * is often a whole postal address — "06, MAHADEV TOWERS CO-OP HSG SOC, LTD,
 * LBS MARG, HARINIWAS CIRCLE, Thane, Maharashtra, 400602" offered as a city.
 * Printed whole it pushed the A–Z chip off the right edge of the screen, which
 * made picking a town the thing that took away the one sort setting he could
 * not get back to.
 *
 * It is SHORTENED rather than parsed. The first comma-separated piece of that
 * string is "06", so guessing which piece is the town would put a confidently
 * wrong place name on the screen with nothing saying so.
 */
function shortPlace(place: string, max = 22): string {
  const one = place.replace(/\s+/g, ' ').trim();
  return one.length <= max ? one : one.slice(0, max - 1).trimEnd() + '…';
}

export default function Customers() {
  const custQ = useStore((s) => s.custQ);
  const set = useStore((s) => s.set);
  const notify = useStore((s) => s.notify);
  const askTravel = useStore((s) => s.askTravel);

  /* The two health thresholds. Read from configuration, never typed here —
     they used to be a literal 70 and 50 inside the pill, which put two
     business numbers where the one screen a manager would change them on
     could not see them. */
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
  /* NULL UNTIL THE READ ANSWERS, and that distinction is load-bearing — see
     `noBook` below. An empty array is the terminal answer "no account on this
     handset can be billed", which takes the save button off the sheet; starting
     there meant every first open of the sheet flashed that sentence over a
     query still in flight, on handsets that had a book. */
  const [billers, setBillers] = React.useState<Customer[] | null>(null);
  const [billerId, setBillerId] = React.useState<string | null>(null);
  const [billerQ, setBillerQ] = React.useState('');
  const [saving, setSaving] = React.useState(false);
  const [rows, setRows] = React.useState<Customer[]>([]);
  const [total, setTotal] = React.useState(0);
  const [hasMore, setHasMore] = React.useState(false);
  const [loadingMore, setLoadingMore] = React.useState(false);
  /*
   * WHETHER THE BOOK HAS ANSWERED YET, and whether it could.
   *
   * `rows` starts empty, so every empty-state sentence on this screen was true
   * of a query that had not run — an unallocated handset and a handset that
   * simply had not read SQLite yet drew the same card. Nothing terminal is
   * claimed until `loaded`, and a read that fails says so rather than leaving
   * a card that never arrives.
   */
  const [loaded, setLoaded] = React.useState(false);
  const [failed, setFailed] = React.useState(false);
  const [today] = React.useState(() => isoDate(new Date()));
  /*
   * WHAT THE OFFICE LAST SAID ABOUT WHERE HE WORKS.
   *
   * Read on focus rather than once on mount: territory is changed at a desk in
   * the middle of a working day, the shops leave the handset on the next pull,
   * and a screen that had cached "you have an area" would then show the wrong
   * sentence over an empty list — the one failure this whole thing exists to
   * remove.
   *
   * Null means the server has never said, which is an older server or a handset
   * that has not pulled since this shipped. Null is NOT "no area": it draws the
   * ordinary empty state, because telling somebody their area is unset when
   * nobody has actually said so sends them to the office for nothing.
   */
  const [territory, setTerritory] = React.useState<TerritoryState | null>(null);
  /*
   * WHICH HALF OF THE BOOK. Customers, leads, or both.
   *
   * It is a VIEW and not a scope: all three show only his own, and a territory
   * has already narrowed them to where he works. Nothing here reaches another
   * salesman's book.
   */
  const [view, setView] = React.useState<BookView>('all');
  /* What the count below is counting. `all` holds both, and calling that
     "customers" is the screen arguing with its own Leads chip. */
  const counted = view === 'leads' ? 'lead' : view === 'customers' ? 'customer' : 'account';
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

  /*
   * WHAT HE HAS TYPED, AND WHAT HAS BEEN ASKED, are two different things.
   *
   * `custQ` went straight into the store on every keystroke, and the focus
   * effect below runs a COUNT(*) and a page query — six `LIKE '%…%'` predicates
   * apiece that no index can serve — over the whole book. On a territory of a
   * couple of thousand shops that is two full table scans per character, and it
   * is the screen he uses most, mid-conversation, one-handed. The pause is what
   * turns a name into one pair of queries instead of one pair per letter.
   */
  const [typed, setTyped] = React.useState(custQ);
  React.useEffect(() => {
    if (typed === custQ) return;
    const t = setTimeout(() => set({ custQ: typed }), SEARCH_PAUSE_MS);
    return () => clearTimeout(t);
  }, [typed, custQ, set]);

  /* The search runs in SQLite, not over a list held in memory — the book is a
     territory, not six rows, and the query reaches the owner, the city, the
     phone and the GST number because that is whichever one the customer just
     said. */
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
      void listCustomersPage({ query: custQ, origin, view })
        .then((p) => {
          if (!live) return;
          setRows(p.rows);
          setTotal(p.total);
          setHasMore(p.hasMore);
          setFailed(false);
          setLoaded(true);
        })
        .catch(() => {
          if (!live) return;
          setFailed(true);
          setLoaded(true);
        });
      void territoryState().then((t) => {
        if (live) setTerritory(t);
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
    void billableCustomers(billerQ)
      .then((r) => {
        if (live) setBillers(r);
      })
      /* A read that never answers leaves the sheet reading "Reading your
         accounts…" with no button under it and no way forward, which is the
         worse of the two dead ends. Failing to the empty answer at least lands
         on a sentence and a reason. */
      .catch(() => {
        if (live) setBillers([]);
      });
    return () => {
      live = false;
    };
  }, [adding, billerQ]);

  const openAdd = () => {
    /* Seeded with what he already typed. He has just searched for the shop by
       name; asking him to type it again is the sort of thing that gets a
       feature left unused. */
    setNewShopName(typed.trim());
    setShopPhone('');
    setShopCity('');
    setBillerId(null);
    setBillerQ('');
    setAdding(true);
  };

  const saveShop = async () => {
    /* The real lock. `PrimaryButton` has no submit state of its own, and
       `addFieldShop` is an insert plus an outbox entry — a second tap during it
       puts the same shop on the book twice, and the order he is standing there
       to take goes against one of them. */
    if (saving) return;
    const biller = billers?.find((b) => b.id === billerId);
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

  /*
   * ONE TAP, ONE DESTINATION, however the shop was found.
   *
   * A LEAD OPENS THE LEAD SCREEN, and everything else opens the customer
   * record. `/customer` for a lead is a page of empty ledgers — no dues, no
   * bills, no order history — and, far worse, the only screen in the app with
   * no route to the funnel on it. The ladder, the §28 gates and both forms
   * live on `/lead`.
   *
   * The list row was taught that and the map pin beside it was not, so the
   * identical shop, tapped two ways one toggle apart, landed him either on the
   * funnel or on a page he could do nothing from — and the map is the view he
   * uses standing in the street. It is one function now and both callers pass
   * through it, so the two cannot drift apart again.
   *
   * `custId` is set either way: `/lead` links across to the record, and the
   * record is what the back button lands on.
   */
  const openAccount = React.useCallback(
    (x: { id: string; isLead?: number | boolean | null }) => {
      set({ custId: x.id, pTab: 0 });
      if (x.isLead) router.push(`/lead?id=${x.id}&from=customers`);
      else router.push('/customer');
    },
    [set],
  );

  /* Only ever true when the server has SAID so — see the state above. `exempt`
     is a manager or an admin, for whom the rule does not apply at all and who
     must not be told to go and ask for a territory. */
  const noArea = territory !== null && !territory.exempt && !territory.allocated;
  const area = territory?.allocated ? territory.places : [];
  const asked = custQ.trim();
  /* What the count is a count OF. A search that matches three rows used to
     print "3 customers · your territory", which asserts a fact about his book
     that is really a fact about his query — read an hour later it says the
     book has collapsed. */
  const matching = asked ? ` · matching “${shortPlace(asked, 18)}”` : '';

  const header = (
    <View>
      <View style={{ position: 'relative' }}>
        <View style={{ position: 'absolute', left: 14, top: 16, zIndex: 1 }}>
          <Icon name="search" size={20} color={C.muted} strokeWidth={1.5} />
        </View>
        <TextInput
          value={typed}
          onChangeText={setTyped}
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
        {/* THE WAY OUT OF A SEARCH. `custQ` lives in the store and survives
            opening a customer, the map toggle and every tab switch, so without
            this the book stays narrowed to a word he typed an hour ago and
            there is no control on the screen that undoes it. It sits where the
            filter button used to — that button opened a sheet whose every row
            raised a toast and changed nothing. */}
        {typed ? (
          <Pressable
            onPress={() => {
              setTyped('');
              set({ custQ: '' });
            }}
            accessibilityRole="button"
            accessibilityLabel="Clear the search"
            style={{ position: 'absolute', right: 2, top: 2, width: HIT, height: HIT, alignItems: 'center', justifyContent: 'center' }}>
            <Icon name="close" size={18} color={C.muted} strokeWidth={1.5} />
          </Pressable>
        ) : null}
      </View>

      {/* LIST OR MAP. A tray with two joined halves rather than a third row of
          free-standing chips, because this control is not a filter at all — it
          does not change WHICH shops are in the book, only how the same book is
          drawn. Three rows of identical pills stacked one under the other read
          as one bank of nine buttons that all do the same kind of thing, and
          the thing that separates a mode switch from a filter at a glance is
          its GEOMETRY, not its position. It says "view" in both halves for the
          same reason: "List" beside "Map" is two nouns, and a noun on a button
          reads as the thing you are about to be shown rather than the way you
          are about to be shown it. */}
      <View
        style={{
          flexDirection: 'row',
          alignSelf: 'flex-start',
          marginTop: 12,
          padding: 3,
          borderRadius: radius.md,
          borderWidth: 1,
          borderColor: C.border,
          backgroundColor: C.wash,
        }}>
        {([
          { key: false, label: 'List view' },
          { key: true, label: 'Map view' },
        ] as const).map((seg) => {
          const on = asMap === seg.key;
          return (
            <Pressable
              key={String(seg.key)}
              onPress={() => setAsMap(seg.key)}
              accessibilityRole="tab"
              accessibilityState={{ selected: on }}
              style={{
                paddingHorizontal: 16,
                paddingVertical: 8,
                borderRadius: radius.sm,
                backgroundColor: on ? C.surface : 'transparent',
                boxShadow: on ? shadow.soft : undefined,
              }}>
              <Text
                style={[
                  { fontSize: 13, color: on ? C.ink : C.muted },
                  weight(on ? 600 : 500),
                ]}>
                {seg.label}
              </Text>
            </Pressable>
          );
        })}
      </View>

      {/* WHICH HALF. A view, never a scope — all three show only his own book,
          already narrowed to the territory he works. Drawn beside "where from"
          rather than buried in the filter sheet because it changes what the
          list IS, and a list whose subject is hidden behind a menu is one people
          misread.

          AND THE ROW IS NAMED. Two rows of identically drawn pills with nothing
          saying what question each answers is why they read as one row of six:
          "Leads" and "A–Z" are answers to different questions, and only the
          label says so. The label is what carries it; the different fills below
          are what let somebody who is not reading tell the rows apart.

          THE SELECTED CHIP IS ALSO HEAVIER, like both chip rows around it. This
          row alone carried its selected state on colour and nothing else, which
          is the wrong row to do it on — it decides what the list IS — and
          colour alone is the first thing to go in sunlight on a phone held at
          arm's length in a market lane. */}
      <View style={{ flexDirection: 'row', gap: 8, marginTop: 14, alignItems: 'center' }}>
        <Text style={[type.label, { width: 42 }]}>Show</Text>
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
              accessibilityState={{ selected: on }}
              style={{
                paddingHorizontal: 12,
                paddingVertical: 7,
                borderRadius: radius.pill,
                borderWidth: 1,
                borderColor: on ? C.ink : C.border,
                backgroundColor: on ? C.ink : C.surface,
              }}>
              <Text style={[{ fontSize: 13, color: on ? C.surface : C.body }, weight(on ? 600 : 500)]}>
                {chip.label}
              </Text>
            </Pressable>
          );
        })}
      </View>

      {/* WHERE FROM. Three chips rather than a menu: it is one tap, it is
          always visible, and the one in use is the answer to "why is this shop
          at the top".

          Its selected chip is TINTED rather than filled, and that is a
          hierarchy rather than a decoration: the row above decides which shops
          are in the book and this one only decides what order they come in, so
          exactly one row on the screen is solid at a time. Two solid black rows
          one under the other is what made them a single mush to look at.

          THE CITY CHIP CARRIES A STORED VALUE and is therefore the one that can
          be any length at all — see `shortPlace`. It shrinks and truncates, or
          a picked town pushes A–Z off the right edge of the phone. */}
      <View style={{ flexDirection: 'row', gap: 8, marginTop: 8, alignItems: 'center' }}>
        <Text style={[type.label, { width: 42 }]}>Sort</Text>
        {[
          /* "Nearest", NOT "Near me" — that phrase belongs to `/nearby`, which
             answers a different question. This chip sorts the whole book by
             distance; that screen lists only shops with a REASON to go, ranked
             by what the stop is worth with distance subtracted as a cost, and
             drops a shop that has nothing outstanding. Two controls one tab
             apart under one name, ordering by opposite rules, is how somebody
             works the wrong list all morning. */
          { key: 'me', label: 'Nearest' },
          { key: 'city', label: cities.some((c) => c.city === originMode) ? shortPlace(originMode) : 'By city' },
          { key: 'name', label: 'A–Z' },
        ].map((chip) => {
          const on =
            chip.key === 'city'
              ? cities.some((c) => c.city === originMode)
              : originMode === chip.key;
          return (
            <Pressable
              key={chip.key}
              onPress={() => (chip.key === 'city' ? setPickingCity(true) : setOriginMode(chip.key))}
              accessibilityState={{ selected: on }}
              style={{
                flexShrink: 1,
                minWidth: 0,
                paddingHorizontal: 12,
                paddingVertical: 7,
                borderRadius: radius.pill,
                borderWidth: 1,
                borderColor: on ? C.primaryEdge : C.border,
                backgroundColor: on ? C.primaryTint : C.surface,
              }}>
              <Text
                numberOfLines={1}
                style={[
                  { fontSize: 13, color: on ? C.primaryDeep : C.body, flexShrink: 1 },
                  weight(on ? 600 : 500),
                ]}>
                {chip.label}
              </Text>
            </Pressable>
          );
        })}
      </View>

      {/* A CAPPED LIST SAYS WHAT IT IS A SLICE OF, and the count comes from
          SQL rather than from what happens to be loaded — otherwise the first
          page of a book of six hundred reads as a book of fifteen.

          AND IT NAMES WHAT IT COUNTED. Under Everything this read "2,317
          customers" about a list that is customers AND leads, on a screen whose
          own chips have just offered those as two different things — so the one
          sentence that exists to say what is on screen contradicted the control
          directly above it. The chip picks the noun.

          AND IT NO LONGER ARGUES WITH THE CARD BELOW IT. "Nothing in your book
          yet" is the sentence AGENTS.md names as the wrong one when the real
          answer is that nobody has allocated him an area — it is what makes an
          unallocated handset look like a broken sync for a fortnight — and it
          was printed here, directly above the card that said the right thing. */}
      <Text numberOfLines={1} style={[type.caption, { marginTop: 10 }]}>
        {total === 0
          ? asked
            ? 'No shop matches that'
            : noArea
              ? 'No area set for you yet'
              : 'Nothing in your book yet'
          : rows.length < total
            ? `Showing ${rows.length} of ${plural(total, counted)}` + matching
            : plural(total, counted) + (matching || ' · your territory')}
        {origin && originMode === 'me' ? ' · nearest first' : ''}
        {origin && originMode !== 'me' && originMode !== 'name'
          ? ` · nearest ${shortPlace(originMode)} first`
          : ''}
      </Text>

      {/* WHICH PLACES THIS IS CUT TO, printed where the count is rather than
          buried in a profile screen. A salesman who cannot find a shop he knows
          is his needs to see the area before he concludes the app has lost it —
          and the answer is almost always that the shop is outside it. */}
      {area.length ? (
        <Text style={[type.caption, { marginTop: 2, color: C.muted }]}>
          {'Your area: ' + area.join(', ')}
        </Text>
      ) : null}

      {/* Asked and could not is a different fact from never asked, and the
          salesman is the one who can do something about it. */}
      {noFix && originMode === 'me' ? (
        <Text style={[type.caption, { marginTop: 4, color: C.muted }]}>
          {'No location fix yet, so this is A–Z for now. Check in, or pick a city.'}
        </Text>
      ) : null}

      {/* THE MAP. Only the loaded page is drawn, deliberately: the list pages
          fifteen at a time and a map that quietly showed the whole book would
          disagree with the count above it. The sentence under the map says what
          could not be placed. */}
      {asMap && rows.length > 0 ? (
        <View style={{ marginTop: 12 }}>
          <ShopMap
            pins={rows.map((x) => ({
              id: x.id,
              name: x.name,
              lat: x.gpsLat ?? NaN,
              lng: x.gpsLng ?? NaN,
              /* Carried so a lead is amber here as it is on the journey
                 picker — and so the tap below can send it where the list row
                 sends it. */
              isLead: Boolean(x.isLead),
            }))}
            /* HERE a tap opens the record. On the journey screen the same
               component adds a stop — the difference lives in the caller, so
               neither screen knows about the other. */
            onPress={openAccount}
          />
        </View>
      ) : null}

      {/* The gap the list's own wrapper used to carry. */}
      <View style={{ height: 8 }} />
    </View>
  );

  /*
   * ONE CARD, AND ONLY ONE.
   *
   * There were two, both gated on the identical `rows.length === 0`: this one,
   * and a second below the Load more button reading "Nothing matches that /
   * Try a shorter word, or clear the filters" with a button that cleared the
   * SEARCH. So an empty book drew two contradictory explanations stacked, and
   * the second blamed a search he had never typed and filters that were never
   * applied. The one screen whose whole purpose is to tell an unallocated
   * salesman why his book is empty answered with two different reasons.
   */
  const emptyCard =
    asMap && rows.length > 0 ? null : !loaded ? (
      <Card style={{ marginTop: 12, alignItems: 'center', paddingVertical: 28 }}>
        <Text style={[type.caption, { textAlign: 'center' }]}>Reading your book…</Text>
      </Card>
    ) : failed ? (
      <Card style={{ marginTop: 12, alignItems: 'center', paddingVertical: 28 }}>
        <Text style={[{ fontSize: 15, color: C.ink, textAlign: 'center' }, weight(500)]}>
          Could not read the book on this phone
        </Text>
        <Text style={[type.caption, { marginTop: 4, textAlign: 'center', paddingHorizontal: 24 }]}>
          Nothing of yours is lost. Leave the screen and come back, and if it keeps
          happening tell the office.
        </Text>
      </Card>
    ) : (
      <Card style={{ marginTop: 12, alignItems: 'center', paddingVertical: 28 }}>
        <Text style={[{ fontSize: 15, color: C.ink, textAlign: 'center' }, weight(500)]}>
          {asked
            ? 'No shop matches that'
            : noArea
              ? 'No area set for you yet'
              : 'Nothing in your book yet'}
        </Text>
        <Text style={[type.caption, { marginTop: 4, textAlign: 'center', paddingHorizontal: 24 }]}>
          {noArea && !asked
            ? 'Your customer list stays empty until the office sets the area you work. Nothing of yours is lost — ask your manager to set it on the Sales Dashboard.'
            : 'If you are standing in a shop we deliver to on somebody else’s bill, open it here and take the order.'}
        </Text>
        {noArea && !asked ? null : (
          <View style={{ marginTop: 14, alignSelf: 'stretch', paddingHorizontal: 24 }}>
            <PrimaryButton label="Add a delivery shop" onPress={openAdd} />
          </View>
        )}
      </Card>
    );

  /* MORE, ON REQUEST. A button rather than infinite scroll: the next
     fifteen cost a query and a render, and a salesman scrolling to find
     one shop should not silently pull his whole territory onto the JS
     thread — which is the fault this whole screen was rebuilt around. */
  const footer = hasMore ? (
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
          ? 'Loading…'
          : `Load ${Math.min(CUSTOMER_PAGE, total - rows.length)} more`}
      </Text>
    </Pressable>
  ) : null;

  const renderRow = ({ item: x }: { item: Customer }) => {
    /* Rupees at the point of display, paise everywhere behind it. */
    const dues = x.outstandingPaise / 100;
    const stage = customerStage(x);
    const seenDays = daysSince(x.lastVisitDate, today);
    /* "Lead · Suspect", not "Lead". The rung is what the salesman is
       choosing between on this screen — see `accountLine`. */
    const type_ = accountLine(x);
    /* Only where the origin is the salesman himself. A distance from the
       middle of a town he picked is not how far HE has to walk, and
       printing it as though it were would be a lie of the most useful
       kind — believable, and acted on. */
    const away = originMode === 'me' ? distanceLabel(metresFromDist2(x.dist2)) : null;
    return (
      <Card padded={false} style={{ overflow: 'hidden' }}>
        <Pressable onPress={() => openAccount(x)} style={{ padding: 16 }}>
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
            {/* A customer the office has not scored yet gets no NUMBER —
                a zero would read as the worst score there is — but a band
                can still stand on its own, because it needs only the last
                order date and the cycle. Both absent draws nothing. */}
            {x.healthScore != null || x.healthBand ? (
              <HealthPill
                value={x.healthScore ?? null}
                band={x.healthBand ?? null}
                strongAtOrAbove={healthStrong}
                watchBelow={healthWatch}
              />
            ) : null}
          </View>

          {/* Compared in PAISE against the one shared threshold — see
              `OUTSTANDING_ALERT_PAISE`. `dues` is rupees, for `inr` below. */}
          <Text
            style={[
              {
                fontSize: 15,
                marginTop: 10,
                color:
                  x.outstandingPaise > OUTSTANDING_ALERT_PAISE
                    ? C.danger
                    : dues
                      ? C.ink
                      : C.success,
              },
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
            {/*
              NO VERDICT, NO DOT.

              `customerStage` answers null for an account nothing has been
              measured on — never ordered, so no cycle, so no band — and
              its own contract says the caller draws no verdict rather than
              inventing one. This drew the dot unconditionally and only the
              WORD was conditional, so a shop nobody has ever sold to got a
              bare GREEN dot: the most reassuring mark on the card, on the
              row that deserves it least, with nothing beside it to say what
              it meant. On a fresh book that is most of the screen.
            */}
            {stage ? (
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                <View
                  style={{
                    width: 8,
                    height: 8,
                    borderRadius: 4,
                    /* Dormant and Lost are the far end of the same scale
                       and must not fall through to green, which is what the
                       old 'Overdue' check did the moment the words changed.
                       `Closed` is somebody's decision to stop dealing with
                       this shop and is the same: it is not a green dot. */
                    backgroundColor:
                      stage === 'Dormant' || stage === 'Lost' || stage === 'Closed'
                        ? C.danger
                        : stage === 'At risk'
                          ? C.warn
                          : C.success,
                  }}
                />
                <Text style={{ fontSize: 14, color: C.body }}>{stage}</Text>
              </View>
            ) : (
              <View />
            )}

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
            /* The travel question comes first — see `TravelGate`. */
            { g: 'shop', l: 'Visit', run: () => askTravel({ customerId: x.id, customerName: x.name }) },
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
  };

  /* No account on this handset can be billed, so the form below cannot be
     completed at all. Said on the sheet rather than discovered by pressing:
     `saveShop` refused with the same toast on every press, forever, and
     nothing anywhere explained why.

     `billers !== null` is what keeps it from claiming that before the read has
     answered — an empty book and a book that has not been asked for look
     identical in an array of length nought, and only one of them is a dead
     end. */
  const noBook = billers !== null && billers.length === 0 && !billerQ.trim();

  return (
    <AppFrame title="Customers" activeTab="customers" scroll={false}>
      <FlatList
        style={{ flex: 1 }}
        contentContainerStyle={{ paddingHorizontal: 16, paddingTop: 12, paddingBottom: 24 }}
        /* The map draws the same page the list would, so the rows are held
           back rather than rendered behind it. */
        data={asMap ? NO_ROWS : rows}
        keyExtractor={(x) => x.id}
        renderItem={renderRow}
        ItemSeparatorComponent={RowGap}
        /* An ELEMENT and never a function: an inline component would be a new
           type on every render, so the header would unmount and remount and
           the search box would lose focus on every keystroke. */
        ListHeaderComponent={header}
        ListEmptyComponent={emptyCard}
        ListFooterComponent={footer}
        initialNumToRender={8}
        maxToRenderPerBatch={8}
        windowSize={7}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        showsVerticalScrollIndicator={false}
      />

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
                  gap: 12,
                  paddingVertical: 13,
                  borderBottomWidth: 1,
                  borderBottomColor: C.border,
                },
                pressed && { backgroundColor: C.wash },
              ]}>
              {/* The WHOLE stored value here, shrunk to one line rather than
                  shortened: this is where two towns are told apart, and the
                  count beside it must not be pushed off the screen by an
                  address that happens to be a paragraph. */}
              <Text numberOfLines={1} style={[{ flex: 1, minWidth: 0, fontSize: 15, color: C.ink }, weight(500)]}>
                {c.city}
              </Text>
              <Text style={type.caption}>{plural(c.n, 'shop')}</Text>
            </Pressable>
          ))
        )}
      </BottomSheet>

      <BottomSheet open={!!rowMore} onClose={() => setRowMore(null)}>
        <Text style={[{ fontSize: 15, color: C.ink, marginBottom: 4 }, weight(600)]}>{rowMore?.name ?? ''}</Text>
        {/*
          THESE FOUR RAISED A TOAST AND DID NOTHING ELSE.

          `Request sample` is wired now: `requestLeadSample` and the screen that
          calls it both exist, and the screen already takes the shop from the
          store — so the row that named the feature was the only part missing.
          Choosing the shop here sets `custId`, which is what `app/samples.tsx`
          reads as its subject.

          The other three are still toasts and are deliberately left as they
          are rather than pointed at the nearest screen that half-fits. A
          complaint is raised from inside a visit, where the photographs and
          the order it is about are to hand; quotations and a document library
          for a customer do not exist in MBOS at all. Sending somebody to a
          screen that cannot do the thing the row names is worse than the
          toast, because it costs them the walk to find out.
        */}
        {[
          { g: 'sample', l: 'Request sample', s: 'Sent for approval' },
          { g: 'note', l: 'Log complaint', s: 'Raised from the visit' },
          { g: 'doc', l: 'Send quotation', s: 'From the price list' },
          { g: 'doc', l: 'Documents', s: 'Agreements and KYC' },
        ].map((i) => (
          <Pressable
            key={i.l}
            onPress={() => {
              const name = rowMore?.name ?? '';
              const shop = rowMore;
              setRowMore(null);
              if (i.l === 'Request sample') {
                if (!shop) return;
                set({ custId: shop.id });
                return router.push('/samples?ask=1&from=customers');
              }
              notify(i.l === 'Documents' ? 'Documents' : i.l.replace('Log complaint', 'Complaint for ' + name).replace('Send quotation', 'Quotation for ' + name));
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

        {/* All four are REQUIRED and the labels say so. Every one of them was
            refused after the press, one at a time, by a toast — which is how a
            form teaches somebody that it is broken. */}
        <Field label="Shop name" required value={newShopName} onChange={setNewShopName} placeholder="As it is written on the board" />
        <Field
          label="Phone"
          required
          value={shopPhone}
          onChange={setShopPhone}
          placeholder="10 digits"
          keyboard="phone-pad"
        />
        <Field label="Town" required value={shopCity} onChange={setShopCity} placeholder="Nashik" />

        <Text style={[type.caption, { marginTop: 14, marginBottom: 6 }]}>
          {'WHO IS BILLED FOR IT · required'}
        </Text>
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
          {(billers ?? []).slice(0, 6).map((b) => (
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
          {/* Reading, nothing matched, and nothing at all are three different
              answers. Only the last one means the form cannot be finished. */}
          {billers === null ? (
            <Text style={type.caption}>Reading your accounts…</Text>
          ) : billers.length === 0 ? (
            <Text style={type.caption}>
              {billerQ.trim() ? 'No account of yours matches that.' : 'You have no accounts to bill yet.'}
            </Text>
          ) : null}
        </View>

        <View style={{ marginTop: 16 }}>
          {/* THE FORM CANNOT BE FINISHED ON AN EMPTY BOOK, and it says so
              instead of drawing a button that refuses every press. The billing
              account has to come from this handset's own accounts, which is the
              same table that is empty — so on a fresh handset, or one whose
              pull has never landed, there is nothing to pick and no way to
              satisfy the demand. */}
          {noBook ? (
            <Text style={[type.caption, { textAlign: 'center', paddingHorizontal: 12 }]}>
              Your book has not reached this phone yet. A delivery shop has to name one
              of your own accounts as the one we bill, so this needs a sync first.
            </Text>
          ) : (
            <PrimaryButton
              label={saving ? 'Adding…' : 'Add the shop'}
              onPress={() => void saveShop()}
              /* Saving is a hard stop with no reason attached, so the button
                 swallows the second tap; a missing biller keeps the button
                 pressable and `saveShop` answers in words. */
              disabled={saving || !billerId}
              whyDisabled={saving ? undefined : 'Pick who is billed for this shop, above.'}
            />
          )}
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
  required,
  value,
  onChange,
  placeholder,
  keyboard,
}: {
  label: string;
  required?: boolean;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  keyboard?: 'phone-pad';
}) {
  return (
    <View style={{ marginBottom: 10 }}>
      <Text style={[type.caption, { marginBottom: 4 }]}>
        {label.toUpperCase() + (required ? ' · required' : '')}
      </Text>
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
