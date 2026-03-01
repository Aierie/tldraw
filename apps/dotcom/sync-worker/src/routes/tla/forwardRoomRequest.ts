import { ROOM_PREFIX } from '@tldraw/dotcom-shared'
import { withSyncSpan } from '@tldraw/sync-core'
import { notFound } from '@tldraw/worker-shared'
import { IRequest } from 'itty-router'
import { injectTraceHeaders } from '../../otel'
import { Environment } from '../../types'
import { isRoomIdTooLong, roomIdIsTooLong } from '../../utils/roomIdIsTooLong'

// Forwards a room request to the durable object associated with that room
export async function forwardRoomRequest(request: IRequest, env: Environment): Promise<Response> {
	return withSyncSpan(
		'tlsync.worker.forward_room_request',
		{
			attributes: {
				'tldraw.msg.type': 'forward_room_request',
				'http.method': request.method,
				'http.path': new URL(request.url).pathname,
			},
		},
		async (span) => {
			const roomId = request.params.roomId
			span.setAttribute('tldraw.room_id', roomId ?? 'missing')

			if (!roomId) {
				span.setAttribute('tldraw.request.outcome', 'room_not_found')
				return notFound()
			}
			if (isRoomIdTooLong(roomId)) {
				span.setAttribute('tldraw.request.outcome', 'room_id_too_long')
				return roomIdIsTooLong()
			}

			// Set up the durable object for this room
			const id = env.TLDR_DOC.idFromName(`/${ROOM_PREFIX}/${roomId}`)
			const response = await env.TLDR_DOC.get(id).fetch(
				new Request(request.url, {
					method: request.method,
					headers: injectTraceHeaders(request.headers),
					body: request.body,
				})
			)
			span.setAttribute('http.status_code', response.status)
			span.setAttribute('tldraw.request.outcome', 'forwarded_to_room')
			return response
		}
	)
}
