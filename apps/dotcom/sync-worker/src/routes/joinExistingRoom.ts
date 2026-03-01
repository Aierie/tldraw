import { ROOM_PREFIX, RoomOpenMode } from '@tldraw/dotcom-shared'
import { withSyncSpan } from '@tldraw/sync-core'
import { notFound } from '@tldraw/worker-shared'
import { IRequest } from 'itty-router'
import { injectTraceHeaders } from '../otel'
import { Environment } from '../types'
import { isRoomIdTooLong, roomIdIsTooLong } from '../utils/roomIdIsTooLong'
import { getSlug } from '../utils/roomOpenMode'

export async function joinExistingRoom(
	request: IRequest,
	env: Environment,
	roomOpenMode: RoomOpenMode
): Promise<Response> {
	return withSyncSpan(
		'tlsync.worker.join_existing_room',
		{
			attributes: {
				'tldraw.msg.type': 'join',
				'http.method': request.method,
				'http.path': new URL(request.url).pathname,
				'tldraw.route.room_open_mode': roomOpenMode,
			},
		},
		async (span) => {
			const roomId = await getSlug(env, request.params.roomId, roomOpenMode)
			span.setAttribute('tldraw.room_id', roomId ?? 'missing')
			if (!roomId) {
				span.setAttribute('tldraw.request.outcome', 'room_not_found')
				return notFound()
			}
			if (isRoomIdTooLong(roomId)) {
				span.setAttribute('tldraw.request.outcome', 'room_id_too_long')
				return roomIdIsTooLong()
			}

			// This needs to be a websocket request!
			if (request.headers.get('upgrade')?.toLowerCase() === 'websocket') {
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

			span.setAttribute('tldraw.request.outcome', 'not_websocket')
			return notFound()
		}
	)
}
