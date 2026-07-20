import { spawnSync } from 'node:child_process'

const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx'
const result = spawnSync(npx, ['playwright', 'test'], {
  env: { ...process.env, CI: '1', UPDATE_README_SCREENSHOTS: '1' },
  stdio: 'inherit',
})

process.exit(result.status ?? 1)
