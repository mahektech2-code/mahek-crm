import React from 'react';
import { View, Pressable } from 'react-native';
import { useFocusEffect } from 'expo-router';
import { AppFrame, BackLink, useCameFrom } from '../src/components/shell/AppFrame';
import { Badge, Bar, Card, ListCard, SectionLabel, T } from '../src/components/ui/primitives';
import { ConfirmSheet } from '../src/components/ui/overlays';
import { Icon } from '../src/components/ui/Icon';
import { color as C, HIT, radius, weight } from '../src/theme/tokens';
import { dataSize, isoDate, plural, pretty } from '../src/lib/format';
import { useStore } from '../src/state/store';
import {
  downloadBlockedBecause,
  listAreas,
  pauseMap,
  refreshMap,
  removeMap,
  resumeMap,
  resumeUnfinished,
  saveArea,
  watchMap,
  type AreaListing,
  type OfflineArea,
  type SavedMap,
} from '../src/data/offline-maps';
import type { OfflinePackStatus } from '@maplibre/maplibre-react-native';

/**
 * Maps kept on the phone, so the map still draws in a market with no signal.
 *
 * The whole feature in one screen: the places this salesman actually works,
 * what each would cost to keep, and the state of the ones he already has.
 *
 * **THE SIZE IS ON THE ROW BEFORE THE BUTTON IS PRESSED, always.** These are
 * the largest downloads this app will ever ask anybody for — several hundred
 * megabytes, on a phone that also has to hold photographs of cheques — and a
 * progress bar that appears after the decision is not a decision. It is an
 * estimate and it says so; the number it is right about is the order of
 * magnitude, which is the one the answer turns on.
 *
 * **A PLACE IS NOT A DISTRICT.** The rows come from the book — see
 * `engines/tiles.ts` — so a salesman is offered the towns he calls on rather
 * than an administrative boundary drawn for revenue collection, most of which
 * is fields with no shop in it.
 *
 * **NOTHING HERE DELETES ANYTHING ON ITS OWN.** Not a pack for an area that
 * has left his book, not a pack that has gone stale, not a pack that failed
 * half-way. Every one of those is offered with what it is and a way to remove
 * it, because the storage is his and taking back three hundred megabytes
 * without being asked is the kind of helpfulness nobody thanks you for.
 */

type Live = Record<string, OfflinePackStatus>;

export default function MapsScreen() {
  const back = useCameFrom('more');
  const notify = useStore((s) => s.notify);

  const [listing, setListing] = React.useState<AreaListing | null>(null);
  /*
   * WHEN the listing was read. "Saved 3 days ago" needs a clock and reading
   * one during render is impure — the React Compiler rules this app runs under
   * forbid it, and `use-ticker.ts` exists for the screens that genuinely have
   * to count. This one does not: an age in whole days does not change while
   * somebody is looking at it, so the clock is read once, where the data is.
   */
  const [readAt, setReadAt] = React.useState(() => Date.now());
  const [blocked, setBlocked] = React.useState<string | null>(null);
  const [live, setLive] = React.useState<Live>({});
  const [confirm, setConfirm] = React.useState<{ id: string; label: string } | null>(null);
  /*
   * A DOWNLOAD THAT STOPPED ON AN ERROR, by row.
   *
   * Two things were wrong and they compounded. MapLibre's own English message
   * was toasted straight at somebody standing in a market — the `catch` around
   * starting a pack deliberately refuses to quote a reason for exactly that
   * reason, and the progress callback did it anyway. And the row's state is
   * derived from `status.state !== 'complete'` alone, so a failed pack sits
   * `inactive` and draws a stalled bar at 34% with a Resume button and the
   * word "Paused" — indistinguishable from a download somebody stopped
   * themselves, with the toast long gone by the time he looks.
   */
  const [failed, setFailed] = React.useState<Record<string, true>>({});
  const clearFailure = React.useCallback((key: string) => {
    setFailed((f) => {
      if (!f[key]) return f;
      const next = { ...f };
      delete next[key];
      return next;
    });
  }, []);

  /*
   * DROP THE LAST PROGRESS EVENT FOR A PACK THAT HAS STOPPED.
   *
   * The row reads `live[id] ?? saved.status`, and a paused pack sends nothing
   * further — so the last `active` event it ever sent went on drawing a moving
   * bar and a "Pause" button over a download that had already stopped. Dropped,
   * the row falls back to the status the reload reads off the pack itself.
   */
  const forget = React.useCallback((ids: string[]) => {
    setLive((l) => {
      const next = { ...l };
      ids.forEach((id) => delete next[id]);
      return next;
    });
  }, []);

  const load = React.useCallback(() => {
    let alive = true;
    void listAreas().then(async (l) => {
      if (!alive) return;
      setListing(l);
      setReadAt(Date.now());
      setBlocked(await downloadBlockedBecause(l.settings));
    });
    return () => {
      alive = false;
    };
  }, []);

  useFocusEffect(load);

  /*
   * Follow every download that is already running, and pick up the ones the
   * app was killed part-way through. A few hundred megabytes does not finish
   * in one sitting, and without the resume a pack sits at 60% for ever with
   * the same number on the screen every time somebody opens it.
   */
  React.useEffect(() => {
    if (!listing) return;
    let alive = true;
    const stops: (() => void)[] = [];

    /* `row` is the AREA this pack answers for, which is what the failure has
       to be drawn against — the pack id alone could not find the row again. */
    const follow = (id: string, row: string) => {
      void watchMap(
        id,
        (status) => {
          if (!alive) return;
          setLive((l) => ({ ...l, [id]: status }));
          /* Progress after a failure means it is going again. */
          if (status.state === 'active') clearFailure(row);
        },
        () => alive && setFailed((f) => ({ ...f, [row]: true })),
      ).then((stop) => {
        if (alive) stops.push(stop);
        else stop();
      });
    };

    const packs: { pack: SavedMap; row: string }[] = [];
    for (const a of listing.areas) if (a.saved) packs.push({ pack: a.saved, row: a.id });
    for (const p of listing.orphans) packs.push({ pack: p, row: p.id });
    const unfinished = packs.filter(
      ({ pack }) => pack.status && pack.status.state !== 'complete',
    );

    unfinished.forEach(({ pack, row }) => follow(pack.id, row));
    if (unfinished.length) void resumeUnfinished();

    return () => {
      alive = false;
      stops.forEach((stop) => stop());
    };
    /* The list is what decides who to follow; `clearFailure` is stable. */
  }, [listing, clearFailure]);

  /*
   * PAUSING HAS TO STICK, and it did not.
   *
   * `pauseMap` then `load()` sets a new listing, the effect above re-runs on it,
   * every pack short of complete counts as unfinished — a paused one does — and
   * `resumeUnfinished` started it again within about a second. `useFocusEffect`
   * did the same on every visit to the screen. So the bar kept climbing after
   * he pressed Pause, and because the only control that abandons a download
   * draws while it is paused, undoing the pause took that away too. The pause
   * is recorded in `pauseMap` now and `resumeUnfinished` skips what he stopped.
   */
  const pause = React.useCallback(
    (id: string) => {
      void pauseMap(id)
        .then(() => {
          forget([id]);
          load();
        })
        .catch(() => notify('That download would not stop. Try again in a moment.'));
    },
    [forget, load, notify],
  );

  const start = async (area: OfflineArea) => {
    if (!listing) return;
    /* Asked AGAIN here rather than trusting what the card is showing. The card
       was right when the screen loaded; a salesman walks out of the office
       between reading it and pressing this, and the whole point of the Wi-Fi
       rule is that it is his data allowance being spent. */
    const reason = await downloadBlockedBecause(listing.settings);
    if (reason) {
      setBlocked(reason);
      return notify(reason);
    }
    setBlocked(null);
    if (area.tooBig) return notify(tooBigSentence(area, listing));

    clearFailure(area.id);
    try {
      /* Keyed off the status's OWN id rather than the one `saveArea` is about
         to return: a progress event can arrive before the promise settles, and
         the returned binding does not exist yet when it does. */
      await saveArea(
        area,
        (status) => setLive((l) => ({ ...l, [status.id]: status })),
        /* The reason is MapLibre's own English and is not worth quoting at
           somebody in a market — the same judgement the `catch` below makes.
           What is worth saying is that it stopped, and it is said on the row
           rather than in a toast he has already looked away from. */
        () => setFailed((f) => ({ ...f, [area.id]: true })),
      );
      notify(`Saving ${area.label} — you can leave this screen.`);
      load();
    } catch {
      /* A refusal from MapLibre, a style that would not load, storage that is
         full. The reason is not worth quoting at somebody in a market; what is
         worth saying is that nothing was saved and the button still works. */
      notify('Could not start the download. Try again on a better connection.');
    }
  };

  const settings = listing?.settings;

  /* Which packs are actually moving, by pack id. Read from the live status
     where there is one and from the listing's own otherwise. */
  const downloading = React.useMemo(() => {
    const out: string[] = [];
    const add = (p: SavedMap | null | undefined) => {
      if (!p) return;
      const st = live[p.id] ?? p.status;
      if (st && st.state !== 'complete' && st.percentage < 100) out.push(p.id);
    };
    listing?.areas.forEach((a) => add(a.saved));
    listing?.orphans.forEach(add);
    return out;
  }, [listing, live]);

  /* Read inside the network listener, so a fix every few seconds of progress
     does not tear down and rebuild the subscription. */
  const downloadingRef = React.useRef<string[]>([]);
  downloadingRef.current = downloading;
  const anyDownloading = downloading.length > 0;
  const wifiOnly = Boolean(settings?.wifiOnly);

  /*
   * WI-FI ONLY HAS TO HOLD AFTER THE DOWNLOAD STARTS, and it held only before.
   *
   * The rule was asked twice — when the screen loads, and again as Save is
   * pressed — and then never again: once MapLibre is fetching tiles there is
   * no network constraint on the pack anywhere, so several hundred megabytes
   * carries straight on when he walks out of the office onto mobile data. The
   * card at the top of this screen promises the opposite in as many words:
   * "Save the places you work once, on Wi-Fi". It is his data allowance, and a
   * promise the screen makes has to survive the walk to the door.
   *
   * Pausing is the whole intervention — the pack keeps what it has downloaded
   * and picks up where it stopped, and `resumeUnfinished` refuses to restart it
   * while the phone is still on mobile data, so it stays stopped until there is
   * Wi-Fi again.
   */
  React.useEffect(() => {
    if (!anyDownloading || !wifiOnly) return;
    let alive = true;
    let off: (() => void) | undefined;

    void import('@react-native-community/netinfo').then(({ default: NetInfo }) => {
      if (!alive) return;
      off = NetInfo.addEventListener((state) => {
        /* An unknown or absent connection is left alone, exactly as
           `downloadBlockedBecause` leaves it alone: a download with no
           connection is spending nothing, and stopping somebody over a network
           type the phone would not name is a dead end he cannot get out of. */
        if (!alive || !state.isConnected || state.type === 'wifi') return;
        const ids = downloadingRef.current;
        if (!ids.length) return;
        setBlocked('Map downloads are set to Wi-Fi only, and this phone is on mobile data.');
        notify('Paused the map download — this phone is on mobile data.');
        /* `network`, not the salesman: this one is meant to pick up again the
           moment there is Wi-Fi, and a pause recorded as his own would never be
           resumed by anything. */
        void Promise.all(ids.map((id) => pauseMap(id, 'network').catch(() => undefined))).then(() => {
          if (!alive) return;
          forget(ids);
          load();
        });
      });
    });

    return () => {
      alive = false;
      off?.();
    };
  }, [anyDownloading, wifiOnly, notify, load, forget]);

  return (
    <AppFrame
      title="Offline maps"
      activeTab={null}
      onBack={back.go}
      contentStyle={{ padding: 16, paddingBottom: 24 }}>
      <BackLink label={back.label} onPress={back.go} />

      <Card>
        <T style={[{ fontSize: 15, color: C.ink }, weight(600)]}>
          Save the streets before you need them
        </T>
        <T s="small" style={{ color: C.muted, marginTop: 4 }}>
          A saved map draws with no signal at all. Save the places you work once,
          on Wi-Fi, and the market lanes are there when the phone has nothing.
        </T>
        {blocked ? (
          <View
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              gap: 8,
              marginTop: 12,
              padding: 12,
              borderRadius: radius.md,
              backgroundColor: C.warnBg,
            }}>
            <Icon name="clock" size={18} color={C.warnInk} strokeWidth={1.6} />
            <T s="small" style={{ flex: 1, color: C.warnInk }}>
              {blocked}
            </T>
          </View>
        ) : null}
      </Card>

      {listing === null ? (
        <T s="caption" style={{ marginTop: 16, textAlign: 'center' }}>
          Working out what is worth saving…
        </T>
      ) : null}

      {listing && !listing.areas.length ? (
        <Card style={{ marginTop: 12 }}>
          <T s="small" style={{ color: C.muted }}>
            {listing.unpinned
              ? `None of your ${listing.unpinned} shops has a location on it yet, so there is nowhere to save a map of. Capture a location while you are standing in one and its area appears here.`
              : 'There are no shops on this phone yet. Sync, and the places you work appear here.'}
          </T>
        </Card>
      ) : null}

      {listing?.areas.length ? (
        <>
          <SectionLabel style={{ marginTop: 20, marginBottom: 8 }}>
            {plural(listing.areas.length, 'place')} you work
          </SectionLabel>
          <ListCard>
            {listing.areas.map((area, i) => (
              <AreaRow
                key={area.id}
                area={area}
                first={i === 0}
                status={area.saved ? live[area.saved.id] ?? area.saved.status : undefined}
                staleAfterDays={settings?.refreshAfterDays ?? 120}
                readAt={readAt}
                onSave={() => void start(area)}
                onPause={() => area.saved && pause(area.saved.id)}
                onResume={() => area.saved && void resumeMap(area.saved.id).then(load)}
                onRefresh={() => {
                  if (!area.saved) return;
                  void refreshMap(area.saved.id).then(() => {
                    notify('Checking the saved map against the server');
                    load();
                  });
                }}
                onRemove={() =>
                  area.saved && setConfirm({ id: area.saved.id, label: area.label })
                }
                tooBigSentence={tooBigSentence(area, listing)}
              />
            ))}
          </ListCard>
        </>
      ) : null}

      {/* SHOPS NO MAP CAN HELP WITH. Said here as well as on the map itself,
          because this is the screen somebody is on when they are thinking
          about coverage, and a place missing from the list above with no
          explanation reads as a broken list. */}
      {listing?.unpinned ? (
        <T s="caption" style={{ marginTop: 10 }}>
          {`${plural(listing.unpinned, 'shop')} in your book has no location on it, so it is in none of these areas.`}
        </T>
      ) : null}

      {listing?.orphans.length ? (
        <>
          <SectionLabel style={{ marginTop: 24, marginBottom: 8 }}>
            Saved, but not for anywhere you work now
          </SectionLabel>
          <ListCard>
            {listing.orphans.map((pack, i) => (
              <View
                key={pack.id}
                style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: 12,
                  paddingHorizontal: 16,
                  paddingVertical: 14,
                  borderTopWidth: i ? 1 : 0,
                  borderTopColor: C.wash,
                }}>
                <View style={{ flex: 1, minWidth: 0 }}>
                  <T style={{ fontSize: 15, color: C.ink }}>{pack.label}</T>
                  <T s="caption">
                    {[
                      dataSize(pack.status?.completedResourceSize),
                      pack.savedAt ? 'saved ' + pretty(isoDate(new Date(pack.savedAt))) : null,
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </T>
                </View>
                <RowButton label="Remove" onPress={() => setConfirm({ id: pack.id, label: pack.label })} />
              </View>
            ))}
          </ListCard>
          <T s="caption" style={{ marginTop: 8 }}>
            No shop in your book is inside these any more. Nothing has been
            deleted — the space comes back when you remove one.
          </T>
        </>
      ) : null}

      {settings ? (
        <T s="caption" style={{ marginTop: 24, textAlign: 'center' }}>
          {`Saved down to zoom ${settings.maxZoom} — close enough to read a lane name. Sizes are estimates.`}
        </T>
      ) : null}

      <ConfirmSheet
        open={confirm !== null}
        title={`Remove ${confirm?.label ?? ''}?`}
        body="The streets stop drawing there without signal. Nothing else changes — your shops, visits and orders are untouched, and you can save it again on Wi-Fi."
        confirmLabel="Remove"
        reason=""
        onReason={() => {}}
        error={false}
        onCancel={() => setConfirm(null)}
        onConfirm={() => {
          const id = confirm?.id;
          setConfirm(null);
          if (!id) return;
          void removeMap(id).then(() => {
            notify('Removed');
            load();
          });
        }}
      />
    </AppFrame>
  );
}

/* -------------------------------------------------------------------- row */

function AreaRow({
  area,
  first,
  status,
  staleAfterDays,
  readAt,
  onSave,
  onPause,
  onResume,
  onRefresh,
  onRemove,
  tooBigSentence: whyTooBig,
}: {
  area: OfflineArea;
  first: boolean;
  status: OfflinePackStatus | null | undefined;
  staleAfterDays: number;
  /** The clock, read once where the data was. Never read during render. */
  readAt: number;
  onSave: () => void;
  onPause: () => void;
  onResume: () => void;
  onRefresh: () => void;
  onRemove: () => void;
  tooBigSentence: string;
}) {
  const saved = area.saved;
  const downloading = status ? status.state !== 'complete' && status.percentage < 100 : false;
  const running = downloading && status?.state === 'active';
  const complete = Boolean(saved) && !downloading;

  const ageDays =
    saved?.savedAt != null ? Math.floor((readAt - saved.savedAt) / 86_400_000) : null;
  const stale = ageDays != null && ageDays > staleAfterDays;

  return (
    <View
      style={{
        paddingHorizontal: 16,
        paddingVertical: 14,
        borderTopWidth: first ? 0 : 1,
        borderTopColor: C.wash,
      }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
        <View style={{ flex: 1, minWidth: 0 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <T style={{ flexShrink: 1, fontSize: 15, color: C.ink }} numberOfLines={1}>
              {area.label}
            </T>
            {complete && area.coverage.state === 'full' ? <Badge tone="success">Saved</Badge> : null}
            {complete && area.coverage.state === 'partial' ? <Badge tone="amber">Part saved</Badge> : null}
            {downloading ? <Badge tone="info">Saving</Badge> : null}
            {complete && stale ? <Badge tone="amber">Old</Badge> : null}
          </View>
          <T s="caption">
            {describe(area, status, ageDays)}
          </T>
        </View>

        {/* ONE action on the row, and it is the obvious one for the state it
            is in. Four buttons side by side is how somebody deletes a
            download they meant to pause — everything else earns its place on
            a line of its own, beneath, with a sentence saying why it is
            there. */}
        {!saved ? (
          <RowButton
            label={area.tooBig ? 'Too big' : 'Save'}
            tone={area.tooBig ? 'muted' : 'primary'}
            onPress={onSave}
          />
        ) : downloading ? (
          <RowButton
            label={running ? 'Pause' : 'Resume'}
            onPress={running ? onPause : onResume}
          />
        ) : (
          <RowButton label="Remove" onPress={onRemove} />
        )}
      </View>

      {downloading && status ? (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 10 }}>
          <Bar pct={status.percentage} fill={C.primary} />
          <T s="caption" style={{ width: 42, textAlign: 'right' }}>
            {Math.round(status.percentage)}%
          </T>
        </View>
      ) : null}

      {/* WHY IT CANNOT BE SAVED, on the row rather than in a toast somebody
          has already looked away from. A disabled control with no reason is
          the thing this app's own button primitive exists to prevent. */}
      {area.tooBig && !saved ? (
        <T s="caption" style={{ marginTop: 8, color: C.warnInk }}>
          {whyTooBig}
        </T>
      ) : null}

      {/* A DOWNLOAD SOMEBODY WANTS TO ABANDON, in either state.
          It was drawn only while the download was PAUSED, on the reasoning
          that a Remove beside a running one is the mis-tap that throws away
          twenty minutes of somebody's Wi-Fi. The mis-tap is real and is
          answered by the confirmation this opens; what the rule actually did
          was hide the only way out behind a pause that immediately undid
          itself, so there was no reachable way to stop several hundred
          megabytes at all. It stays off the row itself — the one button there
          is still Pause or Resume — and sits on its own line with the sentence
          that says which state it is in. */}
      {downloading ? (
        <Secondary
          sentence={
            running
              ? 'Saving now. Removing it stops the download and gives the space back.'
              : 'Paused. It picks up where it stopped.'
          }
          label="Remove"
          onPress={onRemove}
        />
      ) : null}

      {/* A saved map the book has grown past. Not an error — the pack still
          works for most of the area — but it is the one thing on this screen
          somebody would otherwise discover by finding a blank patch. */}
      {complete && area.coverage.state === 'partial' ? (
        <Secondary
          sentence={`${plural(area.coverage.outside, 'shop')} here fell outside what was saved — the book has grown since.`}
          label="Save again"
          tone="primary"
          note="warn"
          onPress={onSave}
        />
      ) : null}

      {/* OLD IS A NUDGE, NEVER AN EXPIRY. Nothing has stopped working and
          nothing is deleted; refreshing re-checks each tile against the
          server and fetches only what actually changed, which is why it is
          worth offering at all. */}
      {complete && stale ? (
        <Secondary
          sentence="Roads change slowly, and a refresh only fetches what actually changed."
          label="Refresh"
          onPress={onRefresh}
        />
      ) : null}
    </View>
  );
}

/** What this row is, in one line, whatever state it is in. */
function describe(
  area: OfflineArea,
  status: OfflinePackStatus | null | undefined,
  ageDays: number | null,
): string {
  const shops = plural(area.shops, 'shop');

  if (!area.saved) return `${shops} · about ${dataSize(area.estimatedBytes)} to save`;

  const downloading = status ? status.state !== 'complete' && status.percentage < 100 : false;
  if (downloading && status) {
    return `${shops} · ${dataSize(status.completedResourceSize)} of about ${dataSize(area.estimatedBytes)}`;
  }

  const size = dataSize(status?.completedResourceSize ?? area.saved.status?.completedResourceSize);
  const age =
    ageDays == null
      ? null
      : ageDays < 1
        ? 'saved today'
        : `saved ${plural(ageDays, 'day')} ago`;

  return [shops, size, age].filter(Boolean).join(' · ');
}

/**
 * Why an area is refused, and what to do about it — which is somebody else's
 * job, so the sentence names it rather than leaving a dead end. Both routes
 * out are settings in the Admin Console, and neither is something a salesman
 * standing in a market can act on himself.
 */
function tooBigSentence(area: OfflineArea, listing: AreaListing | null): string {
  const ceiling = listing ? dataSize(listing.settings.maxPackBytes) : null;
  return `About ${dataSize(area.estimatedBytes)}, which is over the ${ceiling ?? 'limit'} a map may take on this phone. Ask the office to split this area or to save one zoom level less.`;
}

/**
 * A sentence and the one thing to do about it, under the row it belongs to.
 *
 * `note` decides whether the sentence is coloured as a gap or as a remark. A
 * paused download and a map a few months old are both ordinary; only shops
 * falling outside what was saved is something going wrong, and colouring all
 * three alike is how the one that matters stops being noticed.
 */
function Secondary({
  sentence,
  label,
  onPress,
  tone = 'muted',
  note = 'plain',
}: {
  sentence: string;
  label: string;
  onPress: () => void;
  tone?: 'muted' | 'primary';
  note?: 'plain' | 'warn';
}) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 8 }}>
      <T s="caption" style={{ flex: 1, color: note === 'warn' ? C.warnInk : C.muted }}>
        {sentence}
      </T>
      <RowButton label={label} tone={tone} onPress={onPress} />
    </View>
  );
}

function RowButton({
  label,
  onPress,
  tone = 'muted',
}: {
  label: string;
  onPress: () => void;
  tone?: 'muted' | 'primary';
}) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      style={({ pressed }) => [
        {
          height: 44,
          paddingHorizontal: 14,
          borderWidth: 1,
          borderColor: tone === 'primary' ? C.primaryEdge : C.border,
          backgroundColor: tone === 'primary' ? C.primaryTint : C.surface,
          borderRadius: radius.md,
          alignItems: 'center',
          justifyContent: 'center',
        },
        pressed && { backgroundColor: C.wash },
      ]}>
      <T style={[{ fontSize: 15, color: tone === 'primary' ? C.primaryDeep : C.body }, weight(500)]}>
        {label}
      </T>
    </Pressable>
  );
}
