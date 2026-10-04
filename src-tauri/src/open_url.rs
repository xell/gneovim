//! The `gneovim://` URL scheme: parse an incoming URL into an [`OpenRequest`].
//!
//! One action for now, VS Code shaped so editor-link templates from other tools
//! (`vscode://file/__FILE__:__LINE__`) work by swapping the scheme name:
//!
//! ```text
//! gneovim://file/<abs path>[:<line>[:<col>]]
//!     [?target=window|tab|nvim-tab][&cwd=<abs dir>][&readonly=1]
//!     [&swap=reveal|readonly|takeover|ask]
//! ```
//!
//! Any web page or app can fire a URL, so this only ever carries declarative
//! parameters: never an Ex command or Lua. The `gneovim` CLI shim (bundled at
//! `Contents/Resources/bin/gneovim`) builds these URLs from Neovim style args.

use crate::config::OpenTarget;
use url::Url;

/// What to do when the file is already loaded in another gneovim window's
/// Neovim, or its swap file is held by an outside Neovim. `swap=` in the URL.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SwapPolicy {
    /// Focus the gneovim window already holding the file and jump there. An
    /// outside holder has nothing to focus, so that case behaves like `Ask`.
    Reveal,
    /// Open it here readonly (`v:swapchoice = 'o'`); the holder is untouched.
    Readonly,
    /// The holder saves and releases the buffer, then it opens here. Falls
    /// back to `Readonly` on any failure, and for an outside holder.
    Takeover,
    /// The user's own `SwapExists` handling (or Neovim's prompt) decides.
    Ask,
}

impl SwapPolicy {
    fn parse(s: &str) -> Option<Self> {
        match s {
            "reveal" => Some(Self::Reveal),
            "readonly" => Some(Self::Readonly),
            "takeover" => Some(Self::Takeover),
            "ask" => Some(Self::Ask),
            _ => None,
        }
    }

    /// The `g:gneovim_swap_policy` value for `runtime/open_request.lua`'s
    /// `SwapExists` handler, or `None` to leave the swap question alone.
    pub fn lua_name(self) -> Option<&'static str> {
        match self {
            Self::Readonly => Some("readonly"),
            Self::Takeover => Some("takeover"),
            Self::Reveal | Self::Ask => None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OpenRequest {
    /// Absolute, percent-decoded.
    pub path: String,
    /// 1-based.
    pub line: Option<u32>,
    /// 1-based byte column, as Vim's `cursor()`.
    pub col: Option<u32>,
    /// Overrides `[window] open_files_in` for this call.
    pub target: Option<OpenTarget>,
    /// Starting directory for a newly spawned Neovim. Ignored otherwise.
    pub cwd: Option<String>,
    /// Neovim's `-R`: open the file readonly, occupied or not.
    pub readonly: bool,
    /// Explicit `swap=`; see [`OpenRequest::swap_policy`] for the default.
    pub swap: Option<SwapPolicy>,
}

impl OpenRequest {
    /// Explicit `swap=` wins; otherwise `readonly=1` (`-R`) implies readonly,
    /// since a readonly open has no reason to prompt or take over; otherwise
    /// `Reveal`.
    pub fn swap_policy(&self) -> SwapPolicy {
        self.swap.unwrap_or(if self.readonly {
            SwapPolicy::Readonly
        } else {
            SwapPolicy::Reveal
        })
    }
}

/// Parse a `gneovim://` URL. `Err` explains why it was rejected (logged by the
/// caller); unknown query parameters are ignored, not rejected.
pub fn parse(url: &Url) -> Result<OpenRequest, String> {
    if url.scheme() != "gneovim" {
        return Err(format!("not a gneovim:// URL: {url}"));
    }
    match url.host_str() {
        Some("file") => {}
        other => return Err(format!("unknown action {other:?} in {url}")),
    }

    // `url.path()` is still percent-encoded, so a `:` that is really part of
    // the file name arrives as `%3A` and is never mistaken for `:line`.
    let raw = url.path();
    let (raw, line, col) = split_line_col(raw);
    // Tolerate `gneovim://file//abs` (a template that pasted `/__FILE__`).
    let raw = format!("/{}", raw.trim_start_matches('/'));
    if raw == "/" {
        return Err(format!("no file path in {url}"));
    }
    let path = Url::parse(&format!("file://{raw}"))
        .ok()
        .and_then(|u| u.to_file_path().ok())
        .ok_or_else(|| format!("bad file path in {url}"))?
        .to_string_lossy()
        .into_owned();

    let mut req = OpenRequest {
        path,
        line,
        col,
        target: None,
        cwd: None,
        readonly: false,
        swap: None,
    };
    for (k, v) in url.query_pairs() {
        match &*k {
            "target" => {
                req.target = match &*v {
                    "window" => Some(OpenTarget::Window),
                    "tab" => Some(OpenTarget::Tab),
                    "nvim-tab" => Some(OpenTarget::NvimTab),
                    _ => return Err(format!("bad target={v:?} in {url}")),
                }
            }
            "cwd" if v.starts_with('/') => req.cwd = Some(v.into_owned()),
            "readonly" => req.readonly = matches!(&*v, "1" | "true" | ""),
            "swap" => {
                req.swap = Some(
                    SwapPolicy::parse(&v).ok_or_else(|| format!("bad swap={v:?} in {url}"))?,
                )
            }
            _ => log::info!("gneovim://: ignoring parameter {k}={v}"),
        }
    }
    Ok(req)
}

/// Split a trailing `:line` or `:line:col` off a path.
fn split_line_col(path: &str) -> (&str, Option<u32>, Option<u32>) {
    let num = |s: &str| -> Option<u32> {
        (!s.is_empty() && s.bytes().all(|b| b.is_ascii_digit()))
            .then(|| s.parse().ok())
            .flatten()
    };
    let Some((rest, last)) = path.rsplit_once(':') else {
        return (path, None, None);
    };
    let Some(last) = num(last) else {
        return (path, None, None);
    };
    match rest.rsplit_once(':') {
        Some((rest2, mid)) if num(mid).is_some() => (rest2, num(mid), Some(last)),
        _ => (rest, Some(last), None),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn p(s: &str) -> Result<OpenRequest, String> {
        parse(&Url::parse(s).unwrap())
    }

    #[test]
    fn path_line_col() {
        let r = p("gneovim://file/Users/me/a.md:12:3").unwrap();
        assert_eq!(r.path, "/Users/me/a.md");
        assert_eq!((r.line, r.col), (Some(12), Some(3)));

        let r = p("gneovim://file/Users/me/a.md:12").unwrap();
        assert_eq!((r.line, r.col), (Some(12), None));

        let r = p("gneovim://file/Users/me/a.md").unwrap();
        assert_eq!((r.line, r.col), (None, None));
    }

    #[test]
    fn encoded_colon_is_part_of_the_name() {
        let r = p("gneovim://file/tmp/notes%3A12").unwrap();
        assert_eq!(r.path, "/tmp/notes:12");
        assert_eq!(r.line, None);

        let r = p("gneovim://file/tmp/notes%3A12:5").unwrap();
        assert_eq!(r.path, "/tmp/notes:12");
        assert_eq!(r.line, Some(5));
    }

    #[test]
    fn decodes_spaces_and_unicode() {
        let r = p("gneovim://file/tmp/my%20notes/%E4%B8%AD.md").unwrap();
        assert_eq!(r.path, "/tmp/my notes/中.md");
    }

    #[test]
    fn double_slash_template() {
        let r = p("gneovim://file//Users/me/a.md:4").unwrap();
        assert_eq!(r.path, "/Users/me/a.md");
        assert_eq!(r.line, Some(4));
    }

    #[test]
    fn query_parameters() {
        let r = p("gneovim://file/a.md?target=nvim-tab&cwd=%2Ftmp%2Fx&readonly=1&swap=takeover&zzz=1")
            .unwrap();
        assert_eq!(r.target, Some(OpenTarget::NvimTab));
        assert_eq!(r.cwd.as_deref(), Some("/tmp/x"));
        assert!(r.readonly);
        assert_eq!(r.swap, Some(SwapPolicy::Takeover));
    }

    #[test]
    fn swap_policy_defaults() {
        let r = p("gneovim://file/a.md").unwrap();
        assert_eq!(r.swap_policy(), SwapPolicy::Reveal);
        let r = p("gneovim://file/a.md?readonly=1").unwrap();
        assert_eq!(r.swap_policy(), SwapPolicy::Readonly);
        let r = p("gneovim://file/a.md?readonly=1&swap=ask").unwrap();
        assert_eq!(r.swap_policy(), SwapPolicy::Ask);
    }

    #[test]
    fn cli_shim_output() {
        // Exactly what resources/bin/gneovim emits for
        // `gneovim -p -R --swap=takeover "+call cursor(3, 7)" /x/中:1.md`.
        let r = p("gneovim://file/x/%E4%B8%AD%3A1.md:3:7?cwd=/tmp&target=nvim-tab&readonly=1&swap=takeover")
            .unwrap();
        assert_eq!(r.path, "/x/中:1.md");
        assert_eq!((r.line, r.col), (Some(3), Some(7)));
        assert_eq!(r.cwd.as_deref(), Some("/tmp"));
        assert_eq!(r.target, Some(OpenTarget::NvimTab));
        assert!(r.readonly);
        assert_eq!(r.swap_policy(), SwapPolicy::Takeover);
    }

    #[test]
    fn rejects() {
        assert!(p("gneovim://run/a.md").is_err());
        assert!(p("gneovim://file/").is_err());
        assert!(p("gneovim://file/a.md?swap=nuke").is_err());
        assert!(p("gneovim://file/a.md?target=elsewhere").is_err());
    }
}
