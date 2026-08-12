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
use zellij_tile::prelude::*;

register_plugin!(State);

#[derive(Default)]
struct State {
    panes: Vec<PaneRow>,
    tabs: Vec<String>,
    /// How many pushes Zellij has sent us — proof this is event driven.
    pane_updates: u64,
    tab_updates: u64,
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
        request_permission(&[
            PermissionType::ReadApplicationState,
            PermissionType::ReadCliPipes,
        ]);
        subscribe(&[EventType::PaneUpdate, EventType::TabUpdate]);
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
        let body = match query.as_str() {
            "events" => self.counters_json(),
            _ => self.panes_json(),
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
