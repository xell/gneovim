-- Injected into every embedded nvim by `bridge::connect` (nvim.exec_lua).
-- NOT a user plugin: it is GUI protocol glue and must match the Rust
-- `handle_notify` / `BridgeEvent` contract. Args: (channel, default, version).
--
--   :MarkdownLivePreviewOn / Off / Toggle    current window
--   :MarkdownLivePreviewOn! / ...             every markdown window in the tab
--
-- Each window carries `w:gnv_md_preview` (0 or 1) while it is a markdown
-- window, unset otherwise, so it can be read from a statusline or a script.

local chan, default, version = ...

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

local function set_preview(win, on)
  local v = on and 1 or 0
  set_flag(win, v)
  notify(win, v)
end

-- Keep w:gnv_md_preview honest as windows and filetypes change: materialize the
-- default on a fresh markdown window, clear it when a window stops being one.
local function reconcile(win)
  if is_md(win) then
    if get_flag(win) == nil then
      set_preview(win, default == 1)
    end
  elseif get_flag(win) ~= nil then
    set_flag(win, nil)
    notify(win, -1)
  end
end

local grp = vim.api.nvim_create_augroup('gnv_md_preview', { clear = true })
vim.api.nvim_create_autocmd({ 'BufWinEnter', 'FileType', 'WinEnter', 'WinNew' }, {
  group = grp,
  callback = function()
    reconcile(vim.api.nvim_get_current_win())
  end,
})

-- Windows that already exist when this is injected (nvim launched with a file):
-- run once so w:gnv_md_preview is set even before any event fires.
vim.schedule(function()
  for _, w in ipairs(vim.api.nvim_list_wins()) do
    reconcile(w)
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

local function apply(action, bang)
  local wins = targets(bang)
  if #wins == 0 then
    vim.notify(
      'MarkdownLivePreview: no markdown window' .. (bang and ' in this tabpage' or ''),
      vim.log.levels.WARN
    )
    return
  end
  for _, w in ipairs(wins) do
    local on = action == 'on' or (action == 'toggle' and get_flag(w) ~= 1)
    set_preview(w, on)
  end
end

for _, spec in ipairs({
  { 'MarkdownLivePreviewOn', 'on' },
  { 'MarkdownLivePreviewOff', 'off' },
  { 'MarkdownLivePreviewToggle', 'toggle' },
}) do
  vim.api.nvim_create_user_command(spec[1], function(o)
    apply(spec[2], o.bang)
  end, { bang = true, desc = 'gneovim: markdown live preview (' .. spec[2] .. ')' })
end
