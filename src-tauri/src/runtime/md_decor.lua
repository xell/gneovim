-- Injected into every embedded nvim by `bridge::connect` (nvim.exec_lua).
-- GUI protocol glue, NOT a user plugin. Pairs with the `gnv_md_decor` arm in
-- the Rust `handle_notify` and the `md_decor` listener in `src/main.js`.
--
-- Purpose: mirror Neovim's *already computed* per-window display state for a
-- markdown-live-preview window into its CodeMirror island. This script does not
-- reimplement conceal, folds, treesitter, syntax, matches, or render-markdown.nvim.
-- It reads their results with built-in calls (synconcealed, the treesitter
-- highlights query, nvim_buf_get_extmarks, getmatches, nvim_get_hl, foldclosed,
-- getpos) and forwards a compact payload.
--
-- Payload keys, all viewport-limited and absolute buffer coordinates:
--   conceal : union of synconcealed() (:syntax), the treesitter highlights
--             query `conceal` metadata, and extmark `conceal`.
--   visual  : the visual / select range.
--   folds   : closed folds (foldclosed / foldtextresult).
--   hl      : { runs, defs } - union of every treesitter capture, hl_group
--             extmark, and :match / matchadd() / matchaddpos() overlay
--             (getmatches()) over the viewport, plus the resolved attrs for
--             each group. The last is how plugins like vim-easymotion and
--             quick-scope colour a window without extmarks or :syntax.
--
-- Args: (channel).

local chan = ...

local PAD = 40 -- extra buffer rows queried around the window viewport

-- Highlight groups resolved this session, cleared on ColorScheme.
local hl_cache = {}
-- Per-window highlight snapshot, to skip the capture walk on a bare cursor move.
local hl_by_win = {}

local function hex(n)
  return n and string.format('#%06x', n) or nil
end

-- Resolve a highlight group name to a compact attr table (or false), memoised.
local function resolve_hl(group)
  local c = hl_cache[group]
  if c ~= nil then
    return c
  end
  local ok, h = pcall(vim.api.nvim_get_hl, 0, { name = group, link = false })
  if not ok or type(h) ~= 'table' or vim.tbl_isempty(h) then
    hl_cache[group] = false
    return false
  end
  hl_cache[group] = {
    fg = hex(h.fg),
    bg = hex(h.bg),
    sp = hex(h.sp),
    bold = h.bold or nil,
    italic = h.italic or nil,
    underline = h.underline or nil,
    undercurl = h.undercurl or nil,
    strikethrough = h.strikethrough or nil,
    reverse = h.reverse or nil,
  }
  return hl_cache[group]
end

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

local HEAD_MARKER_LEVEL = {
  atx_h1_marker = 1,
  atx_h2_marker = 2,
  atx_h3_marker = 3,
  atx_h4_marker = 4,
  atx_h5_marker = 5,
  atx_h6_marker = 6,
}

-- Markdown block structure over the padded viewport: headings (with level),
-- fenced / indented code blocks, and block quotes, each as {startRow, endRow}
-- (0-based, inclusive), headings with a third level element. Read straight off
-- the base markdown tree by node *type*, not a highlights query: these are
-- structural, not colour, and want the whole block's line range.
local function collect_structure(buf, first, last)
  local heads, codes, quotes = {}, {}, {}
  pcall(function()
    local parser = vim.treesitter.get_parser(buf, 'markdown')
    if not parser then
      return
    end
    local trees = parser:parse({ first, last })
    local root = trees[1] and trees[1]:root()
    if not root then
      return
    end
    local function last_row(er, ec)
      return ec == 0 and math.max(er - 1, 0) or er
    end
    local function walk(node)
      local sr, _, er, ec = node:range()
      if sr > last or last_row(er, ec) < first then
        return -- outside the padded viewport; prune the subtree
      end
      local t = node:type()
      if t == 'atx_heading' then
        local level = 1
        for child in node:iter_children() do
          level = HEAD_MARKER_LEVEL[child:type()] or level
        end
        heads[#heads + 1] = { sr, last_row(er, ec), level }
        return
      elseif t == 'setext_heading' then
        local level = 1
        for child in node:iter_children() do
          if child:type() == 'setext_h2_underline' then
            level = 2
          end
        end
        heads[#heads + 1] = { sr, last_row(er, ec), level }
        return
      elseif t == 'fenced_code_block' or t == 'indented_code_block' then
        codes[#codes + 1] = { sr, last_row(er, ec) }
        return -- no headings/quotes nest inside code content
      elseif t == 'block_quote' then
        quotes[#quotes + 1] = { sr, last_row(er, ec) }
      end
      for child in node:iter_children() do
        walk(child)
      end
    end
    walk(root)
  end)
  return heads, codes, quotes
end

-- Closed folds overlapping the padded viewport, as { {startRow, endRow, text},
-- ... } (0-based rows, inclusive). `text` is `foldtextresult`, trimmed of the
-- trailing fill run. There is no fold autocmd, so this re-runs on the same
-- broad trigger set as the rest.
local function collect_folds(win, first, last)
  local folds = {}
  vim.api.nvim_win_call(win, function()
    if not vim.wo.foldenable then
      return
    end
    local l = first + 1 -- 1-based
    local top = last + 1
    while l <= top do
      local fc = vim.fn.foldclosed(l)
      if fc == -1 then
        l = l + 1
      else
        local fe = vim.fn.foldclosedend(l)
        local text = (tostring(vim.fn.foldtextresult(fc)):gsub('[%s%-%.·•_=]+$', ''))
        folds[#folds + 1] = { fc - 1, fe - 1, text }
        l = fe + 1
      end
    end
  end)
  return folds
end

-- Every treesitter capture and every hl_group extmark over the padded viewport,
-- as { runs = { {row, sc, ec, group}, ... }, defs = { [group] = attrs } }.
-- Single line runs only; a multi line capture (a raw code block) is left to the
-- structural styling. Faithful mirror: no priority resolution, the client
-- stacks the marks and CSS decides, same as a browser rendering treesitter.
-- capture names that never carry a visible highlight
local HL_SKIP = { spell = true, nospell = true, conceal = true, none = true, nocombine = true }

-- Baseline layer priorities, matching Neovim's own compositing order (:syntax
-- and treesitter lowest, extmarks above that at their own priority, :match /
-- matchadd() always on top). Used only to order overlapping *groups'* CSS
-- rules so the higher layer's colour wins when two decorations cover the same
-- character; it is not a per-run z-index, groups get one priority each.
local PRIO_TREESITTER = 100
local PRIO_EXTMARK = 4096
local PRIO_MATCH = 10000

local function collect_highlights(win, buf, first, last, marks)
  local runs, seen, codespans, virt = {}, {}, {}, {}
  local function note(group, prio)
    if group then
      seen[group] = math.max(seen[group] or 0, prio or 0)
    end
  end
  local function add(row, sc, ec, group, prio)
    if group and ec > sc then
      runs[#runs + 1] = { row, sc, ec, group }
      note(group, prio)
    end
  end

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
          for id, node in q:iter_captures(tstree:root(), buf, first, last + 1) do
            local name = q.captures[id]
            if name and name:sub(1, 1) ~= '_' and not HL_SKIP[name] then
              local sr, sc, er, ec = node:range()
              if sr == er then
                add(sr, sc, ec, '@' .. name, PRIO_TREESITTER)
                -- inline code span: flagged separately so the client can give
                -- it a monospace face, which no highlight group attribute
                -- carries.
                if node:type() == 'code_span' then
                  codespans[#codespans + 1] = { sr, sc, ec }
                end
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

  for _, mk in ipairs(marks) do
    local row, col, d = mk[2], mk[3], mk[4]
    if d then
      if d.hl_group and d.end_row == row and d.end_col and d.end_col > col then
        add(row, col, d.end_col, d.hl_group, d.priority or PRIO_EXTMARK)
      end
      -- overlay virt_text: hop.nvim's jump-target letters and similar. Not a
      -- buffer edit and not colour on existing text, it is new content drawn
      -- over the top, so it needs its own client-side widget, unlike conceal
      -- or highlights. Only 'overlay' is handled; 'eol' / 'inline' /
      -- 'right_align' and virt_text_win_col-positioned marks (screen column,
      -- not buffer column) are a later pass.
      if d.virt_text and d.virt_text_pos == 'overlay' and row >= first and row <= last then
        local segs, hide = {}, 0
        for _, seg in ipairs(d.virt_text) do
          local text, grp = seg[1], seg[2]
          if text and text ~= '' then
            hide = hide + #text
            note(grp, d.priority or PRIO_EXTMARK)
            segs[#segs + 1] = { text, grp }
          end
        end
        if hide > 0 then
          virt[#virt + 1] = { row, col, hide, segs }
        end
      end
    end
  end

  -- :match / matchadd() / matchaddpos() overlays (easymotion, quick-scope,
  -- and any plugin that recolors this way instead of extmarks or :syntax).
  -- Not seen by any of the above; getmatches() is the only read for it. Each
  -- match gets its own pcall: one bad entry (matchbufline requires its 5th
  -- arg to be an unambiguous Dict, a bare Lua {} converts to an empty List and
  -- errors) must not abort every match after it in the list, which a single
  -- pcall around the whole loop silently did.
  local ok, all_matches = pcall(vim.fn.getmatches, win)
  if ok then
    for _, m in ipairs(all_matches) do
      pcall(function()
        if m.pos1 then
          -- matchaddpos(): up to 8 literal positions, each {lnum[, col[, len]]}
          for i = 1, 8 do
            local p = m['pos' .. i]
            if not p then
              break
            end
            local row = (p[1] or 0) - 1
            if row >= first and row <= last then
              local sc = (p[2] or 1) - 1
              add(row, sc, sc + (p[3] or 1), m.group, PRIO_MATCH + (m.priority or 0))
            end
          end
        elseif m.pattern and m.pattern ~= '' then
          -- matchadd(): resolve the pattern the same way Neovim would, over
          -- the padded viewport only.
          local hits =
            vim.fn.matchbufline(buf, m.pattern, first + 1, last + 1, vim.empty_dict())
          for _, hit in ipairs(hits) do
            add(
              hit.lnum - 1,
              hit.byteidx,
              hit.byteidx + #hit.text,
              m.group,
              PRIO_MATCH + (m.priority or 0)
            )
          end
        end
      end)
    end
  end

  -- `priority` rides in each group's own attrs (not just a side table): a
  -- Lua table used as a JSON object has no defined key order, so the client
  -- cannot infer relative priority from where a group lands in `defs`. It
  -- sorts by this field itself before emitting CSS, so a higher layer's rule
  -- is always written after a lower one's: two decorations covering the same
  -- character (easymotion's dim "shade" under the whole line and its bright
  -- "target" on one letter) are flattened onto one element client side, and
  -- CSS gives the later same-specificity rule the win.
  local defs = {}
  for group, prio in pairs(seen) do
    local a = resolve_hl(group)
    if a then
      a.priority = prio
      defs[group] = a
    end
  end
  return { runs = runs, defs = defs, codespans = codespans, virt = virt }
end

-- Forward declared: `ensure_attached` below needs to call it, but `schedule`
-- itself is only assigned further down (after `push`), once `flush` exists.
local schedule

-- Buffers with a live island get a second, low-level trigger alongside the
-- VimL autocmds: `nvim_buf_attach`'s `on_lines` fires unconditionally on every
-- real text change, including ones made *inside* a blocking call like
-- getchar(). `TextChanged` / `TextChangedI` do not: a plugin that shows a
-- prompt while blocked on getchar() (vim-easymotion's target-letter overlay,
-- also a real setline() edit) changes the buffer and adds its matchaddpos()
-- highlights, but neither fires until the blocking call returns, so this
-- script's own debounced push never ran while the overlay was visible. The
-- island then showed the letters (bridge.rs's own separate buffer attach,
-- for content sync, does fire) with no colour, because collect_highlights
-- never got a chance to read getmatches() during that window. One attach per
-- buffer, lazily added the first time it is pushed for.
local attached_bufs = {}
local function ensure_attached(buf)
  if attached_bufs[buf] then
    return
  end
  attached_bufs[buf] = true
  pcall(vim.api.nvim_buf_attach, buf, false, {
    on_lines = function()
      schedule()
    end,
    on_detach = function()
      attached_bufs[buf] = nil
    end,
  })
end

local function push(win)
  local buf = vim.api.nvim_win_get_buf(win)
  ensure_attached(buf)
  local info = vim.fn.getwininfo(win)[1]
  if not info then
    return
  end
  local n = vim.api.nvim_buf_line_count(buf)
  local first = math.max((info.topline or 1) - 1 - PAD, 0)
  local last = math.min((info.botline or info.topline or 1) + PAD, n - 1)

  -- Highlights are the heavy part (a treesitter walk); reuse the last
  -- snapshot when nothing collect_highlights reads has changed. `tick` and
  -- the viewport range catch an edit or a scroll. Extmark or match content
  -- can change with *no* buffer edit at all (hop.nvim's virt_text hints,
  -- matchadd() from any plugin), which a tick-only cache would never
  -- invalidate, so a fingerprint of both over the same viewport rides along
  -- too. A plain count is not enough, confirmed live: hop.nvim clears its
  -- N search-preview extmarks and creates N hint extmarks in the same breath,
  -- so the count is unchanged across a very real content swap.
  --
  -- Extmark ids are monotonic only *within a namespace*, not across a
  -- buffer: two different (freshly created) namespaces both start counting
  -- from 1, so hop.nvim's preview marks (namespace A, ids 1..N) and its
  -- hint marks (namespace B, ids 1..N, at the same jump-target positions)
  -- can carry an identical id sum, confirmed live. A row/col-only fold-in
  -- does not help either: both sets sit at the same buffer positions. What
  -- actually differs is the mark's own content (hl_group vs. virt_text), so
  -- the fingerprint hashes that in too. This is computed from the same
  -- details=true fetch collect_highlights itself needs, fetched once here
  -- and passed down, rather than queried twice.
  local tick = vim.api.nvim_buf_get_changedtick(buf)
  local mcount, msum = 0, 0
  for _, m in ipairs(vim.fn.getmatches(win)) do
    mcount = mcount + 1
    msum = msum + (m.id or 0)
  end
  local marks =
    vim.api.nvim_buf_get_extmarks(buf, -1, { first, 0 }, { last, -1 }, { details = true })
  local ecount, esum = 0, 0
  for _, mk in ipairs(marks) do
    ecount = ecount + 1
    local h = (mk[1] or 0) * 1000003 + (mk[2] or 0) * 131 + (mk[3] or 0)
    local d = mk[4]
    if d then
      h = h + (d.priority or 0)
      if d.hl_group then
        for i = 1, #d.hl_group do
          h = h + d.hl_group:byte(i)
        end
      end
      if d.virt_text then
        h = h + 97
        for _, seg in ipairs(d.virt_text) do
          local t = seg[1]
          if t then
            for i = 1, #t do
              h = h + t:byte(i)
            end
          end
        end
      end
    end
    esum = esum + h
  end
  local c = hl_by_win[win]
  local hl
  if
    c
    and c.tick == tick
    and c.first == first
    and c.last == last
    and c.mcount == mcount
    and c.msum == msum
    and c.ecount == ecount
    and c.esum == esum
  then
    hl = c.value
  else
    hl = collect_highlights(win, buf, first, last, marks)
    hl_by_win[win] = {
      tick = tick,
      first = first,
      last = last,
      mcount = mcount,
      msum = msum,
      ecount = ecount,
      esum = esum,
      value = hl,
    }
  end

  local heads, codes, quotes = collect_structure(buf, first, last)
  local payload = {
    first = first,
    last = last,
    conceal = collect_conceal(win, buf, first, last),
    visual = collect_visual(win, first, last),
    folds = collect_folds(win, first, last),
    hl = hl,
    heads = heads,
    codes = codes,
    quotes = quotes,
    visual_hl = (function()
      local v = resolve_hl('Visual')
      if not v then
        return nil
      end
      return v.reverse and v.fg or v.bg
    end)(),
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
schedule = function()
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
  -- backstop: a lone `zo` / `zc` with a stationary cursor fires no other event.
  'CursorHold',
  'CursorHoldI',
}, { group = grp, callback = schedule })
vim.api.nvim_create_autocmd('OptionSet', {
  group = grp,
  -- foldlevel / foldenable catch the bulk fold commands (`zR` `zM` `zi` ...).
  pattern = { 'conceallevel', 'concealcursor', 'foldlevel', 'foldenable' },
  callback = schedule,
})
vim.api.nvim_create_autocmd('ColorScheme', {
  group = grp,
  callback = function()
    hl_cache = {}
    hl_by_win = {}
    schedule()
  end,
})

-- General trigger for display-only changes with no buffer edit and no autocmd
-- of their own, made while Neovim is blocked on a synchronous input wait
-- (hop.nvim's hint letters: pure virt_text extmarks, no setline()). Verified
-- live: this callback, and the vim.defer_fn timer schedule() sets up, both do
-- run during a blocking getchar() / getcharstr(). A decoration provider fires
-- on every redraw of every window, which is why: it is the same mechanism
-- treesitter's own highlighter uses to stay live. schedule() is a single
-- boolean check once a push is already pending, so the extra call volume
-- costs nothing measurable.
vim.api.nvim_set_decoration_provider(vim.api.nvim_create_namespace('gnv_md_decor_watch'), {
  on_win = function()
    schedule()
    return false
  end,
})
