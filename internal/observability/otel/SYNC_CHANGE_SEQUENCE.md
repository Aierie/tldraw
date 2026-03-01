# Sync change path span map (client → server)

This document maps the sync span flow for a document change from browser client to server persistence/fanout.

## Sequence diagram (updated)

```mermaid
sequenceDiagram
	autonumber
	participant Edit as Local edit
	participant Client as TLSyncClient / client socket layer
	participant Edge as sync-worker route
	participant DO as TLDrawDurableObject
	participant Ingress as TLSocketRoom
	participant Room as TLSyncRoom
	participant DB as SQLite storage

	Note over Client,Room: Common background path (heartbeat)
	Client->>Client: tlsync.client.ping
	Client->>Ingress: tlsync.socket.client.send (ping)
	Ingress->>Ingress: tlsync.socket.server.assemble
	Ingress->>Ingress: tlsync.socket.server.receive (ping)
	Ingress->>Room: handleMessage(ping)
	Room->>Room: tlsync.room.handle_message
	Room->>Ingress: tlsync.socket.server.send (pong)
	Ingress-->>Client: pong
	Client->>Client: tlsync.socket.client.parse_message / receive
	Client->>Client: tlsync.client.receive (pong)

	Note over Client,DB: Per-change path
	Edit->>Client: local store change
	Client->>Client: tlsync.client.store_changes
	Client->>Client: tlsync.client.queue_push
	Client->>Client: tlsync.client.push
	Client->>Ingress: tlsync.socket.client.send (push)
	Ingress->>Ingress: tlsync.socket.server.assemble
	Ingress->>Ingress: tlsync.socket.server.receive
	Ingress->>Room: handleMessage(push)
	Room->>Room: tlsync.room.handle_message
	Room->>Room: tlsync.room.push
	Room->>DB: tlsync.storage.sqlite.transaction
	DB->>DB: tlsync.storage.sqlite.transaction.wrapper / statement.*
	Room->>Room: tlsync.room.push_outcome (commit/discard/rebase)
	Room->>Ingress: tlsync.socket.server.send (push_result)
	Room->>Room: tlsync.room.broadcast_patch
	Ingress->>Ingress: tlsync.socket.server.flush_data (debounced batches)
	Note over Ingress,Client: push_result/patch may arrive via data envelope
	Ingress-->>Client: data [...push_result/patch...]
	Client->>Client: tlsync.socket.client.parse_message / receive
	Client->>Client: tlsync.client.receive
	Client->>Client: tlsync.client.rebase

	Note over Edge,DO: Connection/setup spans may occur outside a short capture window
	Edge->>Edge: tlsync.worker.fetch / join_existing_room / forward_room_request
	DO->>DO: tlsync.worker.do.fetch / on_request.*
	DO->>Ingress: tlsync.socket.server.connect
	Ingress->>Room: handleNewSession
	Room->>Room: tlsync.room.connect
```

## Notes

- `traceparent` / `tracestate` are propagated in protocol `trace` carriers.
- Server ingress passes active context into room handling (`tlsync.socket.server.receive` → `tlsync.room.handle_message`).
- Push outcomes expose `tldraw.push_result.action` (`commit`, `discard`, `rebase`, `none`) and `tldraw.push_result.broadcast`.
- `push_result` can be sent as a data payload, so client-side receive type may be `data` rather than `push_result`.
- In the current `data/traces.jsonl` capture, client and server spans did **not** share trace IDs (no cross-service trace joins observed in that window).
