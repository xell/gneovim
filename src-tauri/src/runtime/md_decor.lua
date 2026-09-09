-- Injected into every embedded nvim by `bridge::connect` (nvim.exec_lua).
-- GUI protocol glue, NOT a user plugin. Pairs with the `gnv_md_decor` arm in
-- the Rust `handle_notify` and the `md_decor` listener in `src/main.js`.
--
-- Purpose: mirror Neovim's *already computed* per-window display state for a
-- markdown-live-preview window into its CodeMirror island. This script does not
-- reimplement conceal, folds, treesitter, syntax, or render-markdown.nvim. It
-- reads their results with built-in calls (synconcealed, and later nvim_get_hl
-- / foldclosed / getpos) and forwards a compact payload.
--
-- First slice: inline conceal only, via synconcealed() (covers :syntax,
-- treesitter and extmark conceal alike). Highlights, folds and the visual
-- range extend the payload in later slices.
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

-- Inline conceal runs for `win` over the padded viewport, as
-- { {row, start_byte, end_byte, text}, ... } in absolute buffer coordinates
-- (byte columns; the client converts to UTF-16 against its own copy).
--
-- Source is synconcealed(): the effective per-cell conceal Neovim would
-- display. It already folds in :syntax conceal, treesitter conceal and extmark
-- conceal, and already honours conceallevel / concealcursor, so this function
-- special-cases none of them. r = { concealed(0/1), replacement, region_id };
-- cells with the same region_id are one run (one cchar for the whole run).
local function collect_conceal(win, buf, first, last)
  if vim.wo[win].conceallevel == 0 then
    return {}
  end
  -- Make sure treesitter has parsed the padded range, so synconcealed() is
  -- right for the rows just outside Neovim's own viewport that the island
  -- (taller lines, so it shows fewer) can still have on screen.
  pcall(function()
    local p = vim.treesitter.get_parser(buf)
    if p then
      p:parse({ first, last })
    end
  end)

  local lines = vim.api.nvim_buf_get_lines(buf, first, last + 1, false)
  local out = {}
  vim.api.nvim_win_call(win, function()
    for i, line in ipairs(lines) do
      local row = first + i - 1
      local lnum = row + 1
      local rs, rid, rtext -- open run: start byte (0-based), region id, text
      for col = 1, #line do
        local r = vim.fn.synconcealed(lnum, col)
        if r[1] == 1 then
          if rs == nil then
            rs, rid, rtext = col - 1, r[3], r[2]
          elseif r[3] ~= rid then
            out[#out + 1] = { row, rs, col - 1, rtext }
            rs, rid, rtext = col - 1, r[3], r[2]
          end
        elseif rs ~= nil then
          out[#out + 1] = { row, rs, col - 1, rtext }
          rs = nil
        end
      end
      if rs ~= nil then
        out[#out + 1] = { row, rs, #line, rtext }
      end
    end
  end)
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
