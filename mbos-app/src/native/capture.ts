import * as ImagePicker from 'expo-image-picker';
import {
  AudioModule,
  AudioQuality,
  IOSOutputFormat,
  useAudioRecorder,
  type RecordingOptions,
} from 'expo-audio';
import { captureImage, queueAudio, type MediaKind } from '../sync/media';

/**
 * Camera and microphone.
 *
 * Nothing here waits for an upload. A photograph is compressed, written to the
 * media queue and the id comes back immediately — the salesman is standing in
 * front of the shop, not waiting for a progress bar.
 */

export async function takePhoto(args: {
  parentType: string;
  parentId: string;
  kind: MediaKind;
  /** The camera for a shop; the library for a bill somebody already has. */
  source?: 'camera' | 'library';
}): Promise<{ ok: true; mediaId: string; uri: string } | { ok: false; reason: string }> {
  const useCamera = args.source !== 'library';

  const perm = useCamera
    ? await ImagePicker.requestCameraPermissionsAsync()
    : await ImagePicker.requestMediaLibraryPermissionsAsync();

  if (!perm.granted) {
    return { ok: false, reason: useCamera ? 'Camera permission is off.' : 'Photo library permission is off.' };
  }

  const result = useCamera
    ? await ImagePicker.launchCameraAsync({ quality: 1, mediaTypes: ['images'] })
    : await ImagePicker.launchImageLibraryAsync({ quality: 1, mediaTypes: ['images'] });

  if (result.canceled || !result.assets?.[0]) return { ok: false, reason: 'cancelled' };

  const asset = result.assets[0];
  const mediaId = await captureImage({
    uri: asset.uri,
    parentType: args.parentType,
    parentId: args.parentId,
    kind: args.kind,
  });

  return { ok: true, mediaId, uri: asset.uri };
}

/**
 * A selfie that was taken by our OWN camera, queued.
 *
 * `takePhoto` above is permission + system camera + queue in one call, which
 * is right for a shop front and wrong for the check-in selfie: that one is
 * taken by `SelfieCamera`, because handing off to the system camera opens it
 * rear-facing and expo's `cameraType` is only a request to another app. So the
 * capture half is somebody else's and only the queueing half is here — which
 * keeps `sync/media` reached from one module rather than two.
 */
export async function queueSelfie(uri: string, parentId: string): Promise<string> {
  return captureImage({ uri, parentType: 'attendance', parentId, kind: 'selfie' });
}

export async function requestMicrophone(): Promise<boolean> {
  const status = await AudioModule.requestRecordingPermissionsAsync();
  return status.granted;
}

/**
 * Everything that has to be true before a recorder will hear anything.
 *
 * TWO things, and NEITHER of them was being done. `startRecording` on the
 * visit screen went straight to `prepareToRecordAsync()`, so:
 *
 *   The permission was never asked for. `requestMicrophone` above has existed
 *   since the voice note shipped and nothing has ever called it. On Android
 *   `RECORD_AUDIO` is a runtime permission, so preparing simply threw and the
 *   screen said "The microphone could not start. Type the note instead." —
 *   which reads as a broken handset rather than a dialog nobody put up.
 *
 *   The iOS audio session was never put into a recording mode. `AVAudioSession`
 *   defaults to playback, and a recorder started under it captures silence or
 *   refuses outright depending on the OS version. `playsInSilentMode` belongs
 *   with it: a salesman with the ringer off is the ordinary case, not the
 *   exception.
 *
 * Both answers are reported rather than thrown, because the caller's job is to
 * say WHICH thing is wrong. "Allow the microphone" and "the microphone would
 * not open" send somebody to two different places.
 */
export async function prepareMicrophone(): Promise<
  { ok: true } | { ok: false; reason: 'permission' | 'unavailable' }
> {
  let granted = false;
  try {
    granted = await requestMicrophone();
  } catch {
    return { ok: false, reason: 'unavailable' };
  }
  if (!granted) return { ok: false, reason: 'permission' };

  try {
    await AudioModule.setAudioModeAsync({
      allowsRecording: true,
      playsInSilentMode: true,
      /* Duck the other app rather than killing it. A salesman on a call has
         not asked for his call to end because he opened a note. */
      interruptionMode: 'duckOthers',
    });
  } catch {
    return { ok: false, reason: 'unavailable' };
  }

  return { ok: true };
}

/**
 * The recorder hook the visit screen uses.
 *
 * `expo-audio` owns the recorder object; this only wraps the queueing, so
 * stopping a recording writes it to the media queue and hands back an id the
 * visit can hold on to.
 */
export function useVoiceRecorder() {
  return useAudioRecorder(DICTATION);
}

export async function queueRecording(uri: string, parentType: string, parentId: string): Promise<string> {
  return queueAudio({ uri, parentType, parentId });
}

/**
 * SPEECH, not music, and it is sent over whatever the shop has.
 *
 * `RecordingPresets.HIGH_QUALITY`, which this used, is 128 kbps of stereo at 44.1 kHz, which is
 * a preset for recording a band. A minute of it is roughly a megabyte, and
 * every byte of that either crawls up a 2G link while somebody stands waiting
 * for their own words to come back, or sits in the media queue behind the
 * payment the salesman actually needs delivered.
 *
 * None of it buys accuracy. Every model this audio can reach downmixes to mono
 * and resamples to 16 kHz before it does anything else, so the second channel
 * is discarded and two thirds of the sample rate with it. 24 kHz mono at
 * 32 kbps is comfortably above what they use and about a seventh of the size:
 * a minute is 240 KB.
 *
 * `LOW_QUALITY` was the other preset on the shelf and is the wrong floor — on
 * Android it drops to AMR narrowband at 8 kHz, which is a telephone line, and
 * a telephone line is where transcription of Indian-language speech starts
 * losing names and numbers. The saving is real and it is taken out of exactly
 * the part that has to survive.
 *
 * Metering is on because the level meter is the only thing on the recording
 * screen that proves the microphone is actually hearing anything. A stalled
 * timer says a recorder is running; a moving bar says a voice is arriving.
 */
export const DICTATION: RecordingOptions = {
  extension: '.m4a',
  sampleRate: 24_000,
  numberOfChannels: 1,
  bitRate: 32_000,
  isMeteringEnabled: true,
  android: { outputFormat: 'mpeg4', audioEncoder: 'aac' },
  ios: {
    outputFormat: IOSOutputFormat.MPEG4AAC,
    audioQuality: AudioQuality.MEDIUM,
    linearPCMBitDepth: 16,
    linearPCMIsBigEndian: false,
    linearPCMIsFloat: false,
  },
  web: { mimeType: 'audio/webm', bitsPerSecond: 32_000 },
};

/**
 * The recorder the dictation sheet drives.
 *
 * The same options as the visit's voice note, deliberately: one of these is
 * read by a model in Mumbai and the other by a model in Mumbai, and there is
 * no reason for them to sound different. Separate hooks because `useAudioRecorder`
 * hands back one recorder per call and two screens must never share one.
 */
export function useDictationRecorder() {
  return useAudioRecorder(DICTATION);
}
