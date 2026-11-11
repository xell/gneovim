-- Injected into every embedded nvim by `bridge::connect` / `bridge::attach`
-- (nvim.exec_lua), after every other runtime file. NOT a user plugin.
-- Arg: (channel).
--
-- When gneovim's UI leaves a Neovim that keeps running (`:detach`, or
-- `:connect`, which is `:detach` for gneovim), undo the glue that misbehaves
-- with nothing on the other end of `chan`:
--
--   the `gnv` autocmds        E475 "Channel doesn't exist" on every cursor move
--   'clipboard' provider      yanks to `+` go nowhere, pastes fail
--   the `ZZ` guard            does nothing on the last window
--   island bridges            per-event and per-redraw work for no one
--   `g:gneovim*`              a config would still think it runs in gneovim
--
-- A terminal Neovim that `:connect`s to the session then gets a plain Neovim;
-- a gui-window that reattaches (`bridge::attach`) injects everything afresh.
-- Commands such as `:GneovimFocusSession` stay; they only `pcall` an
-- rpcnotify, so on their own they do nothing.

local chan = ...

vim.api.nvim_create_autocmd('UILeave', {
  group = vim.api.nvim_create_augroup('gnv_ui_leave', { clear = true }),
  callback = function()
    -- Another UI leaving, or Neovim exiting (nothing left to undo for).
    if vim.v.event.chan ~= chan or vim.v.exiting ~= vim.NIL then
      return
    end
    for _, group in ipairs({ 'gnv', 'gnv_md_preview', 'gnv_md_decor', 'gnv_normal_maps', 'gnv_open_request' }) do
      pcall(vim.api.nvim_del_augroup_by_name, group)
    end
    pcall(vim.api.nvim_set_decoration_provider, vim.api.nvim_create_namespace('gnv_md_decor_watch'), {})
    pcall(vim.keymap.del, 'n', 'ZZ')
    -- Back to Neovim's own clipboard detection (pbcopy on macOS). The reload
    -- recipe is from autoload/provider/clipboard.vim itself.
    vim.g.clipboard = nil
    vim.g.loaded_clipboard_provider = nil
    pcall(vim.cmd, 'runtime autoload/provider/clipboard.vim')
    for _, name in ipairs({ 'gneovim', 'gneovim_version', 'gneovim_aot_window', 'gneovim_zen' }) do
      vim.g[name] = nil
    end
  end,
})
