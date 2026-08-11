import React from 'react';
import { View, Pressable } from 'react-native';
import { AppFrame, BackLink, useCameFrom } from '../src/components/shell/AppFrame';
import { ListCard, T } from '../src/components/ui/primitives';
import { color as C, type, weight } from '../src/theme/tokens';
import { DOCS } from '../src/data/fixtures';
import { useStore } from '../src/state/store';

/**
 * The papers he needs in a shop with no signal — which is why the note under
 * the title says so, and why an expiring one is called out by date rather than
 * left to be discovered when a customer asks.
 */

export default function DocsScreen() {
  const back = useCameFrom('more');
  const notify = useStore((s) => s.notify);

  return (
    <AppFrame title="Documents" activeTab={null} onBack={back.go} contentStyle={{ padding: 16, paddingBottom: 24 }}>
      <BackLink label={back.label} onPress={back.go} />

      <T style={type.h1}>Documents</T>
      <T s="small" style={{ color: C.muted, marginTop: 2 }}>
        Everything here works without signal. Re-download after an update.
      </T>

      <ListCard style={{ marginTop: 12 }}>
        {DOCS.map((d, i) => (
          <Pressable
            key={d.name}
            onPress={() => notify(d.name + ' · opens offline, already downloaded')}
            accessibilityRole="button"
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              gap: 12,
              paddingHorizontal: 16,
              paddingVertical: 14,
              borderTopWidth: i ? 1 : 0,
              borderTopColor: C.wash,
            }}>
            <View style={{ flex: 1, minWidth: 0 }}>
              <T style={[{ fontSize: 15, color: C.ink }, weight(500)]}>{d.name}</T>
              <T s="caption">{d.kind + ' · ' + d.size}</T>
            </View>
            <T style={[{ fontSize: 13, color: d.expiring ? C.warn : C.muted }, weight(d.expiring ? 500 : 400)]}>
              {d.expiring ? 'Expires in 12 days' : 'Current'}
            </T>
          </Pressable>
        ))}
      </ListCard>
      <T s="caption" style={{ marginTop: 12 }}>This list is not live yet.</T>
    </AppFrame>
  );
}
