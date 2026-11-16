import React from 'react';
import { Pressable, Text, View } from 'react-native';
import { Choice, T } from '../ui/primitives';
import { SearchBox } from '../ui/book-controls';
import { Icon, type IconName } from '../ui/Icon';
import { color as C, weight } from '../../theme/tokens';
import { grouped, plural } from '../../lib/format';
import type { AreaChoice } from '../../engines/lead-areas';
import {
  areaFacts,
  areaName,
  areaParent,
  nearLabel,
  searchAreas,
  suggestAreas,
  type AreaFacts,
  type BookPlace,
} from '../../engines/area-picker';
import { bookPlaceCounts, bookPlacesNear, recentAreaKeys } from '../../data/lead-areas';
import { recentFix } from '../../native/where';

/**
 * THE AREA ON THE NEW LEAD FORM.
 *
 * A handful of areas are still chips, because one tap beats two. Past
 * `CHIP_LIMIT` the field becomes a single row that opens `AreaPickerPage` —
 * search first, his nearest areas offered before he types, the list capped
 * and the rest counted. See `engines/area-picker.ts` for the ordering.
 *
 * The page is drawn INSIDE the form's own sheet rather than as a second sheet
 * over it: the app never stacks two, and closing the form to open a picker
 * would animate the half-typed lead away and back for one tap.
 */

/** At or below this many, every area is a chip on the form. */
export const CHIP_LIMIT = 8;

export function AreaField({
  choices,
  picked,
  onPick,
  onOpen,
}: {
  choices: AreaChoice[];
  picked: AreaChoice | null;
  onPick: (a: AreaChoice) => void;
  onOpen: () => void;
}) {
  if (choices.length <= CHIP_LIMIT) {
    return (
      <View style={{ paddingVertical: 12 }}>
        <AreaLabel />
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 8 }}>
          {choices.map((a) => (
            <Choice
              key={a.key}
              label={a.label}
              selected={picked?.key === a.key}
              onPress={() => onPick(a)}
              style={{ paddingHorizontal: 14 }}
            />
          ))}
        </View>
      </View>
    );
  }
  const parent = picked ? areaParent(picked) : null;
  /* V3 draws the area as one row of the form's card: the pin, the label, the
     name in bold with where it belongs under it, and a Change pill. */
  return (
    <Pressable
      onPress={onOpen}
      accessibilityRole="button"
      accessibilityLabel={picked ? `Area: ${picked.label}. Change it` : 'Choose the area'}
      style={({ pressed }) => ({
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
        minHeight: 60,
        paddingVertical: 8,
        backgroundColor: pressed ? C.wash : 'transparent',
      })}>
      <Icon name="pin" size={20} color={picked ? C.primaryDeep : C.muted} strokeWidth={2} />
      <View style={{ flex: 1, minWidth: 0 }}>
        <AreaLabel />
        {picked ? (
          <>
            <T numberOfLines={1} style={[{ fontSize: 16, lineHeight: 21, color: C.ink }, weight(700)]}>
              {areaName(picked)}
            </T>
            {parent ? (
              <T numberOfLines={1} style={{ fontSize: 12, lineHeight: 16, color: C.muted }}>
                {parent}
              </T>
            ) : null}
          </>
        ) : (
          <>
            <T style={{ fontSize: 16, lineHeight: 21, color: C.faint }}>Choose the area</T>
            <T style={{ fontSize: 12, lineHeight: 16, color: C.muted }}>{`Search your ${grouped(choices.length)} areas`}</T>
          </>
        )}
      </View>
      <View
        style={{
          height: 32,
          paddingHorizontal: 12,
          borderRadius: 16,
          backgroundColor: C.primaryTint,
          alignItems: 'center',
          justifyContent: 'center',
        }}>
        <T style={[{ fontSize: 12, color: C.primaryDeep }, weight(700)]}>{picked ? 'Change' : 'Choose'}</T>
      </View>
    </Pressable>
  );
}

/** "Area *" — the 11-point label the form rows carry, the star in red. */
function AreaLabel() {
  return (
    <T style={{ fontSize: 11, lineHeight: 15, color: C.faint }}>
      {'Area'}
      <T style={{ fontSize: 11, color: C.danger }}>{' *'}</T>
    </T>
  );
}

type Loaded = {
  book: BookPlace[];
  nearby: BookPlace[];
  recent: string[];
  fix: { lat: number; lng: number } | null;
};

export function AreaPickerPage({
  choices,
  pickedKey,
  onPick,
  onBack,
}: {
  choices: AreaChoice[];
  pickedKey: string | null;
  onPick: (a: AreaChoice) => void;
  onBack: () => void;
}) {
  const [loaded, setLoaded] = React.useState<Loaded | null>(null);
  const [query, setQuery] = React.useState('');

  React.useEffect(() => {
    let alive = true;
    void (async () => {
      const [book, recent, fix] = await Promise.all([
        bookPlaceCounts().catch(() => [] as BookPlace[]),
        recentAreaKeys(),
        recentFix().catch(() => null),
      ]);
      const nearby = fix ? await bookPlacesNear(fix).catch(() => [] as BookPlace[]) : [];
      if (alive) setLoaded({ book, nearby, recent, fix });
    })();
    return () => {
      alive = false;
    };
  }, []);

  const facts = React.useMemo(
    () => areaFacts(choices, loaded?.book ?? [], loaded?.fix ?? null, loaded?.nearby ?? []),
    [choices, loaded],
  );
  const suggested = React.useMemo(
    () => (loaded ? suggestAreas(choices, facts, loaded.recent) : []),
    [choices, facts, loaded],
  );
  const found = React.useMemo(() => searchAreas(choices, facts, query), [choices, facts, query]);
  const asking = query.trim().length > 0;

  return (
    <View>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 12 }}>
        <Pressable
          onPress={onBack}
          accessibilityRole="button"
          accessibilityLabel="Back to the lead"
          style={({ pressed }) => ({
            width: 44,
            height: 44,
            borderRadius: 22,
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: pressed ? C.hairline : C.wash,
          })}>
          <Icon name="back" size={20} color={C.ink} strokeWidth={2} />
        </Pressable>
        <View style={{ flex: 1 }}>
          <Text accessibilityRole="header" style={[{ fontSize: 18, lineHeight: 23, color: C.ink }, weight(800)]}>
            Which area?
          </Text>
          <T style={{ fontSize: 12, lineHeight: 16, color: C.muted }}>{plural(choices.length, 'area') + ' are yours'}</T>
        </View>
      </View>

      {/* Focused straight away only where there is nothing to offer first —
          with suggestions on the screen the keyboard would cover the answer. */}
      <View style={{ flexDirection: 'row', marginBottom: 8 }}>
        <SearchBox
          /* `autoFocus` is read on mount, and the suggestions arrive after it —
             so the box mounts again once they have, keeping what was typed. */
          key={loaded ? 'ready' : 'loading'}
          value={query}
          onChange={setQuery}
          onClear={() => setQuery('')}
          placeholder="Type the place name"
          bg={C.wash}
          autoFocus={loaded != null && suggested.length === 0}
        />
      </View>

      {!asking && suggested.length > 0 ? (
        <>
          <PickerHead
            icon={suggested[0].why === 'near' ? 'locate' : 'clock'}
            label={suggested[0].why === 'near' ? 'Near you' : 'Recently used'}
          />
          {suggested.map((s, i) => (
            <React.Fragment key={'s' + s.choice.key}>
              {i > 0 && s.why === 'recent' && suggested[i - 1].why === 'near' ? (
                <PickerHead icon="clock" label="Recently used" />
              ) : null}
              <AreaRow
                choice={s.choice}
                facts={facts.get(s.choice.key)}
                picked={pickedKey === s.choice.key}
                nearM={s.nearM}
                onPress={() => onPick(s.choice)}
              />
            </React.Fragment>
          ))}
          <PickerHead label="All your areas" />
        </>
      ) : null}

      {found.total === 0 ? (
        <T style={{ paddingVertical: 16, fontSize: 13, lineHeight: 19, color: C.muted }}>
          {`No area of yours is called “${query.trim()}”. A lead can only be added in your own area. If this shop should be yours, ask the office to add the area.`}
        </T>
      ) : (
        found.rows.map((c) => (
          <AreaRow
            key={c.key}
            choice={c}
            facts={facts.get(c.key)}
            picked={pickedKey === c.key}
            nearM={null}
            onPress={() => onPick(c)}
          />
        ))
      )}

      {found.total > found.rows.length ? (
        <T style={{ paddingTop: 12, textAlign: 'center', fontSize: 12, lineHeight: 17, color: C.muted }}>
          {`Showing ${grouped(found.rows.length)} of ${grouped(found.total)}. Type more of the name to find the rest.`}
        </T>
      ) : null}
    </View>
  );
}

function AreaRow({
  choice,
  facts,
  picked,
  nearM,
  onPress,
}: {
  choice: AreaChoice;
  facts: AreaFacts | undefined;
  picked: boolean;
  nearM: number | null;
  onPress: () => void;
}) {
  const parent = areaParent(choice);
  const shops = facts?.shops;
  /* What kind of place it is, in words: a state asks for the town next, and
     saying so here saves the surprise of a second question after the tap. */
  const sub = [
    /* Plain words, not the office's: "beat" is what the territory screen
       calls a part of a town, and a salesman reading it on a phone does not. */
    choice.area
      ? parent
        ? `Part of ${parent}`
        : 'Part of a town'
      : choice.city
        ? parent
          ? `Town in ${parent}`
          : 'Town'
        : 'Whole state · you will type the town next',
    shops ? `${grouped(shops)} of your shops` : null,
  ]
    .filter(Boolean)
    .join(' · ');
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="radio"
      accessibilityState={{ selected: picked }}
      style={({ pressed }) => ({
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
        minHeight: 52,
        paddingVertical: 8,
        paddingHorizontal: 4,
        borderBottomWidth: 1,
        borderBottomColor: C.hairline,
        backgroundColor: pressed ? C.wash : picked ? C.primaryTint : 'transparent',
      })}>
      <View style={{ flex: 1, minWidth: 0 }}>
        <T numberOfLines={1} style={[{ fontSize: 15, lineHeight: 20, color: C.ink }, weight(picked ? 700 : 600)]}>
          {areaName(choice)}
        </T>
        <T numberOfLines={1} style={{ fontSize: 12, lineHeight: 16, color: C.muted }}>
          {sub}
        </T>
      </View>
      {nearM != null ? (
        <T style={[{ fontSize: 12, color: C.primaryDeep }, weight(700)]}>{nearLabel(nearM)}</T>
      ) : null}
      {picked ? <Icon name="tick" size={18} color={C.primaryDeep} strokeWidth={2.2} /> : null}
    </Pressable>
  );
}

/** A group heading in the picker — "Near you", "Recently used", "All your areas". */
function PickerHead({ icon, label }: { icon?: IconName; label: string }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 12, marginBottom: 2 }}>
      {icon ? <Icon name={icon} size={14} color={icon === 'locate' ? C.primaryDeep : C.muted} strokeWidth={2.2} /> : null}
      <Text accessibilityRole="header" style={[{ fontSize: 12, color: C.ink }, weight(700)]}>
        {label}
      </Text>
    </View>
  );
}
