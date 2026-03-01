# tldraw sync instrumentation taxonomy

Use this as a naming and coverage guide when instrumenting sync flows.

## 1) Client spans (`packages/sync`, `packages/sync-core`)

- `tlsync.client.store_changes`
- `tlsync.client.queue_push`
- `tlsync.client.push`
- `tlsync.client.push_presence`
- `tlsync.client.ping`
- `tlsync.client.rebase`
- `tlsync.client.reset_connection`
- `tlsync.client.socket_status_change`

### Local demo source for client spans

- In the simple lab setup, browser client spans are emitted from `apps/dotcom/sync-worker/src/simple/worker.ts`.
- These spans are exported under service `tldraw-sync-core-simple-client`.
- If a page does not initialize a browser OTel provider/exporter, expect server-only traces even if `TLSyncClient` code contains span calls.

### Socket adapter (client)

- `tlsync.socket.client.send`
- `tlsync.socket.client.send_dropped`
- `tlsync.socket.client.receive`
- `tlsync.socket.client.parse_message`
- `tlsync.socket.client.dispatch_message`
- `tlsync.socket.client.onopen`
- `tlsync.socket.client.onclose`
- `tlsync.socket.client.onerror`
- `tlsync.socket.client.connected`
- `tlsync.socket.client.disconnected`
- `tlsync.socket.client.reconnect.schedule_attempt`
- `tlsync.socket.client.reconnect.maybe_reconnected`

## 2) Server spans (`packages/sync-core`)

### Socket/transport boundary

- `tlsync.socket.server.connect`
- `tlsync.socket.server.receive`
- `tlsync.socket.server.assemble`
- `tlsync.socket.server.send`
- `tlsync.socket.server.flush_data`
- `tlsync.socket.server.error`
- `tlsync.socket.server.close`

### Room/message handling

- `tlsync.room.handle_message`
- `tlsync.room.push`
- `tlsync.room.push_outcome`
- `tlsync.room.broadcast_patch`
- `tlsync.room.reject_session`

### Storage layer

- `tlsync.storage.sqlite.transaction`
- wrapper/statement spans around SQL execution paths

## 3) Worker / Durable Object spans (`apps/dotcom/sync-worker`)

- `tlsync.worker.fetch`
- `tlsync.worker.do.fetch`
- `tlsync.worker.do.on_request`
- explicit child spans for auth/permission/rate-limit/room-load/socket-connect/forward

Always set `http.status_code` on request-level spans.

## 4) Attribute conventions

Prefer stable keys and low-cardinality values.

Recommended keys:

- `tldraw.room_id`
- `tldraw.session_id`
- `tldraw.user_id`
- `tldraw.store_id`
- `tldraw.outcome`
- `tlsync.message.type`
- `tlsync.message.bytes`
- `tlsync.listener_count`
- `tlsync.reconnect.attempt`
- `tlsync.reconnect.delay_ms`
- `tlsync.close.code`
- `tlsync.close.reason`

If branch code already standardizes different keys, follow local convention consistently within that branch.

## 5) Gap checklist

Audit these every time:

1. Missing span for outbound socket send.
2. Repeated context extraction causing trace flattening.
3. Error-only observability with no business outcome attribute.
4. Request spans missing `http.status_code`.
5. Worker/DO flow missing child spans for auth/forward decision points.
6. Snapshot instability caused by optional trace fields emitted as `undefined`.
