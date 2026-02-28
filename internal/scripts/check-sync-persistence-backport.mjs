import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import assert from 'node:assert/strict'

function test(name, fn) {
	try {
		fn()
		console.log(`PASS ${name}`)
	} catch (error) {
		console.error(`FAIL ${name}`)
		throw error
	}
}

function run(command) {
	try {
		return execSync(command, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
	} catch (error) {
		if (typeof error.status === 'number' && error.status === 1) return ''
		throw error
	}
}

const wranglerToml = readFileSync('templates/sync-cloudflare/wrangler.toml', 'utf8')
const durableObjectCode = readFileSync('templates/sync-cloudflare/worker/TldrawDurableObject.ts', 'utf8')
const syncCoreIndex = readFileSync('packages/sync-core/src/index.ts', 'utf8')

const sqliteSearch = run(
	"rg \"SQLiteSyncStorage|DurableObjectSqliteSyncWrapper|NodeSqliteWrapper|TLSyncSqliteWrapper\" packages/sync-core/src templates/sync-cloudflare/worker templates/sync-cloudflare/wrangler.toml -n"
)

const sqliteMigrationsSearch = run(
	"rg \"classes_with_sqlite|new_sqlite_classes\" templates/sync-cloudflare/wrangler.toml -n"
)

const doStorageUsage = run(
	"rg \"ctx\.storage\.|r2\.(get|put)\" templates/sync-cloudflare/worker/TldrawDurableObject.ts -n"
)

test('Cloudflare migrations create DO class but do not enable SQLite mode', () => {
	assert.match(wranglerToml, /new_classes\s*=\s*\[\s*\"TldrawDurableObject\"\s*\]/)
	assert.equal(sqliteMigrationsSearch.trim(), '')
})

test('Durable Object persistence path is room snapshots in R2 plus roomId in DO storage', () => {
	assert.match(durableObjectCode, /this\.ctx\.storage\.get\('roomId'\)/)
	assert.match(durableObjectCode, /this\.ctx\.storage\.put\('roomId'/)
	assert.match(durableObjectCode, /this\.r2\.get\(`rooms\/\$\{roomId\}`\)/)
	assert.match(durableObjectCode, /this\.r2\.put\(`rooms\/\$\{this\.roomId\}`, snapshot\)/)
	assert.ok(doStorageUsage.includes('ctx.storage'))
	assert.ok(doStorageUsage.includes('r2.get'))
	assert.ok(doStorageUsage.includes('r2.put'))
})

test('sync-core has no SQLite storage classes exported or referenced in template code', () => {
	assert.equal(sqliteSearch.trim(), '')
	assert.doesNotMatch(syncCoreIndex, /SQLiteSyncStorage|DurableObjectSqliteSyncWrapper|NodeSqliteWrapper|TLSyncSqliteWrapper/)
})
