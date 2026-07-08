import { expect, test } from '@playwright/test'

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

test.beforeEach(async ({ page }) => {
  await page.route('**/api/contexts', async route => {
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify([{ name: 'dev', namespace: 'default' }]),
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
})

test('renders pod table, copy feedback, YAML details, and resource events tab', async ({ page }) => {
  await page.goto('/')

  await page.getByRole('combobox').first().selectOption('dev')

  const row = page.getByRole('row', { name: /api-7d9f/ })
  await expect(row).toContainText('2 (')
  await expect(row).toContainText('node-a')

  const copyButton = row.getByRole('button', { name: 'Copy api-7d9f' })
  await copyButton.click()
  await expect(copyButton).toHaveText('Copied')

  await row.click()
  await expect(page.getByRole('heading', { name: 'Pod/api-7d9f' })).toBeVisible()
  await expect(page.getByText('managedFields')).not.toBeVisible()
  await expect(page.getByText('nodeName: node-a')).toBeVisible()

  await page.getByRole('button', { name: 'Events' }).click()
  await expect(page.getByText('Started container api')).toBeVisible()
})
