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
  /** Absent on the notifications screen itself — see `AppFrame`. */
  onBell?: () => void;
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
      {/* A bell whose whole job is to bring you to the notifications screen is
          furniture once you are standing on it — and tapping it pushed a second
          copy of the page. The space is held rather than collapsed, so the title
          does not jump sideways as you arrive. */}
      {onBell ? (
        <Pressable onPress={onBell} accessibilityLabel="Notifications" style={s.iconBtn}>
          <Icon name="bell" size={24} color={C.body} strokeWidth={1.5} />
          {unread > 0 ? (
            <View style={s.bellBadge}>
              <Text style={[{ color: '#fff', fontSize: 12, lineHeight: 18, textAlign: 'center' }, weight(500)]}>{unread}</Text>
            </View>
          ) : null}
        </Pressable>
      ) : (
        <View style={s.iconBtn} />
      )}
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
          /* 28pt of cell against a 48pt floor, on the one control that is on
             all forty screens — so the miss was repeated everywhere. The strip
             cannot be made taller without moving every screen down, so the
             touch area is bought back rather than the pixels. Vertical only:
             the three cells are adjacent, and horizontal slop would make each
             one steal its neighbour's edge. */
          hitSlop={{ top: 10, bottom: 10 }}
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

/**
 * The bar's own height, above the safe-area inset.
 *
 * Exported because the toast has to clear it and was guessing: `bottom: 88`
 * happened to equal `64 + a 24pt gesture bar` on one handset and sat on top of
 * the bar on every other. One number, read by the two things whose job is not
 * to overlap.
 */
export const TAB_BAR_HEIGHT = 64;

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
  bottomInset,
  badges,
}: {
  active: TabKey | null;
  onTab: (k: TabKey) => void;
  bottomInset: number;
  /**
   * A count to draw on a tab, by key. Absent or zero draws nothing.
   *
   * A tab bar is on every screen of the app, which is what makes it the only
   * place a question can be put in front of somebody who is not looking for
   * it. That is also why the bar must stay quiet: a pip that is lit all day is
   * one nobody sees. Only counts that GO AWAY when they are dealt with belong
   * here.
   */
  badges?: Partial<Record<TabKey, number>>;
}) {
  return (
    <View style={[s.tabBar, { height: TAB_BAR_HEIGHT + bottomInset, paddingBottom: bottomInset }]}>
      {TABS.slice(0, 2).map((t) => (
        <Tab key={t.k} tab={t} on={active === t.k} count={badges?.[t.k] ?? 0} onPress={() => onTab(t.k)} />
      ))}
      {/* The gap the raised button sits in — it is drawn BESIDE this bar
          rather than inside it, see `TabBarAction`. */}
      <View style={{ flex: 1 }} />
      {TABS.slice(2).map((t) => (
        <Tab key={t.k} tab={t} on={active === t.k} count={badges?.[t.k] ?? 0} onPress={() => onTab(t.k)} />
      ))}
    </View>
  );
}

/**
 * The raised `+`, and why it is not a child of the bar it sits on.
 *
 * `bottom: TAB_BAR_HEIGHT + bottomInset - 52 + 20` inside a container of height
 * `TAB_BAR_HEIGHT + bottomInset` puts the 52pt circle's top edge at y = −20
 * relative to that container — the gesture inset cancels out, so the top 20pt
 * of the button hangs outside its own parent on every handset.
 *
 * It is still DRAWN there, and on this renderer it is still touchable: React
 * Native leaves `clipChildren` off, and Fabric measures how far a child
 * overflows its parent and widens the parent's hit test by exactly that much.
 * But that is a lot of machinery holding up the entry point to every quick
 * action in the app — one `overflow: 'hidden'` on the bar, or a build that is
 * not on the new renderer, and the visually obvious top of the button goes
 * inert with nothing to see. A dead button reads as a frozen app, not as a
 * missed target.
 *
 * So it is a SIBLING of the bar, positioned against the frame, which is tall
 * enough to contain it. The arithmetic is deliberately unchanged and lands on
 * the same pixel: an absolutely positioned child is measured from its
 * containing block's border box — padding is not subtracted — and the frame's
 * bottom edge is the bar's bottom edge.
 */
export function TabBarAction({ onPress, bottomInset }: { onPress: () => void; bottomInset: number }) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityLabel="What are you doing?"
      style={[s.fab, { bottom: TAB_BAR_HEIGHT + bottomInset - 52 + 20 }]}>
      <Text style={{ color: C.lime, fontSize: 26, lineHeight: 30 }}>+</Text>
    </Pressable>
  );
}

function Tab({
  tab,
  on,
  count,
  onPress,
}: {
  tab: { k: TabKey; label: string; ic: string };
  on: boolean;
  count: number;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="tab"
      accessibilityState={{ selected: on }}
      /* The count is read out as part of the tab rather than left as a
         decoration a screen reader skips — it is the whole reason to press. */
      accessibilityLabel={count > 0 ? `${tab.label}, ${count} waiting` : tab.label}
      style={{ flex: 1, minWidth: 0, alignItems: 'center', justifyContent: 'center', gap: 2 }}>
      <View style={{ height: 22, alignItems: 'center', justifyContent: 'center' }}>
        <Icon name={tab.ic} size={22} color={on ? C.primary : C.muted} />
        {count > 0 ? (
          <View style={s.tabBadge}>
            <Text style={[{ color: '#fff', fontSize: 11, lineHeight: 16, textAlign: 'center' }, weight(500)]}>
              {count > 9 ? '9+' : count}
            </Text>
          </View>
        ) : null}
      </View>
      <Text style={[{ fontSize: 12, color: on ? C.primary : C.muted }, weight(on ? 500 : 400)]}>{tab.label}</Text>
    </Pressable>
  );
}

const s = StyleSheet.create({
  iconBtn: { width: HIT, height: HIT, alignItems: 'center', justifyContent: 'center' },
  /* Hung off the icon's top-right, like the bell's. Smaller, because it sits
     in a 22pt row rather than a 48pt button and a badge that pushes the label
     down would move the whole bar. */
  tabBadge: {
    position: 'absolute',
    top: -5,
    left: 12,
    minWidth: 16,
    height: 16,
    paddingHorizontal: 4,
    borderRadius: 8,
    backgroundColor: C.danger,
  },
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
