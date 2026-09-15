import React from 'react';
import { View, Pressable, Linking } from 'react-native';
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

  /**
   * A TAP HAS TO REACH THE PAPER, or say why it cannot.
   *
   * Every row here used to raise one of two toasts and do nothing else —
   * "already on this phone" or "needs signal to download" — chosen off
   * `availableOffline`, which is a CLAIM. The file itself is `localUri`, and
   * nothing in the app has ever read it: no viewer, no `openURL`, and no
   * download path either. So the first toast asserted a paper was here that he
   * could not reach, and the second named an action that does not exist. He
   * taps the price list standing in front of a customer and gets a grey pill.
   *
   * The file is now the only thing that decides, at both ends: the row says
   * what is actually openable and the tap opens it. There is still no way to
   * FETCH one — the bytes live behind `/api/attachments/[id]`, which takes a
   * browser session and not this handset's device token — so the other half
   * says so in words rather than promising a download nothing can start.
   */
  const open = React.useCallback(
    (d: DocumentRow) => {
      const uri = d.localUri?.trim();
      if (!uri) {
        notify(d.title + ' is not on this phone — ask the office to send it to you.');
        return;
      }
      void (async () => {
        try {
          if (!(await Linking.canOpenURL(uri))) {
            notify('Nothing on this phone can open ' + d.title + '.');
            return;
          }
          await Linking.openURL(uri);
        } catch {
          notify(d.title + ' could not be opened.');
        }
      })();
    },
    [notify],
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
            /* The FILE, not `availableOffline`. The flag is what the row claims
               and the uri is what can actually be opened, and where those two
               disagree the flag is the one that reads as a lie. */
            const onPhone = !!d.localUri?.trim();
            return (
              <Pressable
                key={d.id}
                onPress={() => open(d)}
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
                  {d.expiresOn
                    ? 'Expires ' + d.expiresOn
                    : onPhone
                      ? 'Offline'
                      : 'Not downloaded'}
                </T>
              </Pressable>
            );
          })}
        </ListCard>
      )}
    </AppFrame>
  );
}
