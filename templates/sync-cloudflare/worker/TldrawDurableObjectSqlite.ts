import * as SyncCore from '@tldraw/sync-core'
import {
	createTLSchema,
	// defaultBindingSchemas,
	defaultShapeSchemas,
} from '@tldraw/tlschema'
import { DurableObject } from 'cloudflare:workers'
import { AutoRouter, error, IRequest } from 'itty-router'

// add custom shapes and bindings here if needed:
const schema = createTLSchema({
	shapes: { ...defaultShapeSchemas },
	// bindings: { ...defaultBindingSchemas },
})

// Keep runtime wiring on public sync-core exports even when template type surfaces lag.
const DurableObjectSqliteSyncWrapper = (SyncCore as any).DurableObjectSqliteSyncWrapper as new (
	storage: DurableObjectStorage
) => any
const SQLiteSyncStorage = (SyncCore as any).SQLiteSyncStorage as new (opts: { sql: any }) => any
const TLSocketRoom = SyncCore.TLSocketRoom as new (opts: {
	schema: typeof schema
	storage: any
}) => {
	handleSocketConnect(args: { sessionId: string; socket: WebSocket }): void
}

// Each whiteboard room is hosted in a Durable Object.
// https://developers.cloudflare.com/durable-objects/
//
// There's only ever one durable object instance per room. Room state is
// persisted automatically to SQLite via ctx.storage.
export class TldrawDurableObjectSqlite extends DurableObject {
	private room: {
		handleSocketConnect(args: { sessionId: string; socket: WebSocket }): void
	}

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env)

		const sql = new DurableObjectSqliteSyncWrapper(ctx.storage)
		const storage = new SQLiteSyncStorage({ sql })
		this.room = new TLSocketRoom({ schema, storage })
	}

	private readonly router = AutoRouter({ catch: (e) => error(e) }).get(
		'/api/connect/:roomId',
		(request) => this.handleConnect(request)
	)

	fetch(request: Request): Response | Promise<Response> {
		return this.router.fetch(request)
	}

	async handleConnect(request: IRequest) {
		const sessionId = request.query.sessionId as string
		if (!sessionId) return error(400, 'Missing sessionId')

		const { 0: clientWebSocket, 1: serverWebSocket } = new WebSocketPair()
		serverWebSocket.accept()

		this.room.handleSocketConnect({ sessionId, socket: serverWebSocket })

		return new Response(null, { status: 101, webSocket: clientWebSocket })
	}
}
