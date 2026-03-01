import {
	context,
	diag,
	DiagConsoleLogger,
	DiagLogLevel,
	propagation,
	trace,
	type Context,
	type TextMapGetter,
	type TextMapSetter,
} from '@opentelemetry/api'
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks'
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http'
import { resourceFromAttributes } from '@opentelemetry/resources'
import {
	BasicTracerProvider,
	BatchSpanProcessor,
	InMemorySpanExporter,
	ParentBasedSampler,
	SimpleSpanProcessor,
	TraceIdRatioBasedSampler,
	type ReadableSpan,
	type SpanProcessor,
} from '@opentelemetry/sdk-trace-base'

export interface SimpleOtelEnvironment {
	OTEL_ENABLED?: string
	OTEL_CAPTURE_SPANS?: string
	OTEL_EXPORTER_OTLP_ENDPOINT?: string
	OTEL_EXPORTER_OTLP_HEADERS?: string
	OTEL_SAMPLE_RATIO?: string
	OTEL_SERVICE_NAME?: string
	WORKER_ENV?: string
}

let didInitialize = false
let provider: BasicTracerProvider | null = null
let didSetContextManager = false
let capturedSpansExporter: InMemorySpanExporter | null = null

function shouldCaptureSpans(env: SimpleOtelEnvironment) {
	return env.OTEL_CAPTURE_SPANS === 'true'
}

function shouldExportOtel(env: SimpleOtelEnvironment) {
	return env.OTEL_ENABLED === 'true' && !!env.OTEL_EXPORTER_OTLP_ENDPOINT
}

function isEnabled(env: SimpleOtelEnvironment) {
	return shouldCaptureSpans(env) || shouldExportOtel(env)
}

function clampSampleRatio(value: string | undefined): number {
	const ratio = Number.parseFloat(value ?? '1')
	if (!Number.isFinite(ratio)) return 1
	if (ratio < 0) return 0
	if (ratio > 1) return 1
	return ratio
}

function parseHeaders(input: string | undefined): Record<string, string> | undefined {
	if (!input) return undefined

	const headers = Object.fromEntries(
		input
			.split(',')
			.map((part) => part.trim())
			.filter(Boolean)
			.map((part) => {
				const [key, ...rest] = part.split('=')
				return [key.trim(), rest.join('=').trim()]
			})
	)

	return Object.keys(headers).length > 0 ? headers : undefined
}

export function initSimpleOtel(env: SimpleOtelEnvironment) {
	if (didInitialize || !isEnabled(env)) return
	didInitialize = true

	if (env.WORKER_ENV === 'development') {
		diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.ERROR)
	}

	if (!didSetContextManager) {
		context.setGlobalContextManager(new AsyncLocalStorageContextManager())
		didSetContextManager = true
	}

	const spanProcessors: SpanProcessor[] = []

	if (shouldExportOtel(env)) {
		const exporter = new OTLPTraceExporter({
			url: env.OTEL_EXPORTER_OTLP_ENDPOINT,
			headers: parseHeaders(env.OTEL_EXPORTER_OTLP_HEADERS),
		})
		spanProcessors.push(
			new BatchSpanProcessor(exporter, {
				scheduledDelayMillis: 500,
				maxExportBatchSize: 64,
				maxQueueSize: 256,
			})
		)
	}

	if (shouldCaptureSpans(env)) {
		capturedSpansExporter = new InMemorySpanExporter()
		spanProcessors.push(new SimpleSpanProcessor(capturedSpansExporter))
	}

	provider = new BasicTracerProvider({
		resource: resourceFromAttributes({
			'service.name': env.OTEL_SERVICE_NAME ?? 'tldraw-sync-core-simple-worker',
			'service.namespace': 'tldraw',
			'deployment.environment': env.WORKER_ENV ?? 'unknown',
		}),
		sampler: new ParentBasedSampler({
			root: new TraceIdRatioBasedSampler(clampSampleRatio(env.OTEL_SAMPLE_RATIO)),
		}),
		spanProcessors,
	})

	trace.setGlobalTracerProvider(provider)
}

export async function flushSimpleOtel() {
	if (!provider) return
	await provider.forceFlush()
}

function hrToUnixMs(hr: [number, number]) {
	return hr[0] * 1000 + hr[1] / 1_000_000
}

export interface CapturedSimpleSpan {
	name: string
	attributes: Record<string, unknown>
	statusCode: number
	startTimeUnixMs: number
	endTimeUnixMs: number
}

function serializeSpan(span: ReadableSpan): CapturedSimpleSpan {
	return {
		name: span.name,
		attributes: span.attributes,
		statusCode: span.status.code,
		startTimeUnixMs: hrToUnixMs(span.startTime),
		endTimeUnixMs: hrToUnixMs(span.endTime),
	}
}

export function getCapturedSimpleSpans(): CapturedSimpleSpan[] {
	if (!capturedSpansExporter) return []
	return capturedSpansExporter.getFinishedSpans().map(serializeSpan)
}

export function clearCapturedSimpleSpans() {
	capturedSpansExporter?.reset()
}

const headersGetter: TextMapGetter<Headers> = {
	keys(carrier) {
		const keys: string[] = []
		carrier.forEach((_, key) => keys.push(key))
		return keys
	},
	get(carrier, key) {
		const value = carrier.get(key)
		if (value === null) return undefined
		return value
	},
}

export function extractRequestContext(headers: Headers): Context {
	return propagation.extract(context.active(), headers, headersGetter)
}

const headersSetter: TextMapSetter<Headers> = {
	set(carrier, key, value) {
		carrier.set(key, value)
	},
}

export function injectTraceHeaders(
	headers?: HeadersInit,
	ctx: Context = context.active()
): Headers {
	const nextHeaders = new Headers(headers)
	propagation.inject(ctx, nextHeaders, headersSetter)
	return nextHeaders
}
