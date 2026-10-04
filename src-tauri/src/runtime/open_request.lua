-- Injected into every embedded nvim by `bridge::connect` (nvim.exec_lua).
-- NOT a user plugin: it is GUI protocol glue for `gneovim://file/...` URLs and
-- the `gneovim` CLI shim, called from the Rust `Bridge::*_file` methods via
-- `_G.__gneovim_open`. No args.
--
-- Occupied files: a gneovim window's nvim holding the file is handled from
-- Rust (`holds` / `reveal` / `release` on the holder's bridge). An outside
-- nvim is only visible through its swap file, so `open` sets the one-shot
-- `g:gneovim_swap_policy` ('readonly' | 'takeover') around its `:edit` and the
-- SwapExists handler below answers from it instead of prompting. A user
-- SwapExists handler that prompts should return early while that variable is
-- set (see docs/neovim-api-surface.md).

local M = {}
_G.__gneovim_open = M

-- Resolves symlinks (macOS /tmp -> /private/tmp) so both forms compare equal.
local function canonical(path)
  return vim.uv.fs_realpath(path) or vim.fn.fnamemodify(path, ':p')
end

local function find_buf(path)
  local target = canonical(path)
  for _, b in ipairs(vim.api.nvim_list_bufs()) do
    if vim.api.nvim_buf_is_loaded(b) then
      local name = vim.api.nvim_buf_get_name(b)
      if name ~= '' and vim.bo[b].buftype == '' and canonical(name) == target then
        return b
      end
    end
  end
end

-- Rust sends an absent field as msgpack nil, which arrives as vim.NIL: a
-- truthy userdata, not Lua nil.
local function arg(v)
  if v == vim.NIL then return nil end
  return v
end

local function set_cursor(line, col)
  if line then
    pcall(vim.fn.cursor, line, col or 1)
    pcall(vim.cmd, 'normal! zv')
  end
end

-- Scheduled: a message during `:edit` or a SwapExists callback can otherwise
-- land as a hit-enter prompt.
local function notify(msg, level)
  vim.schedule(function()
    vim.notify('gneovim: ' .. msg, level or vim.log.levels.WARN)
  end)
end

function M.holds(path)
  return find_buf(path) ~= nil
end

-- Jump to the loaded buffer: its window if it has one (switching tabpage),
-- else a new tabpage showing it.
function M.reveal(path, line, col)
  line, col = arg(line), arg(col)
  local b = find_buf(path)
  if not b then return false end
  local wins = vim.fn.win_findbuf(b)
  if #wins > 0 then
    vim.api.nvim_set_current_win(wins[1])
  else
    vim.cmd('tab sbuffer ' .. b)
  end
  set_cursor(line, col)
  return true
end

-- Give the buffer up for another nvim: save it if modified, park its windows on
-- an explanatory scratch buffer (so splits survive), then :bdelete it, which
-- also removes its swap file. 'OK' or 'ERR:<why>'; on any error the buffer is
-- left loaded. Same contract as swap_takeover.lua's remote_save/remote_release.
function M.release(path)
  local ok, res = pcall(function()
    local b = find_buf(path)
    if not b then return 'OK' end
    if vim.bo[b].modified then
      local werr
      vim.api.nvim_buf_call(b, function()
        local wok, e = pcall(vim.cmd, 'silent write')
        if not wok then werr = e end
      end)
      if werr then return 'ERR:write failed: ' .. tostring(werr) end
    end
    if vim.bo[b].modified then return 'ERR:still modified' end

    local wins = vim.fn.win_findbuf(b)
    if #wins > 0 then
      local scratch = vim.api.nvim_create_buf(false, true)
      vim.bo[scratch].bufhidden = 'wipe'
      vim.api.nvim_buf_set_lines(scratch, 0, -1, false, {
        vim.api.nvim_buf_get_name(b) .. ' was taken over by another gneovim window',
      })
      vim.bo[scratch].modifiable = false
      vim.bo[scratch].modified = false
      for _, win in ipairs(wins) do
        vim.api.nvim_win_set_buf(win, scratch)
      end
    end
    local dok, e = pcall(vim.api.nvim_buf_delete, b, { force = false })
    if not dok then return 'ERR:' .. tostring(e) end
    return 'OK'
  end)
  if not ok then return 'ERR:' .. tostring(res) end
  return res
end

--- Open a file for a URL / CLI request.
--- @param o table { path, line?, col?, readonly?, swap?, notice?, tab? }
---   tab: open as a new tabpage, reusing a still pristine [No Name] tab
---   (like open_files_as_tabs); otherwise `:edit` in the current window.
function M.open(o)
  for k, v in pairs(o) do o[k] = arg(v) end
  local cmd = 'edit'
  if o.tab then
    local buf = vim.api.nvim_get_current_buf()
    local pristine = vim.api.nvim_buf_get_name(buf) == ''
      and not vim.bo[buf].modified
      and #vim.api.nvim_list_tabpages() == 1
      and #vim.api.nvim_tabpage_list_wins(0) == 1
    if not pristine then cmd = 'tabedit' end
  end

  vim.g.gneovim_swap_policy = o.swap
  local ok, err = pcall(vim.cmd, { cmd = cmd, args = { o.path } })
  vim.g.gneovim_swap_policy = nil
  if not ok then
    -- E325 here means the swap question was answered "quit".
    notify(tostring(err))
    return false
  end
  if o.readonly then vim.bo.readonly = true end
  set_cursor(o.line, o.col)
  if o.notice then notify(o.notice) end
  return true
end

vim.api.nvim_create_autocmd('SwapExists', {
  group = vim.api.nvim_create_augroup('gnv_open_request', { clear = true }),
  callback = function()
    local policy = vim.g.gneovim_swap_policy
    if not policy then return end
    local info = vim.fn.swapinfo(vim.v.swapname)
    local pid = tonumber(info.pid) or 0
    local host = vim.uv.os_gethostname()
    -- The swap header truncates long host names, hence the prefix match.
    local same_host = (info.host or '') == '' or host:sub(1, #info.host) == info.host
    if same_host and (pid == 0 or not vim.uv.kill(pid, 0)) then
      -- Stale swap file: a recovery question, never answered for the user.
      return
    end
    if policy == 'takeover' then
      notify(string.format(
        '%s is held by a Neovim outside gneovim (pid %s); opened readonly',
        vim.fn.fnamemodify(vim.fn.expand('<afile>'), ':~'), info.pid or '?'))
    end
    vim.v.swapchoice = 'o'
  end,
})
