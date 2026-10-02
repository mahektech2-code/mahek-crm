import React from 'react';
import { Pressable, ScrollView, TextInput, View } from 'react-native';
import { router, useFocusEffect } from 'expo-router';

import { AppFrame, BackLink, useCameFrom } from '../src/components/shell/AppFrame';
import { Badge, Card, ListCard, T } from '../src/components/ui/primitives';
import { Icon } from '../src/components/ui/Icon';
import { Chip } from '../src/components/ui/account-parts';
import { bookMoney, listAccountsPage, type BookMoney } from '../src/data/customer-account';
import type { AccountFilter, AccountSort } from '../src/data/customer-query';
import type { Customer } from '../src/data/customers';
import { creditUse, longDay } from '../src/engines/account-view';
import { compactInrFromPaise, inrFromPaise, plural, shopName } from '../src/lib/format';
import { color as C, radius, tabular, weight } from '../src/theme/tokens';

/**
 * CUSTOMER ACCOUNTS — his book, as the Accounts app sees it.
 *
 * The Customers tab is the book as a salesman WORKS it: nearest first, leads
 * beside customers, visits and health. This is the same book as accounts READ
 * it: who owes what, who is past the limit the office set, who the office has
 * stopped supplying. Every figure on it is the office's own outstanding, sent
 * on the pull — so the list works with no signal, and the number on a row is
 * the number an accounts clerk would read out for the same shop.
 *
 * Tapping a row opens the account in full — statement, bills, payments,
 * aging, credit notes — which is asked of the office and remembered.
 *
 * It is READ-ONLY by design. Confirming, reversing and re-pointing money are
 * accounts' decisions; the salesman's own actions — collect a payment, take an
 * order — start where they always have, from the + button.
 */

const FILTERS: { key: AccountFilter; label: string }[] = [
  { key: 'all', label: 'All accounts' },
  { key: 'owing', label: 'Owe money' },
  { key: 'over', label: 'Over limit' },
  { key: 'blocked', label: 'Supply stopped' },
  { key: 'third', label: 'Billed elsewhere' },
];

const SORTS: { key: AccountSort; label: string }[] = [
  { key: 'owed', label: 'Most owed' },
  { key: 'name', label: 'A–Z' },
];

const PAGE = 40;

export default function AccountsScreen() {
  const back = useCameFrom('more');
  const [query, setQuery] = React.useState('');
  const [filter, setFilter] = React.useState<AccountFilter>('all');
  const [sort, setSort] = React.useState<AccountSort>('owed');
  const [rows, setRows] = React.useState<Customer[] | null>(null);
  const [total, setTotal] = React.useState(0);
  const [hasMore, setHasMore] = React.useState(false);
  const [money, setMoney] = React.useState<BookMoney | null>(null);
  const [loadingMore, setLoadingMore] = React.useState(false);

  /* One reading per change of question. `live` drops an answer that arrives
     after the question changed — typing "sh" then "shr" must never leave the
     "sh" page on the screen because its query happened to finish last. */
  useFocusEffect(
    React.useCallback(() => {
      let live = true;
      void Promise.all([listAccountsPage({ query, filter, sort, limit: PAGE }), bookMoney()]).then(
        ([page, m]) => {
          if (!live) return;
          setRows(page.rows);
          setTotal(page.total);
          setHasMore(page.hasMore);
          setMoney(m);
        },
      );
      return () => {
        live = false;
      };
    }, [query, filter, sort]),
  );

  const more = () => {
    if (!rows || loadingMore) return;
    setLoadingMore(true);
    void listAccountsPage({ query, filter, sort, offset: rows.length, limit: PAGE })
      .then((page) => {
        setRows((r) => [...(r ?? []), ...page.rows]);
        setHasMore(page.hasMore);
      })
      .finally(() => setLoadingMore(false));
  };

  const open = (c: Customer) =>
    router.push(`/account?id=${encodeURIComponent(c.id)}&from=accounts`);

  return (
    <AppFrame title="MBOS" activeTab={null} contentStyle={{ padding: 16, paddingBottom: 32 }}>
      <BackLink label={back.label} onPress={back.go} />
      <T s="h1">Customer accounts</T>
      <T s="small" style={{ color: C.muted, marginTop: 2 }}>
        Your customers&apos; accounts, as the accounts team sees them. Open one for its bills,
        payments and statement.
      </T>

      {/* ---- the book's money ----

          The book, not the filter: these do not move as chips are tapped,
          because a total that changes under your thumb is a total nobody can
          quote. Each figure is also a way in — tapping it sets the chip that
          lists what it counts. */}
      <Card style={{ marginTop: 14, padding: 0, overflow: 'hidden' }}>
        <View style={{ padding: 16, borderLeftWidth: 3, borderLeftColor: money?.owedPaise ? C.danger : C.border }}>
          <T s="label">Owed to us across your book</T>
          <T style={[{ fontSize: 28, lineHeight: 34, color: C.ink, marginTop: 2 }, weight(600), tabular]}>
            {money ? inrFromPaise(money.owedPaise) : '—'}
          </T>
          <T s="caption" style={{ marginTop: 2 }}>
            {money
              ? `${plural(money.owing, 'account')} of ${money.accounts} owe money · confirmed money only`
              : 'Loading…'}
          </T>
        </View>
        <View style={{ flexDirection: 'row', borderTopWidth: 1, borderTopColor: C.hairline }}>
          <Stat
            label="Owe money"
            value={money ? String(money.owing) : '—'}
            on={filter === 'owing'}
            onPress={() => setFilter(filter === 'owing' ? 'all' : 'owing')}
          />
          <Stat
            label="Over limit"
            value={money ? String(money.over) : '—'}
            tone={money?.over ? C.danger : undefined}
            on={filter === 'over'}
            onPress={() => setFilter(filter === 'over' ? 'all' : 'over')}
            divider
          />
          <Stat
            label="Supply stopped"
            value={money ? String(money.blocked) : '—'}
            tone={money?.blocked ? C.warnInk : undefined}
            on={filter === 'blocked'}
            onPress={() => setFilter(filter === 'blocked' ? 'all' : 'blocked')}
            divider
          />
        </View>
      </Card>

      {/* ---- search ---- */}
      <View
        style={{
          marginTop: 14,
          flexDirection: 'row',
          alignItems: 'center',
          gap: 8,
          height: 52,
          paddingHorizontal: 14,
          borderRadius: radius.lg,
          borderWidth: 1,
          borderColor: C.border,
          backgroundColor: C.surface,
        }}>
        <Icon name="search" size={20} color={C.muted} strokeWidth={1.6} />
        <TextInput
          value={query}
          onChangeText={setQuery}
          placeholder="Shop, owner, city, phone or GST"
          placeholderTextColor={C.faint}
          autoCorrect={false}
          autoCapitalize="none"
          returnKeyType="search"
          accessibilityLabel="Search customer accounts"
          style={{ flex: 1, fontSize: 16, color: C.ink, height: '100%' }}
        />
        {query ? (
          <Pressable
            onPress={() => setQuery('')}
            accessibilityRole="button"
            accessibilityLabel="Clear search"
            hitSlop={12}>
            <Icon name="close" size={18} color={C.muted} strokeWidth={1.6} />
          </Pressable>
        ) : null}
      </View>

      {/* ---- the chips ---- */}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={{ gap: 8, paddingRight: 16 }}
        style={{ flexGrow: 0, marginTop: 12, marginHorizontal: -16, paddingHorizontal: 16 }}>
        {FILTERS.map((f) => (
          <Chip key={f.key} label={f.label} on={filter === f.key} onPress={() => setFilter(f.key)} />
        ))}
      </ScrollView>

      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 14 }}>
        <T s="caption">
          {rows === null ? 'Loading…' : query || filter !== 'all' ? `${plural(total, 'account')} match` : plural(total, 'account')}
        </T>
        <View style={{ flexDirection: 'row', gap: 4 }}>
          {SORTS.map((s) => (
            <Pressable
              key={s.key}
              onPress={() => setSort(s.key)}
              accessibilityRole="button"
              accessibilityState={{ selected: sort === s.key }}
              style={{ paddingHorizontal: 10, paddingVertical: 6, borderRadius: radius.sm, backgroundColor: sort === s.key ? C.primaryTint : 'transparent' }}>
              <T style={[{ fontSize: 13, color: sort === s.key ? C.primaryDeep : C.muted }, weight(sort === s.key ? 500 : 400)]}>
                {s.label}
              </T>
            </Pressable>
          ))}
        </View>
      </View>

      {/* ---- the list ---- */}
      {rows === null ? null : rows.length === 0 ? (
        <Card style={{ marginTop: 10, paddingVertical: 28 }}>
          <T style={{ fontSize: 15, lineHeight: 22, color: C.ink, textAlign: 'center' }}>
            {query ? `No account matches “${query}”` : 'No accounts here'}
          </T>
          <T s="small" style={{ color: C.muted, textAlign: 'center', marginTop: 6 }}>
            {query
              ? 'Try part of the shop name, the owner, the phone number or the GST number.'
              : filter === 'all'
                ? 'Your customers come from the office. If you have shops and see none, open Send to office and sync.'
                : 'None of your customers fall under this filter.'}
          </T>
        </Card>
      ) : (
        <ListCard style={{ marginTop: 10 }}>
          {rows.map((c, i) => (
            <AccountRow key={c.id} c={c} first={i === 0} onPress={() => open(c)} />
          ))}
        </ListCard>
      )}

      {hasMore ? (
        <Pressable
          onPress={more}
          accessibilityRole="button"
          style={{ marginTop: 12, height: 48, borderRadius: radius.lg, borderWidth: 1, borderColor: C.border, backgroundColor: C.surface, alignItems: 'center', justifyContent: 'center' }}>
          <T style={[{ fontSize: 15, color: C.primary }, weight(500)]}>
            {loadingMore ? 'Loading…' : `Show more · ${total - (rows?.length ?? 0)} left`}
          </T>
        </Pressable>
      ) : null}

      {money?.syncedAt ? (
        <T s="caption" style={{ marginTop: 14, textAlign: 'center' }}>
          Figures from the office, last refreshed on this phone with the sync.
        </T>
      ) : null}
    </AppFrame>
  );
}

/* ---------------------------------------------------------------- pieces */

function AccountRow({ c, first, onPress }: { c: Customer; first: boolean; onPress: () => void }) {
  const owed = c.outstandingPaise ?? 0;
  const use = creditUse(owed, c.creditLimitPaise);
  const over = use != null && use > 100;
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`${c.name}, ${owed > 0 ? inrFromPaise(owed) + ' outstanding' : 'nothing outstanding'}`}
      style={({ pressed }) => [
        { paddingHorizontal: 16, paddingVertical: 14, borderTopWidth: first ? 0 : 1, borderTopColor: C.wash },
        pressed && { backgroundColor: C.wash },
      ]}>
      <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 12 }}>
        <View style={{ flex: 1, minWidth: 0 }}>
          <T style={[{ fontSize: 15, lineHeight: 21, color: C.ink }, weight(500)]} numberOfLines={1}>
            {shopName(c.name)}
          </T>
          <T s="caption" numberOfLines={1}>
            {[c.city, c.lastOrderDate ? 'last order ' + longDay(c.lastOrderDate) : null].filter(Boolean).join(' · ') || '—'}
          </T>
        </View>
        <View style={{ alignItems: 'flex-end' }}>
          <T style={[{ fontSize: 16, lineHeight: 22, color: owed > 0 ? (over ? C.danger : C.ink) : C.muted }, weight(600), tabular]}>
            {owed > 0 ? inrFromPaise(owed) : 'Nothing due'}
          </T>
          {c.creditLimitPaise ? (
            <T s="micro" style={tabular}>
              of {compactInrFromPaise(c.creditLimitPaise)} limit
            </T>
          ) : null}
        </View>
        <Icon name="forward" size={18} color={C.faint} strokeWidth={1.5} />
      </View>

      {/* How much of the limit is used — drawn only where there IS a limit.
          A bar with no limit behind it would be a percentage of nothing. */}
      {use != null ? (
        <View style={{ marginTop: 8, height: 4, borderRadius: 2, backgroundColor: C.hairline, overflow: 'hidden', marginRight: 30 }}>
          <View
            style={{
              width: `${Math.min(100, use)}%`,
              height: 4,
              backgroundColor: over ? C.danger : use >= 80 ? C.warn : C.success,
            }}
          />
        </View>
      ) : null}

      {c.creditBlocked || over || c.thirdParty ? (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 8 }}>
          {c.creditBlocked ? <Badge tone="danger">Supply stopped</Badge> : null}
          {over ? <Badge tone="danger">{use}% of limit</Badge> : null}
          {c.thirdParty ? <Badge tone="neutral">Billed to distributor</Badge> : null}
        </View>
      ) : null}
    </Pressable>
  );
}

function Stat({
  label,
  value,
  tone,
  on,
  onPress,
  divider,
}: {
  label: string;
  value: string;
  tone?: string;
  on: boolean;
  onPress: () => void;
  divider?: boolean;
}) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityState={{ selected: on }}
      style={({ pressed }) => [
        {
          flex: 1,
          paddingVertical: 12,
          paddingHorizontal: 12,
          borderLeftWidth: divider ? 1 : 0,
          borderLeftColor: C.hairline,
          backgroundColor: on ? C.primaryTint : C.surface,
        },
        pressed && { backgroundColor: C.wash },
      ]}>
      <T style={[{ fontSize: 18, lineHeight: 24, color: tone ?? C.ink }, weight(600), tabular]}>{value}</T>
      <T s="micro" numberOfLines={1}>
        {label}
      </T>
    </Pressable>
  );
}
