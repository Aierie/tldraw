import type { UnknownRecord } from '@tldraw/store'
import { NetworkDiff, ObjectDiff, RecordOpType, ValueOpType } from './diff'
import type { TLSyncForwardDiff } from './TLSyncStorage'

interface ShapeLike {
	typeName?: string
	parentId?: string
}

export function summarizeNetworkDiff<R extends UnknownRecord>(diff?: NetworkDiff<R> | null) {
	let puts = 0
	let patches = 0
	let removes = 0
	if (!diff) {
		return { puts, patches, removes, total: 0 }
	}
	for (const op of Object.values(diff)) {
		switch (op[0]) {
			case RecordOpType.Put:
				puts++
				break
			case RecordOpType.Patch:
				patches++
				break
			case RecordOpType.Remove:
				removes++
				break
		}
	}
	return { puts, patches, removes, total: puts + patches + removes }
}

export function summarizeForwardDiff(diff?: TLSyncForwardDiff<UnknownRecord>) {
	if (!diff) {
		return { puts: 0, updates: 0, deletes: 0, total: 0 }
	}
	let puts = 0
	let updates = 0
	for (const value of Object.values(diff.puts)) {
		if (Array.isArray(value)) {
			updates++
		} else {
			puts++
		}
	}
	const deletes = diff.deletes.length
	return {
		puts,
		updates,
		deletes,
		total: puts + updates + deletes,
	}
}

function getShapeParentKind(parentId: unknown): 'shape' | 'page' | 'other' {
	if (typeof parentId !== 'string') return 'other'
	if (parentId.startsWith('shape:')) return 'shape'
	if (parentId.startsWith('page:')) return 'page'
	return 'other'
}

function isShapeRecord(record: unknown): record is ShapeLike {
	if (!record || typeof record !== 'object') return false
	const typeName = (record as ShapeLike).typeName
	return typeName === 'shape'
}

function patchContainsParentId(patch: ObjectDiff): boolean {
	return 'parentId' in patch
}

function getParentIdFromPatch(patch: ObjectDiff): string | undefined {
	const value = patch.parentId
	if (!value || !Array.isArray(value) || value[0] !== ValueOpType.Put) {
		return undefined
	}
	const parent = value[1]
	if (typeof parent !== 'string') return undefined
	return parent
}

export function summarizeShapeHierarchyFromNetworkDiff<R extends UnknownRecord>(
	diff?: NetworkDiff<R> | null
) {
	let shapePuts = 0
	let shapeRemoves = 0
	let shapePatches = 0
	let reparentOps = 0
	let parentPage = 0
	let parentShape = 0
	let parentOther = 0

	if (!diff) {
		return {
			shapePuts,
			shapePatches,
			shapeRemoves,
			reparentOps,
			parentPage,
			parentShape,
			parentOther,
		}
	}

	for (const [id, op] of Object.entries(diff)) {
		switch (op[0]) {
			case RecordOpType.Put: {
				if (!isShapeRecord(op[1])) break
				shapePuts++
				switch (getShapeParentKind(op[1].parentId)) {
					case 'shape':
						parentShape++
						break
					case 'page':
						parentPage++
						break
					case 'other':
						parentOther++
						break
				}
				break
			}
			case RecordOpType.Patch: {
				if (!id.startsWith('shape:')) break
				shapePatches++
				if (patchContainsParentId(op[1])) {
					reparentOps++
					switch (getShapeParentKind(getParentIdFromPatch(op[1]))) {
						case 'shape':
							parentShape++
							break
						case 'page':
							parentPage++
							break
						case 'other':
							parentOther++
							break
					}
				}
				break
			}
			case RecordOpType.Remove: {
				if (id.startsWith('shape:')) {
					shapeRemoves++
				}
				break
			}
		}
	}

	return {
		shapePuts,
		shapePatches,
		shapeRemoves,
		reparentOps,
		parentPage,
		parentShape,
		parentOther,
	}
}
