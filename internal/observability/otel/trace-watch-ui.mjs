#!/usr/bin/env node

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import http from 'node:http'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const traceFile = process.env.OTEL_TRACE_FILE ?? path.join(__dirname, 'data', 'traces.jsonl')
const port = Number(process.env.OTEL_TRACE_UI_PORT ?? 9091)

const clients = new Set()
let position = 0

function toEventPayload(line) {
	const trimmed = line.trim()
	if (!trimmed) return null
	try {
		return JSON.stringify({ raw: trimmed, parsed: JSON.parse(trimmed) })
	} catch {
		return JSON.stringify({ raw: trimmed })
	}
}

function broadcastLine(line) {
	const payload = toEventPayload(line)
	if (!payload) return
	for (const client of clients) {
		client.write(`data: ${payload}\n\n`)
	}
}

function readNewLines() {
	if (!fs.existsSync(traceFile)) return
	const content = fs.readFileSync(traceFile, 'utf8')
	if (content.length < position) {
		position = 0
	}
	const next = content.slice(position)
	position = content.length
	if (!next) return
	for (const line of next.split('\n')) {
		broadcastLine(line)
	}
}

function html() {
	return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>OTel trace live view</title>
  <style>
    body { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; background: #111; color: #eee; margin: 0; }
    header { padding: 12px 16px; border-bottom: 1px solid #333; position: sticky; top: 0; background: #111; }
    main { padding: 12px 16px; display: grid; gap: 8px; }
    .row { border: 1px solid #2f2f2f; border-radius: 6px; padding: 8px; background: #181818; white-space: pre-wrap; overflow-wrap: anywhere; }
    .raw { color: #a8a8a8; }
    .meta { color: #70e0ff; margin-bottom: 4px; }
  </style>
</head>
<body>
  <header>
    <strong>tldraw sync OTel live trace stream</strong>
    <span> — reading ${traceFile}</span>
  </header>
  <main id="rows"></main>
  <script>
    const rows = document.getElementById('rows')
    const source = new EventSource('/events')
    source.onmessage = (event) => {
      const data = JSON.parse(event.data)
      const row = document.createElement('div')
      row.className = 'row'
      const parsed = data.parsed
      if (parsed) {
        const meta = document.createElement('div')
        meta.className = 'meta'
        const maybeName = parsed.resourceSpans?.[0]?.scopeSpans?.[0]?.spans?.[0]?.name
        meta.textContent = maybeName ? 'span: ' + maybeName : 'trace payload'
        row.appendChild(meta)
      }
      const raw = document.createElement('div')
      raw.className = 'raw'
      raw.textContent = data.raw
      row.appendChild(raw)
      rows.prepend(row)
      if (rows.children.length > 300) rows.removeChild(rows.lastChild)
    }
  </script>
</body>
</html>`
}

const server = http.createServer((req, res) => {
	if (req.url === '/events') {
		res.writeHead(200, {
			'Content-Type': 'text/event-stream',
			'Cache-Control': 'no-cache',
			Connection: 'keep-alive',
		})
		res.write('\n')
		clients.add(res)
		req.on('close', () => {
			clients.delete(res)
		})
		return
	}

	if (req.url === '/' || req.url === '/index.html') {
		res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
		res.end(html())
		return
	}

	res.writeHead(404)
	res.end('Not found')
})

fs.mkdirSync(path.dirname(traceFile), { recursive: true })
if (!fs.existsSync(traceFile)) {
	fs.writeFileSync(traceFile, '', 'utf8')
}
position = fs.statSync(traceFile).size

fs.watch(path.dirname(traceFile), (_event, filename) => {
	if (filename && path.join(path.dirname(traceFile), filename) === traceFile) {
		readNewLines()
	}
})

server.listen(port, () => {
	console.log(`OTel trace watcher UI on http://localhost:${port}`)
	console.log(`Watching ${traceFile}`)
})
