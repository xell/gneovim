# macOS predictive text and autocorrect in Markdown islands

This note records a deferred investigation. It concerns macOS inline predictive
text and automatic correction in a CodeMirror 6 Markdown live-preview island.
Do not change the typing path from this note alone: the island deliberately
forwards ordinary typing to Neovim, and that preserves important editor
semantics.

## Current state

The installed CodeMirror packages are current as of this note:

| Package | Version |
|---|---:|
| `@codemirror/view` | 6.43.11 |
| `@codemirror/state` | 6.7.4 |
| `@codemirror/lang-markdown` | 6.5.2 |

The island has a real CodeMirror `contenteditable` surface, but ordinary
physical typing does not become a native CodeMirror edit:

```text
physical key
→ global keydown handler
→ preventDefault()
→ nvim_input
→ Neovim buffer update
→ CodeMirror buffer echo
```

Neovim remains authoritative for buffer contents, cursor state, modes,
mappings, abbreviations, completion plugins, and undo behavior. The browser is
not an independently authoritative editor.

The island already has dedicated IME handling:

1. `compositionstart` saves a snapshot.
2. Composition changes stay local while the IME is active.
3. `compositionend` restores the snapshot and sends the committed text to
   Neovim.
4. Neovim's buffer echo supplies the final rendered state.

This prevents a buffer echo from aborting a CJK IME composition. It does not
automatically provide macOS inline predictions or normal autocorrect.

## Why browser support alone is insufficient

CodeMirror supports WebKit text input and carefully handles Safari
`beforeinput` and composition edge cases. That support applies when WebKit is
allowed to perform the native edit.

The island's global keydown forwarder cancels the default action for ordinary
printable keys before WebKit can create a native predictive text or
autocorrection transaction. Updating CodeMirror will not change that ownership
boundary.

The existing `onUpdate` to `nvim_edit` path can forward an explicit native DOM
replacement to Neovim. It is useful for direct external mutations, spell
replacement, drag and drop, and similar events. It cannot help if WebKit never
received the key that starts the prediction.

## Predictive text and autocorrect are different

### Autocorrect

Autocorrect may arrive as a committed replacement, commonly through
`beforeinput` with `inputType = insertReplacementText`, a composition event, or
an accessibility driven edit. Once there is a concrete changed range, it may be
possible to forward that range through `nvim_edit`.

### Inline predictive text

Inline prediction can be provisional state in WebKit's text input system rather
than a committed document edit. It is vulnerable to:

* replacing the CodeMirror document while the prediction is visible
* changing the DOM selection
* rebuilding decorations near the prediction
* synchronously forcing a view update after each input event

CodeMirror has fixed Safari and macOS composition and predictive text issues
over time. Keep the packages current, but treat a specific reproduction as the
source of truth.

## Do not take the broad shortcut

Do not simply let all insert-mode text edit CodeMirror natively and forward
every resulting mutation to Neovim. That would create a second ordinary editor
path and risks differences in:

* insert mappings and abbreviations
* Neovim completion and snippet plugins
* undo grouping
* Backspace, Enter, indentation, and bracket behavior
* cursor and selection synchronization
* IME and external-editor interaction

It may ultimately be a conscious product choice, but it is not a safe
implementation shortcut.

## Recommended future investigation

First add temporary observability only. Record, in one ordered timeline:

1. `keydown`, including key, code, modifiers, `isComposing`, and whether the
   island forwards or prevents it
2. capture-phase `beforeinput` and `input`, including input type, data, and
   target ranges
3. `compositionstart` and `compositionend`
4. `selectionchange`
5. CodeMirror transactions, including document changes and selection changes
6. outgoing `nvim_input` and `nvim_edit` requests
7. incoming Neovim buffer and cursor events

Run that trace separately for:

1. accepting an inline prediction
2. rejecting an inline prediction
3. ordinary automatic correction after Space or punctuation
4. selecting a correction from macOS's suggestion UI
5. text adjacent to a Markdown decoration
6. text containing multibyte characters

## Likely design direction

If the trace exposes a reliable composition or native text transaction
boundary, add a narrow **native text session**:

1. Let WebKit and CodeMirror handle only that active native transaction.
2. Suppress Neovim buffer echoes and decoration changes that would disrupt it.
3. On commit, convert the exact CodeMirror change into positional `nvim_edit`.
4. Resume normal Neovim key forwarding immediately afterward.

This retains Neovim as the buffer and command authority for the vast majority
of interaction. It is preferable to a permanent second editor path.

If macOS predictions do not expose a dependable boundary, stop and reassess
instead of introducing a timer based editing mode. A timeout risks accepting
some user keys natively and others through Neovim, which can silently diverge
from expected editor semantics.

## References

* [CodeMirror view changelog](https://codemirror.net/docs/changelog/)
* [CodeMirror issue 1486: diagnostics overlapping macOS predictive text](https://github.com/codemirror/dev/issues/1486)
* [Slate issue 540: Safari beforeinput behavior](https://github.com/ianstormtaylor/slate/issues/540)
* [Slate issue 1176: iOS text input duplication](https://github.com/ianstormtaylor/slate/issues/1176)
