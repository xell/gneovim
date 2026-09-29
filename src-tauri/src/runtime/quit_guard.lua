-- Injected into every embedded nvim by `bridge::connect` (nvim.exec_lua).
-- NOT a user plugin: it is GUI protocol glue and must match the Rust
-- `handle_notify` `gnv_quit_request` arm and `BridgeEvent::QuitRequest`.
--
-- `ZZ` writes the current buffer (if modified) and closes the window; on the
-- last window of the last tabpage that ends the whole Neovim session. Left
-- alone, that quit runs with none of Cmd+W's protection: no confirmation
-- even when `confirm_close` asks for one, and any interactive prompt nvim
-- would otherwise show (e.g. a live `:terminal` job) can't render in this
-- embedded UI and would just hang it. `QuitPre` cannot stop the quit either,
-- confirmed empirically (throwing inside it does not abort `:quit`). So
-- catch it before nvim's own quit machinery ever runs: remap `ZZ` itself,
-- and when it would end the session, hand off to Rust's `guard_close`
-- (the same function Cmd+W's `WindowEvent::CloseRequested` calls) instead of
-- quitting here. It decides whether to warn and, if confirmed, quits this
-- nvim itself via `quit_all`.
--
-- Arg: (channel).

local chan = ...

vim.keymap.set('n', 'ZZ', function()
  if vim.fn.tabpagenr('$') == 1 and vim.fn.winnr('$') == 1 then
    pcall(vim.rpcnotify, chan, 'gnv_quit_request')
  else
    vim.cmd('x')
  end
end, { silent = true, desc = 'gneovim: route session-ending ZZ through the Cmd+W close guard' })
