# Preparing a Neovim config for gneovim

Advisory notes for Leo, written 2026-09-10, while pausing the display bridge work.
The question was: my `~/.config/nvim` is a decade of accumulated settings, mostly markdown, mixing old Vim habits with new Neovim ones. How should I overhaul it to be ready for gneovim, and what is the relationship between treesitter and LSP.

## The three layers, in plain English

Neovim has three separate systems that people lump together. They do different jobs and mostly cooperate.

### 1. Syntax (the old `:syntax` engine)

Regex patterns in `runtime/syntax/<ft>.vim` files. They scan the text line by line, tag runs of characters with highlight groups, and can also hide text (`conceal`), define folds (`foldmethod=syntax`), and mark spell regions.
It has no idea about structure. It does not know that a fenced code block contains Python. It just matches patterns.
It is slow and fragile on large or deeply nested files, and every filetype needs someone to hand write and maintain the regexes.
It still ships for hundreds of filetypes and is the fallback when nothing better exists.

### 2. Treesitter

A real parser. `nvim-treesitter` installs a small compiled grammar per language, and Neovim keeps an actual syntax tree of the buffer, updated incrementally as you type.
On top of the tree you run queries, small `.scm` files, one set per language:

- `highlights.scm` produces highlighting, and can also hide markers via `(#set! conceal "")` metadata
- `folds.scm` drives `foldexpr = v:lua.vim.treesitter.foldexpr()`
- `indents.scm` drives `indentexpr`
- `injections.scm` says "this node is actually Python", so a code block inside markdown gets parsed and highlighted as Python
- `textobjects` queries give you "select the function", "next class", and so on

Because it understands nesting and structure, it is accurate and composable in a way regex syntax cannot be.
It is the future for the display and structure layer: highlighting, folding, indent, conceal, text objects, injections.
Costs: it needs a compiled parser per language, a handful of filetypes still have no good grammar, and a few very dynamic files confuse it.

### 3. LSP (Language Server Protocol)

A completely different axis. An external program, the language server, runs alongside Neovim and understands your whole project, not just the current buffer.
It provides diagnostics (the red and yellow squiggles for real errors), go to definition, hover documentation, completion, rename, code actions, formatting, and a symbol list.
It is semantic and cross file. It does not do ordinary highlighting (there is a minor "semantic tokens" layer that only refines what treesitter already did).
For prose, the relevant servers are things like `marksman` (markdown links, headings, workspace symbols) and a grammar checker such as `harper-ls` or `ltex`.

### How they relate

They are not competitors. A normal modern setup runs treesitter and LSP together, and turns syntax off wherever treesitter covers the language.

| Layer | Question it answers | Scope | Needs |
| --- | --- | --- | --- |
| syntax | what does this text look like (legacy) | current buffer, regex | nothing |
| treesitter | what is the structure, how should it look, fold, indent | current buffer, a parse tree | a parser per language |
| LSP | what does this mean in the project | whole project | a server per language |

Rule of thumb: treesitter replaces syntax. LSP adds a layer syntax and treesitter never had.

## What gneovim specifically needs from your config

The markdown island in gneovim mirrors Neovim's display state for the buffer: conceal, folds, extmark highlights, the visual range, and later virtual text.
That display state is the treesitter and extmark layer. It is not the regex syntax layer.

Concretely:

- Conceal that comes from treesitter or from an extmark (render-markdown) is what the island can reflect.
- Conceal that comes from a `:syntax` rule is second class. Neovim exposes it through `synconcealed()`, which is syntax only on every version including 0.12, so gneovim has to read it through a separate path and it will always be the weaker half.
- The cleaner and more treesitter centric your markdown display config is, the more faithfully the island matches your editor, and the less special casing gneovim needs.

So this overhaul is not busywork for gneovim. It directly reduces the surface gneovim has to bridge.

## Markdown overhaul, concrete

Your markdown settings currently live in five places and partly fight each other: `after/ftplugin/markdown.lua`, `after/syntax/markdown.vim`, `init.lua` (three globals plus a toggle), `lua/plugins/coding.lua` (treesitter), and the prose plugins in `special.lua` and `general.lua`.

### Step 1. Make treesitter the only highlighter for markdown

In `lua/plugins/coding.lua`, `additional_vim_regex_highlighting` is `{ 'markdown', 'outlinex', 'help' }`. That runs the full builtin regex syntax on top of treesitter.
Remove `markdown` and `help` from that list. The `vimdoc` parser is good now, and the markdown parser plus `markdown_inline` cover markdown well.
Keep `outlinex` only if your custom parser registration is not enough on its own (test with it removed first).
Ideally that option ends up empty.

Effect: `markdownBold`, `markdownCode`, and the rest of the `markdown*` highlight groups stop existing.

### Step 2. Retire the builtin regex syntax features

In `init.lua`:

- `vim.g.markdown_syntax_conceal = 1`: delete it. This is a builtin regex syntax feature. Treesitter conceals the standard markers itself.
- `vim.g.markdown_folding = 1`: delete it. Your ftplugin already uses `foldexpr = v:lua.vim.treesitter.foldexpr()`, so this global does nothing useful.
- `vim.o.concealcursor = 'nc'` at global scope (line 60) and the same value again nearby: remove the global. Set `conceallevel` and `concealcursor` only in the markdown ftplugin (and any other prose filetype), so code buffers are never affected. Keep your conceallevel toggle command.

### Step 3. Rework `after/syntax/markdown.vim`

Once step 1 lands, most of this file is dead:

- The `hi! default link markdownBold @markup.strong` block and friends: dead, because `markdownBold` no longer exists. If any of those remaps were doing something you want (for example linking inline code to `@string`), redo it as a treesitter highlight link: `vim.api.nvim_set_hl(0, '@markup.raw.markdown_inline', { link = '@string' })` in a colorscheme hook or `after/plugin`.
- `syntax spell toplevel`: replace with treesitter spellcheck, which is on by default for `@spell` captures. You mostly just need `set spell` in the ftplugin.
- `markdownListMarkerConceal`: the stock nvim-treesitter markdown query does not conceal list markers. Decide between render-markdown (step 5) doing it properly with a real bullet glyph, or a query override (`after/queries/markdown/highlights.scm` starting with `; extends` and a capture with `(#set! conceal "")` on `(list_marker_minus)` and siblings).
- `{==...==}` and `{= =}` (your critic markup style highlight and template markers): these are not markdown grammar, so treesitter cannot see them without a grammar extension. The modern way is a tiny Lua module that walks the visible range and sets extmarks (a highlight, plus `conceal` on the `{==` and `==}`). That also means gneovim's island picks them up through the extmark path. Roughly twenty lines with `nvim_buf_set_extmark` on a debounced `CursorMoved` / `TextChanged` autocmd, scoped to markdown buffers.

Syntax and treesitter can still coexist. You are only removing the full builtin markdown regex syntax used for highlighting. A minimal `after/syntax/markdown.vim` that defines just your bespoke constructs is fine, but extmarks are the better tool for `{==...==}`.

### Step 4. Keep as is

- The `<Leader>` visual mode wrap mappings (`s`, `b`, `i`, `t`, `c`, `h`) and `ExportTextbundle` in the ftplugin. Unrelated to syntax versus treesitter.
- `breakindent`, `linebreak`, `formatoptions`, `tabstop`, `shiftwidth`, the `comments` tweaks. Display and editing options, mechanism neutral.
- `section-wordcount.nvim`, `ltex_extra.nvim`. Fine.

### Step 5. Get render-markdown.nvim actually loading

It reported "no namespace", meaning it never rendered. Check `:Lazy` for an install or load error, then `:checkhealth render_markdown`, then `:RenderMarkdown enable` while on a markdown buffer.
Likely causes: not installed yet (`:Lazy sync`), or an error on setup, or the `ft` lazy trigger.
render-markdown is extmark based, which is exactly what the gneovim island consumes. Once it works it becomes your main markdown display layer (heading icons, bullets, code block backgrounds, quote bars, table formatting), and treesitter conceal handles the rest.
Note the current gneovim limitation: the island does not render virtual text yet, so render-markdown's icons and backgrounds will not show in the island until that slice lands. Its conceal will.

### Step 6. Optional, a markdown LSP

If you want link and heading navigation and workspace symbols across your notes, add `marksman`.
For grammar you already have `ltex` via `ltex_extra.nvim`; `harper-ls` is a lighter, fully local alternative worth trying.
None of this affects the island rendering. Diagnostics show in the gneovim grid, hover floats render on the grid.

### End state for markdown

- treesitter: highlighting, folding, conceal of standard markers, code block injection
- render-markdown: icons, bullets, backgrounds, tables, and its own conceal
- a small Lua extmark module: your `{==...==}` and `{= =}` constructs
- ftplugin: `conceallevel`, `concealcursor`, `spell`, wrap and indent options, your mappings
- no builtin markdown regex syntax, no `markdown_syntax_conceal`, no `markdown_folding`

## Whole config direction

### `additional_vim_regex_highlighting`

Treat a non empty value here as a smell. For every language with a maintained parser, treesitter should be the sole highlighter. The known reasons to keep regex syntax on top are narrow (a few embedded language edge cases, or a filetype whose parser is weak). Audit the list, remove entries, and only add one back when you can point at a concrete rendering bug it fixes.

### Parsers

Move `ensure_installed` to the set you actually edit (add at least `bash`, `json`, `yaml`, `toml`, `python`, `lua`, `diff`, `gitcommit`), or set `auto_install = true` and let it fetch on demand.

### nvim-treesitter branch

You are on the `master` branch API (`require('nvim-treesitter.configs').setup{...}`). There is a `main` branch rewrite with a smaller API and no central `setup`. `master` still works and is the safe choice today. If you are doing a clean overhaul anyway, read the `main` branch README so you know what is coming, but you do not have to switch now.

### Folding

`foldmethod=expr` with `foldexpr=v:lua.vim.treesitter.foldexpr()` is the modern default. You have it for markdown. You can set it globally and let filetypes without a parser fall back. Pair it with `foldtext=v:lua.vim.treesitter.foldtext()` for nicer fold lines. Consider `set foldlevelstart=99` so files open unfolded.

### Indentation

Treesitter indent (`indents.scm`, enabled via the `indent` module) is good for many languages and still rough for a few (notably some template and whitespace sensitive ones). Enable it, and override `indentexpr` per ftplugin only where it misbehaves.

### LSP

On Neovim 0.11 and later the native pattern is `vim.lsp.config('name', {...})` plus `vim.lsp.enable({ 'name', ... })`, which removes most of the old `nvim-lspconfig` boilerplate. `nvim-lspconfig` is still fine and still useful for its default server definitions. Either way the mental model is: one server per language, started per project root, providing diagnostics, navigation, completion, actions. Keep it separate in your head from treesitter.

### Completion

If you have not already, the current common stack is `blink.cmp` (or `nvim-cmp`) fed by LSP, buffer, path, and snippet sources. Orthogonal to this overhaul, but it is the third leg with treesitter and LSP.

## How to do it without breaking your daily driver

- You already keep `init-old.lua`. Good. Do the work on a git branch of your config.
- Go filetype by filetype, markdown first since that is what gneovim needs. Get markdown clean and dogfood it for a few days before touching other languages.
- After each removal, open a representative file and diff the look against the old config. Treesitter highlight group names differ from the old `markdown*` names, so your colorscheme may need a few `@markup.*` tweaks.
- Point gneovim at the new config once markdown is stable, and use the island as one of your test surfaces.

## Open decisions

1. `{==...==}` and `{= =}`: a Lua extmark module (recommended, works in the island), a treesitter query extension (only if you extend the grammar), or a minimal kept `after/syntax`.
2. List marker conceal: render-markdown bullet, query override, or drop it.
3. `outlinex`: confirm the markdown parser registration is enough once regex syntax is off, or keep a thin syntax file for the parts the markdown grammar does not cover.
4. nvim-treesitter `master` versus reading ahead to `main`.
5. Whether to add `marksman` and swap `ltex` for `harper-ls`.
