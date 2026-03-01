/// <reference no-default-lib="true"/>
/// <reference types="@cloudflare/workers-types" />

import { withSyncSpan } from '@tldraw/sync-core'
import { WorkerEntrypoint } from 'cloudflare:workers'
import { AutoRouter, error, type IRequest } from 'itty-router'
import { extractRequestContext, flushSimpleOtel, initSimpleOtel, injectTraceHeaders } from './otel'
import type { SimpleSyncWorkerEnvironment } from './SimpleTldrawDurableObject'

export { SimpleTldrawDurableObject } from './SimpleTldrawDurableObject'

function redirectToClient(request: IRequest, roomId: string) {
	const url = new URL(request.url)
	const clientBase =
		url.hostname === 'localhost' ? 'http://localhost:5173' : 'http://127.0.0.1:5173'
	const target = new URL(clientBase)
	target.searchParams.set('room', roomId)
	return Response.redirect(target.toString(), 302)
}
function isTestRouteAllowed(env: SimpleSyncWorkerEnvironment) {
	return env.WORKER_ENV === 'development' || env.WORKER_ENV === 'test'
}

function forwardToRoomDo(
	request: IRequest,
	env: SimpleSyncWorkerEnvironment,
	opts: {
		roomId: string
		route: string
		path: string
		spanName: string
		search?: string
		trace?: boolean
	}
) {
	const forward = async () => {
		const id = env.SIMPLE_TLDRAW_DURABLE_OBJECT.idFromName(opts.roomId)
		const target = new URL(request.url)
		target.pathname = opts.path
		target.search = opts.search ?? ''
		return env.SIMPLE_TLDRAW_DURABLE_OBJECT.get(id).fetch(target.toString(), {
			method: request.method,
			headers: injectTraceHeaders(request.headers),
			body: request.body,
		})
	}

	if (opts.trace === false) return forward()

	return withSyncSpan(
		opts.spanName,
		{
			attributes: {
				'http.method': request.method,
				'http.route': opts.route,
				'tldraw.room.id': opts.roomId,
			},
		},
		async (span) => {
			const response = await forward()
			span.setAttribute('http.status_code', response.status)
			return response
		}
	)
}

const router = AutoRouter<IRequest, [env: SimpleSyncWorkerEnvironment]>({
	catch: (e) => error(e),
})
	.get('/', (request) => {
		return Response.redirect(new URL('/room/demo-room', request.url).toString(), 302)
	})
	.get('/room/:roomId', (request) => {
		return redirectToClient(request, request.params.roomId)
	})
	.get('/api/connect/:roomId', (request, env) => {
		const reqUrl = new URL(request.url)
		return forwardToRoomDo(request, env, {
			roomId: request.params.roomId,
			route: '/api/connect/:roomId',
			path: '/api/connect/' + encodeURIComponent(request.params.roomId),
			search: reqUrl.search,
			spanName: 'tlsync.example.worker.forward_connect',
		})
	})
	.post('/__test__/room/:roomId/reset', (request, env) => {
		if (!isTestRouteAllowed(env)) {
			return new Response('Not found', { status: 404 })
		}
		return forwardToRoomDo(request, env, {
			roomId: request.params.roomId,
			route: '/__test__/room/:roomId/reset',
			path: '/api/__test__/reset',
			spanName: 'tlsync.example.worker.test.reset',
			trace: false,
		})
	})
	.get('/__test__/room/:roomId/snapshot', (request, env) => {
		if (!isTestRouteAllowed(env)) {
			return new Response('Not found', { status: 404 })
		}
		return forwardToRoomDo(request, env, {
			roomId: request.params.roomId,
			route: '/__test__/room/:roomId/snapshot',
			path: '/api/__test__/snapshot',
			spanName: 'tlsync.example.worker.test.snapshot',
			trace: false,
		})
	})
	.get('/__test__/room/:roomId/spans', (request, env) => {
		if (!isTestRouteAllowed(env)) {
			return new Response('Not found', { status: 404 })
		}
		return forwardToRoomDo(request, env, {
			roomId: request.params.roomId,
			route: '/__test__/room/:roomId/spans',
			path: '/api/__test__/spans',
			spanName: 'tlsync.example.worker.test.spans',
			trace: false,
		})
	})
	.post('/__test__/room/:roomId/spans/clear', (request, env) => {
		if (!isTestRouteAllowed(env)) {
			return new Response('Not found', { status: 404 })
		}
		return forwardToRoomDo(request, env, {
			roomId: request.params.roomId,
			route: '/__test__/room/:roomId/spans/clear',
			path: '/api/__test__/spans/clear',
			spanName: 'tlsync.example.worker.test.clear_spans',
			trace: false,
		})
	})
	.get('/health', () => new Response('ok'))
	.all('*', () => new Response('Not found', { status: 404 }))

export default class SimpleSyncWorker extends WorkerEntrypoint<SimpleSyncWorkerEnvironment> {
	override async fetch(request: Request): Promise<Response> {
		initSimpleOtel(this.env)

		const pathname = new URL(request.url).pathname
		if (pathname.startsWith('/__test__/room/')) {
			try {
				return await router.fetch(request, this.env)
			} finally {
				this.ctx.waitUntil(flushSimpleOtel())
			}
		}

		const traceContext = extractRequestContext(request.headers)
		return withSyncSpan(
			'tlsync.example.worker.fetch',
			{
				attributes: {
					'http.method': request.method,
					'http.path': pathname,
				},
			},
			async () => {
				try {
					return await router.fetch(request, this.env)
				} finally {
					this.ctx.waitUntil(flushSimpleOtel())
				}
			},
			traceContext
		)
	}
}
