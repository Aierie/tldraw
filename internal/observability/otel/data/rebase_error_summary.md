# Rebase Error Trace Summary

Signal used: `tldraw.client.reset.reason == "rebase_error"`

## Per-file counts and related spans

| File | rebase_error count | Associated span | Parent span | Preceding spans (count) |
|---|---:|---|---|---|
| `traces.chromium.essential-canvas-ops-via-dom-interaction-write-to-otel-traces-create-move-delete.w0.r0.jsonl` | 24 | `tlsync.client.reset_connection` | `tlsync.client.rebase` | `rebase` 10, `close_socket` 8, `disconnected` 2, `restart` 2, `reset_connection` 1, `socket_status_change` 1 |
| `traces.chromium.essential-canvas-ops-write-to-otel-traces-create-update-group-delete.w0.r0.jsonl` | 25 | `tlsync.client.reset_connection` | `tlsync.client.rebase` | `rebase` 11, `close_socket` 6, `disconnected` 3, `reset_connection` 2, `socket_status_change` 2, `restart` 1 |
| `traces.chromium.reload-keeps-grouped-ungrouped-mixed-deletion-state-and-captures-stack-traces.w0.r0.jsonl` | 24 | `tlsync.client.reset_connection` | `tlsync.client.rebase` | `rebase` 10, `close_socket` 6, `restart` 3, `disconnected` 2, `reset_connection` 2, `socket_status_change` 1 |
| `traces.jsonl` | 26 | `tlsync.client.reset_connection` | `tlsync.client.rebase` | `rebase` 11, `close_socket` 7, `disconnected` 3, `reset_connection` 2, `socket_status_change` 2, `restart` 1 |
