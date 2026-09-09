-- Injected into every embedded nvim by `bridge::connect` (nvim.exec_lua).
-- GUI protocol glue, NOT a user plugin. Pairs with the `gnv_md_decor` arm in
-- the Rust `handle_notify` and the `md_decor` listener in `src/main.js`.
--
-- Purpose: mirror Neovim's *already computed* per-window display state for a
-- markdown-live-preview window into its CodeMirror island. This script does not
-- reimplement conceal, folds, treesitter, syntax, or render-markdown.nvim. It
-- reads their results with built-in calls (nvim_buf_get_extmarks, and later
-- nvim_get_hl / foldclosed / getpos) and forwards a compact payload.
--
-- First slice: inline conceal only (`conceallevel` / `concealcursor`, the
-- extmark `conceal` field). Highlights, folds and the visual range extend the
-- payload in later slices.
--
-- Args: (channel).

local chan = ...

local PAD = 40 -- extra buffer rows queried around the window viewport

local function preview_on(win)
  if not vim.api.nvim_win_is_valid(win) then
    return false
  end
  -- `w:gnv_md_preview` is maintained by md_preview.lua: 1 while the window is a
  -- live-preview markdown window, 0 or unset for a grid window. This is the
  -- guard that keeps the augroup inert for grid windows.
  local ok, v = pcall(vim.api.nvim_win_get_var, win, 'gnv_md_preview')
  return ok and v == 1
end

-- Inline conceal segments for `win` over the padded viewport, as
-- { {row, start_byte, end_byte, text}, ... } in absolute buffer coordinates.
-- Byte columns; the client converts to UTF-16 offsets against its own copy.
local function collect_conceal(win, buf, first, last)
  local wo = vim.wo[win]
  local cl = wo.conceallevel
  if cl == 0 then
    return {}
  end
  -- conceallevel 1 shows the cchar (or a space); 2 and 3 show nothing.
  local text_for = cl >= 2 and function()
    return ''
  end or function(cchar)
    return (cchar ~= nil and cchar ~= '') and cchar or ' '
  end

  -- Conceal is suppressed on the window's own cursor line unless
  -- 'concealcursor' names the current mode.
  local guard_row = nil
  if not tostring(wo.concealcursor):find(vim.fn.mode():sub(1, 1), 1, true) then
    guard_row = vim.api.nvim_win_get_cursor(win)[1] - 1 -- 0-based
  end

  local marks =
    vim.api.nvim_buf_get_extmarks(buf, -1, { first, 0 }, { last, -1 }, { details = true })
  local out = {}
  for _, m in ipairs(marks) do
    local row, col, d = m[2], m[3], m[4]
    -- a conceal extmark carries a `conceal` string (possibly ""). Single-line
    -- only for now; multi-line conceal marks are rare in markdown.
    if
      d
      and d.conceal ~= nil
      and d.end_row == row
      and d.end_col ~= nil
      and d.end_col > col
      and guard_row ~= row
    then
      out[#out + 1] = { row, col, d.end_col, text_for(d.conceal) }
    end
  end
  return out
end

local function push(win)
  local buf = vim.api.nvim_win_get_buf(win)
  local info = vim.fn.getwininfo(win)[1]
  if not info then
    return
  end
  local n = vim.api.nvim_buf_line_count(buf)
  local first = math.max((info.topline or 1) - 1 - PAD, 0)
  local last = math.min((info.botline or info.topline or 1) + PAD, n - 1)
  local payload = {
    first = first,
    last = last,
    conceal = collect_conceal(win, buf, first, last),
  }
  pcall(vim.rpcnotify, chan, 'gnv_md_decor', win, vim.json.encode(payload))
end

local pending = false
local function flush()
  pending = false
  for _, win in ipairs(vim.api.nvim_list_wins()) do
    if preview_on(win) then
      pcall(push, win)
    end
  end
end

-- Debounced: many of the trigger events fire in bursts (holding `j`, a paste).
local function schedule()
  if pending then
    return
  end
  pending = true
  vim.defer_fn(flush, 20)
end

-- One always-registered augroup. It fires on every matching event, but the
-- per-window `preview_on` guard makes the work skip grid windows entirely, so
-- the cost for a non-preview window is one variable read. Toggling preview
-- on/off never touches this augroup; md_preview.lua flips the flag it reads.
local grp = vim.api.nvim_create_augroup('gnv_md_decor', { clear = true })
vim.api.nvim_create_autocmd({
  'CursorMoved',
  'CursorMovedI',
  'TextChanged',
  'TextChangedI',
  'WinScrolled',
  'ModeChanged',
  'WinEnter',
  'BufWinEnter',
}, { group = grp, callback = schedule })
vim.api.nvim_create_autocmd('OptionSet', {
  group = grp,
  pattern = { 'conceallevel', 'concealcursor' },
  callback = schedule,
})
