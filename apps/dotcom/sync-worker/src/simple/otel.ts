import {
	context,
	diag,
	DiagConsoleLogger,
	DiagLogLevel,
	propagation,
	trace,
	type Context,
	type TextMapGetter,
} from '@opentelemetry/api'
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http'
import { resourceFromAttributes } from '@opentelemetry/resources'
import {
	BasicTracerProvider,
	BatchSpanProcessor,
	ParentBasedSampler,
	TraceIdRatioBasedSampler,
} from '@opentelemetry/sdk-trace-base'

export interface SimpleOtelEnvironment {
	OTEL_ENABLED?: string
	OTEL_EXPORTER_OTLP_ENDPOINT?: string
	OTEL_EXPORTER_OTLP_HEADERS?: string
	OTEL_SAMPLE_RATIO?: string
	OTEL_SERVICE_NAME?: string
	WORKER_ENV?: string
}

let didInitialize = false
let provider: BasicTracerProvider | null = null

function isEnabled(env: SimpleOtelEnvironment) {
	return env.OTEL_ENABLED === 'true' && !!env.OTEL_EXPORTER_OTLP_ENDPOINT
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

	const exporter = new OTLPTraceExporter({
		url: env.OTEL_EXPORTER_OTLP_ENDPOINT,
		headers: parseHeaders(env.OTEL_EXPORTER_OTLP_HEADERS),
	})

	provider = new BasicTracerProvider({
		resource: resourceFromAttributes({
			'service.name': env.OTEL_SERVICE_NAME ?? 'tldraw-sync-core-simple-worker',
			'service.namespace': 'tldraw',
			'deployment.environment': env.WORKER_ENV ?? 'unknown',
		}),
		sampler: new ParentBasedSampler({
			root: new TraceIdRatioBasedSampler(clampSampleRatio(env.OTEL_SAMPLE_RATIO)),
		}),
		spanProcessors: [
			new BatchSpanProcessor(exporter, {
				scheduledDelayMillis: 500,
				maxExportBatchSize: 64,
				maxQueueSize: 256,
			}),
		],
	})

	trace.setGlobalTracerProvider(provider)
}

export async function flushSimpleOtel() {
	if (!provider) return
	await provider.forceFlush()
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
