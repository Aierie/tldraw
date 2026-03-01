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

			const roomId = ${JSON.stringify(roomId)}

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
						React.createElement(Tldraw, { store, options: { deepLinks: true } })
					)
				)
			}

			createRoot(document.getElementById('root')).render(React.createElement(App))
		</script>
	</body>
</html>`
}

const router = AutoRouter<IRequest, [env: SimpleSyncWorkerEnvironment]>({
	catch: (e) => error(e),
})
	.get('/', (request) => {
		return Response.redirect(new URL('/room/demo-room', request.url), 302)
	})
	.get('/room/:roomId', (request) => {
		return html(renderApp(request.params.roomId))
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
					headers: injectTraceHeaders(request.headers),
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
