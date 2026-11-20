import { expect, test, type TestInfo } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'

const readmeScreenshotDirectory = process.env.UPDATE_README_SCREENSHOTS
  ? resolve(process.cwd(), '../docs/screenshots')
  : null

type ScreenshotTheme = 'light' | 'dark'

function screenshotTheme(testInfo: TestInfo): ScreenshotTheme {
  return testInfo.project.use.colorScheme === 'dark' ? 'dark' : 'light'
}

async function captureReadmeScreenshot(
  page: import('@playwright/test').Page,
  name: string,
  theme: ScreenshotTheme,
  clip?: { x: number; y: number; width: number; height: number },
) {
  if (!readmeScreenshotDirectory) return
  mkdirSync(readmeScreenshotDirectory, { recursive: true })
  await page.locator('.MuiAlert-root').evaluateAll(alerts => {
    for (const alert of alerts) {
      if (alert.textContent?.includes('interrupted')) (alert as HTMLElement).style.display = 'none'
    }
  })
  const themedName = theme === 'dark' ? name.replace(/\.png$/, '-dark.png') : name
  await page.screenshot({ path: join(readmeScreenshotDirectory, themedName), clip })
}

const pod = {
  kind: 'Pod',
  metadata: {
    uid: 'pod-1',
    name: 'api-7d9f',
    namespace: 'default',
    creationTimestamp: '2026-07-07T23:00:00Z',
    managedFields: [{ manager: 'ignored' }],
  },
  spec: {
    nodeName: 'node-a',
    containers: [{ name: 'api' }],
  },
  status: {
    phase: 'Running',
    containerStatuses: [{
      ready: true,
      restartCount: 2,
      lastState: { terminated: { finishedAt: '2026-07-07T23:55:00Z' } },
    }],
  },
}

const helmRelease = {
  apiVersion: 'helm.sh/v3',
  kind: 'HelmRelease',
  metadata: {
    uid: 'helmrelease:default:api',
    name: 'api',
    namespace: 'default',
    creationTimestamp: '2026-07-07T23:00:00Z',
    labels: { status: 'deployed' },
  },
  spec: {
    chart: 'api',
    version: '1.2.3',
    appVersion: '4.5.6',
  },
  status: {
    status: 'deployed',
    revision: 2,
    updated: '2026-07-07T23:55:00Z',
    description: 'Upgrade complete',
    storageDriver: 'secrets',
  },
}

const helmHistory = [
  {
    revision: 1,
    status: 'superseded',
    updated: '2026-07-07T23:00:00Z',
    chart: 'api',
    version: '1.2.2',
    appVersion: '4.5.5',
    description: 'Install complete',
  },
  {
    revision: 2,
    status: 'deployed',
    updated: '2026-07-07T23:55:00Z',
    chart: 'api',
    version: '1.2.3',
    appVersion: '4.5.6',
    description: 'Upgrade complete',
  },
]

async function maximizeAndExpectExpanded(
  page: import('@playwright/test').Page,
  contentSelector: string,
  fixedSelector?: string,
  scrollSelector?: string,
  screenshotName?: string,
  theme?: ScreenshotTheme,
) {
  const normalContent = page.locator(`.details-panel:not(.details-panel-maximized) ${contentSelector}`)
  const normalFixed = fixedSelector && page.locator(`.details-panel:not(.details-panel-maximized) ${fixedSelector}`)
  const originalHeight = (await normalContent.boundingBox())?.height || 0
  const originalFixedHeight = normalFixed && (await normalFixed.boundingBox())?.height
  await page.getByRole('button', { name: 'Maximize details' }).click()
  const maximizedDrawer = page.locator('.details-panel-maximized')
  const maximizedContent = page.locator(`.details-panel-maximized ${contentSelector}`)
  await expect(maximizedDrawer).toBeVisible()
  await expect(page.locator('.MuiBackdrop-root')).toHaveCount(0)
  await page.waitForTimeout(300)
  const drawer = await maximizedDrawer.boundingBox()
  expect(drawer?.height).toBeGreaterThan((page.viewportSize()?.height || 0) * 0.9)
  const maximizedHeight = (await maximizedContent.boundingBox())?.height || 0
  expect(maximizedHeight).toBeGreaterThan(originalHeight)
  if (fixedSelector) {
    const maximizedFixedHeight = (await page.locator(`.details-panel-maximized ${fixedSelector}`).boundingBox())?.height || 0
    expect(Math.abs(maximizedFixedHeight - (originalFixedHeight || 0))).toBeLessThan(2)
  }
  if (scrollSelector) {
    await expect.poll(async () => page.locator(`.details-panel-maximized ${scrollSelector}`).evaluate(element => element.scrollTop)).toBeGreaterThan(0)
  }
  const contentBox = await maximizedContent.boundingBox()
  const bottomGap = (drawer?.y || 0) + (drawer?.height || 0) - ((contentBox?.y || 0) + (contentBox?.height || 0))
  expect(bottomGap).toBeGreaterThanOrEqual(0)
  expect(bottomGap).toBeLessThan(16)
  if (screenshotName && theme) await captureReadmeScreenshot(page, screenshotName, theme)
  await page.getByRole('button', { name: 'Restore details size' }).click()
  await expect(maximizedDrawer).toHaveCount(0)
  await expect.poll(async () => {
    const restoredHeight = (await normalContent.boundingBox())?.height || 0
    return Math.abs(restoredHeight - originalHeight)
  }).toBeLessThan(2)
}

test.beforeEach(async ({ page }) => {
  await page.clock.install({ time: new Date('2026-07-08T00:00:00Z') })

  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: () => Promise.resolve(),
      },
    })
  })

  await page.route('**/api/metrics/**', route => {
    const usage = workloadMetrics('pod-1', pod.metadata.name)
    return route.fulfill({ json: { time: metricsNow, items: { 'pod-1': usage }, pods: { 'pod-1': usage } } })
  })

  await page.route('**/api/contexts', async route => {
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify([{ name: 'dev', namespace: 'default' }]),
    })
  })

  await page.route('**/api/version', async route => {
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        version: '1.0.0',
        commit: 'abc123',
        date: '2026-07-08T00:00:00Z',
        latestVersion: 'v1.1.0',
        latestUrl: 'https://github.com/davidvanlaatum/kube-watch/releases/tag/v1.1.0',
        updateAvailable: true,
      }),
    })
  })

  await page.route('**/api/helm-history/dev/secrets/api', async route => {
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify(helmHistory),
    })
  })

  await page.route('**/api/backend-logs', async route => {
    await route.fulfill({
      contentType: 'text/event-stream',
      body: `data: ${JSON.stringify({ info: 'connected' })}\n\n`,
    })
  })

  await page.route('**/sse/dev/pods', async route => {
    await route.fulfill({
      contentType: 'text/event-stream',
      body: [
        `data: ${JSON.stringify({ type: 'ADDED', object: pod })}`,
        `data: ${JSON.stringify({ type: 'SYNCED' })}`,
        '',
      ].join('\n\n'),
    })
  })

  await page.route('**/sse/dev/events', async route => {
    await route.fulfill({
      contentType: 'text/event-stream',
      body: [
        `data: ${JSON.stringify({
          type: 'ADDED',
          object: {
            metadata: {
              uid: 'event-1',
              name: 'api-7d9f.abc123',
              namespace: 'default',
              creationTimestamp: '2026-07-08T00:00:00Z',
            },
            type: 'Normal',
            reason: 'Started',
            message: 'Started container api',
            lastTimestamp: '2026-07-08T00:00:00Z',
            involvedObject: {
              kind: 'Pod',
              name: 'api-7d9f',
              namespace: 'default',
              uid: 'pod-1',
            },
          },
        })}`,
        `data: ${JSON.stringify({ type: 'SYNCED' })}`,
        '',
      ].join('\n\n'),
    })

  })

  await page.route('**/sse/dev/helmreleases', async route => {
    await route.fulfill({
      contentType: 'text/event-stream',
      body: [
        `data: ${JSON.stringify({ type: 'ADDED', object: helmRelease })}`,
        `data: ${JSON.stringify({ type: 'SYNCED' })}`,
        '',
      ].join('\n\n'),
    })
  })

  await page.route('**/logs/dev/pods/default/api-7d9f?tailLines=200', async route => {
    const logEvents = Array.from({ length: 80 }, (_, index) => `data: ${JSON.stringify({
      type: 'LOG',
      pod: 'api-7d9f',
      container: 'api',
      timestamp: `2026-07-08T00:00:${String(index % 60).padStart(2, '0')}Z`,
      line: index % 5 === 0
        ? JSON.stringify({ level: 'info', message: `request ${index + 1} complete`, status: 200 })
        : `server line ${index + 1}`,
      seq: index,
    })}`)
    await route.fulfill({
      contentType: 'text/event-stream',
      body: [...logEvents, ''].join('\n\n'),
    })
  })
})

test('renders Helm release table and history drawer', async ({ page }) => {
  await page.goto('/view/dev/helmreleases')

  const row = page.getByRole('row', { name: /api/ })
  await expect(row).toContainText('deployed')
  await expect(row).toContainText('api-1.2.3')
  await expect(row).toContainText('4.5.6')
  await row.click()
  await page.getByRole('tab', { name: 'History' }).click()

  await expect(page.getByText('Install complete')).toBeVisible()
  await expect(page.getByText('Upgrade complete')).toBeVisible()
  await maximizeAndExpectExpanded(page, '.details-table')
  await expect(page.locator('.details-table')).toBeVisible()
})

test('keeps detail actions visible for long resource names', async ({ page }) => {
  const originalName = pod.metadata.name
  pod.metadata.name = `api-${'a'.repeat(80)}`
  try {
    await page.goto('/')
    await page.getByRole('combobox', { name: 'Context' }).click()
    await page.getByRole('option', { name: /dev/ }).click()
    const row = page.getByRole('row', { name: /api-/ })
    await expect(row).toBeVisible()
    await row.getByText(pod.metadata.name, { exact: true }).click()

    await expect(page.getByRole('heading', { name: `Pod/${pod.metadata.name}` })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Maximize details' })).toBeVisible()
    await page.getByRole('button', { name: 'Maximize details' }).click()
    await expect(page.getByRole('button', { name: 'Restore details size' })).toBeVisible()
    await page.getByRole('button', { name: 'Restore details size' }).click()
    await expect(page.getByRole('button', { name: 'Maximize details' })).toBeVisible()
  } finally {
    pod.metadata.name = originalName
  }
})

test('keeps detail actions visible while scrolling YAML', async ({ page }) => {
  const originalContainers = pod.spec.containers
  pod.spec.containers = Array.from({ length: 80 }, (_, index) => ({ name: `container-${index}` }))
  try {
    await page.goto('/')
    await page.getByRole('combobox', { name: 'Context' }).click()
    await page.getByRole('option', { name: /dev/ }).click()
    const row = page.getByRole('row', { name: /api-7d9f/ })
    await expect(row).toBeVisible()
    await row.click()
    await page.getByRole('button', { name: 'Maximize details' }).click()

    const editorScroller = page.locator('.details-panel-maximized .cm-scroller')
    await expect.poll(async () => editorScroller.evaluate(element => element.scrollHeight - element.clientHeight)).toBeGreaterThan(0)
    await editorScroller.evaluate(element => { element.scrollTop = element.scrollHeight })
    await page.waitForTimeout(1_000)

    await expect.poll(async () => editorScroller.evaluate(element => element.scrollTop)).toBeGreaterThan(0)
    await expect(page.getByRole('button', { name: 'Restore details size' })).toBeVisible()
  } finally {
    pod.spec.containers = originalContainers
  }
})

test('renders pod table, copy feedback, YAML details, events, and logs tab', async ({ page }, testInfo) => {
  const theme = screenshotTheme(testInfo)
  await page.goto('/')

  await expect(page.getByText('v1.0.0')).toBeVisible()
  await expect(page.getByRole('link', { name: 'Update available: v1.1.0' })).toHaveAttribute(
    'href',
    'https://github.com/davidvanlaatum/kube-watch/releases/tag/v1.1.0',
  )
  await page.getByRole('combobox', { name: 'Context' }).click()
  await page.getByRole('option', { name: /dev/ }).click()

  const row = page.getByRole('row', { name: /api-7d9f/ })
  await expect(row).toContainText('2 (')
  await expect(row).toContainText('node-a')
  await expect(page.getByText('1/1 shown')).toBeVisible()
  await page.getByLabel('Name contains').fill('missing')
  await expect(row).toBeHidden()
  await expect(page.getByText('0/1 shown')).toBeVisible()
  await page.getByRole('button', { name: 'Clear filters' }).click()
  await expect(row).toBeVisible()
  await captureReadmeScreenshot(page, 'resource-overview.png', theme, { x: 0, y: 0, width: 1280, height: 300 })

  await row.click()
  await expect(page.getByRole('heading', { name: 'Pod/api-7d9f' })).toBeVisible()
  await expect(page.getByLabel('YAML editor')).toContainText('managedFields')
  await expect(page.locator('.cm-foldPlaceholder')).toBeVisible()
  await expect(page.getByLabel('YAML editor')).toContainText('nodeName')
  const editor = page.getByLabel('YAML editor')
  await editor.focus()
  for (let line = 0; line < 6; line += 1) await page.keyboard.press('ArrowDown')
  const isMac = await page.evaluate(() => navigator.platform.includes('Mac'))
  await page.keyboard.press(isMac ? 'Meta+Alt+]' : 'Control+Shift+]')
  await expect(editor).toContainText('manager: ignored')
  await page.keyboard.press(isMac ? 'Meta+Alt+[' : 'Control+Shift+[')
  await expect(page.locator('.cm-foldPlaceholder')).toBeVisible()
  const findShortcut = isMac ? 'Meta+f' : 'Control+f'
  await page.keyboard.press(findShortcut)
  await expect(page.locator('.cm-search')).toBeVisible()
  await page.keyboard.press('Escape')
  await page.waitForTimeout(300)
  const [normalDrawer, normalEditor] = await Promise.all([
    page.locator('.details-panel:not(.details-panel-maximized)').boundingBox(),
    page.locator('.details-panel:not(.details-panel-maximized) .yaml-editor').boundingBox(),
  ])
  expect((normalEditor?.y || 0) + (normalEditor?.height || 0)).toBeLessThanOrEqual(
    (normalDrawer?.y || 0) + (normalDrawer?.height || 0),
  )
  await captureReadmeScreenshot(page, 'details-yaml.png', theme)
  await maximizeAndExpectExpanded(page, '.yaml-editor')
  await expect(page.locator('.details-panel .yaml-editor')).toBeVisible()

  await page.getByRole('tab', { name: 'Events' }).click()
  await expect(page.getByText('Started container api')).toBeVisible()
  await maximizeAndExpectExpanded(page, '.details-table')
  await expect(page.locator('.details-table')).toBeVisible()

  await page.getByRole('tab', { name: 'Logs' }).click()
  await expect(page.getByRole('spinbutton')).toHaveValue('200')
  await expect(page.getByRole('tab', { name: 'api', exact: true })).toHaveAttribute('aria-selected', 'true')
  await expect(page.getByLabel('Logs for api')).toContainText('api-7d9f: server line 80')
  await maximizeAndExpectExpanded(page, '.log-details', '.log-controls', '.log-output', 'maximized-logs.png', theme)
  await expect(page.locator('.log-details')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Auto scroll on' })).toBeVisible()
  await expect.poll(async () => page.locator('.log-details').evaluate(element => element.scrollTop)).toBeGreaterThan(0)
  const logDetails = page.locator('.details-panel:not([role="dialog"]) .log-details').last()
  await page.getByRole('button', { name: 'Auto scroll on' }).click()
  await expect(page.getByRole('button', { name: 'Auto scroll off' })).toBeVisible()
  await expect.poll(async () => logDetails.evaluate(element => element.scrollTop)).toBeGreaterThan(0)
  await logDetails.evaluate(element => { element.scrollTop = 120 })
  const manualScrollTop = await logDetails.evaluate(element => element.scrollTop)
  await page.getByRole('button', { name: 'Maximize details' }).click()
  await expect.poll(async () => page.locator('.details-panel-maximized .log-output').evaluate(element => element.scrollTop)).toBe(manualScrollTop)
  await page.getByRole('button', { name: 'Restore details size' }).click()
  await expect.poll(async () => logDetails.evaluate(element => element.scrollTop)).toBe(manualScrollTop)

  const copyButton = row.getByRole('button', { name: 'Copy api-7d9f' })
  await copyButton.click()
  await expect(row.getByText('Copied')).toBeVisible()
})


test('replacement snapshots remove rows after a missed deletion', async ({ page }) => {
  await page.route('**/sse/dev/pods', async route => {
    await route.fulfill({
      contentType: 'text/event-stream',
      body: [
        { type: 'ADDED', object: pod },
        { type: 'SNAPSHOT', objects: [] },
        { type: 'SYNCED' },
      ].map(event => `data: ${JSON.stringify(event)}\n\n`).join(''),
    })
  })
  await page.goto('/view/dev/pods')
  await expect(page.getByRole('table')).toBeVisible()
  await expect(page.getByRole('status')).toHaveCount(0)
  await expect(page.getByRole('row', { name: /api-7d9f/ })).toHaveCount(0)
})

const metricsNow = new Date('2026-07-08T00:00:00Z').getTime()
function workloadMetrics(uid: string, name: string, cpu = 125) {
  return {
    uid, name, usage: { cpu, memory: 128 * 1024 ** 2 }, requests: { cpu: 100, memory: 64 * 1024 ** 2 }, limits: { cpu: 500, memory: 256 * 1024 ** 2 },
    reporting: 1, expected: 1, updated: metricsNow,
    history: Array.from({ length: 61 }, (_, i) => ({ time: metricsNow - (60 - i) * 15_000, usage: i === 30 ? null : { cpu: cpu * (1 + Math.sin((i - 60) / 6) * 0.2), memory: 128 * 1024 ** 2 * (1 + Math.sin((i - 60) / 10) * 0.15) } })),
    containers: [{ name: 'api', usage: { cpu, memory: 128 * 1024 ** 2 }, requests: { cpu: 100, memory: 64 * 1024 ** 2 }, limits: { cpu: 500, memory: 256 * 1024 ** 2 } }],
  }
}

test('shows pod CPU/memory trends and a scrollable, maximizable Metrics tab', async ({ page }, testInfo) => {
  const usage = workloadMetrics('pod-1', pod.metadata.name)
  usage.requests.cpu = usage.limits.cpu
  usage.containers[0].requests.cpu = usage.limits.cpu
  await page.route('**/api/metrics/dev/pods', route => route.fulfill({ json: { time: metricsNow, items: { 'pod-1': usage }, pods: { 'pod-1': usage } } }))
  await page.goto('/view/dev/pods')
  const row = page.getByRole('row', { name: /api-7d9f/ })
  await expect(row).toContainText('125m')
  await expect(row).toContainText('128 MiB')
  await expect(row.getByRole('img')).toHaveCount(2)
  await row.click()
  await page.getByRole('tab', { name: 'Metrics' }).click()
  await expect(page.getByRole('table', { name: 'Container metrics' })).toContainText('api')
  await expect(page.getByText(/1 of 1 containers reporting/)).toBeVisible()
  await expect(page.locator('.details-panel').getByRole('img')).toHaveCount(2)
  await expect(page.getByText('Requests and limits: 500m', { exact: true })).toBeVisible()
  const panel = page.locator('.details-panel-metrics')
  await expect.poll(async () => panel.evaluate(el => el.scrollHeight <= el.clientHeight)).toBe(true)
  await page.getByRole('button', { name: 'Maximize details' }).click()
  await expect(page.locator('.details-panel-maximized')).toBeVisible()
  await expect(page.getByRole('table', { name: 'Container metrics' })).toBeVisible()
  await expect.poll(async () => (await page.locator('.details-panel-maximized').boundingBox())?.height || 0).toBeGreaterThan((page.viewportSize()?.height || 0) * 0.9)
  await expect.poll(async () => (await page.locator('.details-panel-maximized').boundingBox())?.y || 0).toBeLessThan(20)
  await page.mouse.move(0, 0)
  await page.getByRole('tooltip').waitFor({ state: 'hidden' })
  await captureReadmeScreenshot(page, 'metrics.png', screenshotTheme(testInfo))
  await page.getByRole('button', { name: 'Restore details size' }).click()
  await expect(page.getByRole('tab', { name: 'Metrics' })).toHaveAttribute('aria-selected', 'true')
})

test('shows deployment totals, per-pod averages, breakdown and incomplete coverage', async ({ page }) => {
  const usage = workloadMetrics('deployment-1', 'web', 250)
  const deployment = { kind: 'Deployment', metadata: { uid: 'deployment-1', name: 'web', namespace: 'default' }, spec: { replicas: 2 }, status: { readyReplicas: 2 } }
  await page.route('**/sse/dev/deployments', route => route.fulfill({ contentType: 'text/event-stream', body: `data: ${JSON.stringify({ type: 'SNAPSHOT', objects: [deployment] })}\n\n` }))
  await page.route('**/api/metrics/dev/deployments', route => route.fulfill({ json: { time: metricsNow, items: { 'deployment-1': { ...usage, reporting: 1, expected: 2, pods: ['pod-1'] } }, pods: { 'pod-1': workloadMetrics('pod-1', 'web-old') } } }))
  await page.goto('/view/dev/deployments')
  const row = page.getByRole('row', { name: /web/ })
  await expect(row).toContainText('250m *')
  await row.click()
  await page.getByRole('tab', { name: 'Metrics' }).click()
  await expect(page.getByText(/1 of 2 pods reporting/)).toBeVisible()
  await expect(page.getByText(/Average per reporting pod: CPU 250m/)).toBeVisible()
  await expect(page.getByText(/Usage is incomplete/)).toBeVisible()
  await expect(page.getByRole('table', { name: 'Pod metrics' })).toContainText('web-old')
})

test('keeps resource browsing available when the Metrics API is missing', async ({ page }) => {
  await page.route('**/api/metrics/dev/pods', route => route.fulfill({ json: { time: metricsNow, items: {}, pods: {}, error: 'Metrics API unavailable' } }))
  await page.goto('/view/dev/pods')
  await expect(page.getByText('Metrics API unavailable')).toBeVisible()
  await page.getByRole('row', { name: /api-7d9f/ }).click()
  await page.getByRole('tab', { name: 'YAML' }).click()
  await expect(page.locator('.yaml-editor')).toBeVisible()
})

test('keeps sparklines beside values when columns have room and wraps them when narrow', async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 900 })
  await page.goto('/view/dev/pods')
  const row = page.getByRole('row', { name: /api-7d9f/ })
  await expect(row).toContainText('125m')
  const cells = [row.getByRole('cell').filter({ has: page.getByText('125m', { exact: true }) }), row.getByRole('cell').filter({ has: page.getByText('128 MiB', { exact: true }) })]
  for (const cell of cells) {
    const value = await cell.locator('span').first().locator('..').boundingBox()
    const graph = await cell.getByRole('img').boundingBox()
    expect(value).not.toBeNull()
    expect(graph).not.toBeNull()
    expect(Math.abs(value!.y + value!.height / 2 - graph!.y - graph!.height / 2)).toBeLessThan(2)
    expect(graph!.x).toBeGreaterThan(value!.x + value!.width)
  }
  await page.setViewportSize({ width: 720, height: 900 })
  for (const cell of cells) {
    await expect.poll(async () => {
      const value = await cell.locator('span').first().locator('..').boundingBox()
      const graph = await cell.getByRole('img').boundingBox()
      return graph!.y >= value!.y + value!.height
    }).toBe(true)
  }
})

test('shows the backend failure reason when a metrics request returns 502', async ({ page }) => {
  const warnings: string[] = []
  page.on('console', message => { if (message.type() === 'warning') warnings.push(message.text()) })
  await page.route('**/api/metrics/dev/pods', route => route.fulfill({ status: 502, contentType: 'text/plain', body: 'metrics unavailable: collect pod metrics: context deadline exceeded\n' }))
  await page.goto('/view/dev/pods')
  await expect(page.getByText('Metrics request failed (502): metrics unavailable: collect pod metrics: context deadline exceeded')).toBeVisible()
  await expect(page.getByRole('row', { name: /api-7d9f/ })).toBeVisible()
  expect(warnings.some(message => message.includes('metrics request failed'))).toBe(true)
})

test('compares list usage to a limit or falls back to the request', async ({ page }) => {
  const usage = workloadMetrics('pod-1', pod.metadata.name)
  usage.limits.cpu = 0
  usage.containers[0].limits.cpu = 0
  await page.route('**/api/metrics/dev/pods', route => route.fulfill({ json: { time: metricsNow, items: { 'pod-1': usage }, pods: { 'pod-1': usage } } }))
  await page.goto('/view/dev/pods')
  const row = page.getByRole('row', { name: /api-7d9f/ })
  await expect(row).toContainText('/ 100m request (125%)')
  await expect(row).toContainText('/ 256 MiB limit (50%)')
})

test('switches deployment list and detail charts between pod aggregates without refetching', async ({ page }, testInfo) => {
  const mib = 1024 ** 2
  const a = workloadMetrics('a', 'api-a', 100), b = workloadMetrics('b', 'api-b', 300)
  a.usage.memory = 400 * mib; b.usage.memory = 100 * mib
  a.limits = { cpu: 200, memory: 800 * mib }; b.limits = { cpu: 600, memory: 200 * mib }
  a.containers[0].usage = a.usage; b.containers[0].usage = b.usage
  a.containers[0].limits = a.limits; b.containers[0].limits = b.limits
  const aggregations = { sum: { cpu: 400, memory: 500 * mib }, avg: { cpu: 200, memory: 250 * mib }, min: { cpu: 100, memory: 100 * mib }, max: { cpu: 300, memory: 400 * mib } }
  const total = {
    ...workloadMetrics('deployment-1', 'api'), usage: aggregations.sum, aggregations, pods: ['a', 'b'], containers: undefined, reporting: 2, expected: 2,
    requests: { cpu: 200, memory: 128 * mib }, limits: { cpu: 800, memory: 1000 * mib },
    history: Array.from({ length: 61 }, (_, i) => {
      const factor = 1 + Math.sin((i - 60) / 6) * 0.2
      const readings = Object.fromEntries(Object.entries(aggregations).map(([key, value]) => [key, { cpu: value.cpu * factor, memory: value.memory * factor }]))
      return { time: metricsNow - (60 - i) * 15_000, usage: i === 30 ? null : readings.sum, aggregations: i === 30 ? undefined : readings }
    }),
  }
  const deployment = { kind: 'Deployment', metadata: { uid: 'deployment-1', name: 'api', namespace: 'default' }, spec: { replicas: 2 }, status: { readyReplicas: 2 } }
  let requests = 0
  await page.route('**/api/metrics/dev/deployments', route => { requests++; return route.fulfill({ json: { time: metricsNow, items: { 'deployment-1': total }, pods: { a, b } } }) })
  await page.route('**/sse/dev/deployments', route => route.fulfill({ contentType: 'text/event-stream', body: `data: ${JSON.stringify({ type: 'SNAPSHOT', objects: [deployment] })}\n\n` }))
  await page.goto('/view/dev/deployments')
  const row = page.locator('.resource-table').getByRole('row', { name: /api/ })
  await expect(row).toContainText('400m')
  await expect(page.getByRole('columnheader', { name: /CPU \(SUM\)/ })).toBeVisible()
  await captureReadmeScreenshot(page, 'deployment-overview.png', screenshotTheme(testInfo), { x: 0, y: 0, width: 1280, height: 320 })
  await page.getByRole('combobox', { name: 'Pod aggregation' }).click()
  await page.getByRole('option', { name: 'Average', exact: true }).click()
  await expect(row).toContainText('200m / 400m limit (50%)')
  await row.click()
  await page.getByRole('tab', { name: 'Metrics' }).click()
  const panel = page.locator('.details-panel')
  await expect(panel.getByText('CPU (Average): 200m')).toBeVisible()
  const cpuChart = panel.getByRole('img', { name: 'CPU usage over the last 15 minutes' })
  const chartBox = (await cpuChart.boundingBox())!
  await cpuChart.hover({ position: { x: chartBox.width - 3, y: chartBox.height / 2 } })
  await expect(panel.getByText('00:00:00: 200m', { exact: true })).toBeVisible()
  await panel.getByRole('combobox', { name: 'Pod aggregation' }).click()
  await page.getByRole('option', { name: 'Maximum', exact: true }).click()
  await expect(row).toContainText('300m / 600m limit (50%)')
  await expect(panel.getByText('CPU (Maximum): 300m')).toBeVisible()
  await cpuChart.hover({ position: { x: chartBox.width - 3, y: chartBox.height / 2 } })
  await expect(panel.getByText('00:00:00: 300m', { exact: true })).toBeVisible()
  await page.getByRole('combobox', { name: 'Pod aggregation' }).first().click()
  await page.getByRole('option', { name: 'Minimum', exact: true }).click()
  await expect(row).toContainText('100m / 200m limit (50%)')
  await expect(panel.getByText('CPU (Minimum): 100m')).toBeVisible()
  expect(requests).toBe(1)
  await page.getByRole('button', { name: 'Maximize details' }).click()
  await expect.poll(async () => (await panel.boundingBox())?.y || 0).toBeLessThan(20)
  await panel.getByRole('combobox', { name: 'Pod aggregation' }).click()
  await page.getByRole('option', { name: 'Sum', exact: true }).click()
  await expect(panel.getByText('CPU (Sum): 400m')).toBeVisible()
  await panel.getByRole('combobox', { name: 'Pod aggregation' }).click()
  await page.getByRole('option', { name: 'Maximum', exact: true }).click()
  await expect(panel.getByText('CPU (Maximum): 300m')).toBeVisible()
  await page.mouse.move(0, 0)
  await expect(page.getByRole('listbox', { includeHidden: true })).toHaveCount(0)
  await captureReadmeScreenshot(page, 'deployment-metrics.png', screenshotTheme(testInfo))
})
