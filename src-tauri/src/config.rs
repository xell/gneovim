//! User configuration, loaded once from
//! `${XDG_CONFIG_HOME:-~/.config}/gneovim/config.toml`.
//!
//! Loading never fails the app. A missing file gives defaults. A malformed file
//! or a bad value logs a warning and falls through to defaults / auto-detection.

use std::path::PathBuf;
use std::sync::OnceLock;

use serde::{Deserialize, Serialize};

#[derive(Debug, Default, Deserialize, Serialize)]
#[serde(default)]
pub struct Config {
    pub neovim: Neovim,
    pub input: Input,
    pub window: Window,
    pub markdown: Markdown,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(default)]
pub struct Markdown {
    /// Whether a `filetype=markdown` window renders as a CodeMirror live
    /// preview island by default. Per-window overridable at runtime with
    /// `:MarkdownLivePreviewOn` / `Off` / `Toggle`. Default true.
    pub live_preview_default: bool,
}

impl Default for Markdown {
    fn default() -> Self {
        Self {
            live_preview_default: true,
        }
    }
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(default)]
pub struct Window {
    /// Confirm before Cmd+Q quits the app, even with nothing unsaved. Closing
    /// destroys every gui-window's Neovim (all its tabs and splits). Default
    /// true.
    pub confirm_quit: bool,

    /// Confirm before Cmd+W closes a gui-window or gui-tab, even with nothing
    /// unsaved. Default true.
    pub confirm_close: bool,

    /// Where a file opened from outside (Open with, drag to the dock, file
    /// association) lands. One of:
    ///   "window"   -> a new gui-window with its own Neovim (the default)
    ///   "tab"      -> a new gui-tab (a macOS merged tab) with its own Neovim
    ///   "nvim-tab" -> a new Neovim tabpage in the last-focused gui-window,
    ///                 reusing its Neovim; no new window or process
    /// "nvim-tab" falls back to "window" when there is no gui-window to receive
    /// the file. An unrecognised value logs a warning and uses "window".
    pub open_files_in: Option<String>,
}

impl Default for Window {
    fn default() -> Self {
        Self {
            confirm_quit: true,
            confirm_close: true,
            open_files_in: None,
        }
    }
}

/// Resolved value of `[window] open_files_in`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OpenTarget {
    /// A new gui-window, its own Neovim.
    Window,
    /// A new gui-tab (macOS merged tab), its own Neovim.
    Tab,
    /// A new Neovim tabpage in the last-focused gui-window, reusing its Neovim.
    NvimTab,
}

impl Window {
    /// `open_files_in` mapped to an [`OpenTarget`]; unset or unknown -> `Window`.
    pub fn open_target(&self) -> OpenTarget {
        match self.open_files_in.as_deref().map(str::trim) {
            None | Some("") | Some("window") => OpenTarget::Window,
            Some("tab") => OpenTarget::Tab,
            Some("nvim-tab") | Some("nvim_tab") => OpenTarget::NvimTab,
            Some(other) => {
                log::warn!(
                    "config: [window] open_files_in = {other:?} is not one of \
                     \"window\" / \"tab\" / \"nvim-tab\"; using \"window\""
                );
                OpenTarget::Window
            }
        }
    }
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(default)]
pub struct Input {
    /// Treat the macOS Option key as Meta, so Option+<key> reaches Neovim as
    /// `<M-...>` instead of composing a character (é, •, …). Default true.
    pub option_is_meta: bool,

    /// Make a markdown island non-editable outside insert/replace mode so an
    /// input method cannot hijack normal-mode keys (a CJK IME turning `j` into
    /// a syllable). Default true.
    pub block_ime_in_normal_mode: bool,

    /// Forward Cmd+<key> to Neovim as `<D-...>`. Default false: on macOS Cmd is
    /// the app/menu modifier, and forwarding it collides with menu shortcuts.
    /// Enable if you have `<D-...>` mappings.
    pub forward_cmd_keys: bool,
}

impl Default for Input {
    fn default() -> Self {
        Self {
            option_is_meta: true,
            block_ime_in_normal_mode: true,
            forward_cmd_keys: false,
        }
    }
}

#[derive(Debug, Default, Deserialize, Serialize)]
#[serde(default)]
pub struct Neovim {
    /// Explicit path to the `nvim` binary. A leading `~/` is expanded. If unset
    /// or not a file, the bridge falls back to auto-detection. Overridden by the
    /// `GNV_NVIM` environment variable.
    pub path: Option<String>,

    /// Which init to load:
    ///   unset or "none" -> `-u NONE` (a bare nvim, the default)
    ///   "user"          -> no `-u`, nvim finds `~/.config/nvim` normally
    ///   "~/path/init.lua" (anything else) -> `-u <that path>` (`~/` expanded)
    pub config: Option<String>,

    /// Extra arguments passed verbatim to `nvim` at startup, split on
    /// whitespace. For flags not covered by `path` / `config`. Default "".
    pub args: Option<String>,
}

impl Neovim {
    /// The `-u ...` args for `nvim`, per `config`. Empty means "no -u flag".
    pub fn init_args(&self) -> Vec<String> {
        match self.config.as_deref().unwrap_or("none") {
            s if s.eq_ignore_ascii_case("none") => vec!["-u".into(), "NONE".into()],
            s if s.eq_ignore_ascii_case("user") || s.is_empty() => vec![],
            path => vec!["-u".into(), expand_tilde(path)],
        }
    }

    /// True when running a bare `nvim -u NONE` (no user config): `config` unset
    /// or "none". gneovim then owns more of the session (throwaway ShaDa, a
    /// forced light background). With any real config, those choices are the
    /// user's.
    pub fn is_bare(&self) -> bool {
        self.config
            .as_deref()
            .unwrap_or("none")
            .eq_ignore_ascii_case("none")
    }

    /// The `-i ...` (ShaDa) args. A bare `-u NONE` session gets `-i NONE` so it
    /// stays fully throwaway. Any real config uses the default ShaDa file, so
    /// command-line history (`q:`), search history, marks, registers, and
    /// `:oldfiles` behave like terminal nvim.
    pub fn shada_args(&self) -> Vec<String> {
        if self.is_bare() {
            vec!["-i".into(), "NONE".into()]
        } else {
            vec![]
        }
    }

    /// Extra `nvim` args from `[neovim] args`, whitespace-split. Empty by
    /// default.
    pub fn extra_args(&self) -> Vec<String> {
        self.args
            .as_deref()
            .unwrap_or("")
            .split_whitespace()
            .map(str::to_string)
            .collect()
    }
}

static CONFIG: OnceLock<Config> = OnceLock::new();

/// The process-wide config, parsed on first access.
pub fn get() -> &'static Config {
    CONFIG.get_or_init(load)
}

/// `${XDG_CONFIG_HOME:-~/.config}/gneovim/config.toml`.
pub fn file_path() -> Option<PathBuf> {
    let base = match std::env::var_os("XDG_CONFIG_HOME") {
        Some(x) if !x.is_empty() => PathBuf::from(x),
        _ => PathBuf::from(std::env::var_os("HOME")?).join(".config"),
    };
    Some(base.join("gneovim").join("config.toml"))
}

fn load() -> Config {
    let Some(p) = file_path() else {
        return Config::default();
    };
    let text = match std::fs::read_to_string(&p) {
        Ok(t) => t,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Config::default(),
        Err(e) => {
            log::warn!("config: cannot read {}: {e}", p.display());
            return Config::default();
        }
    };
    match toml::from_str::<Config>(&text) {
        Ok(c) => {
            log::info!("config: loaded {}", p.display());
            c
        }
        Err(e) => {
            log::warn!("config: {} is malformed, ignoring it: {e}", p.display());
            Config::default()
        }
    }
}

/// Expand a leading `~` or `~/` to `$HOME`. Anything else is returned unchanged.
pub fn expand_tilde(s: &str) -> String {
    if s == "~" {
        return std::env::var("HOME").unwrap_or_else(|_| s.to_string());
    }
    if let Some(rest) = s.strip_prefix("~/") {
        if let Ok(home) = std::env::var("HOME") {
            return format!("{home}/{rest}");
        }
    }
    s.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_neovim_path() {
        let c: Config = toml::from_str("[neovim]\npath = \"/opt/nvim/bin/nvim\"\n").unwrap();
        assert_eq!(c.neovim.path.as_deref(), Some("/opt/nvim/bin/nvim"));
    }

    #[test]
    fn empty_and_partial_configs_are_fine() {
        assert!(toml::from_str::<Config>("").unwrap().neovim.path.is_none());
        assert!(toml::from_str::<Config>("[neovim]\n").unwrap().neovim.path.is_none());
        // unknown keys are tolerated, not fatal
        assert!(toml::from_str::<Config>("[general]\nfoo = 1\n").is_ok());
    }

    #[test]
    fn init_args_from_config() {
        std::env::set_var("HOME", "/home/x");
        let none = Neovim { path: None, config: None, args: None };
        assert_eq!(none.init_args(), vec!["-u", "NONE"]);
        let explicit_none = Neovim { path: None, config: Some("none".into()), args: None };
        assert_eq!(explicit_none.init_args(), vec!["-u", "NONE"]);
        let user = Neovim { path: None, config: Some("user".into()), args: None };
        assert!(user.init_args().is_empty());
        let custom = Neovim { path: None, config: Some("~/x/init.lua".into()), args: None };
        assert_eq!(custom.init_args(), vec!["-u", "/home/x/x/init.lua"]);
    }

    #[test]
    fn shada_args_from_config() {
        let none = Neovim { path: None, config: None, args: None };
        assert_eq!(none.shada_args(), vec!["-i", "NONE"]);
        let explicit_none = Neovim { path: None, config: Some("NONE".into()), args: None };
        assert_eq!(explicit_none.shada_args(), vec!["-i", "NONE"]);
        let user = Neovim { path: None, config: Some("user".into()), args: None };
        assert!(user.shada_args().is_empty());
        let custom = Neovim { path: None, config: Some("~/x/init.lua".into()), args: None };
        assert!(custom.shada_args().is_empty());
    }

    #[test]
    fn open_target_from_config() {
        assert_eq!(Window::default().open_target(), OpenTarget::Window);
        let mk = |s: &str| {
            toml::from_str::<Config>(&format!("[window]\nopen_files_in = \"{s}\"\n"))
                .unwrap()
                .window
                .open_target()
        };
        assert_eq!(mk("window"), OpenTarget::Window);
        assert_eq!(mk("tab"), OpenTarget::Tab);
        assert_eq!(mk("nvim-tab"), OpenTarget::NvimTab);
        assert_eq!(mk("nvim_tab"), OpenTarget::NvimTab);
        assert_eq!(mk("bogus"), OpenTarget::Window);
    }

    #[test]
    fn extra_args_splits_on_whitespace() {
        let none = Neovim { path: None, config: None, args: None };
        assert!(none.extra_args().is_empty());
        let empty = Neovim { path: None, config: None, args: Some("   ".into()) };
        assert!(empty.extra_args().is_empty());
        let some = Neovim {
            path: None,
            config: None,
            args: Some("--clean  +startinsert".into()),
        };
        assert_eq!(some.extra_args(), vec!["--clean", "+startinsert"]);
    }

    #[test]
    fn tilde_expands_with_home() {
        std::env::set_var("HOME", "/home/x");
        assert_eq!(expand_tilde("~/.local/bin/nvim"), "/home/x/.local/bin/nvim");
        assert_eq!(expand_tilde("~"), "/home/x");
        assert_eq!(expand_tilde("/abs/path"), "/abs/path");
        assert_eq!(expand_tilde("relative"), "relative");
    }
}
