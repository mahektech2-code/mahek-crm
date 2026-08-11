import * as ImagePicker from 'expo-image-picker';
import { AudioModule, RecordingPresets, useAudioRecorder } from 'expo-audio';
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

export async function requestMicrophone(): Promise<boolean> {
  const status = await AudioModule.requestRecordingPermissionsAsync();
  return status.granted;
}

/**
 * The recorder hook the visit screen uses.
 *
 * `expo-audio` owns the recorder object; this only wraps the queueing, so
 * stopping a recording writes it to the media queue and hands back an id the
 * visit can hold on to.
 */
export function useVoiceRecorder() {
  return useAudioRecorder(RecordingPresets.HIGH_QUALITY);
}

export async function queueRecording(uri: string, parentType: string, parentId: string): Promise<string> {
  return queueAudio({ uri, parentType, parentId });
}
