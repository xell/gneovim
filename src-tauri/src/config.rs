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
        let none = Neovim { path: None, config: None };
        assert_eq!(none.init_args(), vec!["-u", "NONE"]);
        let explicit_none = Neovim { path: None, config: Some("none".into()) };
        assert_eq!(explicit_none.init_args(), vec!["-u", "NONE"]);
        let user = Neovim { path: None, config: Some("user".into()) };
        assert!(user.init_args().is_empty());
        let custom = Neovim { path: None, config: Some("~/x/init.lua".into()) };
        assert_eq!(custom.init_args(), vec!["-u", "/home/x/x/init.lua"]);
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
