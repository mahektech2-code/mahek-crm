import React from 'react';
import { Pressable, TextInput, View } from 'react-native';
import { router, useFocusEffect } from 'expo-router';

import { AppFrame, useCameFrom } from '../src/components/shell/AppFrame';
import { Badge, Card, T } from '../src/components/ui/primitives';
import { Icon } from '../src/components/ui/Icon';
import { Chip } from '../src/components/ui/account-parts';
import { bookMoney, listAccountsPage, type BookMoney } from '../src/data/customer-account';
import type { AccountFilter, AccountSort } from '../src/data/customer-query';
import type { Customer } from '../src/data/customers';
import { creditUse, longDay } from '../src/engines/account-view';
import { compactInrFromPaise, inrFromPaise, shopName } from '../src/lib/format';
import { color as C, tabular, weight } from '../src/theme/tokens';
import { Stagger } from '../src/components/ui/motion';
import { feedback } from '../src/components/ui/feedback';

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
    <AppFrame
      title="Customer accounts"
      activeTab={null}
      tone="navy"
      onBack={back.go}
      contentStyle={{ padding: 14, paddingBottom: 32 }}
      hero={
        <View style={{ marginTop: 4 }}>
          {/* The intro, kept whole for a screen reader: V3 cut it to one line. */}
          <View
            accessible
            accessibilityLabel="Your customers' accounts, as the accounts team sees them. Open one for its bills, payments and statement.">
            <T style={[{ fontSize: 12, color: C.lime }, weight(700)]}>As accounts see your book</T>
          </View>

          {/* ---- the book's money ----

              The book, not the filter: these do not move as chips are tapped,
              because a total that changes under your thumb is a total nobody
              can quote. Each figure is also a way in — tapping it sets the chip
              that lists what it counts. */}
          <T style={{ fontSize: 12, color: C.onNavyMuted, marginTop: 14 }}>Owed across your book · confirmed money</T>
          <T
            style={[
              { fontSize: 38, lineHeight: 44, letterSpacing: -0.8, color: money?.owedPaise ? '#FF8A80' : '#FFFFFF' },
              weight(800),
              tabular,
            ]}>
            {money ? inrFromPaise(money.owedPaise) : '—'}
          </T>
          <T style={{ fontSize: 12, color: C.onNavyMuted }}>
            {money ? `${money.owing} of ${money.accounts} accounts owe` : 'Loading…'}
          </T>
          <View style={{ flexDirection: 'row', gap: 8, marginTop: 12 }}>
            <Stat
              label="Owe money"
              value={money ? String(money.owing) : '—'}
              on={filter === 'owing'}
              onPress={() => setFilter(filter === 'owing' ? 'all' : 'owing')}
            />
            <Stat
              label="Over limit"
              value={money ? String(money.over) : '—'}
              tone={money?.over ? 'danger' : undefined}
              on={filter === 'over'}
              onPress={() => setFilter(filter === 'over' ? 'all' : 'over')}
            />
            <Stat
              label="Supply stopped"
              value={money ? String(money.blocked) : '—'}
              tone={money?.blocked ? 'warn' : undefined}
              on={filter === 'blocked'}
              onPress={() => setFilter(filter === 'blocked' ? 'all' : 'blocked')}
            />
          </View>
        </View>
      }>
      {/* ---- search ---- */}
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          gap: 10,
          height: 48,
          paddingHorizontal: 16,
          borderRadius: 24,
          backgroundColor: C.surface,
        }}>
        <Icon name="search" size={18} color={C.muted} strokeWidth={2} />
        <TextInput
          value={query}
          onChangeText={setQuery}
          placeholder="Shop, owner, city, phone, GST"
          placeholderTextColor={C.faint}
          autoCorrect={false}
          autoCapitalize="none"
          returnKeyType="search"
          accessibilityLabel="Search customer accounts"
          style={{ flex: 1, fontSize: 15, color: C.ink, height: '100%' }}
        />
        {query ? (
          <Pressable
            onPress={() => setQuery('')}
            accessibilityRole="button"
            accessibilityLabel="Clear search"
            hitSlop={10}
            style={{ width: 28, height: 28, borderRadius: 14, backgroundColor: C.canvas, alignItems: 'center', justifyContent: 'center' }}>
            <Icon name="close" size={12} color={C.ink} strokeWidth={2.4} />
          </Pressable>
        ) : null}
      </View>

      {/* ---- the chips ---- */}
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 10 }}>
        {FILTERS.map((f) => (
          <Chip
            key={f.key}
            label={f.label}
            ink={f.key === 'owing' ? C.danger : undefined}
            on={filter === f.key}
            onPress={() => setFilter(f.key)}
          />
        ))}
      </View>

      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 12 }}>
        <T style={{ flex: 1, fontSize: 13, color: C.muted }}>
          {rows === null ? (
            'Loading…'
          ) : (
            <>
              <T style={[{ fontSize: 13, color: C.ink }, weight(700)]}>{String(total)}</T>
              {query || filter !== 'all' ? ' match' : total === 1 ? ' account' : ' accounts'}
            </>
          )}
        </T>
        <View style={{ flexDirection: 'row', gap: 6 }}>
          {SORTS.map((s) => (
            <Pressable
              key={s.key}
              onPress={() => {
                if (sort !== s.key) feedback('select');
                setSort(s.key);
              }}
              accessibilityRole="button"
              accessibilityState={{ selected: sort === s.key }}
              hitSlop={8}
              style={{ height: 32, paddingHorizontal: 12, borderRadius: 16, justifyContent: 'center', backgroundColor: sort === s.key ? C.navy : C.surface }}>
              <T style={[{ fontSize: 12, color: sort === s.key ? '#FFFFFF' : C.ink }, weight(700)]}>
                {s.label}
              </T>
            </Pressable>
          ))}
        </View>
      </View>

      {/* ---- the list ---- */}
      {rows === null ? null : rows.length === 0 ? (
        <Card style={{ marginTop: 10, paddingVertical: 24, borderRadius: 24 }}>
          <T style={[{ fontSize: 17, lineHeight: 22, color: C.ink, textAlign: 'center' }, weight(800)]}>
            {query ? `No account matches “${query}”` : 'No accounts here'}
          </T>
          <T s="small" style={{ color: C.muted, textAlign: 'center', marginTop: 6 }}>
            {query
              ? 'Try part of the shop name, the owner, the phone number or the GST number.'
              : filter === 'all'
                ? 'Your customers come from the office. If you have shops and see none, open More, then Send to office, and tap Send now.'
                : 'None of your customers fall under this filter.'}
          </T>
        </Card>
      ) : (
        <View style={{ marginTop: 10, backgroundColor: C.surface, borderRadius: 22, paddingVertical: 4, paddingHorizontal: 16 }}>
          {rows.map((c, i) => (
            <Stagger key={c.id} index={i}>
              <AccountRow c={c} first={i === 0} onPress={() => open(c)} />
            </Stagger>
          ))}
        </View>
      )}

      {hasMore ? (
        <Pressable
          onPress={more}
          accessibilityRole="button"
          style={({ pressed }) => ({ marginTop: 12, height: 52, borderRadius: 26, backgroundColor: pressed ? C.primaryTint : C.surface, alignItems: 'center', justifyContent: 'center' })}>
          <T style={[{ fontSize: 14, color: C.primaryDeep }, weight(700)]}>
            {loadingMore ? 'Loading…' : `Show more · ${total - (rows?.length ?? 0)} left`}
          </T>
        </Pressable>
      ) : null}

      {money?.syncedAt ? (
        <View
          accessible
          accessibilityLabel="Figures from the office, last refreshed on this phone with the sync."
          style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, marginTop: 12 }}>
          <Icon name="synced" size={14} color={C.muted} strokeWidth={2} />
          <T style={{ fontSize: 12, color: C.muted }}>Office figures, refreshed with the sync</T>
        </View>
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
        { paddingVertical: 12, borderTopWidth: first ? 0 : 1, borderTopColor: C.hairline },
        pressed && { opacity: 0.7 },
      ]}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
        <View style={{ flex: 1, minWidth: 0 }}>
          <T style={[{ fontSize: 16, lineHeight: 21, color: C.ink }, weight(700)]} numberOfLines={1}>
            {shopName(c.name)}
          </T>
          <T s="caption" numberOfLines={1}>
            {[c.city, c.lastOrderDate ? 'ordered ' + longDay(c.lastOrderDate) : null].filter(Boolean).join(' · ') || '—'}
          </T>
        </View>
        <View style={{ alignItems: 'flex-end' }}>
          <T style={[{ fontSize: 17, lineHeight: 22, color: owed > 0 ? (over ? C.danger : C.ink) : C.muted }, weight(owed > 0 ? 800 : 600), tabular]}>
            {owed > 0 ? inrFromPaise(owed) : 'Nothing due'}
          </T>
          {c.creditLimitPaise ? (
            <T s="micro" style={tabular}>
              of {compactInrFromPaise(c.creditLimitPaise)} limit
            </T>
          ) : null}
        </View>
        <Icon name="forward" size={16} color={C.faint} strokeWidth={2} />
      </View>

      {/* How much of the limit is used — drawn only where there IS a limit.
          A bar with no limit behind it would be a percentage of nothing. */}
      {use != null ? (
        <View style={{ marginTop: 8, height: 6, borderRadius: 3, backgroundColor: C.hairline, overflow: 'hidden' }}>
          <View
            style={{
              width: `${Math.min(100, use)}%`,
              height: 6,
              backgroundColor: over ? C.danger : use >= 80 ? C.warn : C.success,
            }}
          />
        </View>
      ) : null}

      {c.creditBlocked || over || c.thirdParty ? (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 8 }}>
          {c.creditBlocked ? <Badge tone="danger">Supply stopped</Badge> : null}
          {over ? <Badge tone="danger">{use + '%'}</Badge> : null}
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
}: {
  label: string;
  value: string;
  tone?: 'danger' | 'warn';
  on: boolean;
  onPress: () => void;
}) {
  /* A figure here is also a filter, so pressing one moves the chips below —
     on, or back off to everything — and ticks like they do. Chosen, it turns
     lime, as V3 draws a filter that is on in the navy block. */
  const ink = tone === 'danger' ? (on ? C.danger : '#FF8A80') : tone === 'warn' ? (on ? C.warnInk : '#FFD27A') : on ? C.navy : '#FFFFFF';
  return (
    <Pressable
      onPress={() => {
        feedback('select');
        onPress();
      }}
      accessibilityRole="button"
      accessibilityState={{ selected: on }}
      accessibilityLabel={label + ', ' + value}
      style={({ pressed }) => ({
        flex: 1,
        height: 64,
        borderRadius: 18,
        paddingHorizontal: 12,
        justifyContent: 'center',
        backgroundColor: on ? C.lime : C.navySoft,
        opacity: pressed ? 0.85 : 1,
      })}>
      <T style={[{ fontSize: 20, lineHeight: 25, color: ink }, weight(800), tabular]}>{value}</T>
      <T style={[{ fontSize: 11, lineHeight: 14, color: on ? C.navy : C.onNavyMuted }, weight(on ? 600 : 500)]} numberOfLines={1}>
        {label}
      </T>
    </Pressable>
  );
}
