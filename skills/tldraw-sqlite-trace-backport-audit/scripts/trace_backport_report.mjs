#!/usr/bin/env node

import fs from 'node:fs'
import path from 'node:path'

const REQUIRED_SQLITE_SPAN_FAMILY = [
	'tlsync.storage.sqlite.exec',
	'tlsync.storage.sqlite.statement.all',
	'tlsync.storage.sqlite.statement.iterate',
	'tlsync.storage.sqlite.statement.run',
	'tlsync.storage.sqlite.transaction',
	'tlsync.storage.sqlite.transaction.wrapper',
]

const CLIENT_SERVICE_NAME = 'tldraw-sync-core-simple-client'
const WORKER_SERVICE_NAME = 'tldraw-sync-core-simple-worker'

function parseArgs(argv) {
	const args = {
		current: '.',
		reference: '../tldraw',
		includeAggregated: false,
	}
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i]
		if (a === '--current') args.current = argv[++i]
		else if (a === '--reference') args.reference = argv[++i]
		else if (a === '--include-aggregated') args.includeAggregated = true
		else if (a === '--help' || a === '-h') {
			printHelp()
			process.exit(0)
		} else {
			throw new Error(`Unknown argument: ${a}`)
		}
	}
	return args
}

function printHelp() {
	console.log(`trace_backport_report.mjs

Usage:
  node skills/tldraw-sqlite-trace-backport-audit/scripts/trace_backport_report.mjs \\
    [--current <path>] [--reference <path>] [--include-aggregated]

Defaults:
  --current .
  --reference ../tldraw

Notes:
  - By default this script reads only traces.chromium*.jsonl to avoid double-counting.
  - Use --include-aggregated to include traces.jsonl as well.
`)
}

function attrValue(value) {
	if (!value) return undefined
	if (value.stringValue !== undefined) return value.stringValue
	if (value.intValue !== undefined) return Number(value.intValue)
	if (value.boolValue !== undefined) return value.boolValue
	if (value.doubleValue !== undefined) return value.doubleValue
	return undefined
}

function parseAttributes(attributes) {
	return Object.fromEntries((attributes || []).map((a) => [a.key, attrValue(a.value)]))
}

function toMap(entries) {
	const m = new Map()
	for (const [k, v] of entries) m.set(k, v)
	return m
}

function mapToSortedEntries(m, limit = null) {
	const arr = [...m.entries()].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])))
	return limit == null ? arr : arr.slice(0, limit)
}

function increment(m, key, by = 1) {
	m.set(key, (m.get(key) || 0) + by)
}

function toFileSafeSegment(value) {
	const normalized = value
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '')
	return normalized.slice(0, 80) || 'trace-test'
}

function derivePlaywrightTitleMap(repoRoot) {
	const out = new Map()
	const specPath = path.resolve(repoRoot, 'apps/dotcom/sync-worker/e2e/tests/simple-sync-worker.spec.ts')
	if (!fs.existsSync(specPath)) return out
	const txt = fs.readFileSync(specPath, 'utf8')
	const re = /\btest\('([^']+)'/g
	let match
	while ((match = re.exec(txt)) !== null) {
		const title = match[1]
		out.set(toFileSafeSegment(title), title)
	}
	return out
}

function inferTraceFileOrigin(fileName, titleMap) {
	if (fileName === 'traces.jsonl') {
		return { kind: 'collector-aggregate', detail: 'collector file-exporter append target' }
	}

	const m = fileName.match(/^traces\.([^.]+)\.(.+)\.w(\d+)\.r(\d+)\.jsonl$/)
	if (!m) return { kind: 'custom-trace-file', detail: 'non-standard naming pattern' }

	const [, project, titleSlug, workerIndex, retryIndex] = m
	const title = titleMap.get(titleSlug)
	return {
		kind: 'playwright-e2e-snapshot',
		project,
		titleSlug,
		title: title || null,
		workerIndex: Number(workerIndex),
		retryIndex: Number(retryIndex),
	}
}

function formatOrigin(origin) {
	if (!origin) return '(unknown)'
	if (origin.kind === 'collector-aggregate') return 'collector-aggregate'
	if (origin.kind === 'custom-trace-file') return `custom (${origin.detail})`
	if (origin.kind === 'playwright-e2e-snapshot') {
		const titlePart = origin.title ? ` title="${origin.title}"` : ` title_slug=${origin.titleSlug}`
		return `playwright-e2e project=${origin.project}${titlePart} worker=${origin.workerIndex} retry=${origin.retryIndex}`
	}
	return origin.kind
}

function loadTraceFiles(repoRoot, includeAggregated) {
	const dir = path.resolve(repoRoot, 'internal/observability/otel/data')
	if (!fs.existsSync(dir)) {
		throw new Error(`Trace directory not found: ${dir}`)
	}

	const all = fs.readdirSync(dir).filter((f) => /^traces.*\.jsonl$/.test(f))
	const selected = all
		.filter((f) => (includeAggregated ? true : /^traces\.chromium\..*\.jsonl$/.test(f)))
		.sort()

	if (selected.length === 0) {
		throw new Error(`No trace files selected in ${dir} (includeAggregated=${includeAggregated})`)
	}

	return {
		dir,
		files: selected.map((f) => path.join(dir, f)),
	}
}

function analyzeRepo(repoRoot, includeAggregated) {
	const { dir, files } = loadTraceFiles(repoRoot, includeAggregated)
	const titleMap = derivePlaywrightTitleMap(repoRoot)
	const spans = []
	const sqliteSpansByFile = new Map()
	const traceOriginByFile = new Map()
	const serviceCounts = new Map()
	const serviceCountsByFile = new Map()

	for (const fullPath of files) {
		const fileName = path.basename(fullPath)
		traceOriginByFile.set(fileName, inferTraceFileOrigin(fileName, titleMap))
		if (!serviceCountsByFile.has(fileName)) serviceCountsByFile.set(fileName, new Map())
		const txt = fs.readFileSync(fullPath, 'utf8').trim()
		if (!txt) continue
		const lines = txt.split('\n').filter(Boolean)
		for (const line of lines) {
			const doc = JSON.parse(line)
			for (const rs of doc.resourceSpans || []) {
				const resourceAttrs = parseAttributes(rs.resource?.attributes || [])
				const serviceName = resourceAttrs['service.name'] || '(missing service.name)'
				for (const ss of rs.scopeSpans || []) {
					for (const sp of ss.spans || []) {
						const attrs = parseAttributes(sp.attributes || [])
						const events = (sp.events || []).map((e) => ({
							name: e.name,
							attrs: parseAttributes(e.attributes || []),
						}))
						const item = {
							file: fileName,
							traceId: sp.traceId,
							spanId: sp.spanId,
							parentSpanId: sp.parentSpanId || '',
							serviceName,
							name: sp.name,
							attrs,
							events,
						}
						spans.push(item)
						increment(serviceCounts, serviceName)
						increment(serviceCountsByFile.get(fileName), serviceName)
						if (sp.name.startsWith('tlsync.storage.sqlite')) {
							increment(sqliteSpansByFile, fileName)
						}
					}
				}
			}
		}
	}

	const byKey = new Map(spans.map((s) => [`${s.traceId}:${s.spanId}`, s]))
	const parentOf = (s) => (s.parentSpanId ? byKey.get(`${s.traceId}:${s.parentSpanId}`) || null : null)

	function inferFlow(s) {
		let cur = s
		while (true) {
			cur = parentOf(cur)
			if (!cur) return 'other'
			if (cur.name === 'tlsync.room.push') return 'push'
			if (cur.name === 'tlsync.room.connect') return 'connect'
		}
	}

	const nameCounts = new Map()
	for (const s of spans) increment(nameCounts, s.name)

	const sqliteSpans = spans.filter((s) => s.name.startsWith('tlsync.storage.sqlite'))
	const sqliteByName = new Map()
	for (const s of sqliteSpans) increment(sqliteByName, s.name)

	const sqliteByFlow = toMap([
		['push', 0],
		['connect', 0],
		['other', 0],
	])
	const sqliteStatementsByFlow = {
		push: new Map(),
		connect: new Map(),
		other: new Map(),
	}
	const txDidChangeByFlow = {
		push: { true: 0, false: 0, missing: 0 },
		connect: { true: 0, false: 0, missing: 0 },
		other: { true: 0, false: 0, missing: 0 },
	}
	const sqliteExceptions = new Map()

	for (const s of sqliteSpans) {
		const flow = inferFlow(s)
		sqliteByFlow.set(flow, sqliteByFlow.get(flow) + 1)

		if (s.name === 'tlsync.storage.sqlite.exec' || s.name.includes('tlsync.storage.sqlite.statement.')) {
			const stmt = s.attrs['db.statement'] || '(none)'
			increment(sqliteStatementsByFlow[flow], stmt)
		}

		if (s.name === 'tlsync.storage.sqlite.transaction') {
			const did = s.attrs['tldraw.storage.did_change']
			if (did === true) txDidChangeByFlow[flow].true++
			else if (did === false) txDidChangeByFlow[flow].false++
			else txDidChangeByFlow[flow].missing++
		}

		for (const event of s.events) {
			if (event.name !== 'exception') continue
			const key = `${event.attrs['exception.message'] || '(no message)'} | ${
				s.attrs['db.statement'] || '(no statement)'
			}`
			increment(sqliteExceptions, key)
		}
	}

	const handleMessageTypes = new Map()
	for (const s of spans.filter((sp) => sp.name === 'tlsync.room.handle_message')) {
		const msgType = s.attrs['tldraw.msg.type'] || '(missing)'
		increment(handleMessageTypes, msgType)
	}

	const pushOutcomeVariants = new Map()
	for (const s of spans.filter((sp) => sp.name === 'tlsync.room.push_outcome')) {
		const key = [
			`doc=${s.attrs['tldraw.room.did_doc_change'] ?? '(none)'}`,
			`presence=${s.attrs['tldraw.room.did_presence_change'] ?? '(none)'}`,
			`broadcast=${s.attrs['tldraw.push_result.broadcast'] ?? '(none)'}`,
			`action=${s.attrs['tldraw.push_result.action'] ?? '(none)'}`,
		].join(',')
		increment(pushOutcomeVariants, key)
	}

	return {
		repoRoot: path.resolve(repoRoot),
		traceDir: dir,
		files: files.map((f) => path.basename(f)),
		totalSpans: spans.length,
		nameCounts,
		handleMessageTypes,
		traceOriginByFile,
		serviceCounts,
		serviceCountsByFile,
		sqlite: {
			total: sqliteSpans.length,
			byName: sqliteByName,
			byFile: sqliteSpansByFile,
			byFlow: sqliteByFlow,
			statementsByFlow: sqliteStatementsByFlow,
			txDidChangeByFlow,
			exceptions: sqliteExceptions,
		},
		push: {
			count: spans.filter((sp) => sp.name === 'tlsync.room.push').length,
			outcomes: pushOutcomeVariants,
		},
		reconnect: {
			schedule: nameCounts.get('tlsync.socket.client.reconnect.schedule_attempt') || 0,
			connected: nameCounts.get('tlsync.socket.client.reconnect.connected') || 0,
			didReconnect: nameCounts.get('tlsync.client.did_reconnect') || 0,
		},
		stacktraceProbe: nameCounts.get('tlsync.client.stacktrace_probe') || 0,
	}
}

function prettyTop(map, limit = 10) {
	const rows = mapToSortedEntries(map, limit)
	if (rows.length === 0) return ['(none)']
	return rows.map(([k, v]) => `${v}  ${k}`)
}

function missingSpanFamily(current) {
	const currentNames = new Set(current.sqlite.byName.keys())
	return REQUIRED_SQLITE_SPAN_FAMILY.filter((n) => !currentNames.has(n))
}

function printRepoSummary(label, repo) {
	console.log(`\n## ${label}`)
	console.log(`repo: ${repo.repoRoot}`)
	console.log(`trace_dir: ${repo.traceDir}`)
	console.log(`files: ${repo.files.join(', ')}`)
	console.log(`total_spans: ${repo.totalSpans}`)
	console.log(`sqlite_spans_total: ${repo.sqlite.total}`)

	console.log('\ntrace_file_origin:')
	for (const file of repo.files) {
		console.log(`  ${file}: ${formatOrigin(repo.traceOriginByFile.get(file))}`)
	}

	console.log('\nservice_names:')
	for (const row of prettyTop(repo.serviceCounts, 10)) console.log(`  ${row}`)

	console.log('\nsqlite_by_name:')
	for (const row of prettyTop(repo.sqlite.byName, 10)) console.log(`  ${row}`)

	console.log('\nsqlite_by_flow:')
	for (const flow of ['push', 'connect', 'other']) {
		console.log(`  ${flow}: ${repo.sqlite.byFlow.get(flow)}`)
	}

	console.log('\ntransaction_did_change_by_flow:')
	for (const flow of ['push', 'connect', 'other']) {
		const bucket = repo.sqlite.txDidChangeByFlow[flow]
		console.log(`  ${flow}: true=${bucket.true} false=${bucket.false} missing=${bucket.missing}`)
	}

	console.log('\ntop_sqlite_statements_by_flow:')
	for (const flow of ['push', 'connect', 'other']) {
		console.log(`  ${flow}:`)
		for (const row of prettyTop(repo.sqlite.statementsByFlow[flow], 8)) {
			console.log(`    ${row}`)
		}
	}

	console.log('\npush_outcome_variants:')
	for (const row of prettyTop(repo.push.outcomes, 10)) console.log(`  ${row}`)

	console.log('\nhandle_message_types:')
	for (const row of prettyTop(repo.handleMessageTypes, 10)) console.log(`  ${row}`)

	console.log('\nreconnect_spans:')
	console.log(
		`  schedule_attempt=${repo.reconnect.schedule} connected=${repo.reconnect.connected} did_reconnect=${repo.reconnect.didReconnect}`
	)

	console.log(`stacktrace_probe_spans: ${repo.stacktraceProbe}`)

	console.log('\nsqlite_spans_by_file:')
	for (const file of repo.files) {
		console.log(`  ${(repo.sqlite.byFile.get(file) || 0).toString().padStart(4, ' ')}  ${file}`)
	}

	console.log('\nservice_names_by_file:')
	for (const file of repo.files) {
		const byFile = repo.serviceCountsByFile.get(file) || new Map()
		const serviceSummary = mapToSortedEntries(byFile, 6)
			.map(([name, count]) => `${name}:${count}`)
			.join(', ')
		console.log(`  ${file}: ${serviceSummary || '(none)'}`)
	}

	const exceptionRows = prettyTop(repo.sqlite.exceptions, 5)
	console.log('\nsqlite_exceptions:')
	for (const row of exceptionRows) console.log(`  ${row}`)
}

function printComparison(current, reference) {
	const missingInCurrent = missingSpanFamily(current)
	const hasReconnectPairCurrent = current.reconnect.schedule > 0 && current.reconnect.connected > 0
	const hasReconnectPairReference =
		reference.reconnect.schedule > 0 && reference.reconnect.connected > 0

	const refConnectReadOnly =
		reference.sqlite.txDidChangeByFlow.connect.true === 0 &&
		reference.sqlite.txDidChangeByFlow.connect.false > 0

	const refPushHasWrites = reference.sqlite.txDidChangeByFlow.push.true > 0
	const refPushNoOpExists = reference.sqlite.txDidChangeByFlow.push.false > 0
	const currentHasClientService = (current.serviceCounts.get(CLIENT_SERVICE_NAME) || 0) > 0
	const currentHasWorkerService = (current.serviceCounts.get(WORKER_SERVICE_NAME) || 0) > 0
	const referenceHasClientService = (reference.serviceCounts.get(CLIENT_SERVICE_NAME) || 0) > 0
	const referenceHasWorkerService = (reference.serviceCounts.get(WORKER_SERVICE_NAME) || 0) > 0

	console.log('\n## Comparison Highlights')
	console.log(
		`missing_sqlite_span_family_in_current: ${
			missingInCurrent.length ? missingInCurrent.join(', ') : '(none)'
		}`
	)
	console.log(
		`reconnect_pair_current: ${hasReconnectPairCurrent} (schedule=${current.reconnect.schedule}, connected=${current.reconnect.connected})`
	)
	console.log(
		`reconnect_pair_reference: ${hasReconnectPairReference} (schedule=${reference.reconnect.schedule}, connected=${reference.reconnect.connected})`
	)
	console.log(`reference_connect_read_only_signal: ${refConnectReadOnly}`)
	console.log(`reference_push_doc_change_write_signal: ${refPushHasWrites}`)
	console.log(`reference_push_presence_or_noop_signal: ${refPushNoOpExists}`)
	console.log(
		`current_service_mix: client=${currentHasClientService} worker=${currentHasWorkerService}`
	)
	console.log(
		`reference_service_mix: client=${referenceHasClientService} worker=${referenceHasWorkerService}`
	)
	if (!currentHasWorkerService) {
		console.log(
			'current_missing_worker_service_hint: worker OTLP export may be disabled; check OTEL_ENABLED / OTEL_EXPORTER_OTLP_ENDPOINT for dev-simple worker startup'
		)
	}

	console.log('\n## Acceptance Signals')
	console.log(`1) sqlite_span_family_present: ${missingInCurrent.length === 0 ? 'pass' : 'fail'}`)
	console.log(
		`2) reconnect_schedule_connected_present: ${hasReconnectPairCurrent ? 'pass' : 'fail'}`
	)
	console.log(
		`3) connect_read_only_transaction_signal: ${
			current.sqlite.txDidChangeByFlow.connect.true === 0 &&
			current.sqlite.txDidChangeByFlow.connect.false > 0
				? 'pass'
				: 'fail'
		}`
	)
	console.log(
		`4) push_doc_change_write_signal: ${
			current.sqlite.txDidChangeByFlow.push.true > 0 ? 'pass' : 'fail'
		}`
	)
	console.log(
		`5) push_presence_or_noop_no_write_signal: ${
			current.sqlite.txDidChangeByFlow.push.false > 0 ? 'pass' : 'fail'
		}`
	)
}

function printProvenanceModel(current, reference) {
	console.log('\n## Trace Provenance Model')
	console.log('collector_export_file (per repo): <repo>/internal/observability/otel/data/traces.jsonl')
	console.log(
		'collector_config_anchor (per repo): <repo>/internal/observability/otel/collector.yaml (file exporter path /var/lib/otel/traces.jsonl)'
	)
	console.log('playwright_snapshot_pattern: traces.<project>.<title>.w<worker>.r<retry>.jsonl')
	console.log(
		'playwright_snapshot_producer: apps/dotcom/sync-worker/e2e/tests/simple-sync-worker.spec.ts (startOtelTraceCapture + readCapturedTraceContents)'
	)
	console.log(
		`current_repo_has_simple_sync_spec: ${fs.existsSync(
			path.resolve(current.repoRoot, 'apps/dotcom/sync-worker/e2e/tests/simple-sync-worker.spec.ts')
		)}`
	)
	console.log(
		`reference_repo_has_simple_sync_spec: ${fs.existsSync(
			path.resolve(reference.repoRoot, 'apps/dotcom/sync-worker/e2e/tests/simple-sync-worker.spec.ts')
		)}`
	)
}

function main() {
	const args = parseArgs(process.argv.slice(2))
	const current = analyzeRepo(args.current, args.includeAggregated)
	const reference = analyzeRepo(args.reference, args.includeAggregated)

	console.log('# tldraw SQLite Backport Trace Report')
	console.log(`include_aggregated: ${args.includeAggregated}`)
	printProvenanceModel(current, reference)
	printRepoSummary('Current Repo', current)
	printRepoSummary('Reference Repo', reference)
	printComparison(current, reference)
}

try {
	main()
} catch (err) {
	console.error(`ERROR: ${err.message}`)
	process.exit(1)
}
