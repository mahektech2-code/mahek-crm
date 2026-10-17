import React from 'react';
import { AppState, Linking, View } from 'react-native';
import { useCameraPermissions } from 'expo-camera';
import { Icon } from './Icon';
import { PrimaryButton, T } from './primitives';
import { color as C } from '../../theme/tokens';

/**
 * WHERE THE CAMERA STANDS, for the two cameras a punch cannot go past.
 *
 * Both the selfie and the meter camera asked for permission from an effect
 * that re-ran whenever the permission object changed — so a refusal produced
 * a fresh object, the effect fired again, and he could be shown the system
 * dialog twice in a row. A "Deny" that left Android willing to ask again then
 * drew "Asking for the camera…" for ever, over a shutter whose reason read
 * "the camera is still starting", which was not the reason. And the dead end
 * told him to turn the camera on in Settings with nothing on the screen that
 * opened Settings, and did not notice when he came back having done it.
 *
 *  - `asking`: the one automatic request of this opening is in flight.
 *  - `granted`.
 *  - `refused`: he said no, and Android would ask again — so a button asks.
 *  - `blocked`: Android will not ask again; only Settings can change it.
 *
 * Asked ONCE per opening, and re-read when the app comes back to the front,
 * which is the moment he returns from Settings.
 */
export type CameraAccess = 'asking' | 'granted' | 'refused' | 'blocked';

export function useCameraAccess(open: boolean): { access: CameraAccess; ask: () => void } {
  const [permission, requestPermission, getPermission] = useCameraPermissions();
  const asked = React.useRef(false);

  React.useEffect(() => {
    if (!open) {
      asked.current = false;
      return;
    }
    if (asked.current || !permission || permission.granted || !permission.canAskAgain) return;
    asked.current = true;
    void requestPermission();
  }, [open, permission, requestPermission]);

  React.useEffect(() => {
    if (!open) return;
    const sub = AppState.addEventListener('change', (s) => {
      if (s === 'active') void getPermission();
    });
    return () => sub.remove();
  }, [open, getPermission]);

  const access: CameraAccess =
    permission == null
      ? 'asking'
      : permission.granted
        ? 'granted'
        : !permission.canAskAgain
          ? 'blocked'
          : asked.current
            ? 'refused'
            : 'asking';

  return { access, ask: () => void requestPermission() };
}

/** What stands where the viewfinder would, with the one thing that moves it on. */
export function CameraRefusal({
  access,
  needs,
  onAsk,
}: {
  access: Exclude<CameraAccess, 'granted'>;
  /** "Attendance needs a selfie." */
  needs: string;
  onAsk: () => void;
}) {
  const body =
    access === 'asking'
      ? 'Asking for the camera…'
      : access === 'refused'
        ? `The camera is not allowed. ${needs} Tap Allow camera and choose Allow.`
        : `Camera permission is off for Mahek MBOS. ${needs} Open Settings, choose Permissions, and allow the camera. If you cannot, tell your manager.`;
  return (
    <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24, backgroundColor: C.ink }}>
      <Icon name="camera" size={32} color="rgba(255,255,255,0.5)" strokeWidth={1.5} />
      <T style={{ fontSize: 15, lineHeight: 22, color: 'rgba(255,255,255,0.8)', textAlign: 'center', marginTop: 12 }}>
        {body}
      </T>
      {access === 'refused' ? (
        <PrimaryButton label="Allow camera" style={{ marginTop: 16, alignSelf: 'stretch' }} onPress={onAsk} />
      ) : access === 'blocked' ? (
        <PrimaryButton
          label="Open Settings"
          style={{ marginTop: 16, alignSelf: 'stretch' }}
          onPress={() => void Linking.openSettings().catch(() => {})}
        />
      ) : null}
    </View>
  );
}

/** Why the shutter will not take, in the camera's own terms. */
export function shutterWhy(access: CameraAccess): string {
  if (access === 'blocked') return 'Camera permission is off. Open Settings above.';
  if (access === 'refused') return 'Allow the camera first.';
  if (access === 'asking') return 'Answer the camera question first.';
  return 'Wait. The camera is still starting.';
}
