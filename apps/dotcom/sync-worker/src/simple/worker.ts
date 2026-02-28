/// <reference no-default-lib="true"/>
/// <reference types="@cloudflare/workers-types" />

import { withSyncSpan } from '@tldraw/sync-core'
import { WorkerEntrypoint } from 'cloudflare:workers'
import { AutoRouter, error, type IRequest } from 'itty-router'
import { extractRequestContext, flushSimpleOtel, initSimpleOtel } from './otel'
import type { SimpleSyncWorkerEnvironment } from './SimpleTldrawDurableObject'

export { SimpleTldrawDurableObject } from './SimpleTldrawDurableObject'

const router = AutoRouter<IRequest, [env: SimpleSyncWorkerEnvironment]>({
	catch: (e) => error(e),
})
	.get('/api/connect/:roomId', (request, env) => {
		return withSyncSpan(
			'tlsync.example.worker.forward_connect',
			{
				attributes: {
					'http.method': request.method,
					'http.route': '/api/connect/:roomId',
					'tldraw.room.id': request.params.roomId,
				},
			},
			() => {
				const id = env.SIMPLE_TLDRAW_DURABLE_OBJECT.idFromName(request.params.roomId)
				return env.SIMPLE_TLDRAW_DURABLE_OBJECT.get(id).fetch(request.url, {
					method: request.method,
					headers: request.headers,
					body: request.body,
				})
			}
		)
	})
	.get('/health', () => new Response('ok'))
	.all('*', () => new Response('Not found', { status: 404 }))

export default class SimpleSyncWorker extends WorkerEntrypoint<SimpleSyncWorkerEnvironment> {
	override async fetch(request: Request): Promise<Response> {
		initSimpleOtel(this.env)

		const traceContext = extractRequestContext(request.headers)

		return withSyncSpan(
			'tlsync.example.worker.fetch',
			{
				attributes: {
					'http.method': request.method,
					'http.path': new URL(request.url).pathname,
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
