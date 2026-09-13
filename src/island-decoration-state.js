import { StateEffect, StateField } from "@codemirror/state";
import { Decoration, EditorView, WidgetType } from "@codemirror/view";
import { byteToCol } from "./pure/text-geometry.js";

export function createIslandDecorationState({ document, log }) {
  const setNvimCursor = StateEffect.define();
  const setIslandDecor = StateEffect.define();
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

  const islandDecorField = StateField.define({
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
        if (effect.is(setIslandDecor)) value = effect.value;
      }
      return value;
    },
    provide: (field) => EditorView.decorations.from(field),
  });

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
    if (position.mode[0] === "i") {
      return Decoration.set([
        Decoration.widget({
          widget: new BarCursor(),
          side: 1,
        }).range(from),
      ]);
    }
    const to = Math.min(from + 1, line.to);
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
  const lineDecoration = (className) => {
    let decoration = lineDecorations.get(className);
    if (!decoration) {
      decoration = Decoration.line({
        attributes: { class: className },
      });
      lineDecorations.set(className, decoration);
    }
    return decoration;
  };

  return {
    concealHide,
    islandDecorField,
    islandFoldField,
    lineDecoration,
    nvimCursorField,
    setIslandDecor,
    setIslandFolds,
    setNvimCursor,
    visualMark,
  };
}
