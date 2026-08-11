# Porting contract

The design at `/Users/abhinabadas/Downloads/MBOS Field Sales.dc.html` is the source
of truth for layout, wording, colour and flow. Port it, do not redesign it.

## Non-negotiables

1. **Every string is the design's string.** Do not reword a label, a helper
   sentence or an empty state. The copy is the product.
2. **Every colour comes from `src/theme/tokens.ts`.** No hex literals in a screen.
   If a colour is not in the tokens file, you have misread the design.
3. **44px minimum on anything tappable, 48px where the design says so.** The
   design is explicit about this everywhere; keep it.
4. **No hardcoded data in a screen.** Everything comes from `src/data/fixtures.ts`
   or `src/state/store.ts`. This is what lets the real MahekOne data replace
   fixtures in one file later.
5. **`fontWeight` is never used.** Use `weight(400|500|600)` from tokens — React
   Native does not synthesise weights on Android.
6. **Money is formatted with `inr()`** from `src/lib/format.ts`, never by hand.

## What exists already

### `src/theme/tokens.ts`
- `color` — `primary primaryDeep primaryDark primaryTint primaryEdge lime ink body
  muted faint border hairline wash surface canvas success successBg warn warnInk
  warnBg warnEdge danger dangerBg info infoBg scrim scrimLight`
- `shadow` — `card soft primary primaryLift primaryDeep fab tabBar saveBar sheet
  toast dialog nextStop` (CSS strings; RN 0.86 supports the `boxShadow` style prop
  directly, so use `boxShadow: shadow.card`)
- `type` — `display h1 h2 h3 body bodyInk small caption micro label`
- `weight(400|500|600)`, `tabular`, `radius`, `HIT` (48), `BADGE`, `BadgeTone`

### `src/lib/format.ts`
`inr(n)` `plural(n, noun, form?)` `pretty(iso)` `dmy(iso)` `monthName(i)`
`isoDate(date)` `initialsOf(name)`

### `src/components/ui/primitives.tsx`
`T` `SectionLabel` `Card` `ListCard` `Badge` `HealthPill` `PrimaryButton`
`SecondaryButton` `DashedButton` `Choice` `Field` `Input` `Toggle` `Bar`
`Divider` `Row`

### `src/components/ui/overlays.tsx`
`Toast` `BottomSheet` `ActionSheet` `ConfirmSheet` `Calendar`

`Calendar` props: `selected onPick rangeFrom rangeTo disabledReason fixedWeeks`.
`disabledReason(iso)` returns a sentence to refuse a day, or `null` to allow it.

### `src/components/ui/Icon.tsx`
`<Icon name size color strokeWidth />`. Names available: `visit pin order money add
camera task sample call chat nav route share clock spark note doc clip close dots
home people grid back forward bell play tick search filter shop person mic finger
lock`.

### `src/components/shell/AppFrame.tsx`
```tsx
<AppFrame title="Tasks" activeTab={null} onBack={() => router.back()}
          contentStyle={{ padding: 16, paddingBottom: 24 }}>
  ...
</AppFrame>
```
It supplies the header, status strip, tab bar, `+` action sheet, the confirm
dialog and the toast. **Do not render any of those yourself.**

Also exports `useCameFrom(fallback)` → `{ from, label, go }` and `<BackLink
label onPress />` — the inline `‹ More` link the design puts at the top of every
sub-screen. Use both together:

```tsx
const back = useCameFrom('more');
...
<BackLink label={back.label} onPress={back.go} />
```

And `<StubCard title body />` for anything not built.

### `src/state/store.ts`
`useStore(selector)` — Zustand. Actions: `set(patch)` `notify(msg)` `signIn`
`signOut` `startDay` `beginVisit(custId)` `markVisitDone(k, line)`
`setQty(sku, qty)` `dropLine(sku)` `askConfirm(c)` `closeConfirm`.
Helpers: `useCustomer()` `useUnreadCount()` `useLiveTasks()` `QUEUE_DEPTH`.

`askConfirm({ title, body, reasonLabel?, confirmLabel, run(reason) })` is how
every "are you sure, and why" moment in the design is expressed. The dialog is
already mounted by `AppFrame`; you only raise it.

## Routing

`expo-router`, flat routes under `app/`. Typed routes are OFF, so `router.push('/tasks?from=home')`
is a plain string. Screens are headerless — `AppFrame` draws the header.

Existing route names: `index` (login) `home` `journey` `customers` `customer`
`visit` `saved` `more` `order` `pay` `samples` `tasks` `sync` `attendance`
`leave` `salary` `expenses` `performance` `catalogue` `docs` `knowledge`
`profile` `notifications` `reports`.

Carry `?from=<route>` on every push into a sub-screen so the back link can name
where it came from.

## Notes on translating the design's idioms

- `sc-if` → a ternary or `&&`.
- `sc-for` → `.map()`.
- A `style` binding computed in `renderVals()` → compute it inline in the
  component. Keep the same conditions.
- `title="…"` on a button → `accessibilityLabel`.
- `<input type="date">` → the `Calendar` in a `BottomSheet`.
- `<select>` → a row of `Choice` chips, unless the design's list is long.
- `overflow-x:auto` → `<ScrollView horizontal showsHorizontalScrollIndicator={false}>`
  with `contentContainerStyle` carrying the padding.
- CSS `gap` works in RN 0.86 — use it.
