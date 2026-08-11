import React from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import { color as C, HIT, shadow, weight } from '../../theme/tokens';
import { Icon } from '../ui/Icon';

/**
 * The frame every in-app screen sits inside: a 52px title bar, the status
 * strip under it, and the tab bar with its raised action button.
 *
 * These take callbacks rather than reaching for the router themselves, so the
 * whole frame can be rendered and looked at without a navigator around it.
 */

/* ----------------------------------------------------------------- header */

export function Header({
  title,
  onBack,
  onBell,
  unread,
}: {
  title: string;
  onBack?: () => void;
  onBell: () => void;
  unread: number;
}) {
  return (
    <View style={{ height: 52, flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16 }}>
      {onBack ? (
        <Pressable onPress={onBack} accessibilityLabel="Back" style={[s.iconBtn, { marginLeft: -12 }]}>
          <Icon name="back" size={24} color={C.body} strokeWidth={1.5} />
        </Pressable>
      ) : null}
      <Text numberOfLines={1} style={[{ flex: 1, fontSize: 14, lineHeight: 20, color: C.ink }, weight(600)]}>
        {title}
      </Text>
      <Pressable onPress={onBell} accessibilityLabel="Notifications" style={s.iconBtn}>
        <Icon name="bell" size={24} color={C.body} strokeWidth={1.5} />
        {unread > 0 ? (
          <View style={s.bellBadge}>
            <Text style={[{ color: '#fff', fontSize: 12, lineHeight: 18, textAlign: 'center' }, weight(500)]}>{unread}</Text>
          </View>
        ) : null}
      </Pressable>
    </View>
  );
}

/* ------------------------------------------------------------ status strip */

export type StripTone = 'ok' | 'warn' | 'idle';

/**
 * Three facts the salesman should never have to go looking for: whether the
 * day is started, whether the phone knows where it is, and how much work is
 * still sitting on the handset unsent. Each one opens the screen that explains
 * it, because a light you cannot act on is decoration.
 */
export function StatusStrip({
  items,
}: {
  items: { key: string; label: string; tone: StripTone; onPress: () => void }[];
}) {
  return (
    <View style={s.strip}>
      {items.map((it, i) => (
        <Pressable
          key={it.key}
          onPress={it.onPress}
          style={[s.stripCell, i > 0 && { borderLeftWidth: 1, borderLeftColor: C.border }]}>
          <View
            style={{
              width: 7,
              height: 7,
              borderRadius: 3.5,
              backgroundColor: it.tone === 'ok' ? C.success : it.tone === 'warn' ? C.warn : C.faint,
            }}
          />
          <Text numberOfLines={1} style={[{ fontSize: 12, color: C.body }, weight(500)]}>
            {it.label}
          </Text>
        </Pressable>
      ))}
    </View>
  );
}

/* --------------------------------------------------------------- tab bar */

export type TabKey = 'home' | 'journey' | 'customers' | 'more';

const TABS: { k: TabKey; label: string; ic: string }[] = [
  { k: 'home', label: 'Home', ic: 'home' },
  { k: 'journey', label: 'Journey', ic: 'route' },
  { k: 'customers', label: 'Customers', ic: 'people' },
  { k: 'more', label: 'More', ic: 'grid' },
];

export function TabBar({
  active,
  onTab,
  onAction,
  bottomInset,
}: {
  active: TabKey | null;
  onTab: (k: TabKey) => void;
  onAction: () => void;
  bottomInset: number;
}) {
  return (
    <View style={[s.tabBar, { height: 64 + bottomInset, paddingBottom: bottomInset }]}>
      {TABS.slice(0, 2).map((t) => (
        <Tab key={t.k} tab={t} on={active === t.k} onPress={() => onTab(t.k)} />
      ))}
      {/* The gap the raised button sits in. */}
      <View style={{ flex: 1 }} />
      {TABS.slice(2).map((t) => (
        <Tab key={t.k} tab={t} on={active === t.k} onPress={() => onTab(t.k)} />
      ))}
      <Pressable
        onPress={onAction}
        accessibilityLabel="What are you doing?"
        style={[s.fab, { bottom: 64 + bottomInset - 52 + 20 }]}>
        <Text style={{ color: C.lime, fontSize: 26, lineHeight: 30 }}>+</Text>
      </Pressable>
    </View>
  );
}

function Tab({ tab, on, onPress }: { tab: { k: TabKey; label: string; ic: string }; on: boolean; onPress: () => void }) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="tab"
      accessibilityState={{ selected: on }}
      style={{ flex: 1, minWidth: 0, alignItems: 'center', justifyContent: 'center', gap: 2 }}>
      <View style={{ height: 22, alignItems: 'center', justifyContent: 'center' }}>
        <Icon name={tab.ic} size={22} color={on ? C.primary : C.muted} />
      </View>
      <Text style={[{ fontSize: 12, color: on ? C.primary : C.muted }, weight(on ? 500 : 400)]}>{tab.label}</Text>
    </Pressable>
  );
}

const s = StyleSheet.create({
  iconBtn: { width: HIT, height: HIT, alignItems: 'center', justifyContent: 'center' },
  bellBadge: {
    position: 'absolute',
    top: 8,
    right: 8,
    minWidth: 18,
    height: 18,
    paddingHorizontal: 5,
    borderRadius: 9,
    backgroundColor: C.danger,
  },
  strip: {
    height: 28,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 4,
    borderTopWidth: 1,
    borderTopColor: C.hairline,
    backgroundColor: C.wash,
  },
  stripCell: {
    flex: 1,
    minWidth: 0,
    height: 28,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingHorizontal: 8,
  },
  tabBar: {
    flexDirection: 'row',
    alignItems: 'stretch',
    backgroundColor: 'rgba(255,255,255,0.96)',
    borderTopWidth: 1,
    borderTopColor: C.hairline,
    boxShadow: shadow.tabBar,
  },
  fab: {
    position: 'absolute',
    left: '50%',
    marginLeft: -28,
    width: 56,
    height: 52,
    borderRadius: 28,
    borderWidth: 3,
    borderColor: '#FFFFFF',
    backgroundColor: C.primary,
    alignItems: 'center',
    justifyContent: 'center',
    boxShadow: shadow.fab,
  },
});
