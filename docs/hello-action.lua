-- A `hello` action for testing gneovim://action/<name> by hand (see the
-- Actions section of url-scheme-and-cli.md). src-tauri/tests/action.rs covers
-- the same path automatically; this is for checking routing across Spaces
-- in the real app.
--
-- Neovim does not load it from here. Link it into your config's plugin/
-- directory, then restart gneovim:
--
--   ln -s ~/Developer/vim/guis/gneovim/docs/hello-action.lua ~/.config/nvim/plugin/gneovim-hello-action.lua
--
-- Then fire it:
--
--   open "gneovim://action/hello"      (from anywhere, e.g. BetterTouchTool)
--   gneovim --action hello             (from a shell)
--
-- It shows a notification in the gui-window that received the action, naming
-- that Neovim's pid so a newly spawned window is easy to tell apart. Other
-- action names are left to other handlers. Remove the link to check the
-- "no handler" warning.
--
-- No `if vim.g.gneovim` guard: gneovim sets that only after the config has
-- loaded, and the event never fires outside gneovim anyway.

vim.api.nvim_create_autocmd("User", {
  pattern = "GneovimAction",
  nested = true,
  callback = function(ev)
    if ev.data.name ~= "hello" then return end
    vim.notify(string.format("Hello, world! (action %q, Neovim pid %d, %s)",
      ev.data.name, vim.fn.getpid(), os.date("%H:%M:%S")))
  end,
})
