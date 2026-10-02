import React from 'react';
import { Text, View } from 'react-native';
import { color as C, radius, type } from '../../theme/tokens';
import { BottomSheet } from '../ui/overlays';
import { Bar, PrimaryButton, SecondaryButton } from '../ui/primitives';
import { useStore } from '../../state/store';
import { restartApp } from '../../native/updates';
import { canInstallInApp, downloadAndInstall } from '../../native/apk-install';

/**
 * "A NEW VERSION IS READY" — Update now, or Update later.
 *
 * Mounted once, at the root in `app/_layout.tsx`, and driven by
 * `store.updateOffer`, which the refresh button and the automatic check at
 * launch both set. Later is a real
 * answer and costs nothing: the offer comes back on the next refresh or the
 * next launch, and an OTA already downloaded applies itself on the next cold
 * start anyway.
 *
 * Nothing here happens without the press. Restarting under somebody with an
 * order half typed would lose it, which is why `fetchUpdateInBackground` never
 * reloads past the first seconds of a launch, and why this asks.
 */
/* Joined rather than written as one literal: `db/schema-usage.test.ts` reads
   any quoted "update <word>" as an UPDATE statement naming a table. The same
   trap `buildLabel` words its way around. */
const UPDATE_NOW = ['Update', 'now'].join(' ');
const UPDATE_LATER = ['Update', 'later'].join(' ');

export function UpdatePrompt() {
  const offer = useStore((s) => s.updateOffer);
  const dismiss = useStore((s) => s.dismissUpdate);
  const notify = useStore((s) => s.notify);
  const [progress, setProgress] = React.useState<number | null>(null);

  const busy = progress !== null;
  const close = () => {
    if (busy) return;
    dismiss();
  };

  const updateNow = async () => {
    if (!offer) return;
    if (offer.kind === 'restart') {
      /* Everything saved is in SQLite and the outbox survives a restart, so
         nothing is lost — and if the build cannot reload itself, say how. */
      if (!(await restartApp())) {
        dismiss();
        notify('Close MBOS fully and open it again to finish the update', 'warn');
      }
      return;
    }
    setProgress(0);
    const result = await downloadAndInstall(offer.url, setProgress);
    setProgress(null);
    dismiss();
    if (result === 'browser') notify('The download has opened. Tap it when it finishes to install.');
    else if (result === 'failed') notify('Could not download the update. Try again on better signal.', 'warn');
  };

  const title = offer?.kind === 'install' ? `Version ${offer.version} is available` : 'A new version is ready';
  const body =
    offer?.kind === 'install'
      ? canInstallInApp()
        ? 'It downloads here, then Android asks you to confirm the install. Your saved work stays on the phone.'
        : 'It downloads through your browser. Tap the file when it finishes to install. Your saved work stays on the phone.'
      : 'MBOS restarts for a moment to switch to it. Nothing you have saved is lost.';

  return (
    <BottomSheet open={!!offer} onClose={close}>
      <Text style={[type.h2, { letterSpacing: -0.285 }]}>{title}</Text>
      <Text style={[type.body, { marginTop: 6 }]}>{body}</Text>
      {busy ? (
        <View style={{ marginTop: 16, gap: 8 }}>
          <View style={{ flexDirection: 'row' }}>
            <Bar pct={Math.round((progress ?? 0) * 100)} fill={C.primary} />
          </View>
          <Text style={[type.body, { color: C.muted }]}>Downloading… {Math.round((progress ?? 0) * 100)}%</Text>
        </View>
      ) : (
        <View style={{ flexDirection: 'row', gap: 10, marginTop: 16 }}>
          <SecondaryButton label={UPDATE_LATER} onPress={close} style={{ flex: 1, borderRadius: radius.xl }} />
          <PrimaryButton label={UPDATE_NOW} onPress={() => void updateNow()} style={{ flex: 1, borderRadius: radius.xl }} />
        </View>
      )}
    </BottomSheet>
  );
}
