import * as ImagePicker from 'expo-image-picker';
import {
  AudioModule,
  AudioQuality,
  IOSOutputFormat,
  useAudioRecorder,
  type RecordingOptions,
} from 'expo-audio';
import { captureImage, queueAudio, queueFile, type MediaKind } from '../sync/media';

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

export type Picked = { mediaId: string; label: string; isPdf: boolean };

/**
 * Several bills from the gallery at once.
 *
 * A two-page bill and the payment screenshot beside it are three photographs
 * he already has, and making him open the gallery three times — once per
 * file — is the kind of friction that ends with one of them not attached.
 * Each is compressed exactly as a camera shot is.
 */
export async function pickPhotos(args: {
  parentType: string;
  parentId: string;
  kind: MediaKind;
  max: number;
}): Promise<{ ok: true; picked: Picked[] } | { ok: false; reason: string }> {
  if (args.max <= 0) return { ok: false, reason: 'No more files can be attached to this claim.' };
  const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
  if (!perm.granted) return { ok: false, reason: 'Photo library permission is off.' };
  const result = await ImagePicker.launchImageLibraryAsync({
    quality: 1,
    mediaTypes: ['images'],
    allowsMultipleSelection: true,
    selectionLimit: args.max,
  });
  if (result.canceled || !result.assets?.length) return { ok: false, reason: 'cancelled' };
  const picked: Picked[] = [];
  for (const asset of result.assets.slice(0, args.max)) {
    const mediaId = await captureImage({
      uri: asset.uri,
      parentType: args.parentType,
      parentId: args.parentId,
      kind: args.kind,
    });
    picked.push({ mediaId, label: 'Photo', isPdf: false });
  }
  return { ok: true, picked };
}

/**
 * A PDF bill — the e-invoice a fuel pump or a hotel mails him, which is not a
 * photograph and never was. Images picked here go through the same compression
 * a camera shot does; a PDF is queued as it is, after its size is checked
 * against the office's own upload limit, so a file the server would refuse is
 * refused here while he is looking rather than in the queue hours later.
 */
export async function pickDocuments(args: {
  parentType: string;
  parentId: string;
  kind: MediaKind;
  max: number;
  maxSizeMb: number;
}): Promise<{ ok: true; picked: Picked[]; refused: string[] } | { ok: false; reason: string }> {
  if (args.max <= 0) return { ok: false, reason: 'No more files can be attached to this claim.' };
  /*
   * LOADED HERE, NOT AT THE TOP OF THE FILE, and that is what lets this
   * JavaScript run on an older APK.
   *
   * `expo-document-picker` is a native module that arrived with 1.12.0. Its
   * package calls `requireNativeModule` the moment it is imported, which throws
   * on a build without it — and this file is imported by nearly every screen,
   * so a top-level import would stop the app opening at all on the 1.9–1.11
   * phones that receive this code over the air. Loaded on the press, a missing
   * module costs exactly this one button, and says so.
   */
  let DocumentPicker: typeof import('expo-document-picker');
  try {
    DocumentPicker = await import('expo-document-picker');
  } catch {
    return {
      ok: false,
      reason: 'Attaching PDFs needs the latest MBOS app. Take a photo of the bill instead, or ask for the update.',
    };
  }
  const result = await DocumentPicker.getDocumentAsync({
    type: ['application/pdf', 'image/jpeg', 'image/png'],
    multiple: true,
    copyToCacheDirectory: true,
  });
  if (result.canceled || !result.assets?.length) return { ok: false, reason: 'cancelled' };
  const picked: Picked[] = [];
  const refused: string[] = [];
  for (const asset of result.assets) {
    if (picked.length >= args.max) {
      refused.push(`${asset.name} — this claim already has as many files as it can take`);
      continue;
    }
    const mime = asset.mimeType ?? '';
    if (mime.startsWith('image/')) {
      const mediaId = await captureImage({
        uri: asset.uri,
        parentType: args.parentType,
        parentId: args.parentId,
        kind: args.kind,
      });
      picked.push({ mediaId, label: asset.name || 'Photo', isPdf: false });
      continue;
    }
    if (mime !== 'application/pdf') {
      refused.push(`${asset.name} — only PDFs and photographs can be attached`);
      continue;
    }
    const mb = (asset.size ?? 0) / (1024 * 1024);
    if (mb > args.maxSizeMb) {
      refused.push(`${asset.name} is ${mb.toFixed(1)} MB and the limit is ${args.maxSizeMb} MB`);
      continue;
    }
    const mediaId = await queueFile({
      uri: asset.uri,
      mimeType: 'application/pdf',
      parentType: args.parentType,
      parentId: args.parentId,
      kind: args.kind,
    });
    picked.push({ mediaId, label: asset.name || 'PDF', isPdf: true });
  }
  return { ok: true, picked, refused };
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

/**
 * An odometer photograph our OWN camera took, queued.
 *
 * The same split as `queueSelfie` above, for a related but distinct reason.
 * The selfie is ours because handing off opens the camera rear-facing; this
 * one is ours because the screen is asking for a NUMBER with the photograph as
 * its proof, and the two have to be one act — see `odometer-camera.tsx`. Only
 * the queueing half lives here, which keeps `sync/media` reached from one
 * module rather than two.
 */
export async function queueOdometerPhoto(uri: string, parentId: string): Promise<string> {
  return captureImage({ uri, parentType: 'travel_leg', parentId, kind: 'odometer_photo' });
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
