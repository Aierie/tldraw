import {
	type Attributes,
	type Context,
	context,
	type Span,
	type SpanOptions,
	SpanStatusCode,
	trace,
} from '@opentelemetry/api'

const tracer = trace.getTracer('@tldraw/sync-core', '1')

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
				return Promise.resolve(result as unknown as Promise<unknown>)
					.catch((error) => {
						recordSpanError(span, error)
						throw error
					})
					.finally(() => {
						span.end()
					}) as unknown as T
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

function recordSpanError(span: Span, error: unknown) {
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
		if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
			span.setAttribute(key, value)
			continue
		}
		if (Array.isArray(value)) {
			const filtered = value.filter(
				(item): item is string | number | boolean =>
					typeof item === 'string' || typeof item === 'number' || typeof item === 'boolean'
			)
			span.setAttribute(
				key,
				filtered as unknown as Parameters<Span['setAttribute']>[1]
			)
		}
	}
}
