-- Injected into every embedded nvim by `bridge::connect` (nvim.exec_lua).
-- GUI protocol glue, NOT a user plugin. Pairs with the `gnv_md_decor` arm in
-- the Rust `handle_notify` and the `md_decor` listener in `src/main.js`.
--
-- Purpose: mirror Neovim's *already computed* per-window display state for a
-- markdown-live-preview window into its CodeMirror island. This script does not
-- reimplement conceal, folds, treesitter, syntax, or render-markdown.nvim. It
-- reads their results with built-in calls (synconcealed, the treesitter
-- highlights query, nvim_buf_get_extmarks, and later nvim_get_hl / foldclosed
-- / getpos) and forwards a compact payload.
--
-- First slice: inline conceal only. synconcealed() is :syntax-only on every
-- Neovim version, so conceal is a union of three reads: synconcealed() for
-- :syntax, the treesitter highlights-query `conceal` metadata for treesitter,
-- and extmark `conceal` for render-markdown and friends. Highlights, folds and
-- the visual range extend the payload in later slices.
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
-- Union of three sources. synconcealed() reports :syntax conceal only, on every
-- Neovim version, so it cannot stand alone: the treesitter query and the
-- extmark scan cover the rest. Neither the query nor synconcealed() honour
-- 'concealcursor', so the cursor-line guard is applied here to every source.
-- The client sorts and drops overlaps, so duplicate runs across sources are
-- harmless.
local function collect_conceal(win, buf, first, last)
  local cl = vim.wo[win].conceallevel
  if cl == 0 then
    return {}
  end

  -- conceallevel: 1 -> cchar or a space; 2 -> cchar or nothing; 3 -> nothing.
  -- synconcealed()'s replacement string already follows these rules, so it is
  -- passed through; the raw treesitter / extmark cchar goes through text_for.
  local function text_for(cchar)
    local has = cchar ~= nil and cchar ~= ''
    if cl >= 3 then
      return ''
    elseif cl == 2 then
      return has and cchar or ''
    end
    return has and cchar or ' '
  end

  -- Conceal is suppressed on the window's own cursor line unless 'concealcursor'
  -- names the current mode.
  local guard_row
  local mc = vim.api.nvim_get_mode().mode:sub(1, 1):lower()
  if mc == '\22' then
    mc = 'v'
  end
  if not tostring(vim.wo[win].concealcursor):find(mc, 1, true) then
    guard_row = vim.api.nvim_win_get_cursor(win)[1] - 1
  end

  local out = {}
  local function add(row, sc, ec, text)
    if row ~= guard_row and ec > sc then
      out[#out + 1] = { row, sc, ec, text }
    end
  end

  -- 1. :syntax conceal, via synconcealed() over the viewport.
  local lines = vim.api.nvim_buf_get_lines(buf, first, last + 1, false)
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
            add(row, rs, col - 1, rtext)
            rs, rid, rtext = col - 1, r[3], r[2]
          end
        elseif rs ~= nil then
          add(row, rs, col - 1, rtext)
          rs = nil
        end
      end
      if rs ~= nil then
        add(row, rs, #line, rtext)
      end
    end
  end)

  -- 2. treesitter conceal, from the `conceal` metadata on the highlights query
  -- (the same query the treesitter highlighter reads). Walk the base language
  -- tree and every injected one.
  pcall(function()
    local parser = vim.treesitter.get_parser(buf)
    if not parser then
      return
    end
    parser:parse({ first, last })
    local function walk(ltree)
      local q = vim.treesitter.query.get(ltree:lang(), 'highlights')
      if q then
        for _, tstree in pairs(ltree:trees()) do
          for id, node, meta in q:iter_captures(tstree:root(), buf, first, last + 1) do
            local cc = (meta[id] and meta[id].conceal) or meta.conceal
            if cc ~= nil then
              local sr, sc, er, ec = node:range()
              if sr == er then
                add(sr, sc, ec, text_for(cc))
              end
            end
          end
        end
      end
      for _, child in pairs(ltree:children()) do
        walk(child)
      end
    end
    walk(parser)
  end)

  -- 3. real extmark conceal (render-markdown and similar). Single line only.
  local marks =
    vim.api.nvim_buf_get_extmarks(buf, -1, { first, 0 }, { last, -1 }, { details = true })
  for _, mk in ipairs(marks) do
    local row, col, d = mk[2], mk[3], mk[4]
    if d and d.conceal ~= nil and d.end_row == row and d.end_col and d.end_col > col then
      add(row, col, d.end_col, text_for(d.conceal))
    end
  end

  return out
end

-- The visual / select range for `win`, as { {row, start_byte, end_byte}, ... }
-- per line, clamped to the padded viewport. Only meaningful when `win` is the
-- current window and it is in a visual or select mode.
local function collect_visual(win, first, last)
  if win ~= vim.api.nvim_get_current_win() then
    return {}
  end
  local mc = vim.api.nvim_get_mode().mode:sub(1, 1)
  local linewise = mc == 'V' or mc == 'S'
  local blockwise = mc == '\22' or mc == '\19'
  if not (linewise or blockwise or mc == 'v' or mc == 's') then
    return {}
  end

  local a, b = vim.fn.getpos('v'), vim.fn.getpos('.') -- {bufnum, lnum, col, off}
  local sl, sc, el, ec = a[2], a[3], b[2], b[3]
  if sl > el or (sl == el and sc > ec) then
    sl, sc, el, ec = el, ec, sl, sc
  end

  local lo = math.max(sl - 1, first) -- 0-based rows
  local hi = math.min(el - 1, last)
  if hi < lo then
    return {}
  end
  local lines = vim.api.nvim_buf_get_lines(0, lo, hi + 1, false)
  local lb, rb = math.min(sc, ec), math.max(sc, ec)
  local runs = {}
  for i, line in ipairs(lines) do
    local row = lo + i - 1
    local s0, e0
    if linewise then
      s0, e0 = 0, #line
    elseif blockwise then
      s0, e0 = lb - 1, rb - 1 + #vim.fn.strpart(line, rb - 1, 1, true)
    else
      s0 = (row == sl - 1) and (sc - 1) or 0
      e0 = (row == el - 1) and (ec - 1 + #vim.fn.strpart(line, ec - 1, 1, true)) or #line
    end
    s0 = math.max(s0, 0)
    e0 = math.min(e0, #line)
    if e0 > s0 then
      runs[#runs + 1] = { row, s0, e0 }
    end
  end
  return runs
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
    visual = collect_visual(win, first, last),
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
