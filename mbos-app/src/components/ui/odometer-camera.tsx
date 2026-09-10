import React from 'react';
import { Image, Modal, Pressable, TextInput, View } from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { color as C, HIT, radius, weight } from '../../theme/tokens';
import { Icon } from './Icon';
import { PrimaryButton, SecondaryButton, T } from './primitives';
import { checkOdometer } from '../../lib/travel-leg';

/**
 * The odometer, photographed and read, inside the app.
 *
 * **WHY THIS IS OUR OWN CAMERA when `selfie-camera.tsx` says in as many words
 * that only the selfie should be.** That note's reasoning is that a shop
 * front, a cheque and a bill are all rear-facing photographs of something the
 * salesman is looking at, and the system camera is better at those than
 * anything worth writing — it has the flash, the zoom and the tap-to-focus
 * people already know. Every word of that is still true and none of it decides
 * this one, because this screen is not asking for a photograph. It is asking
 * for a NUMBER, with the photograph as the proof of it, and the two have to be
 * one act.
 *
 * Split across two screens they stop being one. `ImagePicker` hands the phone
 * to another application; MBOS goes to the background, and on the handsets
 * this team carries that is routinely where a battery manager reaps it. What
 * comes back is a picture and a form, and the number gets typed against a
 * photograph nobody is looking at any more — which is exactly the claim the
 * photograph existed to make checkable. Here the image is on the screen above
 * the field while the digits are entered, and it can be retaken without
 * abandoning anything.
 *
 * **THE READING AND THE PHOTOGRAPH ARE BOTH REQUIRED, and neither is
 * redundant.** Two photographs cannot be subtracted — a distance that only
 * exists once a person has squinted at two images is a distance nobody will
 * ever compute — and a figure with no picture behind it cannot be checked by
 * anybody who was not standing there. So the only ways out of this screen are
 * both of them together, and abandoning the whole action. There is no third
 * door: the same reversal, and the same argument, as the attendance selfie.
 *
 * A refused camera permission is therefore a real dead end, and it says so in
 * words rather than working around itself.
 */

export type OdometerResult = { uri: string; km: number } | null;

export function OdometerCamera({
  open,
  title,
  subtitle,
  cancelLabel,
  /** The departure reading when this is an arrival; null when it is the departure. */
  previousKm,
  maxLegKilometres,
  onDone,
}: {
  open: boolean;
  title: string;
  subtitle: string;
  cancelLabel: string;
  previousKm: number | null;
  maxLegKilometres: number;
  onDone: (result: OdometerResult) => void;
}) {
  const insets = useSafeAreaInsets();
  const [permission, requestPermission] = useCameraPermissions();
  const camera = React.useRef<CameraView>(null);
  const [ready, setReady] = React.useState(false);
  const [shooting, setShooting] = React.useState(false);
  const [shot, setShot] = React.useState<string | null>(null);
  const [typed, setTyped] = React.useState('');
  const [err, setErr] = React.useState<string | null>(null);

  /* Fresh every time it opens. A reading left over from the previous shop is
     the one mistake this screen absolutely cannot make — it would be a
     plausible number, in the right field, about the wrong journey. */
  React.useEffect(() => {
    if (open) {
      setShot(null);
      setTyped('');
      setErr(null);
      setReady(false);
      setShooting(false);
    }
  }, [open]);

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
         closing on a failure nobody can see. They can press again. */
    } catch {
      /* Same. */
    } finally {
      setShooting(false);
    }
  };

  const confirm = () => {
    if (!shot) return;
    const verdict = checkOdometer({ typed, previousKm, maxLegKilometres });
    if (!verdict.ok) {
      setErr(verdict.why);
      return;
    }
    onDone({ uri: shot, km: verdict.km });
  };

  const denied = permission != null && !permission.granted && !permission.canAskAgain;

  /* Live, so the distance appears as he types rather than after he presses —
     it is the number he can sanity-check against the road he just rode, and
     showing it only on the next screen is showing it to nobody. */
  const preview =
    previousKm != null && /^\d{1,7}(\.\d+)?$/.test(typed.trim())
      ? Math.floor(Number(typed)) - previousKm
      : null;

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
            <Image source={{ uri: shot }} style={{ flex: 1 }} resizeMode="contain" />
          ) : denied ? (
            <Refusal body="Camera permission is off for MBOS. The meter reading has to be photographed, so turn the camera on in your phone’s Settings and try again. Tell your manager if you cannot." />
          ) : permission?.granted ? (
            /* Rear-facing, unmirrored. A mirrored odometer is a mirrored
               NUMBER, which is the one thing on this photograph anybody will
               ever want to read. */
            <CameraView ref={camera} style={{ flex: 1 }} facing="back" onCameraReady={() => setReady(true)} />
          ) : (
            <Refusal body="Asking for the camera…" />
          )}
        </View>

        {/* ---- the shutter, or the reading that goes with what it took ---- */}
        <View style={{ paddingHorizontal: 16, paddingTop: 16, paddingBottom: insets.bottom + 16, gap: 10 }}>
          {shot ? (
            <>
              <T style={{ fontSize: 13, lineHeight: 18, color: 'rgba(255,255,255,0.65)' }}>
                Now type what the meter reads, in kilometres.
              </T>
              <View
                style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: 10,
                  backgroundColor: 'rgba(255,255,255,0.1)',
                  borderRadius: radius.md,
                  borderWidth: 1,
                  borderColor: err ? C.warn : 'rgba(255,255,255,0.25)',
                  paddingHorizontal: 14,
                }}>
                <TextInput
                  value={typed}
                  onChangeText={(v) => {
                    setTyped(v);
                    if (err) setErr(null);
                  }}
                  keyboardType="number-pad"
                  placeholder="41208"
                  placeholderTextColor="rgba(255,255,255,0.35)"
                  autoFocus
                  accessibilityLabel="Odometer reading in kilometres"
                  style={{ flex: 1, height: 52, fontSize: 22, color: '#FFFFFF', letterSpacing: 0.5 }}
                />
                <T style={[{ fontSize: 15, color: 'rgba(255,255,255,0.6)' }, weight(500)]}>km</T>
              </View>

              {err ? (
                <T style={{ fontSize: 13, lineHeight: 18, color: C.warn }}>{err}</T>
              ) : preview != null && preview >= 0 ? (
                <T style={{ fontSize: 13, lineHeight: 18, color: 'rgba(255,255,255,0.65)' }}>
                  {preview.toLocaleString('en-IN')} km on this trip.
                </T>
              ) : previousKm != null ? (
                <T style={{ fontSize: 13, lineHeight: 18, color: 'rgba(255,255,255,0.5)' }}>
                  You set off on {previousKm.toLocaleString('en-IN')} km.
                </T>
              ) : null}

              <PrimaryButton label="Save this reading" onPress={confirm} />
              <SecondaryButton label="Take it again" onPress={() => { setShot(null); setErr(null); }} />
            </>
          ) : (
            <>
              <PrimaryButton
                label={shooting ? 'Taking…' : 'Photograph the meter'}
                onPress={() => void take()}
                disabled={!permission?.granted || !ready || shooting}
                whyDisabled={
                  denied ? 'Camera permission is off for MBOS.' : 'The camera is still starting up.'
                }
              />
              {/*
                A CANCEL, and it says what it abandons. There is no "record it
                without the photo" here and there never will be — see the note
                at the top of the file. A button offering a third thing is what
                makes a mileage record unreadable afterwards: some journeys
                would prove something and some would prove nothing, and nothing
                on the record would say which kind you were looking at.
              */}
              <Pressable
                accessibilityRole="button"
                onPress={() => onDone(null)}
                style={{ minHeight: HIT, alignItems: 'center', justifyContent: 'center' }}>
                <T style={[{ fontSize: 15, color: 'rgba(255,255,255,0.8)' }, weight(500)]}>{cancelLabel}</T>
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
