# Card tags stay editable on a read-only card (card-resources `TagsEditor`)

Draft for an upstream issue against `hcengineering/platform`. Not filed yet.

Affected file: `plugins/card-resources/src/components/TagsEditor.svelte`
(the `card` plugin's own tag editor, not `plugins/tags-resources/.../TagsEditor.svelte`).

## Summary

`TagsEditor` gates its write actions on an `export let readonly: boolean = false` prop that the
caller has to remember to pass. One of the two call sites does not pass it, and the drag/dropdown
path inside the component was never gated at all. The result: on a card that the main panel renders
as read-only, the same card's sidebar widget still lets a user add and remove tags (mixins), and the
compact dropdown lets it happen even from the main panel.

## Reproduction

1. Open a card whose read-only state is on — e.g. a versioned (frozen) card, where
   `Card.readonly === true` (`VersionableDoc.readonly`, `foundations/core/packages/core/src/versioning.ts`).
2. In the main panel (`EditCardNew.svelte`) the tag chips have no remove button and the "+" button
   is hidden — correct, because line 317 passes `readonly={_readonly}`.
3. Open the same card in the card sidebar widget (`CardWidget.svelte`). Line 138 renders
   `<TagsEditor {doc} dropdownTags={clientWidth < 512} id={'cardSidebar-tags'} />` — no `readonly`,
   so the prop falls back to its `false` default. The remove buttons and the "+" button are back,
   and both write through `client.update` / `client.createMixin`.
4. Independently of the widget: make the container narrow enough that `dropdownTags` is true (or use
   the sidebar at < 512px). The chevron button calls `handleDrop`, which opened a `SelectPopup` of
   active + addable tags and applied the selection with **no** `readonly` check, no
   `ForbidAddTag` / `ForbidRemoveTag` permission check and no `isRemoveable` check. That path was
   writable even on the main panel, where `readonly` *is* passed.

## Root cause

Two distinct defects, same shape:

1. **The safe state depends on the caller.** `readonly` defaults to `false`, and the component has
   no other source of truth, so a call site that forgets the prop silently gets the editable
   component. `CardWidget` forgot it. Nothing in the type system or in a test catches this — a
   missing Svelte prop is not a compile error.
2. **`handleDrop` bypassed every gate.** The `readonly` flag, both card permissions and
   `isRemoveable()` were only consulted in the non-dropdown branch of the markup (former lines 136
   and 144). The dropdown branch shares no code with it.

## Fix

Derive the read-only state inside the component instead of trusting the caller, and route every
write through the same two derived flags:

```svelte
$: isReadonly = readonly || doc.readonly === true
$: canAdd = !isReadonly && !checkAddPermission($permissionsStore)
$: canRemove = !isReadonly && !checkRemovePermission($permissionsStore)
```

- `doc` is already a required prop and already carries `readonly`, so `CardWidget` needs no change:
  it cannot get this wrong any more, and neither can a future call site.
- `handleDrop` now only offers addable tags when `canAdd`, and re-checks `canRemove` +
  `isRemoveable()` / `canAdd` in the popup callback before writing.
- The markup branches now read `canRemove && isRemoveable(...)` and `canAdd`, which is the same
  condition the two branches previously disagreed on.
- Both write callbacks re-check the flag rather than trusting the button that opened them: `add()`'s
  `SelectPopup` callback checks `canAdd`, and `on:remove` checks `removable`. A popup can outlive the
  state that opened it (the card can be frozen, or a permission revoked, while it is open).

`handleDrop` still opens its popup when read-only: with `canAdd` false it lists the card's active
tags and writes nothing, which keeps the compact layout's only way of *seeing* the tags.

The `readonly` prop is kept and still ORs in, because `EditCardNew` passes a wider notion
(`readonly || doc.readonly || doc.readonlyFields?.includes('title')`) than the component can derive
on its own.

### Why not flip the default to `readonly = true`

Considered and rejected. It would make every existing call site that omits the prop silently
read-only, which is the same class of caller-dependent failure in the opposite direction, and it
breaks the codebase-wide `export let readonly: boolean = false` convention. Removing the dependency
on the caller altogether is the smaller and safer change.

## Notes / not fixed here

- `CardWidget.svelte` never derives a read-only state at all, so two more writers leak the same way
  and are **not** fixed here:
  - the title `EditBox` — `saveTitle` (line 71) calls `client.update(doc, { title })` with no
    read-only check, while `EditCardNew.saveTitle` guards with
    `canSave = trimmedTitle.length > 0 && !_readonly`;
  - `<EditCardNewContent _id={doc._id} {doc} {context} {isContextLoaded} />` (line 143) omits
    `readonly`, so the whole sidebar body — content sections and the message input, which
    `EditCardNewContent` gates on `!readonly` — stays editable on a read-only card.

  The same one-line derivation (`$: isReadonly = doc.readonly === true`) would cover both.
- This is a client-side gate only. The server does not appear to reject mixin writes to a read-only
  card, so the underlying enforcement question is separate from the UI leak reported here.
