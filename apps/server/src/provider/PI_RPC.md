# Pi RPC coverage

T3 targets `@earendil-works/pi-coding-agent` and CLI **0.80.6**.

Native mappings:

- `prompt`, `steer`, and `abort` back T3 send, mid-turn steering, extension-command invocation, and stop.
- `get_state`, `get_messages`/streamed message events, model/thinking commands, `get_commands`, session statistics, session naming events, queue events, compaction, retry events, and extension errors synchronize existing T3 state and activity surfaces where RPC emits the data.
- `get_fork_messages`, `fork`, and `new_session` back checkpoint rollback. Session files back reconnect/resume.
- Extension dialogs and fire-and-forget UI requests use T3's composer, user-input, toast, status, widget, and browser-title surfaces.
- Export, manual compaction, queue-mode controls, session switch/tree/clone, and RPC bash have no separate T3 controls because T3 currently has no matching user workflow. They remain Pi-native commands rather than duplicate UI.

RPC limitations (not T3 bugs): Pi does not transport `ctx.ui.custom()`, raw terminal input, TUI shortcuts, custom working indicators, custom headers/footers, component widgets, custom editor components, TUI render functions, autocomplete providers, themes, or tool expansion state. RPC also exposes no query/event for the complete active-tool list, so extension-driven `setActiveTools()` cannot be mirrored; tool calls themselves remain visible through generic structured lifecycle events.
