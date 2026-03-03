import { context, propagation, SpanStatusCode, trace } from '@opentelemetry/api'
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http'
import { resourceFromAttributes } from '@opentelemetry/resources'
import { BatchSpanProcessor, WebTracerProvider } from '@opentelemetry/sdk-trace-web'
import { useSync } from '@tldraw/sync'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { Tldraw } from 'tldraw'
import '../../../../../../packages/tldraw/src/lib/ui.css'

declare global {
	interface Window {
		__tldrawEditor?: unknown
		__tldrawOtel?: {
			withSpan?(
				name: string,
				attributes: Record<string, unknown>,
				callback: (span: unknown) => unknown,
				activeContext?: unknown
			): unknown
			instrumentEditor?(editor: any): void
		}
		__tldrawEditorClientDispose?(): void
		__tldrawClientSocketPatched?: boolean
		WebSocket: typeof WebSocket
	}
}

const WORKER_BASE_URL = import.meta.env.VITE_SIMPLE_SYNC_WORKER_BASE_URL ?? 'http://127.0.0.1:8790'
const roomId = new URLSearchParams(window.location.search).get('room') ?? 'demo-room'
const E2E_SOCKET_SOURCE = 'e2e-client-socket'
const E2E_EDITOR_SOURCE = 'e2e-editor'
const CANVAS_OP_BAGGAGE_KEYS = {
	id: 'tldraw.canvas_op_id',
	kind: 'tldraw.canvas_op_kind',
} as const

const TRACE_KEYS = ['traceparent', 'tracestate']
const traceCarrierGetter = {
	keys(carrier: Record<string, string> | undefined) {
		const keys: string[] = []
		for (const key of TRACE_KEYS) {
			if (carrier?.[key]) keys.push(key)
		}
		return keys
	},
	get(carrier: Record<string, string> | undefined, key: string) {
		const normalized = String(key).toLowerCase()
		if (!TRACE_KEYS.includes(normalized)) return undefined
		return carrier?.[normalized] ?? undefined
	},
}

function getDataByteLength(data: unknown) {
	if (typeof data === 'string') return data.length
	if (data instanceof Blob) return data.size
	if (data instanceof ArrayBuffer) return data.byteLength
	if (ArrayBuffer.isView(data)) return data.byteLength
	return 0
}

function parseJsonSafely(value: unknown) {
	if (typeof value !== 'string') return null
	try {
		return JSON.parse(value) as Record<string, any>
	} catch {
		return null
	}
}

function summarizeStoreChanges(changes: any) {
	const count = (obj: Record<string, unknown> | undefined) => (obj ? Object.keys(obj).length : 0)
	return {
		'tldraw.record.added': count(changes?.added),
		'tldraw.record.updated': count(changes?.updated),
		'tldraw.record.removed': count(changes?.removed),
	}
}

function createCanvasOpId(kind: string) {
	return `${kind}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

function createCanvasOpContext(opId: string, opKind: string, activeContext = context.active()) {
	const base = propagation.getBaggage(activeContext) ?? propagation.createBaggage()
	const withOpId = base.setEntry(CANVAS_OP_BAGGAGE_KEYS.id, { value: opId })
	const withKind = withOpId.setEntry(CANVAS_OP_BAGGAGE_KEYS.kind, { value: opKind })
	return propagation.setBaggage(activeContext, withKind)
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
			const withSpan = (
				name: string,
				attributes: Record<string, unknown>,
				callback: (span: unknown) => unknown,
				activeContext = context.active()
		) => {
			return context.with(activeContext, () => {
				return tracer.startActiveSpan(name, { attributes }, (span) => {
					try {
						const result = callback(span)
						if (result && typeof (result as Promise<unknown>).then === 'function') {
							return (result as Promise<unknown>)
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
						span.recordException(error as Error)
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
				private __tldrawInstrumentSyncSocket: boolean

				constructor(url: string | URL, protocols?: string | string[]) {
					super(url, protocols)
					this.__tldrawInstrumentSyncSocket = this.url.includes('/api/connect/')
					if (!this.__tldrawInstrumentSyncSocket) return
						this.addEventListener('open', () => {
							withSpan(
								'tlsync.socket.client.onopen',
								{ 'tldraw.instrumentation.source': E2E_SOCKET_SOURCE },
								() => {}
							)
						})
						this.addEventListener('close', (event) => {
							withSpan(
								'tlsync.socket.client.onclose',
								{
									'tldraw.instrumentation.source': E2E_SOCKET_SOURCE,
									'tldraw.socket.close_code': event.code,
									'tldraw.socket.close_reason': event.reason,
								},
								() => {}
							)
						})
						this.addEventListener('error', () => {
							withSpan(
								'tlsync.socket.client.onerror',
								{ 'tldraw.instrumentation.source': E2E_SOCKET_SOURCE },
								() => {}
							)
						})
						this.addEventListener('message', (event) => {
							const bytes = getDataByteLength(event.data)
							const parsed = withSpan(
								'tlsync.socket.client.parse_message',
								{
									'tldraw.msg.bytes': bytes,
									'tldraw.instrumentation.source': E2E_SOCKET_SOURCE,
								},
								() => parseJsonSafely(event.data)
							)
							const traceContext = (parsed as any)?.trace
								? propagation.extract(context.active(), (parsed as any).trace, traceCarrierGetter)
								: context.active()
						withSpan(
							'tlsync.socket.client.receive',
								{
									'tldraw.msg.type': (parsed as any)?.type ?? 'unknown',
									'tldraw.msg.bytes': bytes,
									'tldraw.instrumentation.source': E2E_SOCKET_SOURCE,
								},
								() => {
									withSpan(
										'tlsync.client.receive',
										{
											'tldraw.msg.type': (parsed as any)?.type ?? 'unknown',
											'tldraw.instrumentation.source': E2E_SOCKET_SOURCE,
										},
										() => {}
									)
									if ((parsed as any)?.type === 'connect') {
										withSpan(
											'tlsync.client.did_reconnect',
											{
												'tldraw.msg.type': 'connect',
												'tldraw.instrumentation.source': E2E_SOCKET_SOURCE,
											},
											() => {}
										)
									}
								},
								traceContext
						)
					})
				}

				override send(data: string | ArrayBufferLike | Blob | ArrayBufferView) {
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
							'tldraw.instrumentation.source': E2E_SOCKET_SOURCE,
						}
						if (msgType === 'push') {
							return withSpan(
								'tlsync.client.push',
								{
									'tldraw.msg.type': msgType,
									'tldraw.instrumentation.source': E2E_SOCKET_SOURCE,
								},
								() => withSpan('tlsync.socket.client.send', sendAttrs, send)
							)
						}
						if (msgType === 'connect') {
							return withSpan(
								'tlsync.client.connect',
								{
									'tldraw.msg.type': msgType,
									'tldraw.instrumentation.source': E2E_SOCKET_SOURCE,
								},
								() => withSpan('tlsync.socket.client.send', sendAttrs, send)
							)
						}
						if (msgType === 'ping') {
							return withSpan(
								'tlsync.client.ping',
								{
									'tldraw.msg.type': msgType,
									'tldraw.instrumentation.source': E2E_SOCKET_SOURCE,
								},
								() => withSpan('tlsync.socket.client.send', sendAttrs, send)
							)
						}
						return withSpan('tlsync.socket.client.send', sendAttrs, send)
					}
				}
			}

			const instrumentEditor = (editor: any) => {
				if (!editor?.store?.listen) return
				if (!editor.__tldrawCanvasOpsPatched) {
					editor.__tldrawCanvasOpsPatched = true

					const wrapCanvasOp = (
						methodName: string,
						opKind: string,
						summarizeArgs: (...args: any[]) => Record<string, unknown>
					) => {
						const original = editor[methodName]
						if (typeof original !== 'function') return
						editor[methodName] = (...args: any[]) => {
							const opId = createCanvasOpId(opKind)
							const attrs: Record<string, unknown> = {
								'tldraw.canvas_op_id': opId,
								'tldraw.canvas_op_kind': opKind,
								'tldraw.instrumentation.source': E2E_EDITOR_SOURCE,
								...summarizeArgs(...args),
							}
							const opContext = createCanvasOpContext(opId, opKind)
							return withSpan('tlsync.client.canvas_op', attrs, () => original.call(editor, ...args), opContext)
						}
					}

					wrapCanvasOp('createShapes', 'create', (shapes: unknown[]) => ({
						'tldraw.canvas_shape_count': Array.isArray(shapes) ? shapes.length : 0,
					}))
					wrapCanvasOp('updateShapes', 'update', (shapes: unknown[]) => ({
						'tldraw.canvas_shape_count': Array.isArray(shapes) ? shapes.length : 0,
					}))
					wrapCanvasOp('groupShapes', 'group', (ids: string[], options?: { groupId?: string }) => ({
						'tldraw.canvas_shape_count': Array.isArray(ids) ? ids.length : 0,
						'tldraw.canvas_group_id': options?.groupId ?? '',
					}))
					wrapCanvasOp('reparentShapes', 'reparent', (ids: string[], parentId?: string) => ({
						'tldraw.canvas_shape_count': Array.isArray(ids) ? ids.length : 0,
						'tldraw.canvas_parent_id': parentId ?? '',
					}))
					wrapCanvasOp('deleteShapes', 'delete', (ids: string[]) => ({
						'tldraw.canvas_shape_count': Array.isArray(ids) ? ids.length : 0,
					}))
				}

				window.__tldrawEditorClientDispose?.()
				window.__tldrawEditorClientDispose = editor.store.listen(
					({ changes }: { changes: unknown }) => {
						withSpan(
							'tlsync.client.store_changes',
							{
								'tldraw.msg.type': 'push',
								'tldraw.instrumentation.source': E2E_EDITOR_SOURCE,
								...summarizeStoreChanges(changes),
							},
							() => {}
						)
					},
				{ source: 'user', scope: 'document' }
			)
		}

		window.__tldrawOtel = {
			withSpan,
			instrumentEditor,
		}
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
	async upload(_asset: unknown, file: File) {
		return { src: URL.createObjectURL(file) }
	},
	resolve(asset: { props?: { src?: string } } | undefined) {
		return asset?.props?.src ?? ''
	},
}

function WifiIcon() {
	return (
		<svg
			xmlns="http://www.w3.org/2000/svg"
			fill="none"
			viewBox="0 0 24 24"
			strokeWidth="1.5"
			stroke="currentColor"
			width={16}
		>
			<path
				strokeLinecap="round"
				strokeLinejoin="round"
				d="M8.288 15.038a5.25 5.25 0 0 1 7.424 0M5.106 11.856c3.807-3.808 9.98-3.808 13.788 0M1.924 8.674c5.565-5.565 14.587-5.565 20.152 0M12.53 18.22l-.53.53-.53-.53a.75.75 0 0 1 1.06 0Z"
			/>
		</svg>
	)
}

function App() {
	const [didCopy, setDidCopy] = useState(false)

	useEffect(() => {
		if (!didCopy) return
		const timeout = setTimeout(() => setDidCopy(false), 2000)
		return () => clearTimeout(timeout)
	}, [didCopy])

	const syncUri = useMemo(() => `${WORKER_BASE_URL}/api/connect/${encodeURIComponent(roomId)}`, [])
	const store = useSync({
		uri: syncUri,
		roomId,
		assets: multiplayerAssets,
	})
	const onMount = useCallback((editor: any) => {
		window.__tldrawEditor = editor
		window.__tldrawOtel?.instrumentEditor?.(editor)
	}, [])

	return (
		<div
			className="RoomWrapper"
			style={{ position: 'fixed', inset: 0, display: 'grid', gridTemplateRows: 'auto 1fr' }}
		>
			<div
				className="RoomWrapper-header"
				style={{
					display: 'flex',
					alignItems: 'center',
					gap: 12,
					padding: '8px 16px',
					borderBottom: '1px solid #e5e5e5',
					fontSize: 14,
				}}
			>
				<WifiIcon />
				<div>{roomId}</div>
				<button
					className="RoomWrapper-copy"
					onClick={() => {
						navigator.clipboard.writeText(window.location.href)
						setDidCopy(true)
					}}
				>
					Copy link
					{didCopy ? <div className="RoomWrapper-copied">Copied!</div> : null}
				</button>
			</div>
			<div className="RoomWrapper-content" style={{ position: 'relative', minHeight: 1 }}>
				<Tldraw store={store} onMount={onMount} options={{ deepLinks: true }} />
			</div>
		</div>
	)
}

const root = document.getElementById('root')
if (!root) throw new Error('Missing root element')
createRoot(root).render(<App />)
