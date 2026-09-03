# A failed `okAction` kills the OK button of every `Card` dialog (`presentation/Card.svelte`)

Draft for an upstream issue against `hcengineering/platform`. Not filed yet.

Affected file: `packages/presentation/src/components/Card.svelte` — the shared dialog shell used by
~167 `.svelte` call sites across `plugins/*` (process, setting, card, tracker, recruit, contact, hr,
board, view, training, templates, drive, document, controlled-documents, calendar, …).

## Summary

`handleOkClick` attaches only a fulfillment handler to the promise returned by `okAction`. If that
promise rejects, `okProcessing` is never cleared — and the guard at the top of `handleOkClick` reads
`okProcessing` *before* it reads `canSave`, so every later click, `Enter` and `Ctrl+Enter` returns
early. The dialog is left standing with a permanently disabled-looking OK button (`loading` stays
true) and nothing on screen explaining what happened. The only way out is to close the dialog and
lose everything typed into it.

## Reproduction

1. Take any dialog built on `Card` whose `okAction` can reject — e.g. a create dialog whose
   `okAction` is `async () => { await client.createDoc(...) }`. Simulate the failure by dropping the
   websocket to the transactor, or by writing to a space the user has no permission for.
2. Fill the form so the OK button is enabled and click it. The button goes into its `loading` state.
3. The rejection surfaces only as an unhandled promise rejection in the console. The dialog stays
   open (correct), but:
4. Click OK again. Nothing happens. Press `Enter` or `Ctrl+Enter`. Nothing happens. Edit a field so
   that `canSave` recomputes to `true`. Still nothing. The dialog can now only be abandoned.

`okAction` throwing *synchronously* has the same effect: `okProcessing = true` is assigned before the
call, and the throw escapes `handleOkClick` without clearing it.

## Root cause

`packages/presentation/src/components/Card.svelte`, `handleOkClick` (before the fix):

```ts
function handleOkClick (): void {
  if (canSave) {
    if (okProcessing) {
      return
    }
    okProcessing = true
    const r = okAction()
    if (r instanceof Promise) {
      r.then(() => {
        okProcessing = false
        dispatch('close')
      })
    } else {
      okProcessing = false
      dispatch('close')
    }
  }
}
```

Two things combine:

1. **No rejection handler.** `okProcessing` is cleared on exactly one path.
2. **The re-entrancy guard is checked before `canSave`.** So the latched flag is not merely cosmetic
   (a stuck spinner) — it disables the whole submit path, keyboard included, for the lifetime of the
   component instance. A guard that checked `canSave` first would still have shown a stuck spinner,
   but a form edit would have released it.

## Fix

Keep the flag as the in-flight guard, but clear it on every path out, without changing what happens
on success:

```ts
okProcessing = true
let r: Promise<void> | void
try {
  r = okAction()
} catch (err) {
  okProcessing = false
  throw err
}
if (r instanceof Promise) {
  r.then(
    () => {
      okProcessing = false
      dispatch('close')
    },
    (err) => {
      okProcessing = false
      throw err
    }
  )
} else {
  okProcessing = false
  dispatch('close')
}
```

Behaviour, by path:

- **Rejected promise** — `okProcessing` is released, so the button is live and the user can retry
  with the values still in the form. No `close` is dispatched, so the dialog stays open, exactly as
  before. The error is **re-thrown**, so the derived promise rejects with the original error just as
  it did when no handler was attached at all: whatever was reporting it keeps reporting it
  (`window.addEventListener('unhandledrejection', …)` in `packages/analytics-providers/src/analyticsCollector.ts:59`).
- **Synchronous throw** — same: release, then re-throw so the error still escapes to the click
  handler.
- **Resolved promise / non-promise return** — untouched.

### Deliberately *not* changed: "resolve closes the dialog"

The other half of the behaviour is that `Card` dispatches `close` whenever `okAction` resolves, with
no way for the dialog to say "this attempt failed, stay open". That is a real problem for any code
whose command layer turns failures into an *outcome value* rather than an exception — the dialog
tears itself down on a 409 or a dropped connection, and the user's only route back in re-runs the
whole submit.

It is not addressed here because dozens of existing dialogs rely on `resolve ⇒ close`, and changing
it is not something a `Card`-local patch can do safely. The two workarounds available today are:

- **Resolve on failure and swallow the resulting `close`** once, keeping the typed values and
  rendering the error inline (relies on `close` arriving in the microtask right after the promise
  settles, so no user click can interleave).
- **Take the submit button out of the footer**: `canSave={false}` + `hideFooter`, put the button in
  the card body, and drive the request yourself. `canSave={false}` also keeps `Enter` /
  `Ctrl+Enter` off `handleOkClick`.

A clean upstream shape would be to let `okAction` signal "handled, do not close" — e.g. treat a
resolved `false` as "stay open" while `undefined`/`true` keeps the current close — but that is a
separate change from the one above, which is strictly a bug fix: no path that worked before behaves
differently, only the previously-dead state becomes recoverable.

## Impact

Every dialog built on `Card` — 167 `.svelte` files. The fix is a strict superset of the old
behaviour (nothing that previously succeeded changes), so no call site needs to be updated. The only
call sites that *could* notice are ones that deliberately relied on the OK button staying dead after
a rejection, which would be relying on a dialog the user can no longer submit or dismiss cleanly.
