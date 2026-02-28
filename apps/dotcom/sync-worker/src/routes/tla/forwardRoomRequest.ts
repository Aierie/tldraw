import { ROOM_PREFIX } from '@tldraw/dotcom-shared'
import { withSyncSpan } from '@tldraw/sync-core'
import { notFound } from '@tldraw/worker-shared'
import { IRequest } from 'itty-router'
import { Environment } from '../../types'
import { isRoomIdTooLong, roomIdIsTooLong } from '../../utils/roomIdIsTooLong'

// Forwards a room request to the durable object associated with that room
export async function forwardRoomRequest(request: IRequest, env: Environment): Promise<Response> {
	return withSyncSpan(
		'tlsync.worker.forward_room_request',
		{
			attributes: {
				'tldraw.msg.type': 'forward_room_request',
			},
		},
		(span) => {
			const roomId = request.params.roomId
			span.setAttribute('tldraw.room_id', roomId ?? 'missing')

			if (!roomId) return notFound()
			if (isRoomIdTooLong(roomId)) return roomIdIsTooLong()

			// Set up the durable object for this room
			const id = env.TLDR_DOC.idFromName(`/${ROOM_PREFIX}/${roomId}`)
			return env.TLDR_DOC.get(id).fetch(request)
		}
	)
}
