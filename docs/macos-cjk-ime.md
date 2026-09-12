# macOS CJK IME in Markdown islands

This note records the working input contract between macOS WebKit,
CodeMirror 6, and embedded Neovim. It also records the failures that made the
bugs difficult to diagnose. Preserve these ownership and coordinate rules when
changing island input, cursor rendering, Accessibility, or buffer sync.

## Versions at implementation

The implementation was validated with:

| Component | Version |
|---|---:|
| `@codemirror/view` | 6.43.11 |
| `@codemirror/state` | 6.7.4 |
| `@codemirror/lang-markdown` | 6.5.2 |
| Tauri | 2.11.3 |

The application runs CodeMirror inside the macOS WKWebView supplied by Tauri.
Neovim is embedded with `--embed --headless`.

## Ownership model

Neovim remains authoritative for ordinary keyboard editing:

```text
physical key
→ global keydown
→ nvim_input
→ Neovim buffer and cursor
→ nvim_buf_lines_event and gnv_cursor
→ CodeMirror rendering
```

This preserves mappings, abbreviations, completion, registers, undo, macros,
Replace mode, and every other Neovim input semantic. CodeMirror has no
`basicSetup` keymap and must not independently handle ordinary Enter,
Backspace, arrows, or printable keys.

A native IME composition is the intentional exception. WebKit and CodeMirror
must own the temporary marked text so macOS can display and update its inline
preedit:

```text
compositionstart
→ temporary preedit stays local in CodeMirror
→ compositionend, or Safari's final insertText fallback
→ committed Unicode text goes once through nvim_input
→ Neovim advances its own cursor
→ normal buffer echo confirms the rendered document
```

Use `EditorView.domEventHandlers` for composition events. Do not attach a
second listener directly to `.cm-content`: CodeMirror already owns that DOM
event lifecycle, and listener ordering can hide or race the final event.

Safari can omit `compositionend`. A final `beforeinput` with
`inputType == "insertText"` while a composition snapshot exists is the fallback
completion signal. Defer the handoff until CodeMirror has finished reconciling
its DOM observer; dispatching an island transaction from inside that update
causes `Calls to EditorView.update are not allowed while an update is in
progress`.

Keep the settled composition in CodeMirror while sending it to Neovim. Do not
restore the precomposition snapshot first. Removing the phrase and adding it
again makes CodeMirror measure two opposite document changes and causes a
visible vertical shake. The Neovim line echo is a no-op when it matches the
settled text, and a minimal correction when a mapping or autocmd changed it.

## Direct CJK punctuation

Full-width punctuation such as `，。；：！？、“”` commonly arrives without a
composition. macOS emits a direct `beforeinput` with
`inputType == "insertText"`.

Do not let that event fall through to the general CodeMirror `onUpdate` to
`nvim_edit` path. `nvim_buf_set_text` changes the buffer at an arbitrary range
but does not advance Neovim's Insert mode cursor. The punctuation would look
correct initially, while the next composed phrase would be inserted before it.

Prevent the direct DOM edit and send its data through `nvim_input`. This rule
is based on the input event type rather than a hardcoded punctuation list, so
it covers every direct character emitted by a macOS input source.

Grammarly and system replacements use replacement event types and retain the
arbitrary-range `nvim_edit` path.

## One coordinate contract

Neovim buffer columns and CodeMirror positions are different units:

| Surface | Column unit |
|---|---|
| Neovim `col('.')` | UTF-8 byte offset, one based |
| Neovim extmarks and `nvim_win_set_cursor` | UTF-8 byte offset, zero based |
| CodeMirror document positions | UTF-16 code unit offset |

All `gnv_cursor` payloads and island snapshots use zero-based UTF-8 byte
columns. The Rust bridge must read `col('.') - 1`, not `charcol('.') - 1`.
The client converts every incoming cursor column through `byteToCol` before
using it as a CodeMirror position.

Do not mix these representations. The original mismatch sent character
columns but treated them as bytes. ASCII hid the error. For three-byte Chinese
characters, inline hints progressively appeared near the first, second, and
later characters instead of at the cursor. The same mismatch made `l` jump
several Chinese characters and made `w` appear to jump directly to line end.

The conversion applies both to CodeMirror's state selection and to the custom
cursor decoration. A correct selection with an incorrectly drawn decoration,
or the reverse, produces misleading debugging evidence.

Cursor and buffer notifications are independent streams. A multibyte cursor
notification can arrive while CodeMirror still has the shorter old line and
be clamped to its end. After applying a line event, re-seat CodeMirror's
selection from the saved Neovim byte cursor against the new document.

## Accessibility selection isolation

`onExternalSelection` exists for Grammarly and macOS Accessibility corrections.
CodeMirror also changes its selection while creating and removing composition
DOM. Those internal selection changes must not be sent back through
`nvim_cursor_set`.

Ignore external-selection synchronization while:

1. A composition snapshot exists.
2. `EditorView.composing` is true.
3. A committed composition is waiting for its Neovim buffer echo.

After the line echo, normal Accessibility selection forwarding resumes.

## Approaches that failed

Do not repeat these approaches without new evidence:

1. Globally blocking keys whenever `EditorView.composing` is true. WebKit can
   leave that state set after a missing completion event, blocking English,
   Backspace, Delete, and Escape.
2. Moving island IME input to the grid's hidden textarea. It removed
   CodeMirror focus, broke Grammarly, and allowed Neovim changes to continue
   while the island presentation appeared stalled.
3. Treating every composition transaction as an external `nvim_edit`. Buffer
   echoes interfere with marked text, and `nvim_edit` does not advance the
   Insert mode cursor.
4. Guessing the cursor from CodeMirror's composition selection. WebKit may
   retain the precomposition anchor during cleanup.
5. Repeatedly forcing the browser DOM Selection. Numeric tracing showed the
   Neovim expectation, CodeMirror state, and native selection already agreed;
   the real error was the character-column versus byte-column contract.
6. Issuing a synchronous RPC to inspect Neovim after a count such as `2` has
   already entered its input queue. Neovim is waiting for the motion key and
   cannot service that request, deadlocking the GUI.

## Chinese semantic `w`

In a Markdown island, a bare normal-mode `w` uses
`Intl.Segmenter("zh", { granularity: "word" })` and moves Neovim's real cursor
to the next semantic segment. `h` and `l` remain native character motions.

Counts and operator prefixes must bypass semantic movement and send native
`w` to Neovim. In particular, never query Neovim synchronously to decide
whether a queued count or operator is pending. The client conservatively tracks
common count and operator prefixes; native grid windows always retain Neovim's
ordinary `w`.

## Regression checklist

Use one line containing several phrases and punctuation, for example:

```text
我们，他们都知道了。今天：很好！
```

Verify:

1. Several consecutive multi-character compositions append at the visible
   cursor.
2. Inline phonetic preedit appears at that same cursor.
3. Direct full-width punctuation advances the real Neovim cursor.
4. A phrase typed after punctuation appears after it.
5. English, Backspace, Delete, Enter, Escape, and Replace mode still work.
6. Grid mode contains exactly the text shown by the island.
7. Grammarly still highlights text and applies corrections to its selected
   range.
8. Composition completion does not vertically shake the island.
9. `h` and `l` move one Chinese character at a time.
10. Bare `w` follows Chinese semantic segments.
11. `2w`, `dw`, `cw`, and `yw` remain native and never freeze the GUI.
