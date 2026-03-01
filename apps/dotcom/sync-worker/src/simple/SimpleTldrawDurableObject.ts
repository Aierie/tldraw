import {
	DEFAULT_INITIAL_SNAPSHOT,
	DurableObjectSqliteSyncWrapper,
	SQLiteSyncStorage,
	TLSocketRoom,
	withSyncSpan,
	type RoomSnapshot,
} from '@tldraw/sync-core'
import { createTLSchema, defaultShapeSchemas, type TLRecord } from '@tldraw/tlschema'
import { DurableObject } from 'cloudflare:workers'
import { AutoRouter, error, type IRequest } from 'itty-router'
import {
	clearCapturedSimpleSpans,
	extractRequestContext,
	flushSimpleOtel,
	getCapturedSimpleSpans,
	initSimpleOtel,
	type SimpleOtelEnvironment,
} from './otel'

const schema = createTLSchema({
	shapes: { ...defaultShapeSchemas },
})

function json(body: unknown, status = 200) {
	return new Response(JSON.stringify(body), {
		status,
		headers: {
			'content-type': 'application/json; charset=utf-8',
		},
	})
}

export interface SimpleSyncWorkerEnvironment extends SimpleOtelEnvironment {
	SIMPLE_TLDRAW_DURABLE_OBJECT: DurableObjectNamespace
}

export class SimpleTldrawDurableObject extends DurableObject<SimpleSyncWorkerEnvironment> {
	private room: TLSocketRoom<TLRecord, void>
	private readonly sql: DurableObjectSqliteSyncWrapper

	constructor(ctx: DurableObjectState, env: SimpleSyncWorkerEnvironment) {
		super(ctx, env)
		initSimpleOtel(env)

		this.sql = new DurableObjectSqliteSyncWrapper(ctx.storage)
		this.room = this.createRoom()
	}

	private createRoom(snapshot?: RoomSnapshot) {
		const storage = new SQLiteSyncStorage<TLRecord>({
			sql: this.sql,
			snapshot,
		})
		return new TLSocketRoom<TLRecord, void>({ schema, storage })
	}

	private readonly router = AutoRouter({ catch: (e) => error(e) })
		.get('/api/connect/:roomId', (request) => this.handleConnect(request))
		.post('/api/__test__/reset', () => this.handleTestReset())
		.get('/api/__test__/snapshot', () => this.handleTestSnapshot())
		.get('/api/__test__/spans', () => this.handleTestSpans())
		.post('/api/__test__/spans/clear', () => this.handleTestClearSpans())

	override fetch(request: Request): Response | Promise<Response> {
		const pathname = new URL(request.url).pathname
		if (pathname.startsWith('/api/__test__/')) {
			try {
				return this.router.fetch(request)
			} finally {
				this.ctx.waitUntil(flushSimpleOtel())
			}
		}

		const traceContext = extractRequestContext(request.headers)
		return withSyncSpan(
			'tlsync.example.do.fetch',
			{
				attributes: {
					'http.method': request.method,
					'http.route': pathname,
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

	private isTestRouteAllowed() {
		return this.env.WORKER_ENV === 'development' || this.env.WORKER_ENV === 'test'
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

	private handleTestReset(): Response {
		if (!this.isTestRouteAllowed()) {
			return new Response('Not found', { status: 404 })
		}

		this.room.close()
		this.room = this.createRoom(DEFAULT_INITIAL_SNAPSHOT)
		clearCapturedSimpleSpans()
		return json({ ok: true })
	}

	private handleTestSnapshot(): Response {
		if (!this.isTestRouteAllowed()) {
			return new Response('Not found', { status: 404 })
		}
		return json(this.room.getCurrentSnapshot())
	}

	private handleTestSpans(): Response {
		if (!this.isTestRouteAllowed()) {
			return new Response('Not found', { status: 404 })
		}
		return json({ spans: getCapturedSimpleSpans() })
	}

	private handleTestClearSpans(): Response {
		if (!this.isTestRouteAllowed()) {
			return new Response('Not found', { status: 404 })
		}
		clearCapturedSimpleSpans()
		return json({ ok: true })
	}

}
