import React from 'react';
import { View, Text, Pressable, TextInput, FlatList, RefreshControl, ScrollView, Platform, type ListRenderItemInfo } from 'react-native';
import { isOnline } from '../src/sync/engine';
import { router, useFocusEffect } from 'expo-router';
import { color as C, radius, type, weight } from '../src/theme/tokens';
import { Icon } from '../src/components/ui/Icon';
import { Badge, Card, HealthPill, PrimaryButton, SecondaryButton } from '../src/components/ui/primitives';
import { BottomSheet } from '../src/components/ui/overlays';
import { ChipRow, PageFooter, SearchBox, Segmented, SheetAction, ToolButton } from '../src/components/ui/book-controls';
import { AppFrame } from '../src/components/shell/AppFrame';
import { useStore } from '../src/state/store';
import { getConfig } from '../src/data/config';
import { daysBetween, reorderState } from '../src/engines/leads';
import { distanceLabel, grouped, inrFromPaise, isoDate, plural, shopName } from '../src/lib/format';
import { callNumber, openMaps, openWhatsApp } from '../src/lib/messaging';
import {
  accountType,
  addFieldShop,
  billableCustomers,
  cityOrigins,
  customerFilterCounts,
  customerStage,
  daysSince,
  listCustomersPage,
  OUTSTANDING_ALERT_PAISE,
  type Customer,
  type CustomerFilterCounts,
} from '../src/data/customers';
import {
  CUSTOMER_FILTERS,
  metresFromDist2,
  type BookView,
  type CustomerFilter,
  type CustomerSort,
  type Origin,
} from '../src/data/customer-query';
import { ShopMap } from '../src/components/ui/shop-map';
import { territoryState } from '../src/sync/pull';
import type { TerritoryState } from '../src/sync/api';
import { whereNow } from '../src/native/where';
import { LeadsBook } from '../src/components/leads/leads-book';
import { countLeads, openLeadCount } from '../src/data/leads';
import { Appear, DUR, Stagger, animateLayoutFor } from '../src/components/ui/motion';
import { STAGGER_CAP } from '../src/components/ui/route-motion';

/**
 * The book — and it is ten thousand shops, not six.
 *
 * WHAT CHANGED, AND WHY, because every part of the old screen was right about
 * a smaller book.
 *
 * THE CONTROLS STAY PUT. Search, the map switch and the chips were the list's
 * header, so they scrolled away with the first four cards — a salesman three
 * hundred shops down could not see what the list was narrowed to or reach the
 * box to narrow it again. They sit above the list now and the list scrolls
 * under them.
 *
 * THE BOOK CAN BE ASKED A QUESTION. A search finds a shop he can name; the
 * chips find the ones he cannot — who owes, who is due to reorder, who is due
 * a visit, who has never been visited, who has no pin — each carrying its
 * count, over whatever he has typed. They are SQL, in `customer-query.ts`,
 * because a filter applied to the rows already on screen answers "which of the
 * first thirty" and calls it the book.
 *
 * THE CARD IS A ROW. It was a 220-point card with six buttons along its foot,
 * so three shops filled a screen and scanning a town meant a hundred flicks.
 * It is about half that now: the name, where it is, what is owed, and what is
 * due — and two buttons. Call is one tap because it is the commonest thing
 * done from this list; everything else (WhatsApp, directions, a visit, an
 * order, a sample) is one sheet away on ⋯, and the record is a tap on the row.
 *
 * THE NEXT PAGE ARRIVES BY ITSELF. "Load 15 more" was a button because the
 * old cards were heavy enough that pulling the territory onto the JS thread by
 * accident froze the phone. The list is virtualised and the rows are cheap, so
 * the next thirty are asked for as he nears the bottom, and the count above
 * says how far into the book he is.
 *
 * It is still a VIEW and never a scope. Everything here is his own book,
 * already narrowed to the territory he works.
 */

/** How long a typed name waits before it becomes a query. See `typed` below. */
const SEARCH_PAUSE_MS = 250;

/**
 * A town, short enough to sit on a line.
 *
 * `customers.city` holds whatever the office typed, and on the real book that
 * is often a whole postal address. It is SHORTENED rather than parsed: the
 * first comma-separated piece of such an address is a shop number, so guessing
 * which piece is the town would put a confidently wrong place on the screen.
 */
function shortPlace(place: string, max = 22): string {
  const one = place.replace(/\s+/g, ' ').trim();
  return one.length <= max ? one : one.slice(0, max - 1).trimEnd() + '…';
}

/**
 * HOW THE LIST IS ORDERED, as the salesman thinks of it.
 *
 * Two of these are the same SQL — distance — measured from two places: where
 * he is standing, and the middle of a town he picked. The town's name rides in
 * `town` rather than in the mode, so a picked town survives switching away to
 * A–Z and back.
 */
type SortMode = 'me' | 'town' | 'name' | 'owed' | 'unseen';

const SORT_LABEL: Record<SortMode, string> = {
  /* "Nearest", NOT "Near me" — that phrase belongs to `/nearby`, which lists
     only shops with a REASON to go and ranks them by what the stop is worth.
     This sorts the whole book by distance. Two controls one tab apart under
     one name, ordering by opposite rules, is how somebody works the wrong list
     all morning. */
  me: 'Nearest',
  town: 'Nearest a town',
  name: 'A–Z',
  owed: 'Most owed',
  unseen: 'Longest since visit',
};

function sqlSort(mode: SortMode): CustomerSort {
  return mode === 'me' || mode === 'town' ? 'near' : mode;
}

/**
 * The status half of the row's last line — what is due, or when he was last
 * there. The VERDICT is `reorderState`'s own, so this row and the record cannot
 * disagree about one shop; only the wording is shorter than `reorderLabel`.
 */
function dueWords(x: Customer, today: string): { text: string; tone: 'late' | 'due' | 'quiet' } {
  const state = reorderState(x.lastOrderDate, x.cycleDays, today);
  if (state) {
    const since = daysBetween(x.lastOrderDate, today) ?? 0;
    return {
      text: `${state === 'overdue' ? 'Reorder late' : 'Reorder due'} · ${since} days, buys every ${x.cycleDays}`,
      tone: state === 'overdue' ? 'late' : 'due',
    };
  }
  const seen = daysSince(x.lastVisitDate, today);
  return {
    text: seen == null ? 'Never visited' : seen === 0 ? 'Visited today' : `Visited ${seen}d ago`,
    tone: 'quiet',
  };
}

/** A round 40-point button inside a row. The row itself is the 48-point target around it. */
function RowButton({
  icon,
  label,
  onPress,
  tint,
  dim = false,
}: {
  icon: 'call' | 'dots';
  label: string;
  onPress: () => void;
  tint: boolean;
  dim?: boolean;
}) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      hitSlop={4}
      style={({ pressed }) => ({
        width: 40,
        height: 40,
        borderRadius: 20,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: pressed ? C.primaryEdge : tint ? C.primaryTint : 'transparent',
      })}>
      <Icon name={icon} size={18} color={dim ? C.faint : tint ? C.primaryDeep : C.muted} />
    </Pressable>
  );
}

/**
 * ONE SHOP, AS A THREE-LINE ROW: who and the verdict; where; money and what is due.
 *
 * `React.memo` because a page arriving re-renders the list, and thirty new
 * rows should not cost re-drawing the three hundred above them. Every prop is
 * a primitive or a stable callback for the same reason.
 */
const CustomerRow = React.memo(function CustomerRow({
  x,
  today,
  showDistance,
  healthStrong,
  healthWatch,
  onOpen,
  onMore,
  onCall,
}: {
  x: Customer;
  today: string;
  showDistance: boolean;
  healthStrong: number;
  healthWatch: number;
  onOpen: (x: Customer) => void;
  onMore: (x: Customer) => void;
  onCall: (x: Customer) => void;
}) {
  /* Only where the origin is the salesman himself. A distance from the middle
     of a town he picked is not how far HE has to walk. */
  const away = showDistance ? distanceLabel(metresFromDist2(x.dist2)) : null;
  const stage = customerStage(x);
  const third = accountType(x) === 'Third party';
  const due = dueWords(x, today);
  const owed = x.outstandingPaise > 0;
  const where = [third ? 'Third party' : null, x.contactPerson, x.city ? shortPlace(x.city, 28) : null]
    .filter(Boolean)
    .join(' · ');

  return (
    <Pressable
      onPress={() => onOpen(x)}
      accessibilityRole="button"
      accessibilityLabel={shopName(x.name)}
      style={({ pressed }) => ({
        flexDirection: 'row',
        alignItems: 'center',
        gap: 4,
        paddingLeft: 14,
        paddingRight: 6,
        paddingVertical: 10,
        backgroundColor: pressed ? C.wash : C.surface,
      })}>
      <View style={{ flex: 1, minWidth: 0 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <Text numberOfLines={1} style={[{ flex: 1, minWidth: 0, fontSize: 15, lineHeight: 20, color: C.ink }, weight(600)]}>
            {shopName(x.name)}
          </Text>
          {/* `Closed` is somebody's decision to stop dealing with this shop,
              and the band cannot say it — `recomputeInactivity` never writes
              `deactivated`. An account nothing has measured draws nothing. */}
          {stage === 'Closed' ? (
            <Badge tone="danger">Closed</Badge>
          ) : x.healthScore != null || x.healthBand ? (
            <HealthPill
              value={x.healthScore ?? null}
              band={x.healthBand ?? null}
              strongAtOrAbove={healthStrong}
              watchBelow={healthWatch}
            />
          ) : null}
        </View>

        <Text numberOfLines={1} style={[type.caption, { marginTop: 1 }]}>
          {away ? <Text style={[{ color: C.ink }, weight(600)]}>{away}</Text> : null}
          {away && where ? ' · ' : ''}
          {where || (away ? '' : 'No contact or town on record')}
        </Text>

        <Text numberOfLines={1} style={{ marginTop: 3, fontSize: 13, lineHeight: 18 }}>
          {/* Compared in PAISE against the one shared threshold — see
              `OUTSTANDING_ALERT_PAISE`. */}
          <Text
            style={[
              { color: !owed ? C.muted : x.outstandingPaise > OUTSTANDING_ALERT_PAISE ? C.danger : C.ink },
              weight(owed ? 600 : 400),
            ]}>
            {owed ? inrFromPaise(x.outstandingPaise) + ' due' : 'Nothing due'}
          </Text>
          {x.creditBlocked ? <Text style={[{ color: C.danger }, weight(600)]}>{' · Supply stopped'}</Text> : null}
          <Text style={{ color: C.faint }}>{'  |  '}</Text>
          <Text
            style={[
              { color: due.tone === 'late' ? C.danger : due.tone === 'due' ? C.warnInk : C.muted },
              weight(due.tone === 'quiet' ? 400 : 600),
            ]}>
            {due.text}
          </Text>
        </Text>
      </View>

      <RowButton
        icon="call"
        label={'Call ' + shopName(x.name)}
        onPress={() => onCall(x)}
        tint={!!x.phone}
        dim={!x.phone}
      />
      <RowButton icon="dots" label={'More for ' + shopName(x.name)} onPress={() => onMore(x)} tint={false} />
    </Pressable>
  );
});

/** A hairline between rows, inset to the text — one list, not a stack of cards. */
function RowGap() {
  return <View style={{ height: 1, marginLeft: 14, backgroundColor: C.hairline }} />;
}

export default function Customers() {
  const custQ = useStore((s) => s.custQ);
  const set = useStore((s) => s.set);
  const notify = useStore((s) => s.notify);
  const askTravel = useStore((s) => s.askTravel);

  /* The two health thresholds, read from configuration and never typed here. */
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

  const [today] = React.useState(() => isoDate(new Date()));

  /* ------------------------------------- a shop that is not on the book yet
   *
   * He is standing in an outlet nobody has recorded, with an order his
   * distributor will be invoiced for. It hangs off the EMPTY SEARCH, because
   * that is the moment he finds out — he types the name, nothing comes back.
   */
  const [adding, setAdding] = React.useState(false);
  const [newShopName, setNewShopName] = React.useState('');
  const [shopPhone, setShopPhone] = React.useState('');
  const [shopCity, setShopCity] = React.useState('');
  /* NULL UNTIL THE READ ANSWERS — an empty array is the terminal answer "no
     account on this handset can be billed", and starting there flashed that
     sentence over a query still in flight. */
  const [billers, setBillers] = React.useState<Customer[] | null>(null);
  const [billerId, setBillerId] = React.useState<string | null>(null);
  const [billerQ, setBillerQ] = React.useState('');
  const [saving, setSaving] = React.useState(false);

  /* ---------------------------------------------------------- the page */
  const [rows, setRows] = React.useState<Customer[]>([]);
  const [total, setTotal] = React.useState(0);
  const [hasMore, setHasMore] = React.useState(false);
  const [loadingMore, setLoadingMore] = React.useState(false);
  const [moreFailed, setMoreFailed] = React.useState(false);
  const [refreshing, setRefreshing] = React.useState(false);
  /* Nothing terminal is claimed until the book has answered, and a read that
     fails says so rather than leaving a card that never arrives. */
  const [loaded, setLoaded] = React.useState(false);
  const [failed, setFailed] = React.useState(false);
  const [counts, setCounts] = React.useState<CustomerFilterCounts | null>(null);
  /*
   * WHICH ANSWER IS CURRENT. A filter tapped while a page is in flight is a
   * different question, and the late answer to the old one must not land on
   * top of the new — or append to it, which is worse: thirty shops that owe
   * nothing appended under the heading "Owes money".
   */
  const asking = React.useRef(0);

  /* What the office last said about where he works — read on focus, because
     territory is changed at a desk in the middle of a working day. Null is the
     server never having said, which is NOT "no area". */
  const [territory, setTerritory] = React.useState<TerritoryState | null>(null);

  /* Which half of the book. A customer and a lead are not the same card, so
     these are two lists rather than a filter on one. */
  const [half, setHalf] = React.useState<'customers' | 'leads'>('customers');
  /* Whether he has switched halves yet. The first half drawn is the screen
     opening, which the route transition already says; only a SWITCH fades. */
  const [halfMoved, setHalfMoved] = React.useState(false);
  const view: BookView = 'customers';
  const [leadCount, setLeadCount] = React.useState<number | null>(null);
  const [leadsMatching, setLeadsMatching] = React.useState(0);

  const [filter, setFilter] = React.useState<CustomerFilter>('all');
  const [asMap, setAsMap] = React.useState(false);
  const [rowMore, setRowMore] = React.useState<Customer | null>(null);

  /* ------------------------------------------------- the order, and from where */
  const [sortMode, setSortMode] = React.useState<SortMode>('me');
  const [town, setTown] = React.useState<string | null>(null);
  const [sorting, setSorting] = React.useState(false);
  const [origin, setOrigin] = React.useState<Origin>(null);
  /* Whether the origin has been worked out for the current mode. The first
     page waits for it: reading A–Z and then re-reading nearest-first a moment
     later makes the list jump under his thumb as it lands. */
  const [originReady, setOriginReady] = React.useState(false);
  const [cities, setCities] = React.useState<{ city: string; lat: number; lng: number; n: number }[]>([]);
  const [pickingCity, setPickingCity] = React.useState(false);
  const [cityQ, setCityQ] = React.useState('');
  const [noFix, setNoFix] = React.useState(false);

  /*
   * WHAT HE HAS TYPED, AND WHAT HAS BEEN ASKED, are two different things. Every
   * ask is a pair of `LIKE '%…%'` scans over the book, and the pause is what
   * turns a name into one pair instead of one pair per letter.
   */
  const [typed, setTyped] = React.useState(custQ);
  React.useEffect(() => {
    if (typed === custQ) return;
    const t = setTimeout(() => set({ custQ: typed }), SEARCH_PAUSE_MS);
    return () => clearTimeout(t);
  }, [typed, custQ, set]);

  /* The towns, once. They change when the book does, not while he reads it. */
  React.useEffect(() => {
    void cityOrigins().then(setCities);
  }, []);

  React.useEffect(() => {
    let live = true;
    setOriginReady(false);
    if (sortMode === 'me') {
      void whereNow()
        .then((w) => {
          if (!live) return;
          const has = typeof w?.lat === 'number' && typeof w?.lng === 'number';
          setOrigin(has ? { lat: w!.lat!, lng: w!.lng! } : null);
          setNoFix(!has);
        })
        .catch(() => {
          if (!live) return;
          setOrigin(null);
          setNoFix(true);
        })
        .finally(() => {
          if (live) setOriginReady(true);
        });
      return () => {
        live = false;
      };
    }
    if (sortMode === 'town') {
      const c = cities.find((x) => x.city === town);
      setOrigin(c ? { lat: c.lat, lng: c.lng } : null);
    } else {
      setOrigin(null);
    }
    setNoFix(false);
    setOriginReady(true);
    return () => {
      live = false;
    };
  }, [sortMode, town, cities]);

  const sort = sqlSort(sortMode);
  const pageArgs = React.useMemo(
    () => ({ query: custQ, origin, view, filter, sort, today }),
    [custQ, origin, view, filter, sort, today],
  );

  /* THE FIRST PAGE. A changed search, filter or order is a different question,
     so the answer starts again from the top. */
  const loadFirst = React.useCallback(async () => {
    const ticket = ++asking.current;
    try {
      const p = await listCustomersPage(pageArgs);
      if (ticket !== asking.current) return;
      setRows(p.rows);
      setTotal(p.total);
      setHasMore(p.hasMore);
      setMoreFailed(false);
      setFailed(false);
    } catch {
      if (ticket !== asking.current) return;
      setFailed(true);
    } finally {
      if (ticket === asking.current) setLoaded(true);
    }
  }, [pageArgs]);

  useFocusEffect(
    React.useCallback(() => {
      if (!originReady) return;
      void loadFirst();
    }, [loadFirst, originReady]),
  );

  /* The chip counts follow the SEARCH and not the picked chip — see
     `customerFilterCountsQuery`. Re-read on focus as well, because an order
     taken two screens ago moves "Reorder due". */
  useFocusEffect(
    React.useCallback(() => {
      let live = true;
      void customerFilterCounts({ query: custQ, view, today })
        .then((c) => {
          if (live) setCounts(c);
        })
        .catch(() => {
          /* A count that could not be read is a count we do not print — the
             chips still work without it. */
          if (live) setCounts(null);
        });
      void territoryState().then((t) => {
        if (live) setTerritory(t);
      });
      /* The badge on the other tab, counted on every focus: a lead raised on a
         visit a moment ago has to be on it by the time he comes back here. */
      void openLeadCount().then((n) => {
        if (live) setLeadCount(n);
      });
      return () => {
        live = false;
      };
    }, [custQ, view, today]),
  );

  /*
   * WHERE THE ANSWER WENT. A name typed on this half no longer finds a shop
   * that is still a lead, so an empty search counts the leads matching the same
   * words and offers the other tab. A COUNT, never the rows: it exists to
   * print one number.
   */
  React.useEffect(() => {
    const words = custQ.trim();
    if (!loaded || rows.length > 0 || !words) {
      setLeadsMatching(0);
      return;
    }
    let live = true;
    void countLeads({}, words)
      .then((n) => {
        if (live) setLeadsMatching(n);
      })
      .catch(() => {
        if (live) setLeadsMatching(0);
      });
    return () => {
      live = false;
    };
  }, [custQ, rows.length, loaded]);

  /* The next page APPENDS, asking for the page after what is on screen, and
     reuses the first page's total rather than counting the book again. */
  const loadMore = React.useCallback(async () => {
    if (loadingMore || !hasMore) return;
    const ticket = asking.current;
    setLoadingMore(true);
    setMoreFailed(false);
    try {
      const p = await listCustomersPage({ ...pageArgs, offset: rows.length, knownTotal: total });
      if (ticket !== asking.current) return;
      setRows((prev) => {
        /* A shop the office moved between two pages can arrive twice; the list
           keys on id and a duplicate key is a row React silently drops. */
        const seen = new Set(prev.map((r) => r.id));
        return [...prev, ...p.rows.filter((r) => !seen.has(r.id))];
      });
      setHasMore(p.hasMore && p.rows.length > 0);
    } catch {
      if (ticket === asking.current) setMoreFailed(true);
    } finally {
      setLoadingMore(false);
    }
  }, [loadingMore, hasMore, pageArgs, rows.length, total]);

  const refresh = React.useCallback(async () => {
    setRefreshing(true);
    try {
      await Promise.all([
        loadFirst(),
        customerFilterCounts({ query: custQ, view, today }).then(setCounts).catch(() => undefined),
      ]);
    } finally {
      setRefreshing(false);
    }
  }, [loadFirst, custQ, view, today]);

  /* Only while the sheet is open, and re-read as he narrows it. */
  React.useEffect(() => {
    if (!adding) return;
    let live = true;
    void billableCustomers(billerQ)
      .then((r) => {
        if (live) setBillers(r);
      })
      .catch(() => {
        if (live) setBillers([]);
      });
    return () => {
      live = false;
    };
  }, [adding, billerQ]);

  const openAdd = () => {
    /* Seeded with what he already typed — asking him to type the name of the
       shop he just searched for again is how a feature gets left unused. */
    setNewShopName(typed.trim());
    setShopPhone('');
    setShopCity('');
    setBillerId(null);
    setBillerQ('');
    setAdding(true);
  };

  const saveShop = async () => {
    /* The real lock: a second tap during the insert puts the shop on the book
       twice, and the order he is standing there to take goes against one. */
    if (saving) return;
    const biller = billers?.find((b) => b.id === billerId);
    if (!biller) return notify('Pick who gets the bill for this shop.', 'warn');
    setSaving(true);
    try {
      const r = await addFieldShop({
        name: newShopName,
        phone: shopPhone,
        city: shopCity,
        distributorCustomerId: biller.id,
        distributorName: biller.name,
      });
      if (!r.ok) return notify(r.message, 'warn');
      setAdding(false);
      notify((await isOnline()) ? 'Shop added · sending to the office now' : 'Shop added · will send when you have signal');
      set({ custId: r.customerId, pTab: 0 });
      router.push('/customer');
    } finally {
      setSaving(false);
    }
  };

  /*
   * ONE TAP, ONE DESTINATION, however the shop was found — the row and the map
   * pin both pass through here. A lead opens `/lead`, where the ladder and the
   * gates are; everything else opens the record.
   */
  const openAccount = React.useCallback(
    (x: { id: string; isLead?: number | boolean | null }) => {
      set({ custId: x.id, pTab: 0 });
      if (x.isLead) router.push(`/lead?id=${x.id}&from=customers`);
      else router.push('/customer');
    },
    [set],
  );

  const callShop = React.useCallback(
    (x: Customer) => {
      if (!x.phone) return notify('No number on this customer', 'warn');
      void callNumber(x.phone);
    },
    [notify],
  );

  /* THE FIRST SCREENFUL CASCADES AND NOTHING ELSE DOES. A row past the cap is
     one a FlatList mounts as it scrolls into view, and fading that in under a
     moving thumb reads as the list lagging — on a book of 2,500 it would be
     every row he ever scrolls to. The rows stay the plain memoised row. */
  const renderRow = React.useCallback(
    ({ item, index }: ListRenderItemInfo<Customer>) => {
      const row = (
      <CustomerRow
        x={item}
        today={today}
        showDistance={sortMode === 'me'}
        healthStrong={healthStrong}
        healthWatch={healthWatch}
        onOpen={openAccount}
        onMore={setRowMore}
        onCall={callShop}
      />
      );
      return index < STAGGER_CAP ? <Stagger index={index}>{row}</Stagger> : row;
    },
    [today, sortMode, healthStrong, healthWatch, openAccount, callShop],
  );

  /* Only ever true when the server has SAID so. `exempt` is a manager or an
     admin, who must not be told to go and ask for a territory. */
  const noArea = territory !== null && !territory.exempt && !territory.allocated;
  const area = territory?.allocated ? territory.places : [];
  const asked = custQ.trim();
  const filterLabel = CUSTOMER_FILTERS.find((f) => f.value === filter)!.label;
  const filtered = filter !== 'all';

  const clearSearch = () => {
    setTyped('');
    set({ custQ: '' });
  };

  /*
   * THE ONE LINE THAT SAYS WHAT IS ON SCREEN — a slice of what, matching what,
   * in what order. A count from SQL, never a loaded length, or the first page
   * of a book of ten thousand reads as a book of thirty.
   */
  const orderWords =
    sortMode === 'me'
      ? origin
        ? 'nearest first'
        : 'A–Z, no GPS yet'
      : sortMode === 'town'
        ? origin && town
          ? `nearest ${shortPlace(town, 16)}`
          : 'A–Z'
        : SORT_LABEL[sortMode];
  const statusLine = !loaded
    ? 'Reading your book…'
    : total === 0
      ? asked || filtered
        ? 'No shop matches'
        : noArea
          ? 'No area set for you yet'
          : 'No customers yet'
      : `${grouped(total)} ${total === 1 ? 'shop' : 'shops'}` +
        (filtered ? ` · ${filterLabel.toLowerCase()}` : '') +
        (asked ? ` · “${shortPlace(asked, 14)}”` : '');

  /* ----------------------------------------------------------- the empty card */
  const emptyCard = !loaded ? (
    <Card style={{ alignItems: 'center', paddingVertical: 28 }}>
      <Text style={[type.caption, { textAlign: 'center' }]}>Loading your customers…</Text>
    </Card>
  ) : failed ? (
    <Card style={{ alignItems: 'center', paddingVertical: 28 }}>
      <Text style={[{ fontSize: 15, color: C.ink, textAlign: 'center' }, weight(500)]}>
        Could not load your customers
      </Text>
      <Text style={[type.caption, { marginTop: 4, textAlign: 'center', paddingHorizontal: 24 }]}>
        Nothing is lost. Pull down to try again. If this keeps happening, tell the office.
      </Text>
    </Card>
  ) : (
    <Card style={{ alignItems: 'center', paddingVertical: 28 }}>
      <Text style={[{ fontSize: 15, color: C.ink, textAlign: 'center' }, weight(500)]}>
        {asked
          ? 'No shop matches that'
          : filtered
            ? `No shop is ${filterLabel.toLowerCase()}`
            : noArea
              ? 'No area set for you yet'
              : 'No customers yet'}
      </Text>
      <Text style={[type.caption, { marginTop: 4, textAlign: 'center', paddingHorizontal: 24 }]}>
        {noArea && !asked && !filtered
          ? 'Your list stays empty until the office sets your area. Nothing is lost. Ask your manager to set your area.'
          : filtered && !asked
            ? 'The rest of your book is still here under All.'
            : 'Are you in a shop where we deliver but bill someone else? Add it here and take the order.'}
      </Text>
      {/* A filter can hide the shop he searched for. Said, with the way out. */}
      {filtered ? (
        <View style={{ marginTop: 14, alignSelf: 'stretch', paddingHorizontal: 24 }}>
          <SecondaryButton label="Show all shops" onPress={() => setFilter('all')} />
        </View>
      ) : null}
      {/* WHERE THE ANSWER ACTUALLY IS — drawn only where there is something to
          find, or people learn the other tab never has the answer either. */}
      {asked && leadsMatching > 0 ? (
        <View style={{ marginTop: 10, alignSelf: 'stretch', paddingHorizontal: 24 }}>
          <PrimaryButton
            label={leadsMatching === 1 ? '1 lead matches. Open Leads' : `${grouped(leadsMatching)} leads match. Open Leads`}
            onPress={() => setHalf('leads')}
          />
        </View>
      ) : null}
      {(noArea && !asked) || (filtered && !asked) ? null : (
        <View style={{ marginTop: 10, alignSelf: 'stretch', paddingHorizontal: 24 }}>
          {asked && leadsMatching > 0 ? (
            <SecondaryButton label="Add a delivery shop" onPress={openAdd} />
          ) : (
            <PrimaryButton label="Add a delivery shop" onPress={openAdd} />
          )}
        </View>
      )}
    </Card>
  );

  /* No account on this handset can be billed, so the form cannot be finished.
     `billers !== null` keeps it from claiming that before the read answers. */
  const noBook = billers !== null && billers.length === 0 && !billerQ.trim();

  const shownCities = React.useMemo(() => {
    const q = cityQ.trim().toLowerCase();
    const list = q ? cities.filter((c) => c.city.toLowerCase().includes(q)) : cities;
    return list.slice(0, 60);
  }, [cities, cityQ]);

  return (
    <AppFrame title="Customers" activeTab="customers" scroll={false}>
      {/* THE TWO HALVES OF THE BOOK, above everything, because they decide
          which of two jobs he is doing and that has to be on the screen the
          whole time he is looking at it. */}
      <View style={{ paddingHorizontal: 16, paddingTop: 12 }}>
        <Segmented
          options={[
            { key: 'customers', label: 'Customers', badge: counts && !asked ? counts.all : null },
            /* What is still being WORKED — a badge counting leads finished
               with in March only ever grows and nobody can clear it. */
            { key: 'leads', label: 'Leads', badge: leadCount },
          ]}
          value={half}
          onChange={(h) => {
            setHalfMoved(true);
            setHalf(h);
          }}
        />
      </View>

      {/* Two siblings, not a deeper level, so the new half fades in place
          rather than sliding. No `animateLayout` here: the half arriving
          carries a list, and moving every frame in it is the cost
          `animateLayoutFor` exists to refuse. */}
      <Appear
        key={half}
        distance={halfMoved ? 4 : 0}
        duration={halfMoved ? DUR.quick : 0}
        style={{ flex: 1 }}>
        {half === 'leads' ? (
          <LeadsBook seedQuery={custQ} />
        ) : (
          <>
            {/* -------------------------------------------- the controls, fixed */}
            <View style={{ paddingHorizontal: 16, paddingTop: 12, gap: 10 }}>
              <View style={{ flexDirection: 'row', gap: 8 }}>
                <SearchBox
                  value={typed}
                  onChange={setTyped}
                  onClear={clearSearch}
                  placeholder="Name, phone, GST, city or code"
                />
                <ToolButton icon="filter" label={'Order: ' + SORT_LABEL[sortMode]} onPress={() => setSorting(true)} />
                {/* LIST OR MAP. It does not change WHICH shops are in the book,
                    only how the same page is drawn. */}
                <ToolButton
                  icon="pin"
                  label={asMap ? 'Show as a list' : 'Show on a map'}
                  on={asMap}
                  onPress={() => setAsMap((m) => !m)}
                />
              </View>

              {/* The tick is in `ChipRow`. The layout eases only on a short list —
                  the new page lands later and cascades in by itself. */}
              <ChipRow
                chips={CUSTOMER_FILTERS}
                value={filter}
                onChange={(f) => {
                  animateLayoutFor(rows.length);
                  setFilter(f);
                }}
                counts={counts}
              />

              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                <Text numberOfLines={1} style={[type.caption, { flex: 1, minWidth: 0 }]}>
                  {statusLine}
                </Text>
                <Pressable onPress={() => setSorting(true)} accessibilityRole="button" hitSlop={8}>
                  <Text numberOfLines={1} style={[{ fontSize: 13, color: C.primaryDeep, maxWidth: 170 }, weight(600)]}>
                    {orderWords + ' ▾'}
                  </Text>
                </Pressable>
              </View>

              {/* WHICH PLACES THIS IS CUT TO — a salesman who cannot find a shop
                  he knows is his needs to see the area before he concludes the
                  app has lost it. */}
              {area.length ? (
                <Text numberOfLines={1} style={[type.caption, { marginTop: -6, color: C.muted }]}>
                  {'Your area: ' + area.join(', ')}
                </Text>
              ) : null}
              {noFix && sortMode === 'me' ? (
                <Text style={[type.caption, { marginTop: -6, color: C.muted }]}>
                  No GPS yet, so the list is A–Z. Punch in, or pick a town to sort from.
                </Text>
              ) : null}
            </View>

            {asMap ? (
              /* THE MAP draws the shops loaded so far, and says so — a map that
                 quietly showed the whole book would disagree with the count. */
              <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 32 }}>
                {rows.length ? (
                  <>
                    <ShopMap
                      height={440}
                      pins={rows.map((x) => ({
                        id: x.id,
                        name: x.name,
                        lat: x.gpsLat ?? NaN,
                        lng: x.gpsLng ?? NaN,
                        isLead: Boolean(x.isLead),
                      }))}
                      onPress={openAccount}
                    />
                    <Text style={[type.caption, { marginTop: 8 }]}>
                      {rows.length < total
                        ? `The first ${grouped(rows.length)} of ${grouped(total)} in this order. Search or filter to map others, or scroll the list to load more.`
                        : `All ${grouped(total)} in this list.`}
                    </Text>
                    {hasMore ? (
                      <View style={{ marginTop: 10 }}>
                        <SecondaryButton
                          label={loadingMore ? 'Loading…' : 'Add the next ' + Math.min(30, total - rows.length) + ' to the map'}
                          /* The map has no end to scroll to, so the next page is
                             asked for here, on purpose, rather than by a gesture. */
                          onPress={() => void loadMore()}
                        />
                      </View>
                    ) : null}
                  </>
                ) : (
                  emptyCard
                )}
              </ScrollView>
            ) : (
              <FlatList
                style={{ flex: 1 }}
                contentContainerStyle={{ paddingTop: 8, paddingBottom: 24 }}
                data={rows}
                keyExtractor={(x) => x.id}
                renderItem={renderRow}
                ItemSeparatorComponent={RowGap}
                ListEmptyComponent={<View style={{ paddingHorizontal: 16 }}>{emptyCard}</View>}
                ListFooterComponent={
                  rows.length ? (
                    <PageFooter
                      loading={loadingMore}
                      failed={moreFailed}
                      done={!hasMore}
                      total={total}
                      noun="shop"
                      onRetry={() => void loadMore()}
                    />
                  ) : null
                }
                onEndReached={() => void loadMore()}
                onEndReachedThreshold={0.6}
                refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void refresh()} />}
                initialNumToRender={10}
                maxToRenderPerBatch={10}
                windowSize={9}
                removeClippedSubviews={Platform.OS === 'android'}
                keyboardShouldPersistTaps="handled"
                keyboardDismissMode="on-drag"
                showsVerticalScrollIndicator={false}
              />
            )}
          </>
        )}
      </Appear>

      {/* ------------------------------------------------------------ the order */}
      <BottomSheet open={sorting} onClose={() => setSorting(false)}>
        <Text style={[{ fontSize: 17, color: C.ink, marginBottom: 8 }, weight(600)]}>Order the list by</Text>
        {(['me', 'town', 'name', 'owed', 'unseen'] as const).map((m) => {
          const on = sortMode === m;
          return (
            <Pressable
              key={m}
              onPress={() => {
                setSorting(false);
                if (m === 'town') {
                  setCityQ('');
                  setPickingCity(true);
                  return;
                }
                setSortMode(m);
              }}
              accessibilityRole="radio"
              accessibilityState={{ selected: on }}
              style={({ pressed }) => [
                {
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: 12,
                  minHeight: 52,
                  borderBottomWidth: 1,
                  borderBottomColor: C.hairline,
                },
                pressed && { backgroundColor: C.wash },
              ]}>
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text style={[{ fontSize: 15, color: on ? C.primaryDeep : C.ink }, weight(on ? 600 : 500)]}>
                  {m === 'town' && town && on ? 'Nearest ' + shortPlace(town, 26) : SORT_LABEL[m]}
                </Text>
                <Text style={type.caption}>
                  {m === 'me'
                    ? 'From where you are standing now'
                    : m === 'town'
                      ? 'From the middle of a town you pick'
                      : m === 'name'
                        ? 'By shop name'
                        : m === 'owed'
                          ? 'Biggest outstanding first'
                          : 'Never visited first, then the longest ago'}
                </Text>
              </View>
              {on ? <Icon name="tick" size={18} color={C.primaryDeep} /> : null}
            </Pressable>
          );
        })}
      </BottomSheet>

      {/* THE TOWNS COME OUT OF THE BOOK, never a list typed into a screen. A
          town with no pinned shop cannot be measured from, so it is not
          offered. Searchable, because a book of ten thousand sells into
          hundreds of them. */}
      <BottomSheet open={pickingCity} onClose={() => setPickingCity(false)} scroll>
        <Text style={[{ fontSize: 17, color: C.ink, marginBottom: 4 }, weight(600)]}>Nearest to which town?</Text>
        <Text style={[type.caption, { marginBottom: 10 }]}>Shops nearest the middle of the town come first.</Text>
        {cities.length > 8 ? (
          <TextInput
            value={cityQ}
            onChangeText={setCityQ}
            placeholder="Find a town"
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
              marginBottom: 6,
            }}
          />
        ) : null}
        {cities.length === 0 ? (
          <Text style={[type.caption, { paddingVertical: 12 }]}>
            None of your shops has a map location yet. So there is no town to pick.
          </Text>
        ) : shownCities.length === 0 ? (
          <Text style={[type.caption, { paddingVertical: 12 }]}>No town with a pinned shop matches that.</Text>
        ) : (
          shownCities.map((c) => (
            <Pressable
              key={c.city}
              onPress={() => {
                setTown(c.city);
                setSortMode('town');
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
              <Text numberOfLines={1} style={[{ flex: 1, minWidth: 0, fontSize: 15, color: C.ink }, weight(500)]}>
                {c.city}
              </Text>
              <Text style={type.caption}>{plural(c.n, 'shop')}</Text>
            </Pressable>
          ))
        )}
      </BottomSheet>

      {/* ----------------------------------------------------- what to do here
          Everything the old card's six buttons did, one tap further away, in
          words rather than glyphs. */}
      <BottomSheet open={!!rowMore} onClose={() => setRowMore(null)}>
        <Text numberOfLines={1} style={[{ fontSize: 17, color: C.ink }, weight(600)]}>
          {rowMore ? shopName(rowMore.name) : ''}
        </Text>
        <Text numberOfLines={1} style={[type.caption, { marginBottom: 8 }]}>
          {rowMore ? [rowMore.contactPerson, rowMore.city, rowMore.phone].filter(Boolean).join(' · ') : ''}
        </Text>
        {(() => {
          const x = rowMore;
          if (!x) return null;
          const close = () => setRowMore(null);
          return (
            <>
              <SheetAction icon="shop" label="Start a visit" sub="Asks how you are getting there first" onPress={() => {
                close();
                askTravel({ customerId: x.id, customerName: x.name });
              }} />
              <SheetAction icon="order" label="Take an order" onPress={() => {
                close();
                set({ custId: x.id });
                router.push('/order?from=customers');
              }} />
              <SheetAction icon="call" label="Call" sub={x.phone ?? 'No number on this customer'} onPress={() => {
                close();
                callShop(x);
              }} />
              <SheetAction icon="chat" label="WhatsApp" sub="Opens your own WhatsApp. Nothing is sent for you." onPress={async () => {
                close();
                if (!x.phone) return notify('No number on this customer', 'warn');
                const out = await openWhatsApp(x.phone, '');
                if (out.status !== 'handed_off') notify(out.reason, 'warn');
              }} />
              <SheetAction icon="nav" label="Directions" sub={x.gpsLat != null ? 'To the pin on the map' : 'No pin. Searches the name and town.'} onPress={async () => {
                close();
                const out = await openMaps({ lat: x.gpsLat, lng: x.gpsLng, name: x.name, city: x.city });
                if (out.status !== 'opened') notify(out.reason, 'warn');
              }} />
              <SheetAction icon="sample" label="Request a sample" sub="Sent for approval" onPress={() => {
                close();
                set({ custId: x.id });
                router.push('/samples?ask=1&from=customers');
              }} />
              <SheetAction icon="doc" label="Open the record" sub="Orders, bills, payments and history" onPress={() => {
                close();
                openAccount(x);
              }} />
              {/* A complaint is raised from inside a visit, where the photographs
                  and the order it is about are to hand. Said here, because this
                  sheet is where somebody looks for it. */}
              <Text style={[type.caption, { marginTop: 10 }]}>To log a complaint, start a visit.</Text>
            </>
          );
        })()}
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
          Goods go to this shop. The bill goes to the one you pick below.
        </Text>

        {/* All four are REQUIRED and the labels say so. Every one of them was
            refused after the press, one at a time, by a toast — which is how a
            form teaches somebody that it is broken. */}
        <Field label="Shop name" required value={newShopName} onChange={setNewShopName} placeholder="Name on the shop board" />
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
          {'WHO GETS THE BILL · needed'}
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
            <Text style={type.caption}>Loading your accounts…</Text>
          ) : billers.length === 0 ? (
            <Text style={type.caption}>
              {billerQ.trim() ? 'None of your accounts match that.' : 'You have no accounts to bill yet.'}
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
              Your customers have not come to this phone yet. You must pick one of your
              accounts to get the bill. Wait for the office update, then try again.
            </Text>
          ) : (
            <PrimaryButton
              label={saving ? 'Adding…' : 'Add the shop'}
              onPress={() => void saveShop()}
              /* Saving is a hard stop with no reason attached, so the button
                 swallows the second tap; a missing biller keeps the button
                 pressable and `saveShop` answers in words. */
              disabled={saving || !billerId}
              whyDisabled={saving ? undefined : 'Pick who gets the bill, above.'}
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
        {label.toUpperCase() + (required ? ' · needed' : '')}
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
