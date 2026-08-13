//! zSwarm event-bus spike.
//!
//! Zellij pushes pane and tab state into this plugin as it changes. A CLI
//! caller asks for the current picture over a pipe and gets an answer from
//! memory — no `dump-screen`, no poll loop, no process per pane.
//!
//!   zellij pipe --plugin file:D:/abs/path/zswarm-events.wasm \
//!     -c instance=zswarm-bus --name zswarm -- status
//!
//! The `-c` key matters: the default empty configuration collides with dead
//! instances of the same plugin, and the pipe is then silently dropped.
//!
//! Pipe names: `status` (pane snapshot), `events` (counters since load).

use std::collections::BTreeMap;
use std::time::Instant;
use zellij_tile::prelude::*;

register_plugin!(State);

#[derive(Default)]
struct State {
    panes: Vec<PaneRow>,
    tabs: Vec<String>,
    /// How many pushes Zellij has sent us — proof this is event driven.
    pane_updates: u64,
    tab_updates: u64,
    /// Last screen handed out per pane, so "did anything move?" needs no second
    /// sample. Only written by the `changed` op — `scrollback` is a pure read.
    seen: BTreeMap<String, String>,
    /// Waits currently holding a CLI pipe open. Keyed by pipe id.
    waiting: Vec<PendingWait>,
    /// Outstanding set_timeout calls. tick_waits only re-arms when this hits
    /// zero, so overlapping waits do not grow a timer chain each.
    timer_pending: u32,
}

/// A `wait` that has not resolved yet. The caller's `zellij pipe` stays blocked
/// until one of these finishes, so a minute-long wait costs one process rather
/// than one per poll.
struct PendingWait {
    pipe_id: String,
    pane: PaneId,
    /// The typed id the caller used, echoed back in the reply.
    pane_key: String,
    /// "match" | "idle" | "either"
    mode: String,
    needle: Option<String>,
    ignore_case: bool,
    idle_ms: f64,
    poll_ms: f64,
    timeout_ms: f64,
    /// Wall clock at begin_wait — not summed Timer elapsed. Extra Timer
    /// events from overlapping set_timeout calls must not speed this up.
    started_at: Instant,
    last_change_at: Instant,
    last_screen: Option<String>,
    /// Match dump --full: include lines above the viewport.
    full: bool,
}

#[derive(Clone)]
struct PaneRow {
    id: u32,
    is_plugin: bool,
    title: String,
    exited: bool,
    focused: bool,
    command: Option<String>,
    tab: usize,
}

/// Callers treat any reply without `ok: true` as no reply and fall back to
/// polling, so an error still has to be well-formed JSON on one line.
fn error_json(message: &str) -> String {
    serde_json::json!({ "ok": false, "error": message }).to_string()
}

/// `terminal_3` / `plugin_1` — the same typed ids the CLI and MCP surface use.
fn parse_pane_id(raw: &str) -> Option<PaneId> {
    let (kind, number) = raw.split_once('_')?;
    let id = number.parse::<u32>().ok()?;
    match kind {
        "terminal" => Some(PaneId::Terminal(id)),
        "plugin" => Some(PaneId::Plugin(id)),
        _ => None,
    }
}

/// Mirror of `normalizeScreen` on the TypeScript side. The viewport arrives
/// padded to the terminal width where `dump-screen` leaves it ragged, so both
/// sides have to strip the same way or "did it change?" answers differently
/// depending on which path served the read.
fn normalize(lines: &[String]) -> String {
    let mut joined = lines
        .iter()
        .map(|line| line.trim_end())
        .collect::<Vec<_>>()
        .join("\n");
    while joined.ends_with('\n') {
        joined.pop();
    }
    joined
}

fn wait_screen(contents: &PaneContents, full: bool) -> String {
    if full {
        let mut lines = contents.lines_above_viewport.clone();
        lines.extend(contents.viewport.iter().cloned());
        lines.extend(contents.lines_below_viewport.iter().cloned());
        normalize(&lines)
    } else {
        normalize(&contents.viewport)
    }
}

fn contains(haystack: &str, needle: &str, ignore_case: bool) -> bool {
    if ignore_case {
        haystack.to_lowercase().contains(&needle.to_lowercase())
    } else {
        haystack.contains(needle)
    }
}

fn escape(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    for ch in input.chars() {
        match ch {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => out.push(' '),
            c => out.push(c),
        }
    }
    out
}

impl State {
    fn panes_json(&self) -> String {
        let rows: Vec<String> = self
            .panes
            .iter()
            .map(|p| {
                let command = match &p.command {
                    Some(c) => format!("\"{}\"", escape(c)),
                    None => "null".to_string(),
                };
                format!(
                    "{{\"id\":\"{}_{}\",\"title\":\"{}\",\"exited\":{},\"focused\":{},\"command\":{},\"tab\":{}}}",
                    if p.is_plugin { "plugin" } else { "terminal" },
                    p.id,
                    escape(&p.title),
                    p.exited,
                    p.focused,
                    command,
                    p.tab
                )
            })
            .collect();
        // `ready` is false until Zellij has pushed at least one manifest, so a
        // caller can tell a cold instance from a genuinely empty session.
        format!(
            "{{\"ok\":true,\"source\":\"plugin\",\"ready\":{},\"paneUpdates\":{},\"tabUpdates\":{},\"tabs\":[{}],\"panes\":[{}]}}",
            self.pane_updates > 0,
            self.pane_updates,
            self.tab_updates,
            self.tabs
                .iter()
                .map(|t| format!("\"{}\"", escape(t)))
                .collect::<Vec<_>>()
                .join(","),
            rows.join(",")
        )
    }

    /// Read N pane screens inside the server, so the caller spawns one process
    /// instead of one `dump-screen` per pane. Unknown ids are reported in
    /// `missing` rather than failing the whole batch — a pane closing between
    /// the ask and the read is normal, not an error.
    fn scrollback_json(&self, request: &serde_json::Value) -> String {
        let full = request
            .get("full")
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(false);
        let requested: Vec<&str> = request
            .get("panes")
            .and_then(serde_json::Value::as_array)
            .map(|items| items.iter().filter_map(serde_json::Value::as_str).collect())
            .unwrap_or_default();

        let mut panes = Vec::new();
        let mut missing = Vec::new();
        for id in requested {
            let Some(pane_id) = parse_pane_id(id) else {
                missing.push(id);
                continue;
            };
            match get_pane_scrollback(pane_id, full) {
                Ok(contents) => panes.push(serde_json::json!({
                    "id": id,
                    "viewport": contents.viewport,
                    "above": contents.lines_above_viewport,
                    "below": contents.lines_below_viewport,
                })),
                Err(_) => missing.push(id),
            }
        }

        serde_json::json!({
            "ok": true,
            "source": "plugin",
            "ready": self.pane_updates > 0,
            "panes": panes,
            "missing": missing,
        })
        .to_string()
    }

    /// Screens plus a `changed` flag against what this plugin handed out last
    /// time. Lets a caller tell moving panes from still ones with no sample gap
    /// — at the cost of a different question: "since your last call", not
    /// "in the last 400ms".
    fn changed_json(&mut self, request: &serde_json::Value) -> String {
        let requested: Vec<String> = request
            .get("panes")
            .and_then(serde_json::Value::as_array)
            .map(|items| {
                items
                    .iter()
                    .filter_map(serde_json::Value::as_str)
                    .map(str::to_string)
                    .collect()
            })
            .unwrap_or_default();

        let mut panes = Vec::new();
        let mut missing = Vec::new();
        for id in requested {
            let Some(pane_id) = parse_pane_id(&id) else {
                missing.push(id);
                continue;
            };
            match get_pane_scrollback(pane_id, false) {
                Ok(contents) => {
                    let screen = normalize(&contents.viewport);
                    let previous = self.seen.get(&id);
                    // First sight is not a change: nobody asked before, so
                    // there is nothing it could have moved since.
                    let changed = previous.is_some_and(|prev| prev != &screen);
                    let first = previous.is_none();
                    panes.push(serde_json::json!({
                        "id": id,
                        "viewport": contents.viewport,
                        "changed": changed,
                        "first": first,
                    }));
                    self.seen.insert(id, screen);
                },
                Err(_) => missing.push(id),
            }
        }

        serde_json::json!({
            "ok": true,
            "source": "plugin",
            "ready": self.pane_updates > 0,
            "panes": panes,
            "missing": missing,
        })
        .to_string()
    }

    /// Take a wait and hold the caller's pipe. Returns an error string when the
    /// request is one this plugin will not serve, so zswarm falls back to
    /// polling rather than getting a wrong answer.
    fn begin_wait(&mut self, pipe_id: &str, request: &serde_json::Value) -> Option<String> {
        // No regex crate in a wasm plugin: a regex wait belongs on the polling
        // path, where the caller's engine decides what matches.
        if request
            .get("regex")
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(false)
        {
            return Some(error_json("regex waits are not served by the plugin"));
        }
        let id = request.get("pane").and_then(serde_json::Value::as_str)?;
        let pane = parse_pane_id(id)?;
        let number = |key: &str, fallback: f64| {
            request
                .get(key)
                .and_then(serde_json::Value::as_f64)
                .unwrap_or(fallback)
        };
        let mode = request
            .get("for")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("idle")
            .to_string();
        let needle = request
            .get("match")
            .and_then(serde_json::Value::as_str)
            .map(str::to_string);
        if mode != "idle" && needle.is_none() {
            return Some(error_json("match waits need a needle"));
        }

        let poll_ms = number("pollMs", 50.0).clamp(20.0, 30_000.0);
        let now = Instant::now();
        self.waiting.push(PendingWait {
            pipe_id: pipe_id.to_string(),
            pane,
            pane_key: id.to_string(),
            mode,
            needle,
            ignore_case: request
                .get("ignoreCase")
                .and_then(serde_json::Value::as_bool)
                .unwrap_or(false),
            idle_ms: number("idleMs", 2000.0).clamp(200.0, 600_000.0),
            poll_ms,
            timeout_ms: number("timeoutMs", 60000.0).clamp(1_000.0, 900_000.0),
            started_at: now,
            last_change_at: now,
            last_screen: None,
            full: request
                .get("full")
                .and_then(serde_json::Value::as_bool)
                .unwrap_or(false),
        });
        block_cli_pipe_input(pipe_id);
        // Arm this wait. tick_waits only re-arms when timer_pending hits zero,
        // so these extra one-shots do not become permanent chains.
        self.timer_pending = self.timer_pending.saturating_add(1);
        set_timeout(poll_ms / 1000.0);
        None
    }

    /// One poll tick for every held wait. Anything that resolves answers its
    /// own pipe and releases the caller; the rest re-arm the timer.
    fn tick_waits(&mut self) {
        self.timer_pending = self.timer_pending.saturating_sub(1);
        let now = Instant::now();
        let mut still_waiting = Vec::new();
        let mut shortest_poll = f64::MAX;

        for mut wait in std::mem::take(&mut self.waiting) {
            let elapsed_ms = now
                .saturating_duration_since(wait.started_at)
                .as_secs_f64()
                * 1000.0;
            let screen = match get_pane_scrollback(wait.pane, wait.full) {
                Ok(contents) => wait_screen(&contents, wait.full),
                // The pane went away mid-wait; say so rather than hanging.
                Err(_) => {
                    self.finish_wait(&wait, "gone", "");
                    continue;
                },
            };

            let matched = wait
                .needle
                .as_ref()
                .is_some_and(|needle| contains(&screen, needle, wait.ignore_case));
            if matched && wait.mode != "idle" {
                self.finish_wait(&wait, "match", &screen);
                continue;
            }

            match &wait.last_screen {
                Some(previous) if previous == &screen => {}
                _ => wait.last_change_at = now,
            }
            wait.last_screen = Some(screen.clone());
            let unchanged_ms = now
                .saturating_duration_since(wait.last_change_at)
                .as_secs_f64()
                * 1000.0;

            if wait.mode != "match" && unchanged_ms >= wait.idle_ms {
                self.finish_wait(&wait, "idle", &screen);
                continue;
            }
            if elapsed_ms >= wait.timeout_ms {
                self.finish_wait(&wait, "timeout", &screen);
                continue;
            }
            shortest_poll = shortest_poll.min(wait.poll_ms);
            still_waiting.push(wait);
        }

        self.waiting = still_waiting;
        if !self.waiting.is_empty() && self.timer_pending == 0 {
            self.timer_pending = 1;
            set_timeout(shortest_poll / 1000.0);
        }
    }

    fn finish_wait(&self, wait: &PendingWait, reason: &str, screen: &str) {
        let body = serde_json::json!({
            "ok": true,
            "source": "plugin",
            "ready": true,
            "reason": reason,
            "pane": wait.pane_key,
            "viewport": screen.split('\n').collect::<Vec<_>>(),
        });
        cli_pipe_output(&wait.pipe_id, &format!("{}\n", body));
        unblock_cli_pipe_input(&wait.pipe_id);
    }

    fn counters_json(&self) -> String {
        format!(
            "{{\"ok\":true,\"paneUpdates\":{},\"tabUpdates\":{},\"panes\":{}}}",
            self.pane_updates,
            self.tab_updates,
            self.panes.len()
        )
    }
}

impl ZellijPlugin for State {
    fn load(&mut self, _configuration: BTreeMap<String, String>) {
        // ReadApplicationState: pane/tab events. ReadCliPipes: answering a
        // `zellij pipe` caller at all (cli_pipe_output / unblock_cli_pipe_input).
        // ReadPaneContents is a third, separate grant for get_pane_scrollback.
        // Adding it to an already-approved URL is silently denied, so a build
        // that gains a permission has to ship under a new filename.
        request_permission(&[
            PermissionType::ReadApplicationState,
            PermissionType::ReadCliPipes,
            PermissionType::ReadPaneContents,
        ]);
        // Timer drives the held waits; without it a blocked pipe never wakes.
        subscribe(&[
            EventType::PaneUpdate,
            EventType::TabUpdate,
            EventType::Timer,
        ]);
    }

    fn update(&mut self, event: Event) -> bool {
        match event {
            // Zellij hands us the whole manifest whenever anything changes.
            Event::PaneUpdate(manifest) => {
                self.pane_updates += 1;
                let mut rows = Vec::new();
                for (tab, panes) in manifest.panes.iter() {
                    for pane in panes {
                        rows.push(PaneRow {
                            id: pane.id,
                            is_plugin: pane.is_plugin,
                            title: pane.title.clone(),
                            exited: pane.exited,
                            focused: pane.is_focused,
                            command: pane
                                .terminal_command
                                .clone()
                                .filter(|c| !c.is_empty()),
                            tab: *tab,
                        });
                    }
                }
                rows.sort_by_key(|r| (r.is_plugin, r.id));
                self.panes = rows;
                true
            }
            Event::TabUpdate(tabs) => {
                self.tab_updates += 1;
                self.tabs = tabs.iter().map(|t| t.name.clone()).collect();
                true
            }
            Event::Timer(_elapsed) => {
                self.tick_waits();
                false
            },
            _ => false,
        }
    }

    fn pipe(&mut self, pipe_message: PipeMessage) -> bool {
        if pipe_message.name != "zswarm" {
            return false;
        }
        let PipeSource::Cli(id) = &pipe_message.source else {
            return false;
        };
        // When stdin is not a terminal the CLI reads it and sends a second,
        // empty message at EOF. Answering it would duplicate the JSON, but
        // leaving it blocked keeps the caller's process alive until it is
        // killed — so unblock it and say nothing.
        let query = match pipe_message.payload.as_deref().map(str::trim) {
            Some(q) if !q.is_empty() => q.to_string(),
            _ => {
                unblock_cli_pipe_input(id);
                return false;
            }
        };
        // A payload that opens a brace is a structured request; anything else
        // stays a bare word, so the original `status` / `events` pipes still work.
        let body = if query.starts_with('{') {
            match serde_json::from_str::<serde_json::Value>(&query) {
                Ok(request) => match request.get("op").and_then(serde_json::Value::as_str) {
                    Some("scrollback") => self.scrollback_json(&request),
                    Some("changed") => self.changed_json(&request),
                    // A wait answers later, from the timer, so it returns here
                    // without unblocking — unless it refused the request.
                    Some("wait") => match self.begin_wait(id, &request) {
                        Some(refusal) => refusal,
                        None => return false,
                    },
                    other => error_json(&format!("unknown op {:?}", other)),
                },
                Err(err) => error_json(&format!("bad json: {}", err)),
            }
        } else {
            match query.as_str() {
                "events" => self.counters_json(),
                _ => self.panes_json(),
            }
        };
        // First argument is the CLI pipe id (a uuid), not the `--name` value.
        cli_pipe_output(id, &format!("{}\n", body));
        unblock_cli_pipe_input(id);
        false
    }

    fn render(&mut self, _rows: usize, _cols: usize) {
        print_text_with_coordinates(
            Text::new(format!(
                "zswarm events — {} panes, {} pushes",
                self.panes.len(),
                self.pane_updates
            )),
            0,
            0,
            None,
            None,
        );
    }
}
