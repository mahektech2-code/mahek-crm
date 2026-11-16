import React from 'react';
import { View, Image, Pressable, ActivityIndicator, Text, TextInput } from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import * as ImageManipulator from 'expo-image-manipulator';
import { PillButton } from '../ui/v3';
import { TickDisc } from './v3-parts';
import { Icon } from '../ui/Icon';
import { useOnline } from '../ui/dictate';
import { color as C, weight } from '../../theme/tokens';
import { getConfig } from '../../data/config';
import { scanLead, type LeadScanFound } from '../../sync/api';
import type { AreaRule } from '../../engines/lead-areas';
import {
  SCAN_FIELDS,
  SCAN_FIELD_LABEL,
  locationLine,
  matchLocation,
  type LocationMatch,
  type ScanField,
} from '../../engines/lead-scan';

/**
 * SCAN A CARD — the New lead form's first six answers from a photograph.
 *
 * A salesman outside a shop has a visiting card in his hand or a board over
 * the door, and was typing a fifteen-character GSTIN on a phone keyboard one
 * character at a time. He photographs up to three things — the card's front
 * and back, the board, a bill head — and MahekOne reads them together.
 *
 * NOTHING IS FILLED UNSEEN. What came back is listed with a tick beside each
 * value, every value editable, and only "Fill the form" moves the ticked ones
 * into the form — where the form's own "Add lead" is still the only thing that
 * saves. A model reading pixels is guessing, and the person holding the card is
 * the one who can tell.
 *
 * THE PHOTOGRAPHS ARE NOT KEPT. They are resized here, sent once and dropped at
 * the far end; the form's Shop photo is a separate, deliberate photograph.
 *
 * NEEDS SIGNAL, like dictation, and says so before it is pressed: an answer
 * that arrived tomorrow would fill a form already saved.
 */

export type LeadScanConfig = { available: boolean; maxImages: number };

export function useLeadScan(): LeadScanConfig {
  const [cfg, setCfg] = React.useState<LeadScanConfig>({ available: false, maxImages: 3 });
  React.useEffect(() => {
    let live = true;
    void getConfig<{ available?: boolean; maxImages?: number } | null>('mbos.ai.leadScan', null).then((c) => {
      if (live) setCfg({ available: c?.available === true, maxImages: Math.max(1, c?.maxImages ?? 3) });
    });
    return () => {
      live = false;
    };
  }, []);
  return cfg;
}

/** What "Fill the form" hands the form — only the ticked, non-empty values. */
export type LeadScanFill = {
  company?: string;
  name?: string;
  mobile?: string;
  location?: LocationMatch;
  address?: string;
  gstin?: string;
};

type Phase = 'pick' | 'reading' | 'review';

export function LeadScanPanel({
  maxImages,
  areas,
  current,
  onFill,
  onClose,
}: {
  maxImages: number;
  areas: AreaRule;
  /* What the form already holds, so a value about to be replaced says so. */
  current: Partial<Record<ScanField, string>>;
  onFill: (fill: LeadScanFill) => void;
  onClose: () => void;
}) {
  const online = useOnline();
  /* One read per press: a second tap inside the frame before the phase
     changes would send the photos twice and bill two reads. A ref, because
     state is a render away and the second tap is not. */
  const reading = React.useRef(false);
  /* Closed mid-read — the sheet shut, or the scan icon pressed again — the
     answer has nowhere to go and must not land in a panel nobody can see. */
  const alive = React.useRef(true);
  React.useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const [photos, setPhotos] = React.useState<string[]>([]);
  const [phase, setPhase] = React.useState<Phase>('pick');
  const [error, setError] = React.useState<string | null>(null);
  const [found, setFound] = React.useState<LeadScanFound | null>(null);
  const [values, setValues] = React.useState<Record<ScanField, string>>(emptyValues);
  const [ticked, setTicked] = React.useState<Record<ScanField, boolean>>(noneTicked);

  const room = maxImages - photos.length;

  /* Resized, because a 12-megapixel card is several megabytes up a village
     link — but NOT to the size every other photograph is. That setting is for
     a shop front a manager looks at; this one is read character by character,
     and a GSTIN in a card's smallest type does not survive 1600px at 70%
     JPEG. A floor of 2048px at 85% keeps a card well under a megabyte and the
     small print legible, and the general setting still wins if it is higher. */
  const shrink = async (a: { uri: string; width?: number; height?: number }) => {
    const maxDim = Math.max(2048, await getConfig<number>('mbos.sync.imageMaxDimensionPx', 1600));
    const qualityPercent = Math.max(85, await getConfig<number>('mbos.sync.imageQualityPercent', 70));
    /* Only ever DOWN, and by the longer side. Resizing every picture to a
       fixed width blew a small gallery image UP — a bigger upload carrying no
       more detail — and left a tall portrait card taller than the ceiling. A
       picture already inside it is only recompressed. */
    const w = a.width ?? 0;
    const h = a.height ?? 0;
    const resize =
      w > maxDim || h > maxDim
        ? [{ resize: w >= h ? { width: maxDim } : { height: maxDim } }]
        : [];
    const r = await ImageManipulator.manipulateAsync(a.uri, resize, {
      compress: Math.min(1, Math.max(0.01, qualityPercent / 100)),
      format: ImageManipulator.SaveFormat.JPEG,
    });
    return r.uri;
  };

  const add = async (from: 'camera' | 'library') => {
    if (room <= 0) return;
    setError(null);
    const perm =
      from === 'camera'
        ? await ImagePicker.requestCameraPermissionsAsync()
        : await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) {
      setError(from === 'camera' ? 'Camera permission is off.' : 'Photo library permission is off.');
      return;
    }
    const result =
      from === 'camera'
        ? await ImagePicker.launchCameraAsync({ quality: 1, mediaTypes: ['images'] })
        : await ImagePicker.launchImageLibraryAsync({
            quality: 1,
            mediaTypes: ['images'],
            allowsMultipleSelection: room > 1,
            selectionLimit: room,
          });
    if (result.canceled || !result.assets?.length) return;
    try {
      const small = await Promise.all(result.assets.slice(0, room).map((a) => shrink(a)));
      setPhotos((p) => [...p, ...small].slice(0, maxImages));
    } catch {
      setError('That photo could not be opened. Try taking it again.');
    }
  };

  const read = async () => {
    if (!photos.length || reading.current) return;
    reading.current = true;
    setPhase('reading');
    setError(null);
    const r = await scanLead(photos).finally(() => {
      reading.current = false;
    });
    if (!alive.current) return;
    if (!r.ok) {
      setPhase('pick');
      setError(r.error);
      return;
    }
    const v: Record<ScanField, string> = {
      company: r.businessName ?? '',
      name: r.contactPerson ?? '',
      mobile: r.mobile ?? '',
      location: r.city ?? '',
      address: r.address ?? '',
      gstin: r.gstin ?? '',
    };
    setFound(r);
    setValues(v);
    /* Ticked where something was found — and the GSTIN not ticked when it
       failed its checksum, so a number that cannot be right is filled only by
       somebody who has looked at the card and decided it is. */
    setTicked({
      company: !!v.company,
      name: !!v.name,
      mobile: !!v.mobile,
      location: !!v.location,
      address: !!v.address,
      gstin: !!v.gstin && r.gstinCheck !== 'invalid',
    });
    setPhase('review');
  };

  const fill = () => {
    const out: LeadScanFill = {};
    const val = (f: ScanField) => (ticked[f] ? values[f].trim() : '');
    if (val('company')) out.company = val('company');
    if (val('name')) out.name = val('name');
    /* The digits, without +91 or a leading 0 — what the form's own
       ten-digit check and duplicate search compare. */
    if (val('mobile')) out.mobile = mobileDigits(val('mobile'));
    if (val('address')) out.address = val('address');
    if (val('gstin')) out.gstin = val('gstin').toUpperCase().replace(/[^0-9A-Z]/g, '');
    if (ticked.location) {
      const m = matchLocation(areas, values.location.trim() || null, found?.state ?? null);
      if (m) out.location = m;
    }
    onFill(out);
  };

  const anyTicked = SCAN_FIELDS.some((f) => ticked[f] && values[f].trim());

  const review = phase === 'review';
  /* V3 draws picking as a navy card (lime accents) and the review as a white
     one — two different jobs, two different surfaces. */
  const ink = review ? C.ink : '#FFFFFF';
  const sub = review ? C.muted : C.onNavyMuted;

  return (
    <View style={{ borderRadius: 24, padding: 16, backgroundColor: review ? C.surface : C.navy }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
        <Icon name="scan" size={20} color={review ? C.primary : C.lime} strokeWidth={2} />
        <Text accessibilityRole="header" style={[{ flex: 1, fontSize: 16, lineHeight: 21, color: ink }, weight(800)]}>
          Scan card or board
        </Text>
        <Pressable
          onPress={onClose}
          accessibilityRole="button"
          accessibilityLabel="Close scan"
          hitSlop={4}
          style={({ pressed }) => ({
            width: 40,
            height: 40,
            borderRadius: 20,
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: review ? (pressed ? C.hairline : C.canvas) : 'rgba(255,255,255,0.1)',
          })}>
          <Icon name="close" size={16} color={ink} strokeWidth={2.2} />
        </Pressable>
      </View>

      {!review ? (
        <>
          <Text
            accessibilityLabel={`Up to ${maxImages} photos: a visiting card (both sides), the shop board, a bill. We fill the details for you to check. Photos are not saved.`}
            style={[{ marginTop: 6, fontSize: 12, lineHeight: 17, color: sub }, weight(400)]}>
            {`Up to ${maxImages}: card both sides, shop board, a bill · photos not saved`}
          </Text>

          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 12 }}>
            {photos.map((uri, i) => (
              <View key={uri}>
                <Image
                  source={{ uri }}
                  style={{ width: 72, height: 72, borderRadius: 16, backgroundColor: C.body }}
                  accessibilityLabel={`Photo ${i + 1}`}
                />
                {phase === 'pick' ? (
                  <Pressable
                    onPress={() => setPhotos((p) => p.filter((x) => x !== uri))}
                    accessibilityRole="button"
                    accessibilityLabel={`Remove photo ${i + 1}`}
                    hitSlop={12}
                    style={{
                      position: 'absolute',
                      top: -6,
                      right: -6,
                      width: 24,
                      height: 24,
                      borderRadius: 12,
                      backgroundColor: C.surface,
                      alignItems: 'center',
                      justifyContent: 'center',
                    }}>
                    <Icon name="close" size={12} color={C.ink} strokeWidth={2.4} />
                  </Pressable>
                ) : null}
              </View>
            ))}
            {phase === 'pick' && room > 0 ? (
              <>
                <PhotoSlot
                  icon="camera"
                  ink={C.lime}
                  label={photos.length ? 'Take another photo' : 'Take a photo'}
                  onPress={() => void add('camera')}
                />
                <PhotoSlot icon="image" ink="#FFFFFF" label="From gallery" onPress={() => void add('library')} />
              </>
            ) : null}
          </View>

          {phase === 'reading' ? (
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 14 }}>
              <ActivityIndicator color={C.lime} />
              <Text style={[{ fontSize: 14, lineHeight: 20, color: '#FFFFFF' }, weight(600)]}>
                Reading {photos.length === 1 ? 'the photo' : `${photos.length} photos`}…
              </Text>
            </View>
          ) : (
            <>
              {photos.length ? (
                <PillButton
                  label={photos.length === 1 ? 'Read the photo' : `Read ${photos.length} photos`}
                  variant="lime"
                  height={56}
                  onPress={() => void read()}
                  disabled={!online}
                  whyDisabled="No internet. Reading photos needs signal. Type the details instead."
                  style={{ marginTop: 14 }}
                />
              ) : null}
              {!online ? (
                <Text
                  accessibilityLabel="No internet. Reading photos needs signal. Type the details instead."
                  style={[{ marginTop: 10, fontSize: 12, lineHeight: 17, color: '#FFD98A' }, weight(400)]}>
                  Offline: reading needs signal, type instead
                </Text>
              ) : null}
            </>
          )}
        </>
      ) : (
        <>
          <Text style={[{ marginTop: 6, fontSize: 12, lineHeight: 17, color: C.muted }, weight(400)]}>
            Check each one against the card. Untick anything wrong. Only ticked values go into the form.
          </Text>
          {found?.note ? (
            <Text style={[{ marginTop: 6, fontSize: 12, lineHeight: 17, color: C.warnInk }, weight(400)]}>{found.note}</Text>
          ) : null}

          {SCAN_FIELDS.map((f, i) => (
            <ReviewRow
              key={f}
              field={f}
              last={i === SCAN_FIELDS.length - 1}
              value={values[f]}
              ticked={ticked[f]}
              onTick={() => setTicked((t) => ({ ...t, [f]: !t[f] }))}
              onChange={(v) => {
                setValues((x) => ({ ...x, [f]: v }));
                setTicked((t) => ({ ...t, [f]: !!v.trim() }));
              }}
              hint={hintFor(f, found, areas, values.location) ?? replaces(f, ticked[f], values[f], current[f])}
            >
              {f === 'mobile' && found?.otherNumbers.length ? (
                <>
                  <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 8, marginLeft: 40 }}>
                    {found.otherNumbers.map((n) => {
                      const on = values.mobile === n;
                      return (
                        <Pressable
                          key={n}
                          onPress={() => {
                            setValues((x) => ({ ...x, mobile: n }));
                            setTicked((t) => ({ ...t, mobile: true }));
                          }}
                          accessibilityRole="radio"
                          accessibilityState={{ selected: on }}
                          accessibilityLabel={'Use ' + n}
                          hitSlop={{ top: 6, bottom: 6 }}
                          style={{
                            minHeight: 32,
                            paddingVertical: 4,
                            paddingHorizontal: 12,
                            borderRadius: 16,
                            justifyContent: 'center',
                            backgroundColor: on ? C.navy : C.canvas,
                          }}>
                          <Text style={[{ fontSize: 12, lineHeight: 17, color: on ? '#FFFFFF' : C.ink }, weight(600)]}>{n}</Text>
                        </Pressable>
                      );
                    })}
                  </View>
                  <Text style={[{ fontSize: 11, color: C.muted, marginTop: 4, marginLeft: 40 }, weight(400)]}>
                    Other numbers · tap to use
                  </Text>
                </>
              ) : null}
            </ReviewRow>
          ))}

          <View style={{ flexDirection: 'row', gap: 10, marginTop: 10 }}>
            <Pressable
              onPress={() => {
                setPhase('pick');
                setFound(null);
              }}
              accessibilityRole="button"
              style={({ pressed }) => ({
                width: 130,
                minHeight: 52,
                paddingVertical: 8,
                borderRadius: 26,
                backgroundColor: pressed ? C.hairline : C.canvas,
                alignItems: 'center',
                justifyContent: 'center',
              })}>
              <Text style={[{ fontSize: 14, lineHeight: 20, color: C.ink }, weight(700)]}>Scan again</Text>
            </Pressable>
            <PillButton
              label="Fill the form"
              variant="navy"
              height={52}
              onPress={fill}
              disabled={!anyTicked}
              whyDisabled="Tick at least one value to fill."
              style={{ flex: 1 }}
            />
          </View>
        </>
      )}

      {error ? (
        <View style={{ marginTop: 10, backgroundColor: C.dangerBg, borderRadius: 20, paddingHorizontal: 14, paddingVertical: 10 }}>
          <Text style={[{ fontSize: 12, lineHeight: 17, color: C.danger }, weight(600)]}>{error}</Text>
        </View>
      ) : null}
    </View>
  );
}

/** A 72 dashed square on the navy card — take a photo, from the gallery. */
function PhotoSlot({ icon, ink, label, onPress }: { icon: 'camera' | 'image'; ink: string; label: string; onPress: () => void }) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={({ pressed }) => ({
        width: 72,
        height: 72,
        borderRadius: 16,
        borderWidth: 1.5,
        borderStyle: 'dashed',
        borderColor: C.faint,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: pressed ? 'rgba(255,255,255,0.08)' : 'transparent',
      })}>
      <Icon name={icon} size={22} color={ink} strokeWidth={2} />
    </Pressable>
  );
}

function ReviewRow({
  field,
  value,
  ticked,
  onTick,
  onChange,
  hint,
  last,
  children,
}: {
  field: ScanField;
  value: string;
  ticked: boolean;
  onTick: () => void;
  onChange: (v: string) => void;
  hint: { text: string; warn: boolean } | null;
  last: boolean;
  children?: React.ReactNode;
}) {
  return (
    <View style={{ paddingVertical: 8, borderBottomWidth: last ? 0 : 1, borderBottomColor: C.hairline }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 40 }}>
        <Pressable
          onPress={onTick}
          accessibilityRole="checkbox"
          accessibilityState={{ checked: ticked }}
          accessibilityLabel={`Use ${SCAN_FIELD_LABEL[field]}`}
          hitSlop={10}>
          <TickDisc on={ticked} />
        </Pressable>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={[{ fontSize: 11, lineHeight: 15, color: C.faint }, weight(400)]}>{SCAN_FIELD_LABEL[field]}</Text>
          <TextInput
            value={value}
            onChangeText={onChange}
            placeholder="Not found"
            placeholderTextColor={C.faint}
            accessibilityLabel={SCAN_FIELD_LABEL[field]}
            keyboardType={field === 'mobile' ? 'phone-pad' : 'default'}
            autoCapitalize={field === 'gstin' ? 'characters' : 'sentences'}
            multiline={field === 'address'}
            style={[{ fontSize: 15, lineHeight: 20, color: C.ink, paddingVertical: 2, paddingHorizontal: 0 }, weight(400)]}
          />
          {hint ? (
            <Text style={[{ fontSize: 11, lineHeight: 15, color: hint.warn ? C.warnInk : C.success }, weight(400)]}>
              {hint.text}
            </Text>
          ) : null}
        </View>
      </View>
      {children}
    </View>
  );
}

/** The sentence under a value, where there is something worth saying. */
function hintFor(
  field: ScanField,
  found: LeadScanFound | null,
  areas: AreaRule,
  city: string,
): { text: string; warn: boolean } | null {
  if (!found) return null;
  if (field === 'gstin' && found.gstin) {
    if (found.gstinCheck === 'invalid') {
      return { text: 'This does not look like a valid GST number. Check it against the card.', warn: true };
    }
    if (found.gstinCheck === 'corrected') {
      return { text: 'Some letters looked like numbers. Check it against the card.', warn: true };
    }
  }
  if (field === 'mobile' && !found.mobile && found.otherNumbers.length) {
    return { text: 'No mobile was clear. Tap a number below if one is the mobile.', warn: true };
  }
  if (field === 'mobile' && found.mobile && found.otherNumbers.length) {
    return { text: 'Other numbers on the card are below. Tap one to use it instead.', warn: false };
  }
  if (field === 'location') {
    const m = matchLocation(areas, city.trim() || null, found.state);
    if (m?.kind === 'outside') {
      return {
        text: areas.kind === 'none' ? 'No area is set for you yet.' : `${m.city} is not in your area. You can add leads only in your own area.`,
        warn: true,
      };
    }
    if (m?.kind === 'area') return { text: 'Your area: ' + m.area.label, warn: false };
    const line = locationLine(null, found.state);
    if (line && !city.trim()) return { text: 'State on the card: ' + line, warn: false };
  }
  return null;
}

/* "98220 11001", "+91 98220 11001" and "098220 11001" are one mobile. */
function mobileDigits(raw: string): string {
  let d = raw.replace(/\D/g, '');
  if (d.length === 12 && d.startsWith('91')) d = d.slice(2);
  else if (d.length === 11 && d.startsWith('0')) d = d.slice(1);
  return d;
}

/** Said where a ticked value will overwrite something he already typed. */
function replaces(
  field: ScanField,
  ticked: boolean,
  value: string,
  typed: string | undefined,
): { text: string; warn: boolean } | null {
  const was = typed?.trim();
  if (!ticked || !was || !value.trim()) return null;
  const same = field === 'mobile' ? mobileDigits(was) === mobileDigits(value) : was.toLowerCase() === value.trim().toLowerCase();
  return same ? null : { text: `Replaces what you typed: ${was}`, warn: true };
}

const emptyValues: Record<ScanField, string> = {
  company: '',
  name: '',
  mobile: '',
  location: '',
  address: '',
  gstin: '',
};
const noneTicked: Record<ScanField, boolean> = {
  company: false,
  name: false,
  mobile: false,
  location: false,
  address: false,
  gstin: false,
};
