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
	type Tracer,
} from '@opentelemetry/api'
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks'
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http'
import { resourceFromAttributes } from '@opentelemetry/resources'
import {
	BasicTracerProvider,
	BatchSpanProcessor,
	ParentBasedSampler,
	TraceIdRatioBasedSampler,
} from '@opentelemetry/sdk-trace-base'
import {
	SEMRESATTRS_DEPLOYMENT_ENVIRONMENT,
	SEMRESATTRS_SERVICE_NAME,
	SEMRESATTRS_SERVICE_NAMESPACE,
} from '@opentelemetry/semantic-conventions'
import type { Environment } from './types'

let didInitialize = false
let provider: BasicTracerProvider | null = null
let tracer: Tracer | null = null
let didSetContextManager = false

function isEnabled(env: Environment) {
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

export function initOtel(env: Environment) {
	if (didInitialize || !isEnabled(env)) return
	didInitialize = true

	if (env.TLDRAW_ENV === 'development') {
		diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.ERROR)
	}

	if (!didSetContextManager) {
		context.setGlobalContextManager(new AsyncLocalStorageContextManager())
		didSetContextManager = true
	}

	const exporter = new OTLPTraceExporter({
		url: env.OTEL_EXPORTER_OTLP_ENDPOINT,
		headers: parseHeaders(env.OTEL_EXPORTER_OTLP_HEADERS),
	})

	provider = new BasicTracerProvider({
		resource: resourceFromAttributes({
			[SEMRESATTRS_SERVICE_NAME]: env.OTEL_SERVICE_NAME ?? 'tldraw-sync-worker',
			[SEMRESATTRS_SERVICE_NAMESPACE]: 'tldraw',
			[SEMRESATTRS_DEPLOYMENT_ENVIRONMENT]: env.TLDRAW_ENV ?? 'unknown',
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
	tracer = trace.getTracer('@tldraw/dotcom-sync-worker', '1')
}

export function getWorkerTracer() {
	return tracer ?? trace.getTracer('@tldraw/dotcom-sync-worker', '1')
}

export async function flushOtel() {
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
		return value === null ? undefined : value
	},
}

const headersSetter: TextMapSetter<Headers> = {
	set(carrier, key, value) {
		carrier.set(key, value)
	},
}

export function extractRequestContext(headers: Headers): Context {
	return propagation.extract(context.active(), headers, headersGetter)
}

export function injectTraceHeaders(
	headers?: HeadersInit,
	ctx: Context = context.active()
): Headers {
	const nextHeaders = new Headers(headers)
	propagation.inject(ctx, nextHeaders, headersSetter)
	return nextHeaders
}
