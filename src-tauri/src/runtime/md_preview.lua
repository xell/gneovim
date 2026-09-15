-- Injected into every embedded nvim by `bridge::connect` (nvim.exec_lua).
-- NOT a user plugin: it is GUI protocol glue and must match the Rust
-- `handle_notify` / `BridgeEvent` contract. Args: (channel, default, version).
--
--   :MarkdownLivePreviewOn / Off / Toggle    current window
--   :MarkdownLivePreviewOn! / ...             every markdown window in the tab
--   :GrammarlyOn / Off / Toggle               current markdown window
--   :GrammarlyOn! / ...                       every markdown window in the tab
--   :MarkdownOptimalWidthOn / Off / Toggle    current markdown window
--   :MarkdownOptimalWidthOn! / ...            every markdown window in the tab
--   :GneovimResyncIsland                      every markdown island, this nvim
--                                              (fold-desync escape hatch)
--
-- Each window carries `w:gnv_md_preview` (0 or 1) while it is a markdown
-- window, unset otherwise, so it can be read from a statusline or a script.
-- `w:gnv_grammarly` (0 or 1) follows the same lifecycle: when 0, the window's
-- island advertises itself to Grammarly as opted out. `w:gnv_md_optimal_width`
-- (0 or 1) likewise: when 1, the island's text column is capped and centred
-- instead of filling the window.

local chan, default, version, grammarly_default, optimal_width_default = ...

vim.g.gneovim = true
vim.g.gneovim_version = version
do
  local mj, mn, pt = tostring(version):match('(%d+)%.(%d+)%.(%d+)')
  pcall(
    vim.api.nvim_set_client_info,
    'gneovim',
    { major = tonumber(mj) or 0, minor = tonumber(mn) or 0, patch = tonumber(pt) or 0 },
    'ui',
    vim.empty_dict(),
    vim.empty_dict()
  )
end

local function is_md(win)
  if not vim.api.nvim_win_is_valid(win) then
    return false
  end
  if vim.api.nvim_win_get_config(win).relative ~= '' then
    return false -- floating window: stays on the grid
  end
  local buf = vim.api.nvim_win_get_buf(win)
  return vim.api.nvim_get_option_value('filetype', { buf = buf }) == 'markdown'
end

local function get_flag(win)
  local ok, v = pcall(vim.api.nvim_win_get_var, win, 'gnv_md_preview')
  return ok and v or nil
end

local function set_flag(win, v)
  if v == nil then
    pcall(vim.api.nvim_win_del_var, win, 'gnv_md_preview')
  else
    pcall(vim.api.nvim_win_set_var, win, 'gnv_md_preview', v)
  end
end

-- push a window's state to the GUI: 1 = preview, 0 = grid, -1 = not markdown.
-- pcall'd so a dead channel never breaks a command or autocmd (w:gnv_md_preview
-- is still authoritative and gets replayed on the next GUI attach).
local function notify(win, val)
  pcall(vim.rpcnotify, chan, 'gnv_md_preview', win, val)
end

-- A public integration point for user configuration. Gneovim itself has no
-- dependency on any renderer plugin; listeners decide whether and how they
-- react to this window entering or leaving the CM6 island.
local function emit_changed(win, on)
  local ok, err = pcall(vim.api.nvim_exec_autocmds, 'User', {
    pattern = 'GneovimMarkdownPreviewChanged',
    modeline = false,
    data = {
      win = win,
      buf = vim.api.nvim_win_get_buf(win),
      preview = on,
    },
  })
  if not ok then
    vim.schedule(function()
      vim.notify('GneovimMarkdownPreviewChanged listener failed: ' .. tostring(err), vim.log.levels.WARN)
    end)
  end
end

local function set_preview(win, on)
  local v = on and 1 or 0
  local previous = get_flag(win)
  set_flag(win, v)
  notify(win, v)
  if previous ~= v then
    emit_changed(win, on)
  end
end

-- Grammarly opt out, per window. The island sets the `data-gramm="false"` and
-- `data-enable-grammarly="false"` attributes Grammarly documents for web
-- content when the flag is 0. Same pcall rationale as notify().
local function get_grammarly(win)
  local ok, v = pcall(vim.api.nvim_win_get_var, win, 'gnv_grammarly')
  return ok and v or nil
end

local function notify_grammarly(win, val)
  pcall(vim.rpcnotify, chan, 'gnv_grammarly', win, val)
end

local function set_grammarly(win, on)
  local v = on and 1 or 0
  pcall(vim.api.nvim_win_set_var, win, 'gnv_grammarly', v)
  notify_grammarly(win, v)
end

-- Optimal-width mode, per window: purely a display preference for the
-- island's CSS, same lifecycle as gnv_grammarly.
local function get_optimal_width(win)
  local ok, v = pcall(vim.api.nvim_win_get_var, win, 'gnv_md_optimal_width')
  return ok and v or nil
end

local function notify_optimal_width(win, val)
  pcall(vim.rpcnotify, chan, 'gnv_md_optimal_width', win, val)
end

local function set_optimal_width(win, on)
  local v = on and 1 or 0
  pcall(vim.api.nvim_win_set_var, win, 'gnv_md_optimal_width', v)
  notify_optimal_width(win, v)
end

-- Mirror a markdown window's gutter options into the GUI so its CM island can
-- draw the same number column Neovim would. signcolumn / foldcolumn ride along
-- for a later pass. Same pcall rationale as notify().
local function push_gutter(win)
  if not is_md(win) then
    return
  end
  local wo = vim.wo[win]
  pcall(vim.rpcnotify, chan, 'gnv_win_gutter', win, {
    number = wo.number,
    relativenumber = wo.relativenumber,
    numberwidth = wo.numberwidth,
    signcolumn = wo.signcolumn,
    foldcolumn = wo.foldcolumn,
  })
end

-- Keep w:gnv_md_preview honest as windows and filetypes change: materialize the
-- default on a fresh markdown window, clear it when a window stops being one.
local function reconcile(win)
  if is_md(win) then
    if get_flag(win) == nil then
      set_preview(win, default == 1)
    end
    if get_grammarly(win) == nil then
      set_grammarly(win, grammarly_default == 1)
    end
    if get_optimal_width(win) == nil then
      set_optimal_width(win, optimal_width_default == 1)
    end
  else
    if get_flag(win) ~= nil then
      set_flag(win, nil)
      notify(win, -1)
    end
    if get_grammarly(win) ~= nil then
      pcall(vim.api.nvim_win_del_var, win, 'gnv_grammarly')
      notify_grammarly(win, -1)
    end
    if get_optimal_width(win) ~= nil then
      pcall(vim.api.nvim_win_del_var, win, 'gnv_md_optimal_width')
      notify_optimal_width(win, -1)
    end
  end
end

local grp = vim.api.nvim_create_augroup('gnv_md_preview', { clear = true })
vim.api.nvim_create_autocmd({ 'BufWinEnter', 'FileType', 'WinEnter', 'WinNew' }, {
  group = grp,
  callback = function()
    local win = vim.api.nvim_get_current_win()
    reconcile(win)
    push_gutter(win)
  end,
})

-- Live `:set number` / `relativenumber` / `numberwidth` / `signcolumn` /
-- `foldcolumn` in the focused window.
vim.api.nvim_create_autocmd('OptionSet', {
  group = grp,
  pattern = { 'number', 'relativenumber', 'numberwidth', 'signcolumn', 'foldcolumn' },
  callback = function()
    push_gutter(vim.api.nvim_get_current_win())
  end,
})

-- Windows that already exist when this is injected (nvim launched with a file):
-- run once so w:gnv_md_preview is set even before any event fires.
vim.schedule(function()
  for _, w in ipairs(vim.api.nvim_list_wins()) do
    reconcile(w)
    push_gutter(w)
  end
end)

local function targets(bang)
  local out = {}
  if bang then
    for _, w in ipairs(vim.api.nvim_tabpage_list_wins(0)) do
      if is_md(w) then
        out[#out + 1] = w
      end
    end
  else
    local w = vim.api.nvim_get_current_win()
    if is_md(w) then
      out[1] = w
    end
  end
  return out
end

local function apply(name, action, bang, get, set)
  local wins = targets(bang)
  if #wins == 0 then
    vim.notify(
      name .. ': no markdown window' .. (bang and ' in this tabpage' or ''),
      vim.log.levels.WARN
    )
    return
  end
  for _, w in ipairs(wins) do
    local on = action == 'on' or (action == 'toggle' and get(w) ~= 1)
    set(w, on)
  end
end

for _, spec in ipairs({
  { 'MarkdownLivePreviewOn', 'on', 'MarkdownLivePreview', get_flag, set_preview },
  { 'MarkdownLivePreviewOff', 'off', 'MarkdownLivePreview', get_flag, set_preview },
  { 'MarkdownLivePreviewToggle', 'toggle', 'MarkdownLivePreview', get_flag, set_preview },
  { 'GrammarlyOn', 'on', 'Grammarly', get_grammarly, set_grammarly },
  { 'GrammarlyOff', 'off', 'Grammarly', get_grammarly, set_grammarly },
  { 'GrammarlyToggle', 'toggle', 'Grammarly', get_grammarly, set_grammarly },
  { 'MarkdownOptimalWidthOn', 'on', 'MarkdownOptimalWidth', get_optimal_width, set_optimal_width },
  {
    'MarkdownOptimalWidthOff',
    'off',
    'MarkdownOptimalWidth',
    get_optimal_width,
    set_optimal_width,
  },
  {
    'MarkdownOptimalWidthToggle',
    'toggle',
    'MarkdownOptimalWidth',
    get_optimal_width,
    set_optimal_width,
  },
}) do
  vim.api.nvim_create_user_command(spec[1], function(o)
    apply(spec[3], spec[2], o.bang, spec[4], spec[5])
  end, { bang = true, desc = 'gneovim: ' .. spec[3] .. ' (' .. spec[2] .. ')' })
end

-- Escape hatch for a wedged island: live rendering stops matching the actual
-- buffer (glitched heading styles, hidden text that should be visible, a
-- caret that will not move) and stays that way until now. Heaviest reported
-- trigger is a document with many closed `foldmethod=expr` folds edited
-- quickly (writing an outline of `## heading` lines): see
-- docs/markdown-island-fold-desync.md for the suspected cause. Toggling
-- `:MarkdownLivePreviewOff` / `On` already forces the client to reattach one
-- window's island from a fresh snapshot; this goes further and is meant to
-- need no follow up:
--   1. re-applies 'foldlevel' in every markdown window, discarding whatever
--      the fold engine's own state currently disagrees with foldexpr about.
--   2. drops md_decor.lua's per-window highlight cache and re-pushes its
--      decor payload synchronously, bypassing the normal 20ms debounce.
--   3. tells the client to tear down and reattach *every* markdown island
--      from a fresh nvim_buf_get_lines snapshot, the same recovery
--      `applyBufLines` already falls back to on a caught desync.
-- Deliberately global (not per-window, no bang): a full resync is cheap and
-- the point is one command that always works, not a scalpel.
vim.api.nvim_create_user_command('GneovimResyncIsland', function()
  local n = 0
  for _, win in ipairs(vim.api.nvim_list_wins()) do
    if is_md(win) then
      n = n + 1
      -- zX: re-apply 'foldlevel' to every fold without forcing any open
      -- (unlike zx, which also does zv). Purely a fold-state refresh.
      pcall(vim.api.nvim_win_call, win, function()
        vim.cmd('normal! zX')
      end)
      if _G.__gnv_resync_decor then
        pcall(_G.__gnv_resync_decor, win)
      end
    end
  end
  pcall(vim.rpcnotify, chan, 'gnv_resync_island')
  vim.notify(
    n > 0
      and ('GneovimResyncIsland: resynced ' .. n .. ' markdown window' .. (n == 1 and '' or 's'))
      or 'GneovimResyncIsland: no markdown window',
    vim.log.levels.INFO
  )
end, { desc = 'gneovim: force a full markdown island resync (fold desync escape hatch)' })
