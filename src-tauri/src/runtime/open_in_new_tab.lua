-- Injected into every embedded nvim by `bridge::connect` (nvim.exec_lua).
-- NOT a user plugin: it is GUI protocol glue and must match the Rust
-- `handle_notify` `gnv_open_new_tab` arm and `BridgeEvent::OpenNewTab`.
-- Arg: (channel).
--
--   :OpenInNewGneovimTab                 move the current buffer into a fresh
--                                        gui-tab: write it if it is a modified
--                                        file (or carry the text if it has no
--                                        name), reopen it there, then wipe it
--                                        from this session.
--   :OpenInNewGneovimTab f1 f2 ...       open a fresh gui-tab with each file in
--                                        its own Neovim tabpage; this session
--                                        is left untouched.
--
-- `_G.OpenInNewGneovimTab(files)` is the same, for scripts: pass a path, a list
-- of paths, or nil / {} for the move-the-current-buffer behaviour.

local chan = ...

-- pcall'd so a dead channel never aborts the command or its caller.
local function notify_open(spec)
  pcall(vim.rpcnotify, chan, 'gnv_open_new_tab', spec)
end

-- Strip one layer of matching surrounding quotes. The command path already
-- de-quotes via parse_args; this is a safety net for a direct caller that
-- passes e.g. { '"a.md"' }.
local function unquote(s)
  local q = s:sub(1, 1)
  if (q == '"' or q == "'") and #s >= 2 and s:sub(-1) == q then
    return s:sub(2, -2)
  end
  return s
end

local function abspath(f)
  return vim.fn.fnamemodify(vim.fn.expand(f), ':p')
end

-- Split a raw command-argument string into paths, honouring "double" and
-- 'single' quoted groups. nargs='*' / <f-args> otherwise splits on every space,
-- including ones inside quotes, so `:OpenInNewGneovimTab "a b.md"` would arrive
-- as two broken args.
local function parse_args(raw)
  local out, i, n = {}, 1, #raw
  while i <= n do
    local c = raw:sub(i, i)
    if c:match('%s') then
      i = i + 1
    elseif c == '"' or c == "'" then
      local j = raw:find(c, i + 1, true)
      if not j then
        out[#out + 1] = raw:sub(i + 1)
        break
      end
      out[#out + 1] = raw:sub(i + 1, j - 1)
      i = j + 1
    else
      local j = raw:find('%s', i) or (n + 1)
      out[#out + 1] = raw:sub(i, j - 1)
      i = j
    end
  end
  return out
end

--- Open one or more files in a brand-new gneovim gui-tab.
--- @param files string|string[]|nil
---   * a path or a list of paths -> a new gui-tab with each file in its own
---     Neovim tabpage; nothing in this session is touched.
---   * nil or {} -> move the *current* buffer: write it if it is a modified file
---     (or carry its text if it has no name), reopen it in a new gui-tab, then
---     wipe it from this session.
--- @return boolean ok  false only if a write failed (nothing was sent / wiped)
function _G.OpenInNewGneovimTab(files)
  if type(files) == 'string' then
    files = { files }
  end

  if files and #files > 0 then
    local paths = {}
    for _, f in ipairs(files) do
      paths[#paths + 1] = abspath(unquote(f))
    end
    notify_open({ paths = paths })
    return true
  end

  -- No files: act on the current buffer.
  local buf = vim.api.nvim_get_current_buf()
  local name = vim.api.nvim_buf_get_name(buf)

  if name ~= '' then
    if vim.bo[buf].modified then
      local ok, e = pcall(vim.api.nvim_buf_call, buf, function()
        vim.cmd('write')
      end)
      if not ok then
        vim.notify(
          'OpenInNewGneovimTab: write failed: ' .. tostring(e),
          vim.log.levels.ERROR
        )
        return false
      end
    end
    notify_open({ paths = { vim.fn.fnamemodify(name, ':p') } })
  else
    -- [No Name] buffer: there is no file to reopen, carry the text across.
    notify_open({ content = vim.api.nvim_buf_get_lines(buf, 0, -1, false) })
  end

  -- Drop it from this session. bwipeout! because it is unnamed or, in the rare
  -- post-write race, still marked modified. If it was the last buffer Neovim
  -- opens a fresh [No Name]; the now-empty gui-tab is left for the user to close.
  pcall(vim.cmd, 'bwipeout! ' .. buf)
  return true
end

vim.api.nvim_create_user_command('OpenInNewGneovimTab', function(o)
  _G.OpenInNewGneovimTab(parse_args(o.args))
end, {
  nargs = '*',
  complete = 'file',
  desc = 'gneovim: open buffer(s) in a new gui-tab',
})
