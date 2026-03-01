import { expect, test, type Page, type TestInfo } from '@playwright/test'

const BASE_URL = process.env.SIMPLE_SYNC_WORKER_BASE_URL ?? 'http://127.0.0.1:8790'

type SnapshotRecord = {
	id: string
	typeName: string
	x?: number
	y?: number
	props?: Record<string, unknown>
}

type RoomSnapshot = {
	documentClock: number
	documents: Array<{ state: SnapshotRecord; lastChangedClock: number }>
	tombstones?: Record<string, number>
}

type CapturedSimpleSpan = {
	name: string
	attributes: Record<string, unknown>
	statusCode: number
	startTimeUnixMs: number
	endTimeUnixMs: number
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
			kind: 'delete'
			ids: string[]
	  }

function sleep(ms: number) {
	return new Promise((resolve) => setTimeout(resolve, ms))
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
	throw new Error(`Timed out waiting for expected snapshot. Latest snapshot: ${JSON.stringify(latest)}`)
}

async function openRoom(page: Page, roomId: string) {
	await page.goto(`${BASE_URL}/room/${encodeURIComponent(roomId)}`)
	await page.waitForFunction(() => Boolean((window as any).__tldrawEditor), null, {
		timeout: 15_000,
	})
}

async function runCanvasOps(page: Page, ops: CanvasOp[]) {
	await page.evaluate(async (opsToRun: CanvasOp[]) => {
		const editor = (window as any).__tldrawEditor
		if (!editor) throw new Error('Missing window.__tldrawEditor')

		const waitForPaint = () =>
			new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))

		for (const op of opsToRun) {
			switch (op.kind) {
				case 'create':
					editor.createShapes(op.shapes)
					break
				case 'update':
					editor.updateShapes(op.shapes)
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

async function waitForConnect(roomId: string) {
	const start = Date.now()
	while (Date.now() - start < 10_000) {
		const spans = await getSpans(roomId)
		if (spans.some((span) => span.name === 'tlsync.room.connect')) {
			return
		}
		await sleep(100)
	}
	throw new Error(`Timed out waiting for connect span for room ${roomId}`)
}

test.describe('simple sync worker e2e', () => {
	test('reset + create/update/delete sequence persists expected tombstone and spans', async ({ page }, testInfo) => {
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

		expect(snapshot.documentClock).toBeGreaterThan(0)
		expect(getSnapshotRecord(snapshot, shapeId)).toBeUndefined()
		expect(snapshot.tombstones?.[shapeId]).toBeDefined()

		const spans = await getSpans(roomId)
		expect(spans.some((span) => span.name === 'tlsync.room.push')).toBeTruthy()
		expect(
			spans.some((span) => span.attributes['tldraw.msg.type'] === 'push')
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
			return Boolean(getSnapshotRecord(next, deletedShapeId) && getSnapshotRecord(next, survivingShapeId))
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
			return !getSnapshotRecord(next, deletedShapeId) && surviving?.x === 460 && surviving?.y === 360
		})

		const surviving = getSnapshotRecord(snapshot, survivingShapeId)
		expect(surviving).toBeDefined()
		expect(surviving?.x).toBe(460)
		expect(surviving?.y).toBe(360)

		expect(getSnapshotRecord(snapshot, deletedShapeId)).toBeUndefined()
		expect(snapshot.tombstones?.[deletedShapeId]).toBeDefined()
		expect(snapshot.tombstones?.[survivingShapeId]).toBeUndefined()
	})

	test('reset wipes an already-dirty room back to baseline snapshot', async ({ page }, testInfo) => {
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
		expect(resetSnapshot.documentClock).toBe(0)
		expect(getSnapshotRecord(resetSnapshot, shapeId)).toBeUndefined()
		expect(resetSnapshot.tombstones?.[shapeId]).toBeUndefined()
	})
})
