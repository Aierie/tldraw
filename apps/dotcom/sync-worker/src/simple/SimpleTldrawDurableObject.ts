import {
	DurableObjectSqliteSyncWrapper,
	SQLiteSyncStorage,
	TLSocketRoom,
	withSyncSpan,
} from '@tldraw/sync-core'
import { createTLSchema, defaultShapeSchemas, type TLRecord } from '@tldraw/tlschema'
import { DurableObject } from 'cloudflare:workers'
import { AutoRouter, error, type IRequest } from 'itty-router'
import {
	extractRequestContext,
	flushSimpleOtel,
	initSimpleOtel,
	type SimpleOtelEnvironment,
} from './otel'

const schema = createTLSchema({
	shapes: { ...defaultShapeSchemas },
})

export interface SimpleSyncWorkerEnvironment extends SimpleOtelEnvironment {
	SIMPLE_TLDRAW_DURABLE_OBJECT: DurableObjectNamespace
}

export class SimpleTldrawDurableObject extends DurableObject<SimpleSyncWorkerEnvironment> {
	private readonly room: TLSocketRoom<TLRecord, void>

	constructor(ctx: DurableObjectState, env: SimpleSyncWorkerEnvironment) {
		super(ctx, env)
		initSimpleOtel(env)

		const sql = new DurableObjectSqliteSyncWrapper(ctx.storage)
		const storage = new SQLiteSyncStorage<TLRecord>({
			sql,
		})

		this.room = new TLSocketRoom<TLRecord, void>({ schema, storage })
	}

	private readonly router = AutoRouter({ catch: (e) => error(e) }).get(
		'/api/connect/:roomId',
		(request) => this.handleConnect(request)
	)

	override fetch(request: Request): Response | Promise<Response> {
		const traceContext = extractRequestContext(request.headers)

		return withSyncSpan(
			'tlsync.example.do.fetch',
			{
				attributes: {
					'http.method': request.method,
					'http.route': '/api/connect/:roomId',
				},
			},
			async () => {
				try {
					return await this.router.fetch(request)
				} finally {
					this.ctx.waitUntil(flushSimpleOtel())
				}
			},
			traceContext
		)
	}

	private handleConnect(request: IRequest): Response {
		return withSyncSpan(
			'tlsync.example.do.connect',
			{
				attributes: {
					'http.method': request.method,
					'http.route': '/api/connect/:roomId',
					'tldraw.room.id': request.params.roomId,
				},
			},
			() => {
				if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
					return error(400, 'Expected websocket upgrade')
				}

				const sessionId = request.query.sessionId as string | undefined
				if (!sessionId) return error(400, 'Missing sessionId')

				const { 0: clientWebSocket, 1: serverWebSocket } = new WebSocketPair()
				serverWebSocket.accept()

				this.room.handleSocketConnect({ sessionId, socket: serverWebSocket })

				return new Response(null, { status: 101, webSocket: clientWebSocket })
			}
		)
	}
}
