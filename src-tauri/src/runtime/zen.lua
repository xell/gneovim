-- Injected into every embedded nvim by `bridge::connect` (nvim.exec_lua).
-- NOT a user plugin: it is GUI protocol glue and must match the Rust
-- `handle_notify` `gnv_zen` arm, `BridgeEvent::Zen` and `Bridge::zen_changed`.
--
-- View > Zen Mode (Cmd+Option+Z) hides this gui-window's native tab bar and
-- traffic lights. This file is the Neovim side of it:
--
--   :GneovimZenOn / Off / Toggle   the same as the menu item. On and Off are
--                                  no-ops when zen is already in that state,
--                                  so a `User GneovimZenEnter` handler may
--                                  call :GneovimZenOn without looping.
--   User GneovimZenEnter / Leave   fired after the GUI changed its chrome,
--                                  however zen was triggered (menu, shortcut
--                                  or command); never for a no-op.
--   g:gneovim_zen                  true while this gui-window is in zen.
--
-- Arg: (channel).

local chan = ...

vim.g.gneovim_zen = false

local function request(state)
  return function()
    pcall(vim.rpcnotify, chan, 'gnv_zen', state)
  end
end

vim.api.nvim_create_user_command('GneovimZenOn', request('on'),
  { desc = 'gneovim: enter zen mode (hide the native tab bar and traffic lights)' })
vim.api.nvim_create_user_command('GneovimZenOff', request('off'),
  { desc = 'gneovim: leave zen mode' })
vim.api.nvim_create_user_command('GneovimZenToggle', request('toggle'),
  { desc = 'gneovim: toggle zen mode' })

-- Called by Rust after zen actually changed.
function _G.__gnv_zen_changed(on)
  vim.g.gneovim_zen = on
  vim.api.nvim_exec_autocmds('User', {
    pattern = on and 'GneovimZenEnter' or 'GneovimZenLeave',
    modeline = false,
  })
end
