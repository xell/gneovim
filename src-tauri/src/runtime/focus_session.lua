-- Injected into every embedded nvim by `bridge::connect` (nvim.exec_lua).
-- NOT a user plugin: it is GUI protocol glue and must match the Rust
-- `handle_notify` `gnv_focus_session` arm, `BridgeEvent::FocusSession` and
-- `focus_session` in lib.rs. Arg: (channel).
--
--   :GneovimFocusSession {addr}   bring the gui-window whose Neovim listens on
--                                 {addr} to the front. {addr} is a server
--                                 address (another Neovim's `v:servername`),
--                                 e.g. one from `serverlist({ peer = true })`,
--                                 which is also what it completes.
--
-- `_G.GneovimFocusSession(addr)` is the same, for scripts (a session picker).
-- Each gui-window runs its own Neovim, so this is the gneovim way to switch
-- sessions; `:connect` would detach this window's UI and lose the window. It
-- never attaches anything to {addr}: when no gui-window runs that Neovim (one
-- in a terminal, say), it only warns here.

local chan = ...

function _G.GneovimFocusSession(addr)
  if type(addr) ~= 'string' or addr == '' then
    error('GneovimFocusSession: expected a server address', 2)
  end
  -- pcall'd so a dead channel never aborts the caller.
  pcall(vim.rpcnotify, chan, 'gnv_focus_session', addr)
end

vim.api.nvim_create_user_command('GneovimFocusSession', function(o)
  _G.GneovimFocusSession(o.args)
end, {
  nargs = 1,
  complete = function(lead)
    local ok, addrs = pcall(vim.fn.serverlist, { peer = true })
    if not ok then
      return {}
    end
    return vim.tbl_filter(function(a) return vim.startswith(a, lead) end, addrs)
  end,
  desc = 'gneovim: bring the window running the Neovim at this address to the front',
})

-- `Bridge::serves`: is `addr` one of this Neovim's own addresses?
function _G.__gnv_serves(addr)
  for _, a in ipairs(vim.fn.serverlist()) do
    if a == addr or vim.fn.resolve(a) == vim.fn.resolve(addr) then
      return true
    end
  end
  return false
end

-- `Bridge::no_session`: no gui-window runs the Neovim at `addr`. Scheduled,
-- so the message is drawn as ordinary main loop output, not inside the RPC.
function _G.__gnv_no_session(addr)
  vim.schedule(function()
    vim.notify('gneovim: no gneovim window runs the Neovim at ' .. addr, vim.log.levels.WARN)
  end)
end
