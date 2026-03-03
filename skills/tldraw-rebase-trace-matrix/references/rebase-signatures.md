# Rebase Camera-Null Signatures

Use these signatures when checking `tldraw.client.rebase.error.message`:

1. `Cannot read properties of undefined (reading 'z')`
2. `Cannot destructure property 'x' of 'this.getCamera(...)' as it is undefined.`
3. `Missing camera record for current page during getCamera`

## Supporting Signals

1. `tldraw.client.reset.reason = rebase_error`
2. `tldraw.client.rebase.push_result.rebase > 0`
3. `tldraw.push_result.action` includes `rebase` or `discard`
4. `tldraw.client.hydration_type = wipe_presence` (reconnect path)

## Signals of likely healthy behavior for this regression

1. No camera-null signatures.
2. No `rebase_error` reset reasons.
3. Push outcomes mostly or entirely `commit`.
4. Initial reconnect hydration observed as `wipe_all`.
