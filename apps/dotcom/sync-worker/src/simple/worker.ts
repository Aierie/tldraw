/// <reference no-default-lib="true"/>
/// <reference types="@cloudflare/workers-types" />

import { withSyncSpan } from '@tldraw/sync-core'
import { WorkerEntrypoint } from 'cloudflare:workers'
import { AutoRouter, error, type IRequest } from 'itty-router'
import { extractRequestContext, flushSimpleOtel, initSimpleOtel, injectTraceHeaders } from './otel'
import type { SimpleSyncWorkerEnvironment } from './SimpleTldrawDurableObject'

export { SimpleTldrawDurableObject } from './SimpleTldrawDurableObject'

function html(content: string) {
	return new Response(content, {
		headers: { 'content-type': 'text/html; charset=utf-8' },
	})
}

function renderApp(roomId: string) {
	return `<!doctype html>
<html lang="en">
	<head>
		<meta charset="utf-8" />
		<meta name="viewport" content="width=device-width, initial-scale=1" />
		<title>tldraw sync worker demo</title>
		<style>
			@import url('https://fonts.googleapis.com/css2?family=Inter:wght@500;700&display=swap');
			@import url('https://unpkg.com/tldraw@4.4.0/tldraw.css');

			:root {
				font-family: 'Inter', sans-serif;
				color-scheme: light;
			}

			html, body, #root {
				margin: 0;
				height: 100%;
			}

			body {
				overscroll-behavior: none;
			}

			.RoomWrapper {
				--background: white;
				--text: hsl(0, 0%, 20%);
				--gray-dark: #e5e5e5;
				--black-transparent-lighter: rgba(0, 0, 0, 0.15);
				position: fixed;
				inset: 0;
				display: grid;
				grid-template-rows: auto 1fr;
			}

			.RoomWrapper-header {
				display: flex;
				align-items: center;
				gap: 12px;
				padding: 8px 16px;
				background: var(--background);
				border-bottom: 1px solid var(--gray-dark);
				color: var(--text);
				font-size: 14px;
			}

			.RoomWrapper-copy {
				background: var(--black-transparent-lighter);
				border: 1px solid var(--gray-dark);
				border-radius: 4px;
				padding: 4px 12px;
				height: 24px;
				cursor: pointer;
				position: relative;
				text-align: center;
			}

			.RoomWrapper-copy:has(.RoomWrapper-copied) {
				color: transparent;
			}

			.RoomWrapper-copied {
				color: var(--text);
				position: absolute;
				inset: 0;
				display: inline-flex;
				align-items: center;
				justify-content: center;
			}

			.RoomWrapper-content {
				position: relative;
				min-height: 1px;
			}
		</style>
	</head>
	<body>
		<div id="root"></div>
		<script type="module">
			import React from 'https://esm.sh/react@19.2.4'
			import { createRoot } from 'https://esm.sh/react-dom@19.2.4/client'
			import { Tldraw } from 'https://esm.sh/tldraw@4.4.0?deps=react@19.2.4,react-dom@19.2.4'
			import { useSync } from 'https://esm.sh/@tldraw/sync@4.4.0?deps=react@19.2.4,react-dom@19.2.4'
			import {
				context,
				propagation,
				SpanStatusCode,
				trace,
			} from 'https://esm.sh/@opentelemetry/api@1.9.0'
			import { OTLPTraceExporter } from 'https://esm.sh/@opentelemetry/exporter-trace-otlp-http@0.207.0'
			import { resourceFromAttributes } from 'https://esm.sh/@opentelemetry/resources@2.1.0'
			import { BatchSpanProcessor, WebTracerProvider } from 'https://esm.sh/@opentelemetry/sdk-trace-web@2.1.0'

			const roomId = ${JSON.stringify(roomId)}

			const TRACE_KEYS = ['traceparent', 'tracestate']
			const traceCarrierGetter = {
				keys(carrier) {
					const keys = []
					for (const key of TRACE_KEYS) {
						if (carrier?.[key]) keys.push(key)
					}
					return keys
				},
				get(carrier, key) {
					const normalized = String(key).toLowerCase()
					if (!TRACE_KEYS.includes(normalized)) return undefined
					return carrier?.[normalized] ?? undefined
				},
			}

			function getDataByteLength(data) {
				if (typeof data === 'string') return data.length
				if (data instanceof Blob) return data.size
				if (data instanceof ArrayBuffer) return data.byteLength
				if (ArrayBuffer.isView(data)) return data.byteLength
				return 0
			}

			function parseJsonSafely(value) {
				if (typeof value !== 'string') return null
				try {
					return JSON.parse(value)
				} catch {
					return null
				}
			}

			function summarizeStoreChanges(changes) {
				const count = (obj) => (obj ? Object.keys(obj).length : 0)
				return {
					'tldraw.record.added': count(changes?.added),
					'tldraw.record.updated': count(changes?.updated),
					'tldraw.record.removed': count(changes?.removed),
				}
			}

			function initBrowserOtel() {
				if (!['localhost', '127.0.0.1'].includes(window.location.hostname)) return

				const otelHost = window.location.hostname === 'localhost' ? 'localhost' : '127.0.0.1'
				try {
					const provider = new WebTracerProvider({
						resource: resourceFromAttributes({
							'service.name': 'tldraw-sync-core-simple-client',
							'service.namespace': 'tldraw',
							'deployment.environment': 'development',
						}),
						spanProcessors: [
							new BatchSpanProcessor(
								new OTLPTraceExporter({
									url: 'http://' + otelHost + ':4318/v1/traces',
								}),
								{
									scheduledDelayMillis: 500,
									maxExportBatchSize: 64,
									maxQueueSize: 256,
								}
							),
						],
					})
					provider.register()

					const tracer = trace.getTracer('tldraw-sync-core-simple-client', '1')
					const withSpan = (name, attributes, callback, activeContext = context.active()) => {
						return context.with(activeContext, () => {
							return tracer.startActiveSpan(name, { attributes }, (span) => {
								try {
									const result = callback(span)
									if (result && typeof result.then === 'function') {
										return result
											.catch((error) => {
												span.recordException(error)
												span.setStatus({
													code: SpanStatusCode.ERROR,
													message: error instanceof Error ? error.message : String(error),
												})
												throw error
											})
											.finally(() => span.end())
									}
									span.end()
									return result
								} catch (error) {
									span.recordException(error)
									span.setStatus({
										code: SpanStatusCode.ERROR,
										message: error instanceof Error ? error.message : String(error),
									})
									span.end()
									throw error
								}
							})
						})
					}

					if (!window.__tldrawClientSocketPatched) {
						window.__tldrawClientSocketPatched = true
						const NativeWebSocket = window.WebSocket
						window.WebSocket = class InstrumentedWebSocket extends NativeWebSocket {
							constructor(...args) {
								super(...args)
								this.__tldrawInstrumentSyncSocket = this.url.includes('/api/connect/')
								if (!this.__tldrawInstrumentSyncSocket) return
								this.addEventListener('open', () => {
									withSpan('tlsync.socket.client.onopen', {}, () => {})
								})
								this.addEventListener('close', (event) => {
									withSpan(
										'tlsync.socket.client.onclose',
										{
											'tldraw.socket.close_code': event.code,
											'tldraw.socket.close_reason': event.reason,
										},
										() => {}
									)
								})
								this.addEventListener('error', () => {
									withSpan('tlsync.socket.client.onerror', {}, () => {})
								})
								this.addEventListener('message', (event) => {
									const bytes = getDataByteLength(event.data)
									const parsed = withSpan(
										'tlsync.socket.client.parse_message',
										{ 'tldraw.msg.bytes': bytes },
										() => parseJsonSafely(event.data)
									)
									const traceContext = parsed?.trace
										? propagation.extract(context.active(), parsed.trace, traceCarrierGetter)
										: context.active()
									withSpan(
										'tlsync.socket.client.receive',
										{
											'tldraw.msg.type': parsed?.type ?? 'unknown',
											'tldraw.msg.bytes': bytes,
										},
										() => {
											withSpan(
												'tlsync.client.receive',
												{ 'tldraw.msg.type': parsed?.type ?? 'unknown' },
												() => {}
											)
											if (parsed?.type === 'connect') {
												withSpan('tlsync.client.did_reconnect', { 'tldraw.msg.type': 'connect' }, () => {})
											}
										},
										traceContext
									)
								})
							}
							send(data) {
								if (!this.__tldrawInstrumentSyncSocket) {
									return super.send(data)
								}
								const bytes = getDataByteLength(data)
								const parsed = parseJsonSafely(data)
								const msgType = parsed?.type ?? 'unknown'
								const send = () => super.send(data)
								const sendAttrs = {
									'tldraw.msg.type': msgType,
									'tldraw.msg.bytes': bytes,
								}
								if (msgType === 'push') {
									return withSpan('tlsync.client.push', { 'tldraw.msg.type': msgType }, () =>
										withSpan('tlsync.socket.client.send', sendAttrs, send)
									)
								}
								if (msgType === 'connect') {
									return withSpan('tlsync.client.connect', { 'tldraw.msg.type': msgType }, () =>
										withSpan('tlsync.socket.client.send', sendAttrs, send)
									)
								}
								if (msgType === 'ping') {
									return withSpan('tlsync.client.ping', { 'tldraw.msg.type': msgType }, () =>
										withSpan('tlsync.socket.client.send', sendAttrs, send)
									)
								}
								return withSpan('tlsync.socket.client.send', sendAttrs, send)
							}
						}
					}

					const instrumentEditor = (editor) => {
						if (!editor?.store?.listen) return
						window.__tldrawEditorClientDispose?.()
						window.__tldrawEditorClientDispose = editor.store.listen(
							({ changes }) => {
								withSpan(
									'tlsync.client.store_changes',
									{
										'tldraw.msg.type': 'push',
										...summarizeStoreChanges(changes),
									},
									() => {}
								)
							},
							{ source: 'user', scope: 'document' }
						)
					}

					window.__tldrawOtel = { provider, withSpan, instrumentEditor }
					window.addEventListener(
						'beforeunload',
						() => {
							provider.forceFlush().catch(() => {})
						},
						{ once: true }
					)
				} catch (error) {
					console.warn('Failed to initialize browser OTel', error)
				}
			}

			initBrowserOtel()

			const multiplayerAssets = {
				async upload(_asset, file) {
					// Keep the demo self-contained: use object URLs instead of server uploads.
					return { src: URL.createObjectURL(file) }
				},
				resolve(asset) {
					return asset?.props?.src ?? ''
				},
			}

			function WifiIcon() {
				return React.createElement(
					'svg',
					{
						xmlns: 'http://www.w3.org/2000/svg',
						fill: 'none',
						viewBox: '0 0 24 24',
						strokeWidth: '1.5',
						stroke: 'currentColor',
						width: 16,
					},
					React.createElement('path', {
						strokeLinecap: 'round',
						strokeLinejoin: 'round',
						d: 'M8.288 15.038a5.25 5.25 0 0 1 7.424 0M5.106 11.856c3.807-3.808 9.98-3.808 13.788 0M1.924 8.674c5.565-5.565 14.587-5.565 20.152 0M12.53 18.22l-.53.53-.53-.53a.75.75 0 0 1 1.06 0Z',
					})
				)
			}

			function App() {
				const [didCopy, setDidCopy] = React.useState(false)

				React.useEffect(() => {
					if (!didCopy) return
					const timeout = setTimeout(() => setDidCopy(false), 2000)
					return () => clearTimeout(timeout)
				}, [didCopy])

				const store = useSync({
					uri: window.location.origin + '/api/connect/' + encodeURIComponent(roomId),
					assets: multiplayerAssets,
				})
				const onMount = React.useCallback((editor) => {
					window.__tldrawEditor = editor
					window.__tldrawOtel?.instrumentEditor?.(editor)
				}, [])

				return React.createElement(
					'div',
					{ className: 'RoomWrapper' },
					React.createElement(
						'div',
						{ className: 'RoomWrapper-header' },
						React.createElement(WifiIcon),
						React.createElement('div', null, roomId),
						React.createElement(
							'button',
							{
								className: 'RoomWrapper-copy',
								onClick: () => {
									navigator.clipboard.writeText(window.location.href)
									setDidCopy(true)
								},
							},
							'Copy link',
							didCopy ? React.createElement('div', { className: 'RoomWrapper-copied' }, 'Copied!') : null
						)
					),
					React.createElement(
						'div',
						{ className: 'RoomWrapper-content' },
						React.createElement(Tldraw, {
							store,
							onMount,
							options: { deepLinks: true },
						})
					)
				)
			}

			createRoot(document.getElementById('root')).render(React.createElement(App))
		</script>
	</body>
</html>`
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
		return html(renderApp(request.params.roomId))
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
