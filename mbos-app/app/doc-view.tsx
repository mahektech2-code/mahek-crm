import React from 'react';
import { ActivityIndicator, FlatList, Image, PixelRatio, Pressable, ScrollView, Text, View, type ViewToken } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { AppFrame, useCameFrom } from '../src/components/shell/AppFrame';
import { HERO } from '../src/components/shell/Chrome';
import { PillButton } from '../src/components/ui/v3';
import { Glyph, type GlyphShape } from '../src/components/me/kit';
import { Icon, type IconName } from '../src/components/ui/Icon';
import { color as C, weight } from '../src/theme/tokens';
import {
  downloadDocument,
  forgetDocumentFile,
  getDocument,
  heldFile,
  mediaTypeOf,
  openDocumentFile,
  type DocumentRow,
} from '../src/data/library';
import { categoryLabel, fileBadge, fileKind, shareFileName } from '../src/lib/library-view';
import { shareAvailable, shareFile } from '../src/native/share';
import { pdfPageCount, pdfPreviewAvailable, renderPdfPage } from '../src/native/pdf-preview';
import { useStore } from '../src/state/store';
import { dmy, isoDate } from '../src/lib/format';
import { BADGE_FONT_CAP } from '../src/components/ui/font-scale';

/**
 * ONE DOCUMENT, READ INSIDE THE APP.
 *
 * Every document used to be handed to "whatever on this phone opens it", and
 * on the phones the field team carries that was frequently nothing: the file
 * was saved without an extension and sent without a type, Android matched it
 * to no app, and the tap did nothing he could see. A price list he cannot open
 * in front of a customer is not a price list.
 *
 * So the app draws it. A PDF is drawn a page at a time by Android's own
 * `PdfRenderer` (`modules/pdf-preview`) — no other app, no signal, the same on
 * every phone — and a picture is a picture. Both sit on a grey desk as white
 * sheets with a margin on all four sides, so the edge of the page is visible
 * and nobody mistakes the end of the screen for the end of the paper.
 *
 * **Zoom is buttons and a double tap.** Pinching needs a gesture library this
 * app does not carry; the buttons are where a thumb can find them and say what
 * they do, and a double tap is the gesture every phone viewer already taught.
 * A zoomed page is redrawn at the new width rather than stretched, so small
 * print on a rate card stays sharp.
 *
 * **Share sends the file itself** — to WhatsApp, Gmail, Bluetooth, whatever
 * the phone has — named after the document's title (`native/share.ts`). It is
 * drawn only on a build that carries the native half, and is the main button
 * there because handing a customer the price list is what this screen is for.
 *
 * **"Open in another app" is always there**, for printing, and because a build
 * without the viewer or the share — an APK from before either shipped — still
 * needs a way to the file.
 */

type Phase =
  | { at: 'loading' }
  | { at: 'gone' }
  | { at: 'downloading'; fraction: number | null }
  | { at: 'failed'; reason: string }
  | { at: 'ready'; uri: string; kind: string | null };

const ZOOMS = [1, 1.5, 2, 3] as const;
const EDGE = 14;
const GAP = 12;
/** Before a page has been measured it is assumed to be A4, which most of these are. */
const A4 = 297 / 210;

export default function DocViewScreen() {
  const back = useCameFrom('docs');
  const notify = useStore((s) => s.notify);
  const { id } = useLocalSearchParams<{ id?: string }>();
  const [doc, setDoc] = React.useState<DocumentRow | null>(null);
  const [phase, setPhase] = React.useState<Phase>({ at: 'loading' });
  const [attempt, setAttempt] = React.useState(0);

  React.useEffect(() => {
    let live = true;
    void (async () => {
      const row = id ? await getDocument(id) : null;
      if (!live) return;
      setDoc(row);
      if (!row) return setPhase({ at: 'gone' });
      const held = heldFile(row);
      if (held) return setPhase({ at: 'ready', uri: held, kind: row.kind });
      setPhase({ at: 'downloading', fraction: null });
      const got = await downloadDocument(row, (f) => live && setPhase({ at: 'downloading', fraction: f }));
      if (!live) return;
      setPhase(got.ok ? { at: 'ready', uri: got.uri, kind: got.kind } : { at: 'failed', reason: got.reason });
    })();
    return () => {
      live = false;
    };
  }, [id, attempt]);

  const openElsewhere = React.useCallback(async () => {
    if (!doc || phase.at !== 'ready') return;
    const r = await openDocumentFile(phase.uri, mediaTypeOf({ kind: phase.kind }, phase.uri));
    if (r.ok) return;
    if (/no longer on this phone/.test(r.reason)) {
      await forgetDocumentFile(doc.id);
      setAttempt((n) => n + 1);
    }
    notify(r.reason, 'error');
  }, [doc, phase, notify]);

  const shareIt = React.useCallback(async () => {
    if (!doc || phase.at !== 'ready') return;
    const mediaType = mediaTypeOf({ kind: phase.kind }, phase.uri);
    const r = await shareFile({
      uri: phase.uri,
      name: shareFileName(doc.title, mediaType),
      mediaType,
      dialogTitle: `Share ${doc.title}`,
    });
    if (r.ok) return;
    if (/no longer on this phone/.test(r.reason)) {
      await forgetDocumentFile(doc.id);
      setAttempt((n) => n + 1);
    }
    notify(r.reason, 'error');
  }, [doc, phase, notify]);

  const meta = doc
    ? [
        categoryLabel(doc.category),
        fileBadge(phase.at === 'ready' ? phase.kind : doc.kind),
        doc.sizeLabel,
        doc.publishedAt ? dmy(isoDate(new Date(doc.publishedAt))) : null,
      ]
        .filter(Boolean)
        .join(' · ')
    : '';

  const kindNow = phase.at === 'ready' ? phase.kind : doc?.kind ?? null;
  const tile = TILE[fileKind(kindNow)];
  const title = doc?.title ?? (phase.at === 'gone' ? 'Not available' : ' ');

  return (
    <AppFrame
      tone="canvas"
      title="Document"
      activeTab={null}
      onBack={back.go}
      scroll={false}
      showTitle={false}
      hero={
        <View style={{ marginTop: 14 }}>
          <Text
            accessibilityRole="header"
            numberOfLines={2}
            style={[{ fontSize: 20, lineHeight: 26, letterSpacing: -0.4, color: HERO.lavender.ink }, weight(800)]}>
            {title}
          </Text>
          {doc ? (
            <View accessible accessibilityLabel={meta} style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 8 }}>
              {categoryLabel(doc.category) ? <MetaPill text={categoryLabel(doc.category)} ink={C.ink} /> : null}
              {fileBadge(kindNow) ? <MetaPill text={fileBadge(kindNow)} bg={tile.bg} ink={tile.ink} strong /> : null}
              {doc.sizeLabel ? <MetaPill text={doc.sizeLabel} /> : null}
              {doc.publishedAt ? <MetaPill text={dmy(isoDate(new Date(doc.publishedAt)))} cal /> : null}
            </View>
          ) : null}
        </View>
      }>
      <View style={{ flex: 1, marginHorizontal: 12, marginTop: 12 }}>
        {phase.at === 'loading' ? (
          <Desk>
            <Centre>
              <ActivityIndicator color={C.primary} accessibilityLabel="Opening" />
            </Centre>
          </Desk>
        ) : phase.at === 'gone' ? (
          <Message
            glyph="doc"
            title="Not on your phone any more"
            body="The office may have withdrawn it or narrowed who it is for. Go back to Documents."
            a11y="This document is not on your phone any more. The office may have withdrawn it, or narrowed who it is for. Go back to Documents for what is there now."
          />
        ) : phase.at === 'downloading' ? (
          <Downloading fraction={phase.fraction} size={doc?.sizeLabel ?? null} />
        ) : phase.at === 'failed' ? (
          <Message
            glyph="alert"
            tint={{ bg: C.dangerBg, ink: C.danger }}
            title="Could not download it"
            body={phase.reason}
            action={{ icon: 'refresh', label: 'Try again', onPress: () => setAttempt((n) => n + 1) }}
          />
        ) : (
          <Viewer uri={phase.uri} kind={phase.kind ?? mediaTypeOf({ kind: null }, phase.uri)} onOpenElsewhere={openElsewhere} />
        )}
      </View>

      {phase.at === 'ready' ? (
        <View style={{ flexDirection: 'row', gap: 10, paddingHorizontal: 14, paddingTop: 12, paddingBottom: 12 }}>
          {shareAvailable ? (
            <PillButton
              label="Share"
              icon="share"
              variant="primary"
              height={60}
              onPress={() => void shareIt()}
              style={{ flex: 1.3 }}
            />
          ) : null}
          <PillButton
            label={shareAvailable ? 'Another app' : 'Open in another app'}
            a11y="Open in another app"
            icon="external"
            variant="white"
            height={60}
            onPress={() => void openElsewhere()}
            style={{ flex: 1 }}
          />
        </View>
      ) : null}
    </AppFrame>
  );
}

const TILE = {
  pdf: { bg: C.dangerBg, ink: C.danger },
  image: { bg: C.infoBg, ink: C.info },
  other: { bg: C.surface, ink: C.muted },
} as const;

/** One fact about the document, as a pill under its title. */
function MetaPill({ text, bg = C.surface, ink = C.muted, strong = false, cal = false }: { text: string; bg?: string; ink?: string; strong?: boolean; cal?: boolean }) {
  return (
    <View style={{ minHeight: 28, paddingVertical: 4, paddingHorizontal: 10, borderRadius: 14, backgroundColor: bg, flexDirection: 'row', alignItems: 'center', gap: 5 }}>
      {cal ? <Icon name="cal" size={13} color={ink} strokeWidth={2.2} /> : null}
      <Text style={[{ flexShrink: 1, fontSize: 12, lineHeight: 17, color: ink }, weight(strong ? 800 : 600)]}>{text}</Text>
    </View>
  );
}

/** The grey desk the sheets lie on. */
function Desk({ children }: { children: React.ReactNode }) {
  return <View style={{ flex: 1, backgroundColor: C.border, borderRadius: 22, overflow: 'hidden' }}>{children}</View>;
}

/** The file is on its way: how much of it, and that it then opens anywhere. */
function Downloading({ fraction, size }: { fraction: number | null; size: string | null }) {
  const pct = Math.round((fraction ?? 0) * 100);
  return (
    <View
      accessible
      accessibilityLabel={
        fraction == null
          ? 'Downloading. Starting. Once it is here it opens without signal.'
          : `Downloading, ${pct}%${size ? ` of ${size}` : ''}. Once it is here it opens without signal.`
      }
      style={{ backgroundColor: C.surface, borderRadius: 22, padding: 16, flexDirection: 'row', gap: 14, alignItems: 'center' }}>
      <View
        style={{
          width: 52,
          height: 52,
          borderRadius: 26,
          backgroundColor: C.primaryTint,
          alignItems: 'center',
          justifyContent: 'center',
        }}>
        {fraction == null ? (
          <ActivityIndicator size="small" color={C.primaryDeep} />
        ) : (
          <Text numberOfLines={1} adjustsFontSizeToFit maxFontSizeMultiplier={BADGE_FONT_CAP} style={[{ fontSize: 14, lineHeight: 18, color: C.primaryDeep }, weight(800)]}>{pct}%</Text>
        )}
      </View>
      <View style={{ flex: 1, minWidth: 0 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          <Icon name="download" size={16} color={C.ink} strokeWidth={2} />
          <Text style={[{ flex: 1, fontSize: 13, color: C.ink }, weight(700)]} numberOfLines={1}>
            {fraction == null ? 'Starting…' : size ? `of ${size}` : 'Downloading'}
          </Text>
        </View>
        <View style={{ height: 8, borderRadius: 4, backgroundColor: C.hairline, marginTop: 8, overflow: 'hidden' }}>
          <View style={{ width: `${pct}%`, height: 8, borderRadius: 4, backgroundColor: C.primary }} />
        </View>
        <Text style={{ fontSize: 12, lineHeight: 17, color: C.muted, marginTop: 6 }}>Then opens without signal</Text>
      </View>
    </View>
  );
}

/* ---------------------------------------------------------------- viewer */

function Viewer({ uri, kind, onOpenElsewhere }: { uri: string; kind: string; onOpenElsewhere: () => void }) {
  const what = fileKind(kind);
  const [pages, setPages] = React.useState<number | null>(what === 'image' ? 1 : null);
  const [problem, setProblem] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (what !== 'pdf' || !pdfPreviewAvailable) return;
    let live = true;
    void pdfPageCount(uri).then((r) => {
      if (!live) return;
      if (r.ok) setPages(r.pages);
      else setProblem(r.reason);
    });
    return () => {
      live = false;
    };
  }, [uri, what]);

  if (what === 'other') {
    return (
      <Message
        glyph="noFile"
        title="This file cannot be shown here"
        body="Phones show PDFs and pictures."
        a11y="Phones can show PDFs and pictures. Open it in another app instead."
        action={{ icon: 'external', label: 'Open in another app', onPress: onOpenElsewhere }}
      />
    );
  }
  if (what === 'pdf' && !pdfPreviewAvailable) {
    return (
      <Message
        glyph="noFile"
        title="Update the app to read PDFs here"
        body="This version cannot draw PDFs; the next update does."
        a11y="This version cannot draw PDFs itself. Open it in another app for now — the next update reads them inside MBOS."
        action={{ icon: 'external', label: 'Open in another app', onPress: onOpenElsewhere }}
      />
    );
  }
  if (problem) {
    return (
      <Message
        glyph="noFile"
        title="This PDF cannot be shown here"
        body={problem}
        action={{ icon: 'external', label: 'Open in another app', onPress: onOpenElsewhere }}
      />
    );
  }
  if (pages == null) {
    return (
      <Desk>
        <Centre>
          <ActivityIndicator color={C.primary} />
        </Centre>
      </Desk>
    );
  }
  return (
    <Desk>
      <Pages uri={uri} count={pages} image={what === 'image'} />
    </Desk>
  );
}

/**
 * The sheets on the desk.
 *
 * Virtualised — a 200-page catalogue mounts the handful of pages near the
 * screen and draws each as it arrives — and zoomed by widening the sheets
 * inside a sideways scroller, so a zoomed page pans in both directions.
 */
function Pages({ uri, count, image }: { uri: string; count: number; image: boolean }) {
  const [box, setBox] = React.useState<{ w: number; h: number } | null>(null);
  const [zoomAt, setZoomAt] = React.useState(0);
  const [current, setCurrent] = React.useState(1);
  const lastTap = React.useRef(0);
  const zoom = ZOOMS[zoomAt];

  /* Stable for the list's lifetime: FlatList refuses a viewability callback
     that changes between renders. */
  const onViewable = React.useCallback(({ viewableItems }: { viewableItems: ViewToken[] }) => {
    const first = viewableItems.find((v) => v.isViewable);
    if (first?.index != null) setCurrent(first.index + 1);
  }, []);

  const onTap = React.useCallback(() => {
    const now = Date.now();
    if (now - lastTap.current < 300) {
      setZoomAt((z) => (z === 0 ? 2 : 0));
      lastTap.current = 0;
    } else {
      lastTap.current = now;
    }
  }, []);

  const sheetW = box ? (box.w - EDGE * 2) * zoom : 0;
  const contentW = sheetW + EDGE * 2;
  const pageIndexes = React.useMemo(() => Array.from({ length: count }, (_, i) => i), [count]);

  return (
    <View style={{ flex: 1 }} onLayout={(e) => setBox({ w: e.nativeEvent.layout.width, h: e.nativeEvent.layout.height })}>
      {box ? (
        <ScrollView
          horizontal
          scrollEnabled={zoom > 1}
          showsHorizontalScrollIndicator={zoom > 1}
          style={{ flex: 1 }}
          contentContainerStyle={{ width: Math.max(contentW, box.w) }}>
          <FlatList
            style={{ width: Math.max(contentW, box.w), height: box.h }}
            data={pageIndexes}
            keyExtractor={(i) => String(i)}
            initialNumToRender={2}
            windowSize={5}
            maxToRenderPerBatch={2}
            contentContainerStyle={{ padding: EDGE, paddingBottom: EDGE + 56 }}
            ItemSeparatorComponent={Gap}
            onViewableItemsChanged={onViewable}
            viewabilityConfig={{ itemVisiblePercentThreshold: 40 }}
            renderItem={({ item }) => (
              <Sheet uri={uri} index={item} width={sheetW} image={image} onTap={onTap} />
            )}
          />
        </ScrollView>
      ) : null}

      {/* The gesture nobody would guess, said once in the corner. */}
      <View
        pointerEvents="none"
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        style={{
          position: 'absolute',
          right: 14,
          top: 14,
          minHeight: 26,
          paddingVertical: 3,
          paddingHorizontal: 10,
          borderRadius: 13,
          backgroundColor: 'rgba(15,27,51,0.7)',
          justifyContent: 'center',
        }}>
        <Text style={[{ fontSize: 11, color: '#FFFFFF' }, weight(600)]}>Double tap 1×/2×</Text>
      </View>

      {/* What page, and the zoom — floating over the desk, never over the paper's edge. */}
      <View
        pointerEvents="box-none"
        style={{ position: 'absolute', left: 0, right: 0, bottom: 12, alignItems: 'center' }}>
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            gap: 4,
            padding: 4,
            borderRadius: 26,
            backgroundColor: C.navy,
          }}>
          <RoundButton
            icon="zoomOut"
            label="Zoom out"
            disabled={zoomAt === 0}
            onPress={() => setZoomAt((z) => Math.max(0, z - 1))}
          />
          <Text
            accessibilityLabel={count > 1 ? `Page ${current} of ${count}` : `Zoom ${Math.round(zoom * 100)} percent`}
            style={[{ fontSize: 14, lineHeight: 20, color: C.lime, minWidth: 64, textAlign: 'center' }, weight(800)]}>
            {count > 1 ? `${current} / ${count}` : `${Math.round(zoom * 100)}%`}
          </Text>
          <RoundButton
            icon="zoomIn"
            label="Zoom in"
            disabled={zoomAt === ZOOMS.length - 1}
            onPress={() => setZoomAt((z) => Math.min(ZOOMS.length - 1, z + 1))}
          />
        </View>
      </View>
    </View>
  );
}

function RoundButton({ icon, label, onPress, disabled }: { icon: IconName; label: string; onPress: () => void; disabled: boolean }) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      hitSlop={6}
      style={({ pressed }) => ({
        width: 44,
        height: 44,
        borderRadius: 22,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: pressed ? 'rgba(255,255,255,0.16)' : 'transparent',
        opacity: disabled ? 0.35 : 1,
      })}>
      <Icon name={icon} size={20} color={C.surface} />
    </Pressable>
  );
}

/**
 * One page: white, edged, shadowed, and drawn at the width it is shown at.
 *
 * The last drawing is kept on screen while a sharper one is made for a new
 * zoom, so zooming never flashes an empty sheet.
 */
function Sheet({
  uri,
  index,
  width,
  image,
  onTap,
}: {
  uri: string;
  index: number;
  width: number;
  image: boolean;
  onTap: () => void;
}) {
  const [drawn, setDrawn] = React.useState<{ uri: string; w: number; h: number } | null>(null);
  const [failed, setFailed] = React.useState<string | null>(null);
  const px = Math.round(width * PixelRatio.get());

  React.useEffect(() => {
    let live = true;
    if (image) {
      Image.getSize(
        uri,
        (w, h) => live && setDrawn({ uri, w, h }),
        () => live && setFailed('This picture could not be read.'),
      );
    } else {
      void renderPdfPage(uri, index, px).then((r) => {
        if (!live) return;
        if (r.ok) setDrawn({ uri: r.page.uri, w: r.page.width, h: r.page.height });
        else setFailed(r.reason);
      });
    }
    return () => {
      live = false;
    };
  }, [uri, index, px, image]);

  const height = drawn ? (width * drawn.h) / drawn.w : width * A4;

  return (
    <Pressable
      onPress={onTap}
      accessibilityLabel={image ? 'The picture' : `Page ${index + 1}`}
      style={{
        width,
        height,
        backgroundColor: C.surface,
        borderRadius: 6,
        overflow: 'hidden',
        boxShadow: '0 6px 16px -8px rgba(15,27,51,0.25)',
      }}>
      {drawn ? (
        <Image source={{ uri: drawn.uri }} style={{ width: '100%', height: '100%' }} resizeMode="contain" fadeDuration={0} />
      ) : failed ? (
        <Centre>
          <Text style={{ fontSize: 12, lineHeight: 17, color: C.muted, textAlign: 'center' }}>{failed}</Text>
        </Centre>
      ) : (
        <Centre>
          <ActivityIndicator color={C.faint} />
        </Centre>
      )}
    </Pressable>
  );
}

/* ----------------------------------------------------------------- parts */

function Gap() {
  return <View style={{ height: GAP }} />;
}

function Centre({ children }: { children: React.ReactNode }) {
  return <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 }}>{children}</View>;
}

const MESSAGE_GLYPH: Record<'doc' | 'alert' | 'noFile', GlyphShape[]> = {
  doc: [{ p: 'M7 3h7l5 5v13H7z' }, { p: 'M14 3v5h5' }],
  alert: [{ p: 'M12 4l9 16H3z' }, { p: 'M12 10v4M12 17h.01' }],
  noFile: [{ p: 'M7 3h7l5 5v13H7z' }, { p: 'M14 3v5h5M9 13l6 6M15 13l-6 6' }],
};

/** Why the document is not on the screen, and — where there is one — the way past it. */
function Message({
  glyph,
  tint = { bg: C.canvas, ink: C.muted },
  title,
  body,
  a11y,
  action,
}: {
  glyph: keyof typeof MESSAGE_GLYPH;
  tint?: { bg: string; ink: string };
  title: string;
  body: string;
  /** The longer sentence, where V3 cut the visible one short. */
  a11y?: string;
  action?: { icon: IconName; label: string; onPress: () => void };
}) {
  return (
    <View style={{ backgroundColor: C.surface, borderRadius: 22, padding: 16, flexDirection: 'row', gap: 12, alignItems: 'center' }}>
      <View
        style={{
          width: 44,
          height: 44,
          borderRadius: 22,
          backgroundColor: tint.bg,
          alignItems: 'center',
          justifyContent: 'center',
        }}>
        <Glyph shapes={MESSAGE_GLYPH[glyph]} size={20} color={tint.ink} />
      </View>
      <View accessible accessibilityLabel={`${title}. ${a11y ?? body}`} style={{ flex: 1, minWidth: 0 }}>
        <Text style={[{ fontSize: 15, lineHeight: 21, color: C.ink }, weight(700)]}>{title}</Text>
        <Text style={{ fontSize: 13, lineHeight: 18, color: C.muted }}>{body}</Text>
      </View>
      {action ? (
        <Pressable
          onPress={action.onPress}
          accessibilityRole="button"
          accessibilityLabel={action.label}
          style={({ pressed }) => ({
            width: 48,
            height: 48,
            borderRadius: 24,
            backgroundColor: C.primary,
            alignItems: 'center',
            justifyContent: 'center',
            opacity: pressed ? 0.85 : 1,
          })}>
          <Icon name={action.icon} size={20} color="#FFFFFF" strokeWidth={2.2} />
        </Pressable>
      ) : null}
    </View>
  );
}
