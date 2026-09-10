import React from 'react';
import { Image, Modal, Pressable, View } from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { color as C, HIT, radius, weight } from '../../theme/tokens';
import { Icon } from './Icon';
import { PrimaryButton, SecondaryButton, T } from './primitives';

/**
 * The attendance selfie, taken inside the app.
 *
 * It used to hand off to the system camera through `ImagePicker`, which opens
 * whatever camera app the phone has and — every time, on every handset here —
 * opens it REAR-FACING. A salesman starting his day was photographing the
 * street. `cameraType: 'front'` exists on the picker, and expo's own
 * documentation says in as many words that on Android its behaviour "may vary
 * based on the camera app installed on the device": it is a request to another
 * application, not an instruction. So the camera is ours.
 *
 * Owning it buys two more things beyond the facing. The app never leaves the
 * foreground, so nothing else in MBOS is interrupted to take it — and the
 * screen can say what the photograph is FOR, which the system camera cannot.
 *
 * ONLY THE SELFIE COMES HERE. A shop front, a cheque and a bill are all
 * rear-facing photographs of something the salesman is looking at, and the
 * system camera is better at those than anything worth writing: it has the
 * flash, the zoom and the tap-to-focus people already know. `takePhoto` still
 * handles all three.
 *
 * **THE PHOTOGRAPH IS MANDATORY, and that is a reversal.** This screen shipped
 * with "Start the day without a photo" on it, under the rule that runs through
 * the rest of the app: a save is never blocked by an attachment, and a
 * salesman who cannot mark attendance cannot work. That rule still holds for
 * every OTHER photograph here — a complaint photo, a cheque, a shop front —
 * and it does not hold for this one, because this one is not an attachment to
 * a record. It IS the record: an attendance mark with no photograph behind it
 * is a claim that somebody was somewhere, and the whole reason to take it is
 * that a claim and a proof are different things. Skippable, it was neither —
 * the days with a photograph proved something and the days without proved
 * nothing, and nobody reading the record afterwards could tell which kind of
 * day they were looking at.
 *
 * So the only ways out of this screen are the photograph and CANCELLING THE
 * WHOLE ACTION. There is no third door, and a refused camera permission is a
 * dead end that says so in words — see `Refusal`. That is the real cost of
 * "mandatory" and it is stated on the screen rather than worked around behind
 * it.
 *
 * It is used for every check-in AND every check-out, several times a day, so
 * it takes its own words: "Start your day" and "Close your day" are different
 * things to be photographed for, and a camera that said the first one while
 * closing the day would read as the app having lost its place.
 */

export type SelfieResult = { uri: string } | null;

export function SelfieCamera({
  open,
  title,
  subtitle,
  cancelLabel,
  onDone,
}: {
  open: boolean;
  /** What this photograph is for: "Start your day", "Close your day". */
  title: string;
  subtitle: string;
  /** What backing out abandons, said plainly — it is no longer a skip. */
  cancelLabel: string;
  /** The photograph, or null for every way out — cancel, refusal, failure. */
  onDone: (result: SelfieResult) => void;
}) {
  const insets = useSafeAreaInsets();
  const [permission, requestPermission] = useCameraPermissions();
  const camera = React.useRef<CameraView>(null);
  const [ready, setReady] = React.useState(false);
  const [shooting, setShooting] = React.useState(false);
  /* What was taken, held for the person to look at before it becomes the
     record of their attendance. */
  const [shot, setShot] = React.useState<string | null>(null);

  /* Fresh camera every time it opens, so a retake from yesterday is never on
     screen and `onCameraReady` fires again for the new mount. */
  React.useEffect(() => {
    if (open) {
      setShot(null);
      setReady(false);
      setShooting(false);
    }
  }, [open]);

  /* Asked when the sheet opens rather than on the first launch: unlike
     location, there is no work riding on this being answered early, and a
     camera dialog on the very first open — before anybody has seen a screen —
     is a dialog people dismiss. */
  React.useEffect(() => {
    if (open && permission && !permission.granted && permission.canAskAgain) void requestPermission();
  }, [open, permission, requestPermission]);

  const take = async () => {
    if (!ready || shooting) return;
    setShooting(true);
    try {
      const picture = await camera.current?.takePictureAsync({ quality: 1 });
      if (picture?.uri) setShot(picture.uri);
      /* A shutter that produced nothing leaves the camera up rather than
         closing on a failure the person cannot see. They can press again. */
    } catch {
      /* Same. The check-in behind this is never blocked by a photograph — see
         `startDay` — so the honest thing is to let them try or cancel. */
    } finally {
      setShooting(false);
    }
  };

  const denied = permission != null && !permission.granted && !permission.canAskAgain;

  return (
    <Modal visible={open} animationType="slide" onRequestClose={() => onDone(null)} statusBarTranslucent>
      <View style={{ flex: 1, backgroundColor: '#000000' }}>
        {/* ---- what is being asked for, and the way out ---- */}
        <View
          style={{
            paddingTop: insets.top + 12,
            paddingHorizontal: 16,
            paddingBottom: 12,
            flexDirection: 'row',
            alignItems: 'center',
            gap: 12,
          }}>
          <View style={{ flex: 1, minWidth: 0 }}>
            <T style={[{ fontSize: 17, lineHeight: 22, color: '#FFFFFF' }, weight(600)]}>{title}</T>
            <T style={{ fontSize: 13, lineHeight: 18, color: 'rgba(255,255,255,0.65)' }}>{subtitle}</T>
          </View>
          {/* The cross ABANDONS the check-in now rather than skipping the
              photograph — it is the same button it always was and it no longer
              means the same thing, so its label says which. */}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={cancelLabel}
            onPress={() => onDone(null)}
            style={{ width: HIT, height: HIT, alignItems: 'center', justifyContent: 'center' }}>
            <Icon name="close" size={24} color="#FFFFFF" strokeWidth={1.5} />
          </Pressable>
        </View>

        {/* ---- the viewfinder, or what is standing in its way ---- */}
        <View style={{ flex: 1, overflow: 'hidden', borderRadius: radius.card, marginHorizontal: 12 }}>
          {shot ? (
            <Image source={{ uri: shot }} style={{ flex: 1 }} resizeMode="cover" />
          ) : denied ? (
            <Refusal
              body="Camera permission is off for MBOS. Attendance needs the photo, so turn the camera on in your phone’s Settings and try again. Tell your manager if you cannot."
            />
          ) : permission?.granted ? (
            <CameraView
              ref={camera}
              style={{ flex: 1 }}
              facing="front"
              /* Mirrored, because a front camera that is not looks wrong to
                 everybody: the face people know is the one in the mirror. */
              mirror
              onCameraReady={() => setReady(true)}
            />
          ) : (
            <Refusal body="Asking for the camera…" />
          )}
        </View>

        {/* ---- the shutter, or the two answers about what it took ---- */}
        <View style={{ paddingHorizontal: 16, paddingTop: 16, paddingBottom: insets.bottom + 16, gap: 10 }}>
          {shot ? (
            <>
              <PrimaryButton label="Use this photo" onPress={() => onDone({ uri: shot })} />
              <SecondaryButton label="Take it again" onPress={() => setShot(null)} />
            </>
          ) : (
            <>
              <PrimaryButton
                label={shooting ? 'Taking…' : 'Take the photo'}
                onPress={() => void take()}
                disabled={!permission?.granted || !ready || shooting}
                whyDisabled={
                  denied
                    ? 'Camera permission is off for MBOS.'
                    : 'The camera is still starting up.'
                }
              />
              {/*
                This was "Start the day without a photo" — see the note at the
                top of the file. It is a CANCEL now, and it says so: the way
                out of this screen is either the photograph or abandoning the
                action, and a button offering a third thing is what made the
                record unreadable. Its words name what is being abandoned, so
                nobody presses it thinking the day starts anyway.
              */}
              <Pressable
                accessibilityRole="button"
                onPress={() => onDone(null)}
                style={{ minHeight: HIT, alignItems: 'center', justifyContent: 'center' }}>
                <T style={[{ fontSize: 15, color: 'rgba(255,255,255,0.8)' }, weight(500)]}>
                  {cancelLabel}
                </T>
              </Pressable>
            </>
          )}
        </View>
      </View>
    </Modal>
  );
}

function Refusal({ body }: { body: string }) {
  return (
    <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24, backgroundColor: C.ink }}>
      <Icon name="camera" size={32} color="rgba(255,255,255,0.5)" strokeWidth={1.5} />
      <T style={{ fontSize: 15, lineHeight: 22, color: 'rgba(255,255,255,0.8)', textAlign: 'center', marginTop: 12 }}>
        {body}
      </T>
    </View>
  );
}
