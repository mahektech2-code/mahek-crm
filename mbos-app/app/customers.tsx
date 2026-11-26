import React from 'react';
import { View, Text, Pressable, TextInput, FlatList, RefreshControl, ScrollView, Platform, type ListRenderItemInfo } from 'react-native';
import { isOnline } from '../src/sync/engine';
import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { color as C, type, weight } from '../src/theme/tokens';
import { Icon, type IconName } from '../src/components/ui/Icon';
import { Badge, HealthPill } from '../src/components/ui/primitives';
import { PillButton, SwitchTabs } from '../src/components/ui/v3';
import { BottomSheet } from '../src/components/ui/overlays';
import { ChipRow, PageFooter, SearchBox, ToolButton } from '../src/components/ui/book-controls';
import { AppFrame } from '../src/components/shell/AppFrame';
import { useStore } from '../src/state/store';
import { getConfig } from '../src/data/config';
import { daysBetween, reorderState } from '../src/engines/leads';
import { distanceLabel, grouped, inrFromPaise, isoDate, plural, shopName } from '../src/lib/format';
import { callNumber, openMaps, openWhatsApp } from '../src/lib/messaging';
import {
  accountLine,
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
import { measureFrom } from '../src/native/where';
import { LeadsBook } from '../src/components/leads/leads-book';
import { opensLeadRecord } from '../src/lib/account-label';
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
 * `long` is the sentence a screen reader is given, because V3 cut the visible
 * words to "Late · 41 d / every 30".
 */
function dueWords(x: Customer, today: string): { text: string; long: string; tone: 'late' | 'due' | 'quiet' | 'today' } {
  const state = reorderState(x.lastOrderDate, x.cycleDays, today);
  if (state) {
    const since = daysBetween(x.lastOrderDate, today) ?? 0;
    return {
      text: `${state === 'overdue' ? 'Late' : 'Due'} · ${since} d / every ${x.cycleDays}`,
      long: `${state === 'overdue' ? 'Reorder late' : 'Reorder due'} · ${since} days, buys every ${x.cycleDays}`,
      tone: state === 'overdue' ? 'late' : 'due',
    };
  }
  const seen = daysSince(x.lastVisitDate, today);
  const text = seen == null ? 'Never visited' : seen === 0 ? 'Visited today' : `Visited ${seen} d ago`;
  return { text, long: text, tone: seen === 0 ? 'today' : 'quiet' };
}

/** A round 44-point button inside a row. The row itself is the 48-point target around it. */
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
      accessibilityState={{ disabled: dim }}
      hitSlop={2}
      style={({ pressed }) => ({
        width: 44,
        height: 44,
        borderRadius: 22,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: pressed ? C.primaryEdge : dim ? C.wash : tint ? C.primaryTint : C.canvas,
      })}>
      <Icon name={icon} size={18} color={dim ? C.faint : tint ? C.primaryDeep : C.ink} strokeWidth={2} />
    </Pressable>
  );
}

/**
 * ONE SHOP, AS A THREE-LINE ROW: who and the verdict; where; money and what is due.
 *
 * The rows of one list sit in ONE white card (V3): `first` and `last` round
 * its two ends, and every other row carries the hairline above it.
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
  first,
  last,
  onOpen,
  onMore,
  onCall,
}: {
  x: Customer;
  today: string;
  showDistance: boolean;
  healthStrong: number;
  healthWatch: number;
  first: boolean;
  last: boolean;
  onOpen: (x: Customer) => void;
  onMore: (x: Customer) => void;
  onCall: (x: Customer) => void;
}) {
  /* Only where the origin is the salesman himself. A distance from the middle
     of a town he picked is not how far HE has to walk. */
  const away = showDistance ? distanceLabel(metresFromDist2(x.dist2)) : null;
  const stage = customerStage(x);
  /* WHAT IT IS AND WHICH RUNG — "Lead · Prospect", "Third party" — off
     `accountLine`, the rule the chips above the list read. A plain customer
     says nothing here: on a list that is mostly customers, the word on every
     row would be the one row in it carrying no information. */
  const line = accountLine(x);
  const kindWord = line && line !== 'Customer' ? line : null;
  const due = dueWords(x, today);
  const owed = x.outstandingPaise > 0;
  /* Compared in PAISE against the one shared threshold — see
     `OUTSTANDING_ALERT_PAISE`. */
  const owedInk = !owed ? C.faint : x.outstandingPaise > OUTSTANDING_ALERT_PAISE ? C.danger : C.ink;
  const dueInk =
    due.tone === 'late' ? C.danger : due.tone === 'due' ? C.warnInk : due.tone === 'today' ? C.success : C.muted;
  const place = x.city ? shortPlace(x.city, 28) : null;
  const nothingWhere = !x.contactPerson && !place;

  return (
    <View
      style={{
        marginHorizontal: 14,
        backgroundColor: C.surface,
        borderTopLeftRadius: first ? 22 : 0,
        borderTopRightRadius: first ? 22 : 0,
        borderBottomLeftRadius: last ? 22 : 0,
        borderBottomRightRadius: last ? 22 : 0,
        paddingTop: first ? 4 : 0,
        paddingBottom: last ? 4 : 0,
        overflow: 'hidden',
      }}>
      <Pressable
        onPress={() => onOpen(x)}
        accessibilityRole="button"
        accessibilityLabel={shopName(x.name)}
        accessibilityHint={[owed ? inrFromPaise(x.outstandingPaise) + ' due' : 'Nothing due', due.long].join(', ')}
        style={({ pressed }) => ({
          flexDirection: 'row',
          alignItems: 'center',
          gap: 6,
          paddingLeft: 16,
          paddingRight: 6,
          paddingVertical: 12,
          marginLeft: 0,
          borderTopWidth: first ? 0 : 1,
          borderTopColor: C.hairline,
          backgroundColor: pressed ? C.wash : C.surface,
        })}>
        <View style={{ flex: 1, minWidth: 0 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <Text numberOfLines={1} style={[{ flex: 1, minWidth: 0, fontSize: 16, lineHeight: 21, color: C.ink }, weight(700)]}>
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

          <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', columnGap: 10, rowGap: 2, marginTop: 4 }}>
            {away ? <Text style={[{ fontSize: 12, lineHeight: 17, color: C.ink }, weight(700)]}>{away}</Text> : null}
            {kindWord ? (
              <View style={{ minHeight: 20, paddingVertical: 2, paddingHorizontal: 8, borderRadius: 10, backgroundColor: C.canvas, justifyContent: 'center' }}>
                <Text style={[{ fontSize: 12, lineHeight: 17, color: C.muted }, weight(600)]}>{kindWord}</Text>
              </View>
            ) : null}
            {x.contactPerson ? (
              <Text numberOfLines={1} style={{ fontSize: 12, color: C.muted, maxWidth: '45%' }}>
                {x.contactPerson}
              </Text>
            ) : null}
            {place ? <Text numberOfLines={1} style={{ fontSize: 12, color: C.muted }}>{place}</Text> : null}
            {nothingWhere ? <Text style={{ fontSize: 12, lineHeight: 17, color: C.muted }}>No contact or town on record</Text> : null}
          </View>

          <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', columnGap: 10, rowGap: 2, marginTop: 6 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
              <Icon name={owed ? 'wallet' : 'tick'} size={13} color={owedInk} strokeWidth={2.2} />
              <Text style={[{ fontSize: 13, lineHeight: 18, color: owedInk }, weight(owed ? 700 : 600)]}>
                {owed ? inrFromPaise(x.outstandingPaise) : 'Nothing due'}
              </Text>
            </View>
            {x.creditBlocked ? (
              <View style={{ minHeight: 22, paddingVertical: 3, paddingHorizontal: 8, borderRadius: 11, backgroundColor: C.dangerBg, justifyContent: 'center' }}>
                <Text style={[{ fontSize: 12, lineHeight: 17, color: C.danger }, weight(700)]}>Supply stopped</Text>
              </View>
            ) : null}
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
              {due.tone === 'late' || due.tone === 'due' ? (
                <Icon name="reorder" size={13} color={dueInk} strokeWidth={2.2} />
              ) : due.tone === 'today' ? (
                <Icon name="tick" size={13} color={dueInk} strokeWidth={2.2} />
              ) : null}
              <Text style={[{ fontSize: 13, lineHeight: 18, color: dueInk }, weight(due.tone === 'quiet' ? 600 : 700)]}>{due.text}</Text>
            </View>
          </View>
        </View>

        <RowButton
          icon="call"
          label={x.phone ? 'Call ' + shopName(x.name) : 'No number on this customer'}
          onPress={() => onCall(x)}
          tint={!!x.phone}
          dim={!x.phone}
        />
        <RowButton icon="dots" label={'More for ' + shopName(x.name)} onPress={() => onMore(x)} tint={false} />
      </Pressable>
    </View>
  );
});

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

  /* RE-READ ON EVERY RETURN TO THE TAB. A tab stays mounted, so a date
     frozen at first render went on calling yesterday "today" after midnight —
     Reorder due, Visit due and Visited today all a day out — and the origin
     for "Nearest first" stayed wherever he stood when he first opened it. */
  const [today, setToday] = React.useState(() => isoDate(new Date()));
  const [focusTick, setFocusTick] = React.useState(0);
  useFocusEffect(
    React.useCallback(() => {
      const now = isoDate(new Date());
      setToday((t) => (t === now ? t : now));
      setFocusTick((n) => n + 1);
    }, []),
  );

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
  /* A figure on Home that opens this list opens it ON the rows it counted —
     "Follow-ups 4" landing on the whole book is a number nobody can trace. */
  const params = useLocalSearchParams<{ filter?: string }>();
  React.useEffect(() => {
    const wanted = CUSTOMER_FILTERS.find((f) => f.value === params.filter);
    if (wanted) setFilter(wanted.value);
  }, [params.filter]);
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
  const [noFix, setNoFix] = React.useState<'denied' | 'off' | 'unavailable' | null>(null);

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
      void measureFrom()
        .then((w) => {
          if (!live) return;
          setOrigin('reason' in w ? null : { lat: w.lat, lng: w.lng });
          setNoFix('reason' in w ? w.reason : null);
        })
        .catch(() => {
          if (!live) return;
          setOrigin(null);
          setNoFix('unavailable');
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
    setNoFix(null);
    setOriginReady(true);
    return () => {
      live = false;
    };
    /* `focusTick`: a walk between two visits to this tab is a new origin. */
  }, [sortMode, town, cities, focusTick]);

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
      /* WHERE HE IS STANDING, which is where a shop opened at its counter is.
         `addFieldShop` has always taken a pin and nothing passed one, so every
         field shop arrived unpinned. `whereNow` never waits on the radio — the
         freshest fix already known, or none, the trade `createLead` makes. */
      const { whereNow } = await import('../src/native/where');
      const fix = await whereNow().catch(() => null);
      const r = await addFieldShop({
        name: newShopName,
        phone: shopPhone,
        city: shopCity,
        distributorCustomerId: biller.id,
        distributorName: biller.name,
        gpsLat: fix?.lat ?? null,
        gpsLng: fix?.lng ?? null,
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
    (x: { id: string; isLead?: number; isFiledLead?: number; leadStage?: string | null }) => {
      set({ custId: x.id, pTab: 0 });
      /* `/lead` only where the lead row is on this phone — see
         `opensLeadRecord`. A shop the office calls a lead whose row never
         arrived opens the record, which says it is a lead. */
      if (opensLeadRecord(x)) router.push(`/lead?id=${x.id}&from=customers`);
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
        first={index === 0}
        last={index === rows.length - 1}
        onOpen={openAccount}
        onMore={setRowMore}
        onCall={callShop}
      />
      );
      return index < STAGGER_CAP ? <Stagger index={index}>{row}</Stagger> : row;
    },
    [today, sortMode, healthStrong, healthWatch, openAccount, callShop, rows.length],
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
        ? 'Nearest first'
        : 'A–Z · no GPS'
      : sortMode === 'town'
        ? origin && town
          ? `Nearest ${shortPlace(town, 16)}`
          : 'A–Z'
        : SORT_LABEL[sortMode];
  const statusLine: { count: string | null; rest: string } = !loaded
    ? { count: null, rest: 'Reading your book…' }
    : total === 0
      ? {
          count: null,
          rest: asked || filtered ? 'No shop matches' : noArea ? 'No area set for you yet' : 'No customers yet',
        }
      : {
          count: grouped(total),
          rest:
            (total === 1 ? 'shop' : 'shops') +
            (filtered ? ` · ${filterLabel.toLowerCase()}` : '') +
            (asked ? ` · “${shortPlace(asked, 14)}”` : ''),
        };

  /* ----------------------------------------------------------- the empty card */
  const emptyShell = (children: React.ReactNode) => (
    <View style={{ backgroundColor: C.surface, borderRadius: 24, paddingVertical: 22, paddingHorizontal: 18, alignItems: 'center' }}>
      {children}
    </View>
  );
  const emptyCard = !loaded ? (
    emptyShell(<Text style={[type.caption, { textAlign: 'center' }]}>Loading your customers…</Text>)
  ) : failed ? (
    emptyShell(
      <>
        <Icon name="alert" size={36} color={C.faint} strokeWidth={1.8} />
        <Text style={[{ fontSize: 18, lineHeight: 25, color: C.ink, textAlign: 'center', marginTop: 6 }, weight(800)]}>
          Could not load your customers
        </Text>
        <Text style={{ fontSize: 13, lineHeight: 18, color: C.muted, marginTop: 4, textAlign: 'center' }}>
          Nothing is lost. Pull down to try again. If this keeps happening, tell the office.
        </Text>
      </>,
    )
  ) : (
    emptyShell(
      <>
        <Icon name="shop" size={40} color={C.faint} strokeWidth={1.8} />
        <Text style={[{ fontSize: 18, lineHeight: 25, color: C.ink, textAlign: 'center', marginTop: 6 }, weight(800)]}>
          {asked
            ? 'No shop matches that'
            : filtered
              ? `No shop is ${filterLabel.toLowerCase()}`
              : noArea
                ? 'No area set for you yet'
                : 'No customers yet'}
        </Text>
        <Text
          accessibilityLabel={
            noArea && !asked && !filtered
              ? 'Your list stays empty until the office sets your area. Nothing is lost. Ask your manager to set your area.'
              : filtered && !asked
                ? 'The rest of your book is still here under All.'
                : 'Are you in a shop where we deliver but bill someone else? Add it here and take the order.'
          }
          style={{ fontSize: 13, lineHeight: 18, color: C.muted, marginTop: 4, textAlign: 'center' }}>
          {noArea && !asked && !filtered
            ? 'Your list stays empty until the office sets your area. Nothing is lost — ask your manager.'
            : filtered && !asked
              ? 'The rest of your book is still here under All.'
              : 'We deliver here but bill someone else? Add it and take the order.'}
        </Text>
        {/* A filter can hide the shop he searched for. Said, with the way out. */}
        {filtered ? (
          <PillButton
            label="Show all shops"
            variant="outline"
            height={48}
            onPress={() => setFilter('all')}
            style={{ marginTop: 14, alignSelf: 'stretch' }}
          />
        ) : null}
        {/* WHERE THE ANSWER ACTUALLY IS — drawn only where there is something to
            find, or people learn the other tab never has the answer either. */}
        {asked && leadsMatching > 0 ? (
          <Pressable
            onPress={() => setHalf('leads')}
            accessibilityRole="button"
            accessibilityLabel={
              leadsMatching === 1 ? '1 lead matches. Open Leads' : `${grouped(leadsMatching)} leads match. Open Leads`
            }
            style={({ pressed }) => ({
              marginTop: 14,
              alignSelf: 'stretch',
              minHeight: 48,
              paddingVertical: 8,
              borderRadius: 24,
              backgroundColor: pressed ? C.primaryEdge : C.primaryTint,
              flexDirection: 'row',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 8,
            })}>
            <Icon name="person" size={16} color={C.primaryDeep} strokeWidth={2} />
            <Text style={[{ fontSize: 14, lineHeight: 20, color: C.primaryDeep }, weight(700)]}>
              {leadsMatching === 1 ? '1 lead matches · Open Leads' : `${grouped(leadsMatching)} leads match · Open Leads`}
            </Text>
          </Pressable>
        ) : null}
        {(noArea && !asked) || (filtered && !asked) ? null : (
          <PillButton
            label="+ Add a delivery shop"
            /* Secondary where the leads button above is the likelier answer. */
            variant={asked && leadsMatching > 0 ? 'outline' : 'navy'}
            height={56}
            onPress={openAdd}
            style={{ marginTop: asked && leadsMatching > 0 ? 8 : 14, alignSelf: 'stretch' }}
          />
        )}
      </>,
    )
  );

  /* No account on this handset can be billed, so the form cannot be finished.
     `billers !== null` keeps it from claiming that before the read answers. */
  const noBook = billers !== null && billers.length === 0 && !billerQ.trim();

  const shownCities = React.useMemo(() => {
    const q = cityQ.trim().toLowerCase();
    const list = q ? cities.filter((c) => c.city.toLowerCase().includes(q)) : cities;
    return list.slice(0, 60);
  }, [cities, cityQ]);

  /* The order pill turns amber when "nearest" could not be honoured — the
     list he is reading is A–Z and the pill is where he looks to see why. */
  const orderFellBack = (sortMode === 'me' || sortMode === 'town') && !origin;

  return (
    <AppFrame
      title="Book"
      activeTab="customers"
      scroll={false}
      hero={
        <View style={{ marginTop: 16 }}>
          {/* THE TWO HALVES OF THE BOOK, above everything, because they decide
              which of two jobs he is doing and that has to be on the screen the
              whole time he is looking at it. */}
          <SwitchTabs
            options={[
              { key: 'customers', label: 'Customers', icon: 'shop', badge: counts && !asked ? counts.all : null },
              /* What is still being WORKED — a badge counting leads finished
                 with in March only ever grows and nobody can clear it. */
              { key: 'leads', label: 'Leads', icon: 'person', badge: leadCount },
            ]}
            value={half}
            onChange={(h) => {
              setHalfMoved(true);
              setHalf(h);
            }}
          />
          {half === 'customers' ? (
            <View style={{ flexDirection: 'row', gap: 8, marginTop: 12 }}>
              <SearchBox
                value={typed}
                onChange={setTyped}
                onClear={clearSearch}
                placeholder="Name, phone, GST, city, code"
              />
              <ToolButton icon="filter" tone="navy" label={'Order: ' + SORT_LABEL[sortMode]} onPress={() => setSorting(true)} />
              {/* LIST OR MAP. It does not change WHICH shops are in the book,
                  only how the same page is drawn. */}
              <ToolButton
                icon={asMap ? 'list' : 'map'}
                label={asMap ? 'Show as a list' : 'Show on a map'}
                on={asMap}
                onPress={() => setAsMap((m) => !m)}
              />
            </View>
          ) : null}
        </View>
      }>
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
            <View style={{ paddingHorizontal: 14, paddingTop: 14, gap: 12 }}>
              {/* The tick is in `ChipRow`. The layout eases only on a short list —
                  the new page lands later and cascades in by itself. */}
              <ChipRow
                chips={CHIPS}
                decor={CHIP_DECOR}
                wrap
                value={filter}
                onChange={(f) => {
                  animateLayoutFor(rows.length);
                  setFilter(f);
                }}
                counts={counts}
              />

              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                <Text numberOfLines={1} style={{ flex: 1, minWidth: 0, fontSize: 13, color: C.muted }}>
                  {statusLine.count != null ? (
                    <Text style={[{ fontSize: 15, color: C.ink }, weight(800)]}>{statusLine.count + ' '}</Text>
                  ) : null}
                  {statusLine.rest}
                </Text>
                <Pressable
                  onPress={() => setSorting(true)}
                  accessibilityRole="button"
                  accessibilityLabel={'Order: ' + orderWords + '. Change it'}
                  hitSlop={8}
                  style={({ pressed }) => ({
                    minHeight: 32,
                    paddingVertical: 4,
                    paddingHorizontal: 12,
                    borderRadius: 16,
                    backgroundColor: orderFellBack ? C.warnBg : pressed ? C.wash : C.surface,
                    flexDirection: 'row',
                    alignItems: 'center',
                    gap: 6,
                    maxWidth: '55%',
                    flexShrink: 1,
                  })}>
                  {!orderFellBack && (sortMode === 'me' || sortMode === 'town') ? (
                    <Icon name="nav" size={14} color={C.primaryDeep} strokeWidth={2} />
                  ) : null}
                  <Text
                    numberOfLines={1}
                    style={[{ fontSize: 13, color: orderFellBack ? C.warnInk : C.primaryDeep, flexShrink: 1 }, weight(700)]}>
                    {orderWords + ' ▾'}
                  </Text>
                </Pressable>
              </View>

              {/* WHICH PLACES THIS IS CUT TO — a salesman who cannot find a shop
                  he knows is his needs to see the area before he concludes the
                  app has lost it. */}
              {area.length ? (
                <View
                  accessible
                  accessibilityLabel={'Your area: ' + area.join(', ')}
                  style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: -4 }}>
                  <Icon name="pin" size={14} color={C.muted} strokeWidth={2} />
                  <Text numberOfLines={1} style={{ flex: 1, fontSize: 12, color: C.muted }}>
                    {area.join(', ')}
                  </Text>
                </View>
              ) : null}
              {noFix && sortMode === 'me' ? (
                <View
                  style={{
                    backgroundColor: C.warnBg,
                    borderRadius: 16,
                    paddingVertical: 10,
                    paddingHorizontal: 14,
                    flexDirection: 'row',
                    gap: 10,
                  }}>
                  <Icon name="locate" size={18} color={C.warnInk} strokeWidth={2} />
                  <Text style={{ flex: 1, fontSize: 13, lineHeight: 18, color: C.warnInk }}>
                    {noFix === 'denied'
                      ? 'Location is not allowed for Mahek MBOS, so A–Z. Allow it in phone settings, or pick a town.'
                      : noFix === 'off'
                        ? 'Location is switched off on this phone, so A–Z. Turn it on, or pick a town.'
                        : 'No GPS yet, so A–Z. Step outside, or pick a town.'}
                  </Text>
                </View>
              ) : null}
            </View>

            {asMap ? (
              /* THE MAP draws the shops loaded so far, and says so — a map that
                 quietly showed the whole book would disagree with the count. */
              <ScrollView contentContainerStyle={{ paddingHorizontal: 14, paddingTop: 12, paddingBottom: 32 }}>
                {rows.length ? (
                  <>
                    <View style={{ borderRadius: 24, overflow: 'hidden' }}>
                      <ShopMap
                        height={440}
                        pins={rows.map((x) => ({
                          id: x.id,
                          name: x.name,
                          lat: x.gpsLat ?? NaN,
                          lng: x.gpsLng ?? NaN,
                          isLead: Boolean(x.isLead),
                        }))}
                        onPress={(p) => {
                          const row = rows.find((r) => r.id === p.id);
                          if (row) openAccount(row);
                        }}
                      />
                    </View>
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 10 }}>
                      <Text
                        accessibilityLabel={
                          rows.length < total
                            ? `The first ${grouped(rows.length)} of ${grouped(total)} in this order. Search or filter to map others, or scroll the list to load more.`
                            : `All ${grouped(total)} in this list.`
                        }
                        style={{ flex: 1, fontSize: 13, color: C.muted }}>
                        {rows.length < total ? 'Map shows ' : 'Map shows all '}
                        <Text style={[{ color: C.ink }, weight(700)]}>
                          {rows.length < total ? `${grouped(rows.length)} of ${grouped(total)}` : grouped(total)}
                        </Text>
                        {' in this order'}
                      </Text>
                      {hasMore ? (
                        <PillButton
                          label={loadingMore ? 'Loading…' : '+ next ' + Math.min(30, total - rows.length)}
                          a11y={'Add the next ' + Math.min(30, total - rows.length) + ' to the map'}
                          variant="white"
                          height={44}
                          disabled={loadingMore}
                          /* The map has no end to scroll to, so the next page is
                             asked for here, on purpose, rather than by a gesture. */
                          onPress={() => void loadMore()}
                        />
                      ) : null}
                    </View>
                  </>
                ) : (
                  emptyCard
                )}
              </ScrollView>
            ) : (
              <FlatList
                style={{ flex: 1 }}
                contentContainerStyle={{ paddingTop: 12, paddingBottom: 24 }}
                data={rows}
                keyExtractor={(x) => x.id}
                renderItem={renderRow}
                ListEmptyComponent={<View style={{ paddingHorizontal: 14 }}>{emptyCard}</View>}
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
        <Text style={[{ fontSize: 20, lineHeight: 26, color: C.ink, marginTop: 6 }, weight(800)]}>Order by</Text>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginTop: 14 }}>
          {(['me', 'town', 'name', 'owed', 'unseen'] as const).map((m) => {
            const on = sortMode === m;
            const wide = m === 'unseen';
            const glyphInk = on ? C.lime : m === 'owed' ? C.danger : m === 'unseen' ? C.ink : C.primaryDeep;
            const glyph =
              m === 'name' ? (
                <Text style={[{ fontSize: 20, color: on ? C.lime : C.primaryDeep }, weight(800)]}>A–Z</Text>
              ) : (
                <Icon
                  name={m === 'me' ? 'nav' : m === 'town' ? 'pin' : m === 'owed' ? 'wallet' : 'clock'}
                  size={22}
                  color={glyphInk}
                  strokeWidth={2}
                />
              );
            const title =
              m === 'town' && town && on ? 'Nearest ' + shortPlace(town, 18) : m === 'name' ? 'Name' : SORT_LABEL[m];
            const sub =
              m === 'me'
                ? 'from where you stand'
                : m === 'town'
                  ? 'middle of a town you pick'
                  : m === 'name'
                    ? 'by shop name'
                    : m === 'owed'
                      ? 'biggest first'
                      : 'never visited first, then longest ago';
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
                accessibilityLabel={(m === 'name' ? 'A–Z' : title) + ', ' + sub}
                style={({ pressed }) => ({
                  width: wide ? '100%' : '48.5%',
                  height: wide ? 64 : 92,
                  borderRadius: 20,
                  padding: 14,
                  paddingVertical: wide ? 0 : 14,
                  backgroundColor: on ? C.navy : pressed ? C.hairline : C.canvas,
                  flexDirection: wide ? 'row' : 'column',
                  alignItems: wide ? 'center' : 'flex-start',
                  justifyContent: wide ? 'flex-start' : 'space-between',
                  gap: wide ? 12 : 0,
                })}>
                {glyph}
                <View style={{ flexShrink: 1 }}>
                  <Text numberOfLines={1} style={[{ fontSize: 15, color: on ? '#FFFFFF' : C.ink }, weight(700)]}>
                    {title}
                  </Text>
                  <Text numberOfLines={1} style={[{ fontSize: 12, color: on ? C.faint : C.muted }, weight(500)]}>
                    {sub}
                  </Text>
                </View>
              </Pressable>
            );
          })}
        </View>
      </BottomSheet>

      {/* THE TOWNS COME OUT OF THE BOOK, never a list typed into a screen. A
          town with no pinned shop cannot be measured from, so it is not
          offered. Searchable, because a book of ten thousand sells into
          hundreds of them. */}
      <BottomSheet open={pickingCity} onClose={() => setPickingCity(false)} scroll>
        <Text style={[{ fontSize: 20, lineHeight: 26, color: C.ink, marginTop: 6 }, weight(800)]}>Nearest which town?</Text>
        <Text style={{ fontSize: 13, lineHeight: 18, color: C.muted, marginTop: 2, marginBottom: 12 }}>
          Shops nearest its middle come first.
        </Text>
        {cities.length > 8 ? (
          <View style={{ flexDirection: 'row', marginBottom: 8 }}>
            <SearchBox value={cityQ} onChange={setCityQ} onClear={() => setCityQ('')} placeholder="Find a town" bg={C.canvas} />
          </View>
        ) : null}
        {cities.length === 0 ? (
          <Text style={[type.caption, { paddingVertical: 12 }]}>
            None of your shops has a map pin yet, so there is no town to pick.
          </Text>
        ) : shownCities.length === 0 ? (
          <Text style={[type.caption, { paddingVertical: 12 }]}>No town with a pinned shop matches that.</Text>
        ) : (
          shownCities.map((c, i) => (
            <Pressable
              key={c.city}
              onPress={() => {
                setTown(c.city);
                setSortMode('town');
                setPickingCity(false);
              }}
              accessibilityRole="button"
              accessibilityLabel={c.city + ', ' + plural(c.n, 'shop')}
              style={({ pressed }) => [
                {
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: 10,
                  minHeight: 54,
                  borderTopWidth: i ? 1 : 0,
                  borderTopColor: C.hairline,
                },
                pressed && { backgroundColor: C.wash },
              ]}>
              <Icon name="pin" size={16} color={C.primaryDeep} strokeWidth={2} />
              <Text numberOfLines={1} style={[{ flex: 1, minWidth: 0, fontSize: 15, color: C.ink }, weight(700)]}>
                {c.city}
              </Text>
              <View style={{ minHeight: 26, paddingVertical: 3, paddingHorizontal: 10, borderRadius: 13, backgroundColor: C.canvas, justifyContent: 'center' }}>
                <Text style={[{ fontSize: 12, lineHeight: 17, color: C.body }, weight(700)]}>{grouped(c.n)}</Text>
              </View>
            </Pressable>
          ))
        )}
      </BottomSheet>

      {/* ----------------------------------------------------- what to do here
          Everything the old card's six buttons did, one tap further away, in
          words rather than glyphs. */}
      <BottomSheet open={!!rowMore} onClose={() => setRowMore(null)}>
        {(() => {
          const x = rowMore;
          if (!x) return null;
          const close = () => setRowMore(null);
          const tile = (
            key: string,
            icon: IconName,
            label: string,
            sub: string | null,
            onPress: () => void,
            a11y: string,
            tone: 'primary' | 'plain' = 'plain',
            iconInk: string = C.primaryDeep,
          ) => (
            <Pressable
              key={key}
              onPress={onPress}
              accessibilityRole="button"
              accessibilityLabel={a11y}
              style={({ pressed }) => ({
                width: '31.6%',
                minHeight: 92,
                paddingVertical: 8,
                borderRadius: 20,
                backgroundColor: tone === 'primary' ? (pressed ? C.primaryDeep : C.primary) : pressed ? C.hairline : C.canvas,
                alignItems: 'center',
                justifyContent: 'center',
                gap: sub ? 4 : 8,
                paddingHorizontal: 6,
              })}>
              <Icon name={icon} size={24} color={tone === 'primary' ? '#FFFFFF' : iconInk} strokeWidth={2} />
              <Text style={[{ fontSize: 13, lineHeight: 18, color: tone === 'primary' ? '#FFFFFF' : C.ink }, weight(700)]}>{label}</Text>
              {sub ? (
                <Text numberOfLines={1} style={[{ fontSize: 11, color: C.muted, textAlign: 'center' }, weight(500)]}>
                  {sub}
                </Text>
              ) : null}
            </Pressable>
          );
          const meta: { icon: IconName; text: string }[] = [];
          if (x.contactPerson) meta.push({ icon: 'person', text: x.contactPerson });
          if (x.city) meta.push({ icon: 'pin', text: shortPlace(x.city, 26) });
          if (x.phone) meta.push({ icon: 'call', text: x.phone });
          return (
            <>
              <Text numberOfLines={1} style={[{ fontSize: 20, color: C.ink, marginTop: 6 }, weight(800)]}>
                {shopName(x.name)}
              </Text>
              {meta.length ? (
                <View style={{ flexDirection: 'row', flexWrap: 'wrap', columnGap: 12, rowGap: 4, marginTop: 6 }}>
                  {meta.map((m) => (
                    <View key={m.icon} style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
                      <Icon name={m.icon} size={14} color={C.muted} strokeWidth={2} />
                      <Text numberOfLines={1} style={{ fontSize: 13, color: C.muted, maxWidth: 200 }}>
                        {m.text}
                      </Text>
                    </View>
                  ))}
                </View>
              ) : null}

              <Pressable
                onPress={() => {
                  close();
                  askTravel({ customerId: x.id, customerName: x.name });
                }}
                accessibilityRole="button"
                accessibilityLabel="Start a visit. Asks how you are getting there first"
                style={({ pressed }) => ({
                  marginTop: 16,
                  minHeight: 60,
                  paddingVertical: 10,
                  borderRadius: 30,
                  backgroundColor: C.navy,
                  opacity: pressed ? 0.88 : 1,
                  flexDirection: 'row',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: 10,
                })}>
                <Icon name="shop" size={20} color={C.lime} strokeWidth={2} />
                <Text style={[{ fontSize: 16, lineHeight: 22, color: '#FFFFFF' }, weight(700)]}>Start a visit</Text>
                <Text style={[{ fontSize: 12, lineHeight: 17, color: C.faint }, weight(500)]}>· asks how you travel</Text>
              </Pressable>

              <View style={{ flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', rowGap: 8, marginTop: 10 }}>
                {tile('order', 'order', 'Order', null, () => {
                  close();
                  set({ custId: x.id });
                  router.push('/order?from=customers');
                }, 'Take an order', 'primary')}
                {tile('call', 'call', 'Call', x.phone ? null : 'no number', () => {
                  close();
                  callShop(x);
                }, x.phone ? 'Call ' + x.phone : 'Call. No number on this customer')}
                {tile('wa', 'chat', 'WhatsApp', 'your own app', async () => {
                  close();
                  if (!x.phone) return notify('No number on this customer', 'warn');
                  const out = await openWhatsApp(x.phone, '');
                  if (out.status !== 'handed_off') notify(out.reason, 'warn');
                }, 'WhatsApp. Opens your own WhatsApp. Nothing is sent for you.', 'plain', C.success)}
                {tile('nav', 'nav', 'Directions', x.gpsLat != null ? 'to the pin' : 'by name', async () => {
                  close();
                  const out = await openMaps({ lat: x.gpsLat, lng: x.gpsLng, name: x.name, city: x.city });
                  if (out.status !== 'opened') notify(out.reason, 'warn');
                }, x.gpsLat != null ? 'Directions to the pin on the map' : 'Directions. No pin. Searches the name and town.', 'plain', C.ink)}
                {tile('sample', 'sample', 'Sample', 'for approval', () => {
                  close();
                  set({ custId: x.id });
                  router.push('/samples?ask=1&from=customers');
                }, 'Request a sample. Sent for approval')}
                {tile('record', 'doc', 'Record', 'orders, bills, history', () => {
                  close();
                  openAccount(x);
                }, 'Open the record. Orders, bills, payments and history', 'plain', C.ink)}
              </View>
              {/* A complaint is raised from inside a visit, where the photographs
                  and the order it is about are to hand. Said here, because this
                  sheet is where somebody looks for it. */}
              <View
                accessible
                accessibilityLabel="To log a complaint, start a visit."
                style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 14 }}>
                <Icon name="warn" size={16} color={C.danger} strokeWidth={2} />
                <Text style={{ fontSize: 13, lineHeight: 18, color: C.muted }}>Complaint? Start a visit.</Text>
              </View>
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
        <Text style={[{ fontSize: 20, lineHeight: 26, color: C.ink, marginTop: 6 }, weight(800)]}>Delivery shop</Text>
        <View
          accessible
          accessibilityLabel="Add a delivery shop. Goods go to this shop. The bill goes to the one you pick below."
          style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 6 }}>
          <Icon name="route" size={16} color={C.muted} strokeWidth={2} />
          <Text style={{ fontSize: 13, lineHeight: 18, color: C.muted }}>Goods here · bill to the account below</Text>
        </View>

        {/* All four are REQUIRED and the marks say so. Every one of them was
            refused after the press, one at a time, by a toast — which is how a
            form teaches somebody that it is broken. */}
        <View style={{ gap: 10, marginTop: 14 }}>
          <Field icon="shop" label="Shop name" required value={newShopName} onChange={setNewShopName} placeholder="Name on the shop board" />
          <Field
            icon="call"
            label="Phone"
            required
            value={shopPhone}
            onChange={setShopPhone}
            placeholder="Phone, 10 digits"
            keyboard="phone-pad"
          />
          <Field icon="pin" label="Town" required value={shopCity} onChange={setShopCity} placeholder="Town, e.g. Nashik" />
        </View>

        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 16, marginBottom: 8 }}>
          <Icon name="doc" size={16} color={C.ink} strokeWidth={2} />
          <Text accessibilityLabel="Who gets the bill, needed" style={[{ fontSize: 13, lineHeight: 18, color: C.ink }, weight(700)]}>
            Bill goes to <Text style={{ color: C.danger }}>*</Text>
          </Text>
        </View>
        <View style={{ flexDirection: 'row' }}>
          <SearchBox value={billerQ} onChange={setBillerQ} onClear={() => setBillerQ('')} placeholder="Search your accounts" bg={C.canvas} />
        </View>
        <View style={{ gap: 8, marginTop: 8 }}>
          {(billers ?? []).slice(0, 6).map((b) => {
            const on = b.id === billerId;
            return (
              <Pressable
                key={b.id}
                onPress={() => setBillerId(b.id)}
                accessibilityRole="radio"
                accessibilityState={{ selected: on }}
                accessibilityLabel={b.name}
                style={{
                  minHeight: 56,
                  borderRadius: 18,
                  paddingHorizontal: 14,
                  paddingVertical: 8,
                  backgroundColor: on ? C.navy : C.canvas,
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: 10,
                }}>
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Text numberOfLines={1} style={[{ fontSize: 15, color: on ? '#FFFFFF' : C.ink }, weight(700)]}>
                    {b.name}
                  </Text>
                  <Text numberOfLines={1} style={{ fontSize: 12, color: on ? C.faint : C.muted }}>
                    {[b.contactPerson, b.city].filter(Boolean).join(' · ')}
                  </Text>
                </View>
                {on ? <Icon name="tick" size={20} color={C.lime} strokeWidth={2.4} /> : null}
              </Pressable>
            );
          })}
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
            <PillButton
              label={saving ? 'Adding…' : 'Add the shop'}
              variant="lime"
              height={60}
              onPress={() => void saveShop()}
              /* Saving is a hard stop with no reason attached, so the button
                 swallows the second tap; a missing biller keeps the button
                 pressable and answers in words. */
              disabled={saving || !billerId}
              whyDisabled={saving ? undefined : 'Pick who gets the bill, above.'}
              onRefused={(why) => notify(why, 'warn')}
            />
          )}
        </View>
      </BottomSheet>
    </AppFrame>
  );
}

/** The V3 filter chips' words and glyphs. The data layer's labels stay the a11y names. */
const CHIP_WORDS: Partial<Record<CustomerFilter, string>> = { followUp: 'Follow-up', unpinned: 'No pin' };
const CHIPS = CUSTOMER_FILTERS.map((f) => ({ value: f.value, label: CHIP_WORDS[f.value] ?? f.label }));
const CHIP_DECOR: Partial<Record<CustomerFilter, { icon?: IconName; ink?: string; iconInk?: string; iconOnly?: boolean }>> = {
  owing: { icon: 'wallet', ink: C.danger, iconOnly: true },
  followUp: { icon: 'cal', iconInk: C.primaryDeep },
  reorder: { icon: 'reorder', ink: C.warnInk, iconOnly: true },
  visitDue: { icon: 'shop' },
  unpinned: { icon: 'pin' },
};

/**
 * One labelled box.
 *
 * Local to this screen rather than a primitive: three fields is not a design
 * system. V3 draws it as a wash pill with the field's glyph and a red `*`;
 * the label rides on the box for a screen reader.
 */
function Field({
  icon,
  label,
  required,
  value,
  onChange,
  placeholder,
  keyboard,
}: {
  icon: IconName;
  label: string;
  required?: boolean;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  keyboard?: 'phone-pad';
}) {
  return (
    <View
      style={{
        minHeight: 52,
        borderRadius: 16,
        backgroundColor: C.canvas,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 10,
        paddingHorizontal: 14,
      }}>
      <Icon name={icon} size={18} color={C.muted} strokeWidth={2} />
      <TextInput
        value={value}
        onChangeText={onChange}
        placeholder={placeholder}
        placeholderTextColor={C.faint}
        keyboardType={keyboard}
        accessibilityLabel={label + (required ? ', needed' : '')}
        style={{ flex: 1, minWidth: 0, minHeight: 52, fontSize: 15, color: C.ink }}
      />
      {required ? <Text style={[{ color: C.danger, fontSize: 15 }, weight(700)]}>*</Text> : null}
    </View>
  );
}
