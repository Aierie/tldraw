import {
	context,
	propagation,
	Span,
	type SpanOptions,
	SpanStatusCode,
	type TextMapGetter,
	type TextMapSetter,
	trace,
	type Attributes,
	type Context,
} from '@opentelemetry/api'
import type { TLTraceCarrier } from './protocol'

const tracer = trace.getTracer('@tldraw/sync-core', '1')

const TRACE_KEYS = ['traceparent', 'tracestate', 'baggage'] as const

export const SYNC_TRACE_BAGGAGE_KEYS = {
	CANVAS_OP_ID: 'tldraw.canvas_op_id',
	CANVAS_OP_KIND: 'tldraw.canvas_op_kind',
	BATCH_ID: 'tldraw.sync.batch_id',
	BATCH_COALESCED_COUNT: 'tldraw.sync.batch_coalesced_count',
} as const

const traceCarrierGetter: TextMapGetter<TLTraceCarrier> = {
	keys(carrier) {
		const keys: string[] = []
		for (const key of TRACE_KEYS) {
			if (carrier[key]) keys.push(key)
		}
		return keys
	},
	get(carrier, key) {
		const lowerKey = key.toLowerCase() as (typeof TRACE_KEYS)[number]
		const value = carrier[lowerKey]
		if (!value) return undefined
		return value
	},
}

const traceCarrierSetter: TextMapSetter<TLTraceCarrier> = {
	set(carrier, key, value) {
		const lowerKey = key.toLowerCase() as (typeof TRACE_KEYS)[number]
		if (lowerKey === 'traceparent' || lowerKey === 'tracestate' || lowerKey === 'baggage') {
			carrier[lowerKey] = value
		}
	},
}

export function getSyncTracer() {
	return tracer
}

export function getTraceCarrierForContext(ctx: Context): TLTraceCarrier | undefined {
	const carrier: TLTraceCarrier = {}
	propagation.inject(ctx, carrier, traceCarrierSetter)
	if (!carrier.traceparent && !carrier.tracestate) {
		return undefined
	}
	return carrier
}

export function getActiveTraceCarrier(): TLTraceCarrier | undefined {
	return getTraceCarrierForContext(context.active())
}

export function withSyncTraceAttributesContext(
	attributes: Record<string, string | number | boolean | undefined>,
	ctx: Context = context.active()
): Context {
	let baggage = propagation.getBaggage(ctx) ?? propagation.createBaggage()
	let didSet = false
	for (const [key, value] of Object.entries(attributes)) {
		if (value === undefined || value === null) continue
		baggage = baggage.setEntry(key, { value: String(value) })
		didSet = true
	}
	if (!didSet) return ctx
	return propagation.setBaggage(ctx, baggage)
}

export function getSyncTraceAttributes(ctx: Context = context.active()): Record<string, string> {
	const baggage = propagation.getBaggage(ctx)
	if (!baggage) return {}
	const attrs: Record<string, string> = {}
	for (const key of Object.values(SYNC_TRACE_BAGGAGE_KEYS)) {
		const value = baggage.getEntry(key)?.value
		if (value) attrs[key] = value
	}
	return attrs
}

export function attachTraceCarrier<T extends { trace?: TLTraceCarrier }>(
	message: T,
	ctx: Context = context.active()
): T {
	const carrier = getTraceCarrierForContext(ctx)
	if (!carrier) return message
	return {
		...message,
		trace: carrier,
	}
}

export function extractTraceContext(traceCarrier?: TLTraceCarrier): Context {
	if (!traceCarrier || (!traceCarrier.traceparent && !traceCarrier.tracestate)) {
		return context.active()
	}
	return propagation.extract(context.active(), traceCarrier, traceCarrierGetter)
}

export function withSyncSpan<T>(
	name: string,
	options: SpanOptions = {},
	fn: (span: Span) => T,
	ctx: Context = context.active()
): T {
	return tracer.startActiveSpan(name, options, ctx, (span) => {
		try {
			const result = fn(span)
			if (
				typeof result === 'object' &&
				result &&
				'then' in result &&
				typeof result.then === 'function'
			) {
				return (result as Promise<unknown>)
					.catch((error) => {
						recordSpanError(span, error)
						throw error
					})
					.finally(() => {
						span.end()
					}) as T
			}
			span.end()
			return result
		} catch (error) {
			recordSpanError(span, error)
			span.end()
			throw error
		}
	})
}

export function recordSpanError(span: Span, error: unknown) {
	span.setStatus({ code: SpanStatusCode.ERROR })
	if (error instanceof Error) {
		span.recordException(error)
		return
	}
	span.recordException({
		name: 'Error',
		message: String(error),
	})
}

export function setSafeAttributes(span: Span, attributes: Attributes | Record<string, unknown>) {
	for (const [key, value] of Object.entries(attributes)) {
		if (value === undefined || value === null) continue
		if (
			typeof value === 'string' ||
			typeof value === 'number' ||
			typeof value === 'boolean'
		) {
			span.setAttribute(key, value)
			continue
		}
		if (Array.isArray(value)) {
			span.setAttribute(
				key,
				value.filter(
					(item): item is string | number | boolean =>
						typeof item === 'string' ||
						typeof item === 'number' ||
						typeof item === 'boolean'
				)
			)
		}
	}
}
