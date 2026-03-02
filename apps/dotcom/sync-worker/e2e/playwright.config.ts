import { defineConfig, devices } from '@playwright/test'
import path from 'path'

const __dirname = path.dirname(new URL(import.meta.url).pathname)

export default defineConfig({
	testDir: './tests',
	fullyParallel: false,
	workers: 1,
	timeout: 60_000,
	retries: process.env.CI ? 1 : 0,
	reporter: process.env.CI ? [['list'], ['github'], ['html', { open: 'never' }]] : 'list',
	use: {
		trace: 'on-first-retry',
		video: 'retain-on-failure',
		screenshot: 'only-on-failure',
	},
	projects: [
		{
			name: 'chromium',
			use: {
				...devices['Desktop Chrome'],
			},
		},
	],
	webServer: [
		{
			command: [
				'wrangler dev --config wrangler.simple.toml --local --log-level info --port 8790',
				'--var OTEL_ENABLED:true',
				'--var OTEL_CAPTURE_SPANS:true',
				'--var OTEL_EXPORTER_OTLP_ENDPOINT:http://127.0.0.1:4318/v1/traces',
				'--var OTEL_SERVICE_NAME:tldraw-sync-core-simple-worker',
				'--var OTEL_SAMPLE_RATIO:1',
				'--var WORKER_ENV:development',
			].join(' '),
			url: 'http://127.0.0.1:8790/health',
			reuseExistingServer: !process.env.CI,
			cwd: path.join(__dirname, '..'),
			timeout: 120_000,
		},
		{
			command: 'yarn dev-simple-client',
			url: 'http://127.0.0.1:5173',
			reuseExistingServer: !process.env.CI,
			cwd: path.join(__dirname, '..'),
			timeout: 120_000,
			env: {
				VITE_SIMPLE_SYNC_WORKER_BASE_URL: 'http://127.0.0.1:8790',
			},
		},
	],
})
