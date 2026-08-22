import React from 'react';
import { View, Pressable } from 'react-native';
import { useFocusEffect } from 'expo-router';
import { AppFrame, BackLink, useCameFrom } from '../src/components/shell/AppFrame';
import { Card, ListCard, T } from '../src/components/ui/primitives';
import { color as C, type, weight } from '../src/theme/tokens';
import { listDocuments, type DocumentRow } from '../src/data/library';
import { useStore } from '../src/state/store';

/**
 * The papers he needs in a shop with no signal.
 *
 * This listed five invented documents until now — a price list, an ID card, a
 * territory map — with a grey caption underneath saying the list was not live.
 * A salesman standing in front of a customer does not read the caption; he
 * taps the price list. The rows come from `documents`, which the pull has been
 * filling since the office could publish, and an empty library says so.
 */

export default function DocsScreen() {
  const back = useCameFrom('more');
  const notify = useStore((s) => s.notify);
  const [docs, setDocs] = React.useState<DocumentRow[] | null>(null);

  useFocusEffect(
    React.useCallback(() => {
      void listDocuments().then(setDocs);
    }, []),
  );

  return (
    <AppFrame title="Documents" activeTab={null} onBack={back.go} contentStyle={{ padding: 16, paddingBottom: 24 }}>
      <BackLink label={back.label} onPress={back.go} />

      <T style={type.h1}>Documents</T>
      <T s="small" style={{ color: C.muted, marginTop: 2 }}>
        Everything downloaded here works without signal.
      </T>

      {/* Three states, and they are three different sentences: still reading,
          nothing published, and the list. A screen that renders "nothing yet"
          while it is still loading teaches people to pull-to-refresh at it. */}
      {docs === null ? (
        <Card style={{ marginTop: 12, paddingHorizontal: 16, paddingVertical: 32 }} padded={false}>
          <T s="small" style={{ color: C.muted, textAlign: 'center' }}>Looking…</T>
        </Card>
      ) : docs.length === 0 ? (
        <Card style={{ marginTop: 12, paddingHorizontal: 16, paddingVertical: 32 }} padded={false}>
          <T style={[{ fontSize: 16, color: C.ink, textAlign: 'center' }, weight(600)]}>Nothing published yet</T>
          <T s="small" style={{ color: C.muted, textAlign: 'center', marginTop: 4 }}>
            Price lists, policies and your own papers appear here once the office publishes them.
          </T>
        </Card>
      ) : (
        <ListCard style={{ marginTop: 12 }}>
          {docs.map((d, i) => {
            const offline = d.availableOffline === 1;
            return (
              <Pressable
                key={d.id}
                onPress={() =>
                  notify(offline ? d.title + ' · already on this phone' : d.title + ' · needs signal to download')
                }
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
                  <T style={[{ fontSize: 15, color: C.ink }, weight(500)]}>{d.title}</T>
                  <T s="caption">{[d.kind, d.sizeLabel, d.category].filter(Boolean).join(' · ') || 'Document'}</T>
                </View>
                {/* An expiry is a fact off the row; nothing is counted down
                    that the office did not put a date on. */}
                <T
                  style={[
                    { fontSize: 13, color: d.expiresOn ? C.warn : C.muted },
                    weight(d.expiresOn ? 500 : 400),
                  ]}>
                  {d.expiresOn ? 'Expires ' + d.expiresOn : offline ? 'Offline' : 'Online'}
                </T>
              </Pressable>
            );
          })}
        </ListCard>
      )}
    </AppFrame>
  );
}
