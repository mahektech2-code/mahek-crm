import React from 'react';
import { View, Pressable } from 'react-native';
import { useFocusEffect } from 'expo-router';
import { AppFrame, BackLink, useCameFrom } from '../src/components/shell/AppFrame';
import { Card, ListCard, T } from '../src/components/ui/primitives';
import { color as C, type, weight } from '../src/theme/tokens';
import {
  downloadDocument,
  forgetDocumentFile,
  heldFile,
  listDocuments,
  openDocumentFile,
  type DocumentRow,
} from '../src/data/library';
import { dmy } from '../src/lib/format';
import { useStore } from '../src/state/store';
import { Stagger } from '../src/components/ui/motion';

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

  const [busy, setBusy] = React.useState<string | null>(null);

  const reload = React.useCallback(() => {
    void listDocuments()
      .then(setDocs)
      .catch(() => setDocs([]));
  }, []);

  useFocusEffect(reload);

  /**
   * A TAP REACHES THE PAPER: open it if it is here, fetch it if it is not.
   *
   * Every row used to end in a toast — no file on any phone, and no way to
   * fetch one, because the bytes sat behind a route that takes a browser
   * session. `/api/mbos/documents/[id]` takes this handset's token, so the
   * first tap downloads and opens, and every later one opens without signal.
   */
  const open = React.useCallback(
    (d: DocumentRow) => {
      if (busy) return;
      void (async () => {
        const held = heldFile(d);
        if (held) {
          const r = await openDocumentFile(held);
          if (r.ok) return;
          await forgetDocumentFile(d.id);
          reload();
          notify(r.reason, 'error');
          return;
        }
        setBusy(d.id);
        try {
          const got = await downloadDocument(d);
          if (!got.ok) return notify(got.reason, 'error');
          reload();
          const r = await openDocumentFile(got.uri);
          if (!r.ok) notify(r.reason, 'error');
        } finally {
          setBusy(null);
        }
      })();
    },
    [busy, notify, reload],
  );

  return (
    <AppFrame title="Documents" activeTab={null} onBack={back.go} contentStyle={{ padding: 16, paddingBottom: 24 }}>
      <BackLink label={back.label} onPress={back.go} />

      <T style={type.h1}>Documents</T>
      <T s="small" style={{ color: C.muted, marginTop: 2 }}>
        Tap once with signal to download. After that it opens without signal.
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
            Price lists, rules and your papers will show here when the office adds them.
          </T>
        </Card>
      ) : (
        <ListCard style={{ marginTop: 12 }}>
          {docs.map((d, i) => {
            /* The FILE, not `availableOffline`. The flag is what the row claims
               and the uri is what can actually be opened, and where those two
               disagree the flag is the one that reads as a lie. */
            const onPhone = heldFile(d) !== null;
            return (
              <Stagger key={d.id} index={i}>
                <Pressable
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
                    {busy === d.id
                      ? 'Downloading…'
                      : d.expiresOn
                        ? 'Expires ' + dmy(d.expiresOn)
                        : onPhone
                          ? 'On this phone'
                          : 'Tap to download'}
                  </T>
                </Pressable>
              </Stagger>
            );
          })}
        </ListCard>
      )}
    </AppFrame>
  );
}
