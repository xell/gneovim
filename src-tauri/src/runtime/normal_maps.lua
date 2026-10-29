-- Injected into every embedded nvim by `bridge::connect` (nvim.exec_lua).
-- NOT a user plugin: it is GUI protocol glue and must match the Rust
-- `handle_notify` `gnv_normal_maps` arm and `BridgeEvent::NormalMaps`.
--
-- A Markdown island holds a plain Normal-mode `g` back until the next key
-- says whether it is a local gj/gk. That is wrong when the `g` finishes or
-- continues a user mapping (`,fg` with `,` as leader): Neovim never sees the
-- `g` until one more key arrives. The client's key router can only tell if it
-- knows which typed key runs are mapping left-hand sides, and it decides
-- synchronously, so this pushes them ahead of time: global plus current
-- buffer-local Normal-mode maps, as raw typed bytes (`<Leader>` and `<Space>`
-- already substituted). Maps with special keys (`<C-w>`, `<Plug>`) or
-- non-ASCII are dropped, since the router only tracks printable keys.
--
-- Mappings appear late (lazy.nvim's VeryLazy, ftplugins, LspAttach), so this
-- re-reads on buffer/window changes and on idle, and only notifies when the
-- set actually changed.
--
-- Payload: (timeoutlen, { lhs, ... }).
--
-- Arg: (channel).

local chan = ...

local last

local function push()
  local seen, list = {}, {}
  local function add(maps)
    for _, m in ipairs(maps) do
      local raw = m.lhsraw or vim.api.nvim_replace_termcodes(m.lhs, true, true, true)
      if #raw > 1 and raw:match('^[\32-\126]+$') and not seen[raw] then
        seen[raw] = true
        list[#list + 1] = raw
      end
    end
  end
  add(vim.api.nvim_get_keymap('n'))
  add(vim.api.nvim_buf_get_keymap(0, 'n'))
  table.sort(list)
  local key = vim.o.timeoutlen .. '\n' .. table.concat(list, '\n')
  if key == last then return end
  last = key
  pcall(vim.rpcnotify, chan, 'gnv_normal_maps', vim.o.timeoutlen, list)
end

-- Deferred: a FileType autocmd fires before the ftplugin that sets the
-- buffer's maps has run, and several of these events land together.
local queued = false
local function schedule_push()
  if queued then return end
  queued = true
  vim.schedule(function()
    queued = false
    push()
  end)
end

local group = vim.api.nvim_create_augroup('gnv_normal_maps', { clear = true })
vim.api.nvim_create_autocmd(
  { 'VimEnter', 'BufEnter', 'WinEnter', 'FileType', 'LspAttach', 'CursorHold' },
  { group = group, callback = schedule_push }
)
vim.api.nvim_create_autocmd('User', {
  group = group,
  pattern = { 'VeryLazy', 'LazyLoad' },
  callback = schedule_push,
})
vim.api.nvim_create_autocmd('OptionSet', {
  group = group,
  pattern = 'timeoutlen',
  callback = schedule_push,
})

schedule_push()
