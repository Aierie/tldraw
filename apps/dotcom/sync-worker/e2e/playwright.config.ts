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
			command: 'yarn dev-simple',
			url: 'http://127.0.0.1:8790/health',
			reuseExistingServer: !process.env.CI,
			cwd: path.join(__dirname, '..'),
			timeout: 120_000,
			env: {
				OTEL_ENABLED: 'true',
				OTEL_CAPTURE_SPANS: 'true',
				OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:4318/v1/traces',
				OTEL_SERVICE_NAME: 'tldraw-sync-core-simple-worker',
				OTEL_SAMPLE_RATIO: '1',
				WORKER_ENV: 'development',
			},
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
