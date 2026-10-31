-- Injected into every embedded nvim by `bridge::connect` (nvim.exec_lua).
-- NOT a user plugin: it is GUI protocol glue for `gneovim://action/<name>`
-- URLs and `gneovim --action <name>`, called from the Rust `Bridge::action`
-- via `_G.__gnv_action`. No args.
--
--   User GneovimAction   fired with `data = { name = <name> }`. The user's own
--                        handler decides what the action does. The name is
--                        all there is: any web page can fire the URL, so it
--                        never carries arguments.

local function warn(msg)
  vim.notify('gneovim: ' .. msg, vim.log.levels.WARN)
end

local function dispatch(name)
  if #vim.api.nvim_get_autocmds({ event = 'User', pattern = 'GneovimAction' }) == 0 then
    warn(string.format('no User GneovimAction handler for action %q', name))
    return
  end
  local ok, err = pcall(vim.api.nvim_exec_autocmds, 'User', {
    pattern = 'GneovimAction',
    modeline = false,
    data = { name = name },
  })
  if not ok then
    warn(string.format('action %q failed: %s', name, tostring(err)))
  end
end

function _G.__gnv_action(name)
  -- Wait until this Neovim has finished starting and the GUI is attached.
  -- Under `--embed --headless` Neovim runs no `exec_lua` before the user's
  -- config has loaded, so the handler already exists by the time Rust gets
  -- here; but a freshly spawned gui-window attaches its UI later, and
  -- anything a handler shows before that (a vim.notify, say) is drawn to a
  -- screen the GUI never receives. Re-checked from the autocmd, so VimEnter
  -- can still lead to UIEnter.
  if vim.v.vim_did_enter == 0 or #vim.api.nvim_list_uis() == 0 then
    vim.api.nvim_create_autocmd(vim.v.vim_did_enter == 0 and 'VimEnter' or 'UIEnter', {
      once = true,
      nested = true,
      callback = function() _G.__gnv_action(name) end,
    })
    return
  end
  -- Scheduled, so the RPC call returns at once (a handler waiting for input
  -- cannot hold up the GUI) and the handler runs as ordinary main loop code,
  -- not inside an API request.
  vim.schedule(function() dispatch(name) end)
end
