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
  await expect(page.getByText('managedFields')).not.toBeVisible()
  await expect(page.getByText('nodeName: node-a')).toBeVisible()
  await page.waitForTimeout(300)
  await captureReadmeScreenshot(page, 'details-yaml.png', theme)
  await maximizeAndExpectExpanded(page, 'pre')
  await expect(page.locator('.details-panel pre')).toBeVisible()

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
