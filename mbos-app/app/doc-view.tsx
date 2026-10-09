import React from 'react';
import { ActivityIndicator, FlatList, Image, PixelRatio, Pressable, ScrollView, View, type ViewToken } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { AppFrame, BackLink, useCameFrom } from '../src/components/shell/AppFrame';
import { Bar, Card, PrimaryButton, SecondaryButton, T } from '../src/components/ui/primitives';
import { Icon, type IconName } from '../src/components/ui/Icon';
import { color as C, radius, weight } from '../src/theme/tokens';
import {
  downloadDocument,
  forgetDocumentFile,
  getDocument,
  heldFile,
  mediaTypeOf,
  openDocumentFile,
  type DocumentRow,
} from '../src/data/library';
import { categoryLabel, fileBadge, fileKind } from '../src/lib/library-view';
import { pdfPageCount, pdfPreviewAvailable, renderPdfPage } from '../src/native/pdf-preview';
import { useStore } from '../src/state/store';
import { dmy, isoDate } from '../src/lib/format';

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
 * **"Open in another app" is always there**, because a person may want to
 * share it on WhatsApp or print it, and because a build without the viewer —
 * an APK from before it shipped — still needs a way to the file.
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

  return (
    <AppFrame title="Document" activeTab={null} onBack={back.go} scroll={false}>
      <View style={{ paddingHorizontal: 16, paddingTop: 12, paddingBottom: 12 }}>
        <BackLink label={back.label} onPress={back.go} />
        <T style={[{ fontSize: 19, lineHeight: 25, color: C.ink }, weight(600)]} numberOfLines={2}>
          {doc?.title ?? (phase.at === 'gone' ? 'Not available' : ' ')}
        </T>
        {meta ? (
          <T s="caption" style={{ marginTop: 2 }} numberOfLines={1}>
            {meta}
          </T>
        ) : null}
      </View>

      <View style={{ flex: 1, backgroundColor: C.hairline, borderTopWidth: 1, borderTopColor: C.border }}>
        {phase.at === 'loading' ? (
          <Centre>
            <ActivityIndicator color={C.primary} />
          </Centre>
        ) : phase.at === 'gone' ? (
          <Message
            title="This document is not on your phone any more"
            body="The office may have withdrawn it, or narrowed who it is for. Go back to Documents for what is there now."
          />
        ) : phase.at === 'downloading' ? (
          <Centre>
            <Card style={{ width: '100%', maxWidth: 360 }}>
              <T style={[{ fontSize: 15, color: C.ink }, weight(600)]}>Downloading</T>
              <T s="small" style={{ color: C.muted, marginTop: 2, marginBottom: 12 }}>
                {phase.fraction == null
                  ? 'Starting…'
                  : `${Math.round(phase.fraction * 100)}%${doc?.sizeLabel ? ` of ${doc.sizeLabel}` : ''}`}
                {' · '}once it is here it opens without signal
              </T>
              <Bar pct={Math.round((phase.fraction ?? 0) * 100)} fill={C.primary} />
            </Card>
          </Centre>
        ) : phase.at === 'failed' ? (
          <Message title="Could not download it" body={phase.reason}>
            <PrimaryButton label="Try again" fullWidth={false} onPress={() => setAttempt((n) => n + 1)} />
          </Message>
        ) : (
          <Viewer uri={phase.uri} kind={phase.kind ?? mediaTypeOf({ kind: null }, phase.uri)} onOpenElsewhere={openElsewhere} />
        )}
      </View>

      {phase.at === 'ready' ? (
        <View
          style={{
            flexDirection: 'row',
            gap: 10,
            paddingHorizontal: 16,
            paddingTop: 10,
            paddingBottom: 12,
            borderTopWidth: 1,
            borderTopColor: C.border,
            backgroundColor: C.surface,
          }}>
          <SecondaryButton label="Open in another app" onPress={() => void openElsewhere()} />
        </View>
      ) : null}
    </AppFrame>
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
      <Message title="This file cannot be shown here" body="Phones can show PDFs and pictures. Open it in another app instead.">
        <PrimaryButton label="Open in another app" fullWidth={false} onPress={onOpenElsewhere} />
      </Message>
    );
  }
  if (what === 'pdf' && !pdfPreviewAvailable) {
    return (
      <Message
        title="Update the app to read PDFs here"
        body="This version cannot draw PDFs itself. Open it in another app for now — the next update reads them inside MBOS.">
        <PrimaryButton label="Open in another app" fullWidth={false} onPress={onOpenElsewhere} />
      </Message>
    );
  }
  if (problem) {
    return (
      <Message title="This PDF cannot be shown here" body={problem}>
        <PrimaryButton label="Open in another app" fullWidth={false} onPress={onOpenElsewhere} />
      </Message>
    );
  }
  if (pages == null) {
    return (
      <Centre>
        <ActivityIndicator color={C.primary} />
      </Centre>
    );
  }
  return <Pages uri={uri} count={pages} image={what === 'image'} />;
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

      {/* What page, and the zoom — floating over the desk, never over the paper's edge. */}
      <View
        pointerEvents="box-none"
        style={{ position: 'absolute', left: 0, right: 0, bottom: 12, alignItems: 'center' }}>
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            gap: 4,
            paddingHorizontal: 6,
            paddingVertical: 4,
            borderRadius: radius.pill,
            backgroundColor: 'rgba(22,22,22,0.82)',
          }}>
          <RoundButton
            icon="zoomOut"
            label="Zoom out"
            disabled={zoomAt === 0}
            onPress={() => setZoomAt((z) => Math.max(0, z - 1))}
          />
          <T style={[{ fontSize: 13, color: C.surface, minWidth: 64, textAlign: 'center' }, weight(500)]}>
            {count > 1 ? `${current} / ${count}` : `${Math.round(zoom * 100)}%`}
          </T>
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
        width: 36,
        height: 36,
        borderRadius: 18,
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
        borderRadius: 4,
        borderWidth: 1,
        borderColor: C.border,
        overflow: 'hidden',
        boxShadow: '0 1px 2px rgba(22,22,22,0.06), 0 6px 16px -8px rgba(22,22,22,0.18)',
      }}>
      {drawn ? (
        <Image source={{ uri: drawn.uri }} style={{ width: '100%', height: '100%' }} resizeMode="contain" fadeDuration={0} />
      ) : failed ? (
        <Centre>
          <T s="small" style={{ color: C.muted, textAlign: 'center' }}>
            {failed}
          </T>
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

function Message({ title, body, children }: { title: string; body: string; children?: React.ReactNode }) {
  return (
    <Centre>
      <Card style={{ width: '100%', maxWidth: 380, alignItems: 'center', paddingVertical: 24 }}>
        <Icon name="doc" size={28} color={C.muted} />
        <T style={[{ fontSize: 16, color: C.ink, textAlign: 'center', marginTop: 10 }, weight(600)]}>{title}</T>
        <T s="small" style={{ color: C.muted, textAlign: 'center', marginTop: 4, marginBottom: children ? 14 : 0 }}>
          {body}
        </T>
        {children}
      </Card>
    </Centre>
  );
}
