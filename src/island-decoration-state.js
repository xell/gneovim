import { StateEffect, StateField, findClusterBreak } from "@codemirror/state";
import { Decoration, EditorView, WidgetType } from "@codemirror/view";
import { byteToCol } from "./pure/text-geometry.js";

export function createIslandDecorationState({ document, log }) {
  const setNvimCursor = StateEffect.define();
  const setIslandDecor = StateEffect.define();
  const setIslandLines = StateEffect.define();
  const setIslandMarks = StateEffect.define();
  const setIslandFolds = StateEffect.define();

  class BlockCursor extends WidgetType {
    toDOM() {
      const span = document.createElement("span");
      span.className = "nvim-cursor nvim-cursor-block nvim-cursor-eol";
      span.textContent = " ";
      return span;
    }
  }

  // The insert-mode caret is independent from CodeMirror's native caret, so a
  // whole-line buffer echo cannot map it to the line start.
  class BarCursor extends WidgetType {
    toDOM() {
      const span = document.createElement("span");
      span.className = "nvim-cursor nvim-cursor-bar";
      return span;
    }
  }

  class HiddenCursor extends WidgetType {
    toDOM() {
      const span = document.createElement("span");
      span.className = "nvim-cursor nvim-cursor-hidden";
      return span;
    }
  }

  // The payload's decorations are split by kind into separate fields, each
  // with its own effect, so a push that leaves one kind unchanged (the
  // common case: a j/k that does not scroll changes almost nothing) neither
  // dispatches it nor makes CodeMirror diff it. islandDecorField is the
  // replace widgets (markers, conceal, overlays): the only kind the cursor
  // and isCursorHidden look into. All replace widgets share one field so
  // nonOverlappingSpans can keep them from overlapping each other.
  const mappedDecorField = (setDecor) =>
    StateField.define({
      create: () => Decoration.none,
      update(value, transaction) {
        if (transaction.docChanged) {
          try {
            value = value.map(transaction.changes);
          } catch (error) {
            log("island decor map failed, dropping: " + error);
            value = Decoration.none;
          }
        }
        for (const effect of transaction.effects) {
          if (effect.is(setDecor)) value = effect.value;
        }
        return value;
      },
      provide: (field) => EditorView.decorations.from(field),
    });
  const islandDecorField = mappedDecorField(setIslandDecor);
  const islandLineField = mappedDecorField(setIslandLines);
  const islandMarkField = mappedDecorField(setIslandMarks);

  const islandFoldField = StateField.define({
    create: () => Decoration.none,
    update(value, transaction) {
      for (const effect of transaction.effects) {
        if (effect.is(setIslandFolds)) value = effect.value;
      }
      if (transaction.docChanged && value.size) {
        // Fold replacements span line breaks and cannot safely use RangeSet.map.
        // Map their endpoints independently and discard collapsed ranges.
        const kept = [];
        value.between(
          0,
          transaction.startState.doc.length,
          (from, to, decoration) => {
            const nextFrom = transaction.changes.mapPos(from, 1);
            const nextTo = transaction.changes.mapPos(to, -1);
            if (nextFrom < nextTo) {
              kept.push(decoration.range(nextFrom, nextTo));
            }
          },
        );
        try {
          value = Decoration.set(kept, true);
        } catch (error) {
          log("island fold remap failed: " + error);
          value = Decoration.none;
        }
      }
      return value;
    },
    provide: (field) => EditorView.decorations.from(field),
  });

  function cursorDecorations(state, position) {
    if (!position) return Decoration.none;
    const doc = state.doc;
    const line = doc.line(Math.min(position.row + 1, doc.lines));
    let from = Math.min(
      line.from + byteToCol(line.text, position.col),
      line.to,
    );

    // A cursor inside a hidden fold body must remain visible at its left edge.
    let onFold = false;
    const folds = state.field(islandFoldField, false);
    if (folds) {
      folds.between(from, from, (foldFrom, foldTo) => {
        if (foldFrom < foldTo) {
          from = foldFrom;
          onFold = true;
          return false;
        }
      });
    }
    if (onFold) {
      return Decoration.set([
        Decoration.widget({
          widget: new BlockCursor(),
          side: -1,
        }).range(from),
      ]);
    }
    // A cursor inside conceal-hidden text (a link's `(url)`, `**`, a quote
    // marker) has no visible character to sit on, so it is drawn at the
    // hidden run's left edge: a slim hollow outline, distinct from the
    // Insert-mode bar, whatever the run's length. Markers that already draw
    // their own cursor (heading icon, list bullet) opt out via drawsCursor.
    let concealRun = null;
    state.field(islandDecorField, false)?.between(
      from,
      from,
      (runFrom, runTo, decoration) => {
        if (runFrom <= from && from < runTo && decoration.spec.widget) {
          concealRun = { from: runFrom, drawn: decoration.spec.drawsCursor };
          return false;
        }
      },
    );
    if (concealRun) {
      if (concealRun.drawn) return Decoration.none;
      return Decoration.set([
        Decoration.widget({
          widget:
            position.mode[0] === "i" ? new BarCursor() : new HiddenCursor(),
          side: -1,
        }).range(concealRun.from),
      ]);
    }
    if (position.mode[0] === "i") {
      return Decoration.set([
        Decoration.widget({
          widget: new BarCursor(),
          side: 1,
        }).range(from),
      ]);
    }
    // Cover the whole grapheme cluster, not one UTF-16 unit: splitting a
    // surrogate pair or a flag's regional-indicator pair renders tofu.
    const to = Math.min(
      line.from + findClusterBreak(line.text, from - line.from),
      line.to,
    );
    return from === to
      ? Decoration.set([
          Decoration.widget({
            widget: new BlockCursor(),
            side: 1,
          }).range(from),
        ])
      : Decoration.set([
          Decoration.mark({
            class: "nvim-cursor nvim-cursor-block",
          }).range(from, to),
        ]);
  }

  const nvimCursorField = StateField.define({
    create: () => ({ deco: Decoration.none, pos: null }),
    update(value, transaction) {
      let position = value.pos;
      for (const effect of transaction.effects) {
        if (effect.is(setNvimCursor)) position = effect.value;
      }
      // Recompute on every transaction because fold effects can change where
      // the cursor must be rendered.
      return {
        deco: cursorDecorations(transaction.state, position),
        pos: position,
      };
    },
    provide: (field) =>
      EditorView.decorations.from(field, (value) => value.deco),
  });

  const visualMark = Decoration.mark({ class: "cm-nvim-visual" });
  const concealHide = Decoration.replace({});
  const lineDecorations = new Map();
  // `style` is optional and carries a CSS custom property for the handful of
  // line classes whose appearance is data-driven (the due-date capsule's
  // --due-label). Cached on the pair, since those labels come from a small
  // closed set and a fresh Decoration object per row per push would defeat
  // CodeMirror's range-set reuse.
  const lineDecoration = (className, style) => {
    const key = style ? className + "\n" + style : className;
    let decoration = lineDecorations.get(key);
    if (!decoration) {
      decoration = Decoration.line({
        attributes: style ? { class: className, style } : { class: className },
      });
      lineDecorations.set(key, decoration);
    }
    return decoration;
  };

  return {
    concealHide,
    islandDecorField,
    islandFoldField,
    islandLineField,
    islandMarkField,
    lineDecoration,
    nvimCursorField,
    setIslandDecor,
    setIslandFolds,
    setIslandLines,
    setIslandMarks,
    setNvimCursor,
    visualMark,
  };
}
