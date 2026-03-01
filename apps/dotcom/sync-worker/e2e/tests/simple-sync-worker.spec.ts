import { expect, test, type Page, type TestInfo } from '@playwright/test'
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const BASE_URL = process.env.SIMPLE_SYNC_WORKER_BASE_URL ?? 'http://127.0.0.1:8790'
const CLIENT_BASE_URL = process.env.SIMPLE_SYNC_CLIENT_BASE_URL ?? 'http://127.0.0.1:5173'
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const OTEL_SOURCE_TRACE_FILE =
	process.env.OTEL_TRACE_FILE ??
	path.resolve(__dirname, '../../../../../internal/observability/otel/data/traces.jsonl')
const OTEL_TRACE_OUTPUT_DIR = path.dirname(OTEL_SOURCE_TRACE_FILE)

interface SnapshotRecord {
	id: string
	typeName: string
	type?: string
	parentId?: string
	x?: number
	y?: number
	props?: Record<string, unknown>
}

interface RoomSnapshot {
	clock: number
	documents: Array<{ state: SnapshotRecord; lastChangedClock: number }>
	tombstones?: Record<string, number>
}

interface CapturedSimpleSpan {
	name: string
	attributes: Record<string, unknown>
	statusCode: number
	startTimeUnixMs: number
	endTimeUnixMs: number
}

interface CapturedTraceEvent {
	name: string
	attributes: Record<string, unknown>
}

interface CapturedTraceSpan {
	name: string
	attributes: Record<string, unknown>
	events: CapturedTraceEvent[]
}

interface OtelTraceCapture {
	sourceFile: string
	outputFile: string
}

type CanvasOp =
	| {
			kind: 'create'
			shapes: Array<Record<string, unknown>>
	  }
	| {
			kind: 'update'
			shapes: Array<Record<string, unknown>>
	  }
	| {
			kind: 'group'
			ids: string[]
			groupId: string
	  }
	| {
			kind: 'reparent'
			ids: string[]
			parentId: string
	  }
	| {
			kind: 'delete'
			ids: string[]
	  }

function sleep(ms: number) {
	return new Promise((resolve) => setTimeout(resolve, ms))
}

async function isCollectorReachable() {
	try {
		await fetch('http://127.0.0.1:4318')
		return true
	} catch {
		return false
	}
}

function toFileSafeSegment(value: string) {
	const normalized = value
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '')
	return normalized.slice(0, 80) || 'trace-test'
}

function buildTraceOutputFile(testInfo: TestInfo) {
	const projectSegment = toFileSafeSegment(testInfo.project.name)
	const titleSegment = toFileSafeSegment(testInfo.title)
	return path.join(
		OTEL_TRACE_OUTPUT_DIR,
		`traces.${projectSegment}.${titleSegment}.w${testInfo.parallelIndex}.r${testInfo.retry}.jsonl`
	)
}

async function startOtelTraceCapture(testInfo: TestInfo): Promise<OtelTraceCapture> {
	const outputFile = buildTraceOutputFile(testInfo)
	await mkdir(path.dirname(outputFile), { recursive: true })
	// Collector file exporter rotates traces.jsonl, so the directory and file
	// must be writable even when collector runs under a different UID.
	await chmod(OTEL_TRACE_OUTPUT_DIR, 0o777).catch(() => {})
	await writeFile(OTEL_SOURCE_TRACE_FILE, '')
	await chmod(OTEL_SOURCE_TRACE_FILE, 0o666).catch(() => {})
	await writeFile(outputFile, '')
	return {
		sourceFile: OTEL_SOURCE_TRACE_FILE,
		outputFile,
	}
}

async function readTraceFileContents(traceFile: string) {
	return await readFile(traceFile, 'utf8').catch((error: NodeJS.ErrnoException) => {
		if (error.code === 'ENOENT') return ''
		throw error
	})
}

async function readCapturedTraceContents(capture: OtelTraceCapture) {
	const contents = await readTraceFileContents(capture.sourceFile)
	await writeFile(capture.outputFile, contents)
	return contents
}

function parseTraceValue(value: unknown): unknown {
	if (!value || typeof value !== 'object') return undefined

	const maybe = value as {
		stringValue?: unknown
		boolValue?: unknown
		intValue?: unknown
		doubleValue?: unknown
	}

	if (typeof maybe.stringValue === 'string') return maybe.stringValue
	if (typeof maybe.boolValue === 'boolean') return maybe.boolValue
	if (typeof maybe.doubleValue === 'number') return maybe.doubleValue
	if (typeof maybe.intValue === 'string') {
		const parsed = Number(maybe.intValue)
		return Number.isFinite(parsed) ? parsed : maybe.intValue
	}

	return undefined
}

function parseTraceAttributes(attributes: unknown): Record<string, unknown> {
	if (!Array.isArray(attributes)) return {}

	const parsed: Record<string, unknown> = {}
	for (const attr of attributes) {
		if (!attr || typeof attr !== 'object') continue
		const key = (attr as { key?: unknown }).key
		if (typeof key !== 'string') continue
		const value = parseTraceValue((attr as { value?: unknown }).value)
		if (value !== undefined) parsed[key] = value
	}

	return parsed
}

function parseTraceEvents(events: unknown): CapturedTraceEvent[] {
	if (!Array.isArray(events)) return []

	const parsed: CapturedTraceEvent[] = []
	for (const event of events) {
		if (!event || typeof event !== 'object') continue
		const name = (event as { name?: unknown }).name
		if (typeof name !== 'string') continue
		parsed.push({
			name,
			attributes: parseTraceAttributes((event as { attributes?: unknown }).attributes),
		})
	}

	return parsed
}

function parseTraceSpans(payload: unknown): CapturedTraceSpan[] {
	if (!payload || typeof payload !== 'object') return []

	const spans: CapturedTraceSpan[] = []
	const resourceSpans = (payload as { resourceSpans?: unknown }).resourceSpans
	if (!Array.isArray(resourceSpans)) return spans

	for (const resourceSpan of resourceSpans) {
		if (!resourceSpan || typeof resourceSpan !== 'object') continue
		const scopeSpans = (resourceSpan as { scopeSpans?: unknown }).scopeSpans
		if (!Array.isArray(scopeSpans)) continue

		for (const scopeSpan of scopeSpans) {
			if (!scopeSpan || typeof scopeSpan !== 'object') continue
			const scopeSpanSpans = (scopeSpan as { spans?: unknown }).spans
			if (!Array.isArray(scopeSpanSpans)) continue

			for (const span of scopeSpanSpans) {
				if (!span || typeof span !== 'object') continue
				const name = (span as { name?: unknown }).name
				if (typeof name !== 'string') continue
				spans.push({
					name,
					attributes: parseTraceAttributes((span as { attributes?: unknown }).attributes),
					events: parseTraceEvents((span as { events?: unknown }).events),
				})
			}
		}
	}

	return spans
}

async function readOtelTraceSpans(capture: OtelTraceCapture) {
	const contents = await readCapturedTraceContents(capture)

	if (!contents.trim()) return []

	const spans: CapturedTraceSpan[] = []
	for (const line of contents.split('\n')) {
		if (!line.trim()) continue
		try {
			spans.push(...parseTraceSpans(JSON.parse(line) as unknown))
		} catch {
			// Ignore partial writes while the collector is appending.
		}
	}

	return spans
}

async function readOtelTraceSpanNames(capture: OtelTraceCapture) {
	const spans = await readOtelTraceSpans(capture)
	return spans.map((span) => span.name)
}

async function waitForTraceSpans(
	capture: OtelTraceCapture,
	predicate: (spanNames: string[]) => boolean,
	timeoutMs = 15_000
): Promise<string[]> {
	const start = Date.now()
	let latest: string[] = []
	while (Date.now() - start < timeoutMs) {
		latest = await readOtelTraceSpanNames(capture)
		if (predicate(latest)) return latest
		await sleep(200)
	}

	throw new Error(
		`Timed out waiting for expected OTel spans in ${capture.outputFile}. Latest spans: ${latest.slice(-20).join(', ')}`
	)
}

async function waitForTraceSpanDetails(
	capture: OtelTraceCapture,
	predicate: (spans: CapturedTraceSpan[]) => boolean,
	timeoutMs = 15_000
): Promise<CapturedTraceSpan[]> {
	const start = Date.now()
	let latest: CapturedTraceSpan[] = []
	while (Date.now() - start < timeoutMs) {
		latest = await readOtelTraceSpans(capture)
		if (predicate(latest)) return latest
		await sleep(200)
	}

	throw new Error(
		`Timed out waiting for expected detailed OTel spans in ${capture.outputFile}. Latest spans: ${latest
			.map((span) => span.name)
			.slice(-20)
			.join(', ')}`
	)
}

function buildRoomId(testInfo: TestInfo) {
	const random = Math.random().toString(36).slice(2, 8)
	return `simple-sync-e2e-${testInfo.parallelIndex}-${testInfo.retry}-${random}`
}

function roomPath(roomId: string, endpoint: string) {
	return `/__test__/room/${encodeURIComponent(roomId)}${endpoint}`
}

async function callTestRoute(path: string, init?: RequestInit) {
	const response = await fetch(`${BASE_URL}${path}`, init)
	if (!response.ok) {
		const body = await response.text()
		throw new Error(`Test route failed (${response.status}): ${path}\n${body}`)
	}
	return response
}

async function resetRoom(roomId: string) {
	await callTestRoute(roomPath(roomId, '/reset'), { method: 'POST' })
}

async function clearSpans(roomId: string) {
	await callTestRoute(roomPath(roomId, '/spans/clear'), { method: 'POST' })
}

async function getSnapshot(roomId: string): Promise<RoomSnapshot> {
	const response = await callTestRoute(roomPath(roomId, '/snapshot'))
	return (await response.json()) as RoomSnapshot
}

async function getSpans(roomId: string): Promise<CapturedSimpleSpan[]> {
	const response = await callTestRoute(roomPath(roomId, '/spans'))
	const payload = (await response.json()) as { spans: CapturedSimpleSpan[] }
	return payload.spans
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
	let timeout: ReturnType<typeof setTimeout> | undefined
	const timeoutPromise = new Promise<never>((_, reject) => {
		timeout = setTimeout(() => reject(new Error(message)), timeoutMs)
	})
	try {
		return (await Promise.race([promise, timeoutPromise])) as T
	} finally {
		if (timeout !== undefined) clearTimeout(timeout)
	}
}

async function flushOtel(_page: Page, roomId: string) {
	// Allow batch processors to enqueue/export naturally first.
	await sleep(10_000)
	// Trigger a request that calls provider.forceFlush() in worker/DO waitUntil.
	await withTimeout(
		callTestRoute(roomPath(roomId, '/spans')),
		10_000,
		`Timed out while triggering server flush for room "${roomId}"`
	)
	// Give the collector file exporter a short moment to append the batch.
	await sleep(250)
}

function getSnapshotRecord(snapshot: RoomSnapshot, id: string) {
	return snapshot.documents.find((doc) => doc.state.id === id)?.state
}

async function waitForSnapshot(
	roomId: string,
	predicate: (snapshot: RoomSnapshot) => boolean,
	timeoutMs = 10_000
) {
	const start = Date.now()
	let latest: RoomSnapshot | null = null
	while (Date.now() - start < timeoutMs) {
		latest = await getSnapshot(roomId)
		if (predicate(latest)) return latest
		await sleep(100)
	}
	throw new Error(
		`Timed out waiting for expected snapshot. Latest snapshot: ${JSON.stringify(latest)}`
	)
}

async function openRoom(page: Page, roomId: string) {
	await page.goto(`${CLIENT_BASE_URL}/?room=${encodeURIComponent(roomId)}`)
	await page.waitForFunction(() => Boolean((window as any).__tldrawEditor), null, {
		timeout: 15_000,
	})
}

async function runCanvasOps(page: Page, ops: CanvasOp[]) {
	await page.evaluate(async (opsToRun: CanvasOp[]) => {
		const editor = (window as any).__tldrawEditor
		if (!editor) throw new Error('Missing window.__tldrawEditor')

		const waitForPaint = () =>
			new Promise<void>((resolve) =>
				requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
			)

		for (const op of opsToRun) {
			switch (op.kind) {
				case 'create':
					editor.createShapes(op.shapes)
					break
				case 'update':
					editor.updateShapes(op.shapes)
					break
				case 'group':
					editor.groupShapes(op.ids, { groupId: op.groupId })
					break
				case 'reparent':
					editor.reparentShapes(op.ids, op.parentId)
					break
				case 'delete':
					editor.deleteShapes(op.ids)
					break
				default:
					throw new Error(`Unknown op kind: ${(op as CanvasOp).kind}`)
			}
			await waitForPaint()
		}
	}, ops)
}

function getGeoShapes(snapshot: RoomSnapshot) {
	return snapshot.documents.map((doc) => doc.state).filter((state) => state.type === 'geo')
}

async function createRectangleViaDom(page: Page, x: number, y: number) {
	await page.keyboard.press('r')
	await page.mouse.click(x, y)
	await sleep(50)
}

async function waitForRoomSpans(
	roomId: string,
	predicate: (spans: CapturedSimpleSpan[]) => boolean,
	timeoutMs = 10_000
) {
	const start = Date.now()
	let latest: CapturedSimpleSpan[] = []
	while (Date.now() - start < timeoutMs) {
		latest = await getSpans(roomId)
		if (predicate(latest)) return latest
		await sleep(100)
	}
	throw new Error(`Timed out waiting for expected spans for room ${roomId}`)
}

async function waitForConnect(roomId: string) {
	await waitForRoomSpans(roomId, (spans) =>
		spans.some((span) => span.name === 'tlsync.room.connect')
	)
}

test.describe('simple sync worker e2e', () => {
	test('reset + create/update/delete sequence persists expected tombstone and spans', async ({
		page,
	}, testInfo) => {
		const roomId = buildRoomId(testInfo)
		const shapeId = 'shape:crud-a'

		await resetRoom(roomId)
		await clearSpans(roomId)
		await openRoom(page, roomId)
		await waitForConnect(roomId)

		await runCanvasOps(page, [
			{
				kind: 'create',
				shapes: [
					{
						id: shapeId,
						type: 'geo',
						x: 120,
						y: 100,
						props: { geo: 'rectangle', w: 220, h: 120 },
					},
				],
			},
		])
		await waitForSnapshot(roomId, (next) => Boolean(getSnapshotRecord(next, shapeId)))

		await runCanvasOps(page, [
			{
				kind: 'update',
				shapes: [
					{
						id: shapeId,
						type: 'geo',
						x: 320,
						y: 240,
						props: { w: 240, h: 120 },
					},
				],
			},
		])
		await waitForSnapshot(roomId, (next) => {
			const shape = getSnapshotRecord(next, shapeId)
			return shape?.x === 320 && shape?.y === 240
		})

		await runCanvasOps(page, [{ kind: 'delete', ids: [shapeId] }])

		const snapshot = await waitForSnapshot(roomId, (next) => {
			return !getSnapshotRecord(next, shapeId)
		})

		expect(snapshot.clock).toBeGreaterThan(0)
		expect(getSnapshotRecord(snapshot, shapeId)).toBeUndefined()
		expect(snapshot.tombstones?.[shapeId]).toBeDefined()

		const spans = await getSpans(roomId)
		expect(spans.some((span) => span.name === 'tlsync.room.push')).toBeTruthy()
		expect(
			spans.some(
				(span) =>
					span.attributes['tldraw.msg.type'] === 'push' ||
					span.attributes['tlsync.message.type'] === 'push'
			)
		).toBeTruthy()
	})

	test('different op ordering keeps final snapshot consistent', async ({ page }, testInfo) => {
		const roomId = buildRoomId(testInfo)
		const deletedShapeId = 'shape:ordering-a'
		const survivingShapeId = 'shape:ordering-b'

		await resetRoom(roomId)
		await clearSpans(roomId)
		await openRoom(page, roomId)
		await waitForConnect(roomId)

		await runCanvasOps(page, [
			{
				kind: 'create',
				shapes: [
					{
						id: deletedShapeId,
						type: 'geo',
						x: 100,
						y: 100,
						props: { geo: 'rectangle', w: 120, h: 80 },
					},
					{
						id: survivingShapeId,
						type: 'geo',
						x: 200,
						y: 180,
						props: { geo: 'rectangle', w: 180, h: 90 },
					},
				],
			},
		])
		await waitForSnapshot(roomId, (next) => {
			return Boolean(
				getSnapshotRecord(next, deletedShapeId) && getSnapshotRecord(next, survivingShapeId)
			)
		})

		await runCanvasOps(page, [{ kind: 'delete', ids: [deletedShapeId] }])
		await waitForSnapshot(roomId, (next) => !getSnapshotRecord(next, deletedShapeId))

		await runCanvasOps(page, [
			{
				kind: 'update',
				shapes: [
					{
						id: survivingShapeId,
						type: 'geo',
						x: 460,
						y: 360,
						props: { w: 210, h: 110 },
					},
				],
			},
		])

		const snapshot = await waitForSnapshot(roomId, (next) => {
			const surviving = getSnapshotRecord(next, survivingShapeId)
			return (
				!getSnapshotRecord(next, deletedShapeId) && surviving?.x === 460 && surviving?.y === 360
			)
		})

		const surviving = getSnapshotRecord(snapshot, survivingShapeId)
		expect(surviving).toBeDefined()
		expect(surviving?.x).toBe(460)
		expect(surviving?.y).toBe(360)

		expect(getSnapshotRecord(snapshot, deletedShapeId)).toBeUndefined()
		expect(snapshot.tombstones?.[deletedShapeId]).toBeDefined()
		expect(snapshot.tombstones?.[survivingShapeId]).toBeUndefined()
	})

	test('essential canvas ops write to OTel traces (create/update/group/delete)', async ({
		page,
	}, testInfo) => {
		const collectorReachable = await isCollectorReachable()
		expect(
			collectorReachable,
			'OTel collector is not reachable at http://127.0.0.1:4318. Start it with ./skills/tldraw-otel-lab/scripts/otel_lab.sh up --fresh from the repo root.'
		).toBe(true)

		const roomId = buildRoomId(testInfo)
		const shapeAId = 'shape:otel-essential-a'
		const shapeBId = 'shape:otel-essential-b'
		const shapeCId = 'shape:otel-essential-c'
		const groupId = 'shape:otel-essential-group'
		const otelTraceCapture = await startOtelTraceCapture(testInfo)

		await resetRoom(roomId)
		await clearSpans(roomId)
		await openRoom(page, roomId)
		await waitForConnect(roomId)

		await runCanvasOps(page, [
			{
				kind: 'create',
				shapes: [
					{
						id: shapeAId,
						type: 'geo',
						x: 120,
						y: 100,
						props: { geo: 'rectangle', w: 180, h: 120 },
					},
					{
						id: shapeBId,
						type: 'geo',
						x: 360,
						y: 120,
						props: { geo: 'rectangle', w: 180, h: 120 },
					},
					{
						id: shapeCId,
						type: 'geo',
						x: 620,
						y: 140,
						props: { geo: 'rectangle', w: 180, h: 120 },
					},
				],
			},
		])

		await waitForSnapshot(roomId, (next) => {
			return Boolean(
				getSnapshotRecord(next, shapeAId) &&
					getSnapshotRecord(next, shapeBId) &&
					getSnapshotRecord(next, shapeCId)
			)
		})

		await runCanvasOps(page, [
			{
				kind: 'update',
				shapes: [
					{
						id: shapeAId,
						type: 'geo',
						x: 220,
						y: 220,
						props: { w: 220, h: 140 },
					},
				],
			},
		])

		await waitForSnapshot(roomId, (next) => {
			const shape = getSnapshotRecord(next, shapeAId)
			return shape?.x === 220 && shape?.y === 220
		})

		await runCanvasOps(page, [
			{ kind: 'group', ids: [shapeAId, shapeBId], groupId },
			{ kind: 'reparent', ids: [shapeCId], parentId: groupId },
		])

		await waitForSnapshot(roomId, (next) => {
			const group = getSnapshotRecord(next, groupId)
			const shapeA = getSnapshotRecord(next, shapeAId)
			const shapeB = getSnapshotRecord(next, shapeBId)
			const shapeC = getSnapshotRecord(next, shapeCId)
			return (
				group?.type === 'group' &&
				shapeA?.parentId === groupId &&
				shapeB?.parentId === groupId &&
				shapeC?.parentId === groupId
			)
		})

		await runCanvasOps(page, [{ kind: 'delete', ids: [shapeBId] }])
		await waitForSnapshot(roomId, (next) => !getSnapshotRecord(next, shapeBId))

		await runCanvasOps(page, [{ kind: 'delete', ids: [groupId] }])

		const finalSnapshot = await waitForSnapshot(roomId, (next) => {
			return (
				!getSnapshotRecord(next, groupId) &&
				!getSnapshotRecord(next, shapeAId) &&
				!getSnapshotRecord(next, shapeCId)
			)
		})

		expect(finalSnapshot.tombstones?.[shapeBId]).toBeDefined()
		expect(finalSnapshot.tombstones?.[shapeAId]).toBeDefined()
		expect(finalSnapshot.tombstones?.[shapeCId]).toBeDefined()
		expect(finalSnapshot.tombstones?.[groupId]).toBeDefined()

			const spans = await getSpans(roomId)
			expect(spans.some((span) => span.name === 'tlsync.room.push')).toBeTruthy()

			await flushOtel(page, roomId)

			const traceSpanNames = await waitForTraceSpans(otelTraceCapture, (names) => {
				const pushCount = names.filter((name) => name === 'tlsync.client.push').length
				const storeChangesCount = names.filter(
					(name) => name === 'tlsync.client.store_changes'
			).length
			return pushCount >= 3 && storeChangesCount >= 3
		})

		expect(traceSpanNames.some((name) => name === 'tlsync.client.push')).toBeTruthy()
		expect(traceSpanNames.some((name) => name === 'tlsync.client.store_changes')).toBeTruthy()
	})

	test('essential canvas ops via DOM interaction write to OTel traces (create/move/delete)', async ({
		page,
	}, testInfo) => {
		const collectorReachable = await isCollectorReachable()
		expect(
			collectorReachable,
			'OTel collector is not reachable at http://127.0.0.1:4318. Start it with ./skills/tldraw-otel-lab/scripts/otel_lab.sh up --fresh from the repo root.'
		).toBe(true)

		const roomId = buildRoomId(testInfo)
		const otelTraceCapture = await startOtelTraceCapture(testInfo)

		await resetRoom(roomId)
		await clearSpans(roomId)
		await openRoom(page, roomId)
		await waitForConnect(roomId)

		await page.mouse.click(80, 80)

		await createRectangleViaDom(page, 220, 180)
		await createRectangleViaDom(page, 420, 180)
		await createRectangleViaDom(page, 620, 180)

		const afterCreate = await waitForSnapshot(roomId, (next) => getGeoShapes(next).length === 3)
		const sortedGeoShapes = getGeoShapes(afterCreate).sort((a, b) => (a.x ?? 0) - (b.x ?? 0))
		expect(sortedGeoShapes).toHaveLength(3)

		await page.keyboard.press('Control+a')
		await page.keyboard.press('ArrowDown')
		await sleep(50)

		await waitForSnapshot(roomId, (next) => {
			const geos = getGeoShapes(next)
			return geos.length === 3 && geos.some((shape) => typeof shape.y === 'number' && shape.y > 42)
		})

		await page.keyboard.press('Control+a')
		await page.keyboard.press('Backspace')
		await sleep(50)

		const afterDelete = await waitForSnapshot(roomId, (next) => {
			return getGeoShapes(next).length === 0 && Object.keys(next.tombstones ?? {}).length >= 3
		})

		expect(Object.keys(afterDelete.tombstones ?? {}).length).toBeGreaterThanOrEqual(3)

			const spans = await getSpans(roomId)
			expect(spans.some((span) => span.name === 'tlsync.room.push')).toBeTruthy()

			await flushOtel(page, roomId)

			const traceSpanNames = await waitForTraceSpans(otelTraceCapture, (names) => {
				const pushCount = names.filter((name) => name === 'tlsync.client.push').length
				const storeChangesCount = names.filter(
					(name) => name === 'tlsync.client.store_changes'
			).length
			return pushCount >= 2 && storeChangesCount >= 2
		})

		expect(traceSpanNames.some((name) => name === 'tlsync.client.push')).toBeTruthy()
		expect(traceSpanNames.some((name) => name === 'tlsync.client.store_changes')).toBeTruthy()
	})

	test('reload keeps grouped + ungrouped mixed deletion state and captures stack traces', async ({
		page,
	}, testInfo) => {
		const collectorReachable = await isCollectorReachable()
		expect(
			collectorReachable,
			'OTel collector is not reachable at http://127.0.0.1:4318. Start it with ./skills/tldraw-otel-lab/scripts/otel_lab.sh up --fresh from the repo root.'
		).toBe(true)

		const roomId = buildRoomId(testInfo)
		const groupedSurvivorId = 'shape:reload-grouped-survivor'
		const groupedSiblingSurvivorId = 'shape:reload-grouped-sibling-survivor'
		const groupedDeletedId = 'shape:reload-grouped-deleted'
		const ungroupedSurvivorId = 'shape:reload-ungrouped-survivor'
		const ungroupedDeletedId = 'shape:reload-ungrouped-deleted'
		const groupId = 'shape:reload-group'
		const otelTraceCapture = await startOtelTraceCapture(testInfo)

		await resetRoom(roomId)
		await clearSpans(roomId)
		await openRoom(page, roomId)
		await waitForConnect(roomId)

		await runCanvasOps(page, [
			{
				kind: 'create',
				shapes: [
					{
						id: groupedSurvivorId,
						type: 'geo',
						x: 100,
						y: 100,
						props: { geo: 'rectangle', w: 120, h: 90 },
					},
					{
						id: groupedDeletedId,
						type: 'geo',
						x: 260,
						y: 120,
						props: { geo: 'rectangle', w: 120, h: 90 },
					},
					{
						id: groupedSiblingSurvivorId,
						type: 'geo',
						x: 380,
						y: 160,
						props: { geo: 'rectangle', w: 120, h: 90 },
					},
					{
						id: ungroupedSurvivorId,
						type: 'geo',
						x: 520,
						y: 200,
						props: { geo: 'rectangle', w: 140, h: 90 },
					},
					{
						id: ungroupedDeletedId,
						type: 'geo',
						x: 740,
						y: 240,
						props: { geo: 'rectangle', w: 140, h: 90 },
					},
				],
			},
		])

		await waitForSnapshot(roomId, (next) => {
			return Boolean(
				getSnapshotRecord(next, groupedSurvivorId) &&
					getSnapshotRecord(next, groupedDeletedId) &&
					getSnapshotRecord(next, groupedSiblingSurvivorId) &&
					getSnapshotRecord(next, ungroupedSurvivorId) &&
					getSnapshotRecord(next, ungroupedDeletedId)
			)
		})

		await runCanvasOps(page, [
			{
				kind: 'group',
				ids: [groupedSurvivorId, groupedDeletedId, groupedSiblingSurvivorId],
				groupId,
			},
		])

		await waitForSnapshot(roomId, (next) => {
			const group = getSnapshotRecord(next, groupId)
			const groupedSurvivor = getSnapshotRecord(next, groupedSurvivorId)
			const groupedSiblingSurvivor = getSnapshotRecord(next, groupedSiblingSurvivorId)
			const groupedDeleted = getSnapshotRecord(next, groupedDeletedId)
			return (
				group?.type === 'group' &&
				groupedSurvivor?.parentId === groupId &&
				groupedSiblingSurvivor?.parentId === groupId &&
				groupedDeleted?.parentId === groupId
			)
		})

		await runCanvasOps(page, [{ kind: 'delete', ids: [groupedDeletedId, ungroupedDeletedId] }])

		const hasExpectedState = (snapshot: RoomSnapshot) => {
			const groupedSurvivor = getSnapshotRecord(snapshot, groupedSurvivorId)
			const groupedSiblingSurvivor = getSnapshotRecord(snapshot, groupedSiblingSurvivorId)
			const ungroupedSurvivor = getSnapshotRecord(snapshot, ungroupedSurvivorId)
			return (
				Boolean(getSnapshotRecord(snapshot, groupId)) &&
				groupedSurvivor?.parentId === groupId &&
				groupedSiblingSurvivor?.parentId === groupId &&
				Boolean(ungroupedSurvivor) &&
				ungroupedSurvivor?.parentId !== groupId &&
				!getSnapshotRecord(snapshot, groupedDeletedId) &&
				!getSnapshotRecord(snapshot, ungroupedDeletedId) &&
				Boolean(snapshot.tombstones?.[groupedDeletedId]) &&
				Boolean(snapshot.tombstones?.[ungroupedDeletedId])
			)
		}

		const beforeReloadSnapshot = await waitForSnapshot(roomId, hasExpectedState)
		expect(getSnapshotRecord(beforeReloadSnapshot, groupedSurvivorId)?.parentId).toBe(groupId)
		expect(getSnapshotRecord(beforeReloadSnapshot, groupedSiblingSurvivorId)?.parentId).toBe(
			groupId
		)
		expect(getSnapshotRecord(beforeReloadSnapshot, ungroupedSurvivorId)?.parentId).not.toBe(groupId)
		const reloadTimeoutMs = 20_000

		await page.evaluate(() => {
			const withSpan = (window as any).__tldrawOtel?.withSpan
			if (typeof withSpan !== 'function') {
				throw new Error('Missing window.__tldrawOtel.withSpan')
			}
			try {
				withSpan(
					'tlsync.client.stacktrace_probe',
					{ 'tldraw.instrumentation.source': 'e2e-stacktrace-probe' },
					() => {
						throw new Error('intentional stacktrace probe')
					}
				)
			} catch {
				// Expected: the callback throws so we can assert exception stacktrace capture.
			}
		})

		await page.reload({ waitUntil: 'domcontentloaded' })
		await page.waitForFunction(() => Boolean((window as any).__tldrawEditor), null, {
			timeout: reloadTimeoutMs,
		})

		const roomSpansAfterReload = await waitForRoomSpans(
			roomId,
			(spans) => spans.filter((span) => span.name === 'tlsync.room.connect').length >= 2,
			reloadTimeoutMs
		)
		expect(
			roomSpansAfterReload.filter((span) => span.name === 'tlsync.room.connect').length
		).toBeGreaterThanOrEqual(2)

		const afterReloadSnapshot = await waitForSnapshot(roomId, hasExpectedState, reloadTimeoutMs)
		expect(getSnapshotRecord(afterReloadSnapshot, groupedSurvivorId)?.parentId).toBe(groupId)
		expect(getSnapshotRecord(afterReloadSnapshot, groupedSiblingSurvivorId)?.parentId).toBe(groupId)
			expect(getSnapshotRecord(afterReloadSnapshot, ungroupedSurvivorId)?.parentId).not.toBe(groupId)
			expect(afterReloadSnapshot.tombstones?.[groupedDeletedId]).toBeDefined()
			expect(afterReloadSnapshot.tombstones?.[ungroupedDeletedId]).toBeDefined()

			await flushOtel(page, roomId)

			const detailedTraceSpans = await waitForTraceSpanDetails(otelTraceCapture, (spans) => {
				const pushCount = spans.filter((span) => span.name === 'tlsync.client.push').length
				const hasStackTrace = spans.some((span) => {
				if (span.name !== 'tlsync.client.stacktrace_probe') return false
				return span.events.some((event) => {
					const stack = event.attributes['exception.stacktrace']
					return event.name === 'exception' && typeof stack === 'string' && stack.length > 0
				})
			})
			return pushCount >= 2 && hasStackTrace
		}, reloadTimeoutMs)

		const probeExceptionEvents = detailedTraceSpans
			.filter((span) => span.name === 'tlsync.client.stacktrace_probe')
			.flatMap((span) => span.events)
			.filter((event) => event.name === 'exception')

		expect(probeExceptionEvents.length).toBeGreaterThan(0)
		expect(
			probeExceptionEvents.some((event) => {
				const message = event.attributes['exception.message']
				const stack = event.attributes['exception.stacktrace']
				return (
					typeof message === 'string' &&
					message.includes('intentional stacktrace probe') &&
					typeof stack === 'string' &&
					stack.length > 0
				)
			})
		).toBeTruthy()
	})

	test('reset wipes an already-dirty room back to baseline snapshot', async ({
		page,
	}, testInfo) => {
		const roomId = buildRoomId(testInfo)
		const shapeId = 'shape:reset-dirty'

		await resetRoom(roomId)
		await clearSpans(roomId)
		await openRoom(page, roomId)
		await waitForConnect(roomId)

		await runCanvasOps(page, [
			{
				kind: 'create',
				shapes: [
					{
						id: shapeId,
						type: 'geo',
						x: 300,
						y: 200,
						props: { geo: 'rectangle', w: 140, h: 100 },
					},
				],
			},
		])

		await waitForSnapshot(roomId, (snapshot) => Boolean(getSnapshotRecord(snapshot, shapeId)))
		await resetRoom(roomId)

		const resetSnapshot = await getSnapshot(roomId)
		expect(resetSnapshot.clock).toBe(0)
		expect(getSnapshotRecord(resetSnapshot, shapeId)).toBeUndefined()
		expect(resetSnapshot.tombstones?.[shapeId]).toBeUndefined()
	})
})
