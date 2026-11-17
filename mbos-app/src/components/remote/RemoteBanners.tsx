import React from 'react';
import { Image, Linking, Pressable, Text, View } from 'react-native';
import { router } from 'expo-router';
import { color as C, radius, weight } from '../../theme/tokens';
import { bannersFor, useRemote, type RemoteBanner } from '../../data/remote';

/**
 * The office's banners for one screen — Admin Console → MBOS control.
 *
 * NOTHING IN HERE MAY BREAK THE SCREEN IT SITS ON. It draws inside its own
 * error boundary, a picture that fails to load is dropped and the card stays,
 * and a tap only goes somewhere this build actually has: a route the server
 * names that this APK does not know is a card with no tap, not a dead end.
 */

/** Screens a banner may open — ones that stand alone without an id. */
const OPENABLE = new Set([
  'accounts',
  'catalogue',
  'collections',
  'customers',
  'docs',
  'expenses',
  'holidays',
  'journeys',
  'knowledge',
  'leads',
  'leave',
  'nearby',
  'notifications',
  'orders',
  'performance',
  'policy',
  'reports',
  'salary',
  'samples',
  'tasks',
]);

const TONES = {
  info: { bg: C.infoBg, ink: C.info },
  success: { bg: C.successBg, ink: C.success },
  warn: { bg: C.warnBg, ink: C.warnInk },
} as const;

export function RemoteBanners({ screen, nowMs }: { screen: RemoteBanner['screen']; nowMs: number }) {
  return (
    <Boundary>
      <Banners screen={screen} nowMs={nowMs} />
    </Boundary>
  );
}

function Banners({ screen, nowMs }: { screen: RemoteBanner['screen']; nowMs: number }) {
  const remote = useRemote();
  const list = bannersFor(remote, screen, nowMs);
  if (!list.length) return null;
  return (
    <View style={{ gap: 12 }}>
      {list.map((b) => (
        <Banner key={b.id} b={b} />
      ))}
    </View>
  );
}

function targetOf(b: RemoteBanner): (() => void) | null {
  if (b.url && /^https:\/\//.test(b.url)) {
    const url = b.url;
    return () => void Linking.openURL(url).catch(() => undefined);
  }
  if (b.route) {
    const base = b.route.split('?')[0];
    if (!OPENABLE.has(base)) return null;
    const href = `/${b.route}`;
    return () => router.push(href as never);
  }
  return null;
}

function Banner({ b }: { b: RemoteBanner }) {
  const [imageFailed, setImageFailed] = React.useState(false);
  const tone = TONES[b.tone ?? 'info'] ?? TONES.info;
  const onPress = targetOf(b);
  const body = (
    <View style={{ backgroundColor: tone.bg, borderRadius: radius.card, overflow: 'hidden' }}>
      {b.imageUrl && !imageFailed ? (
        <Image
          source={{ uri: b.imageUrl }}
          onError={() => setImageFailed(true)}
          accessibilityIgnoresInvertColors
          style={{ width: '100%', aspectRatio: 2.4, backgroundColor: C.hairline }}
          resizeMode="cover"
        />
      ) : null}
      <View style={{ padding: 16, gap: 6 }}>
        <Text style={[{ fontSize: 15, lineHeight: 20, color: C.ink }, weight(800)]}>{b.title}</Text>
        {b.body ? <Text style={[{ fontSize: 13, lineHeight: 19, color: C.body }, weight(400)]}>{b.body}</Text> : null}
        {onPress ? <Text style={[{ fontSize: 13, color: tone.ink, marginTop: 2 }, weight(700)]}>Open ›</Text> : null}
      </View>
    </View>
  );
  if (!onPress) return <View accessibilityLabel={b.title}>{body}</View>;
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={b.title} onPress={onPress} style={({ pressed }) => ({ opacity: pressed ? 0.85 : 1 })}>
      {body}
    </Pressable>
  );
}

class Boundary extends React.Component<{ children: React.ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch() {
    /* Drawn as nothing: an office banner is never worth the screen under it. */
  }
  render() {
    return this.state.failed ? null : this.props.children;
  }
}
