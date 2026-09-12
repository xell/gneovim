# Markdown live preview plugin integration

Gneovim's CM6 Markdown island replaces the Neovim grid for a window, while the buffer and Neovim remain authoritative. Plugins that draw their own extmarks, conceal, virtual text, or virtual lines can therefore be redundant or visually incompatible with live preview.

## The signal

Whenever a Markdown window changes mode, Gneovim updates `w:gnv_md_preview` and emits:

```text
User GneovimMarkdownPreviewChanged
```

The autocmd receives:

```lua
event.data = {
  win = 1000,       -- Neovim window id
  buf = 12,         -- buffer id
  preview = true,   -- true: CM6 island; false: normal grid
}
```

The event is emitted for the initial auto selected state and after an actual `:MarkdownLivePreviewOn`, `Off`, or `Toggle` transition. Repeating a command that leaves the state unchanged does not emit an event.

Gneovim deliberately emits only this generic signal. It does not know, load, configure, or depend on user plugins. User configuration chooses which plugin APIs to call.

## Buffer scope

`w:gnv_md_preview` is window local, but many visual plugins store their decorations as buffer extmarks and expose buffer scoped enablement. A single buffer visible in both a grid window and an island cannot have such a plugin enabled in only one of those windows.

The safe policy used by the examples is: if any visible window for a buffer is in CM6 preview, disable the plugin for that entire buffer. It re enables when all views return to the grid.

## IBL

Place this after `require("ibl").setup(...)`:

```lua
vim.api.nvim_create_autocmd("User", {
  pattern = "GneovimMarkdownPreviewChanged",
  callback = function(event)
    require("ibl").setup_buffer(event.data.buf, {
      enabled = not event.data.preview,
    })
  end,
})
```

IBL's `setup_buffer` clears its indent guide extmarks when disabled and restores its normal configuration when grid rendering resumes.

## render-markdown.nvim

Do not use render markdown's `ignore` option for toggling. `ignore` prevents the plugin from attaching, which makes later re enablement unreliable. Let it attach, then call its per buffer API:

```lua
local render_markdown = require("render-markdown")

local function any_live_preview(buf)
  for _, win in ipairs(vim.fn.win_findbuf(buf)) do
    if vim.w[win].gnv_md_preview == 1 then
      return true
    end
  end
  return false
end

vim.api.nvim_create_autocmd("User", {
  pattern = "GneovimMarkdownPreviewChanged",
  callback = function(event)
    vim.api.nvim_win_call(event.data.win, function()
      render_markdown.set_buf(not any_live_preview(event.data.buf))
    end)
  end,
})
```

`render_markdown.set_buf(false)` clears its buffer extmarks, including virtual text, conceal, and table decorations. That avoids conflicts with the island's own table and image renderers. Its normal rich grid rendering resumes with `set_buf(true)`.

To diagnose an active Markdown buffer:

```vim
:lua local b=vim.api.nvim_get_current_buf(); print(require("render-markdown.state").get(b).enabled)
```

The expected value is `false` in live preview. To verify the marks were cleared:

```vim
:lua local b=vim.api.nvim_get_current_buf(); local ns=vim.api.nvim_get_namespaces()["render-markdown.nvim"]; print(ns and #vim.api.nvim_buf_get_extmarks(b, ns, 0, -1, {}) or 0)
```

After render markdown's debounce period, this should print `0` in live preview.
