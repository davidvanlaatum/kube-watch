import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { chartSegments, UsageChart } from './UsageChart'
import { coverage, formatUsage, type MetricPoint } from '../metrics'

const now = 1_000_000
const points: MetricPoint[] = [
  { time: now - 60_000, usage: { cpu: 50, memory: 1024 ** 2 } },
  { time: now - 45_000, usage: { cpu: 100, memory: 1024 ** 3 } },
  { time: now - 30_000, usage: null },
  { time: now - 15_000, usage: { cpu: 0, memory: 0 } },
]
describe('usage charts', () => {
  it('preserves zero usage and breaks lines at missing samples and collection gaps', () => {
    expect(chartSegments(points, 'cpu', 0, now)).toEqual([
      [{ time: now - 60_000, value: 50 }, { time: now - 45_000, value: 100 }],
      [{ time: now - 15_000, value: 0 }],
    ])
    expect(chartSegments([points[0], { time: now, usage: { cpu: 10, memory: 0 } }], 'cpu', 0, now)).toHaveLength(2)
    expect(chartSegments(points, 'cpu', now - 20_000, now)).toHaveLength(1)
    expect(chartSegments(points, 'cpu', now + 1, now + 100)).toHaveLength(0)
  })
  it('renders accessible charts, reference lines and hover sample values', () => {
    const { container } = render(<UsageChart points={points} metric="cpu" now={now} request={100} limit={200} />)
    const chart = screen.getByRole('img', { name: 'CPU usage over the last 15 minutes' })
    expect(container.querySelectorAll('polyline')).toHaveLength(2)
    expect(screen.getByText('Configured requests: 100m')).toBeInTheDocument()
    fireEvent.pointerMove(chart, { clientX: 300 })
    expect(screen.queryByText(/Hover for sample values/)).not.toBeInTheDocument()
    fireEvent.pointerLeave(chart)
    expect(screen.getByText(/Hover for sample values/)).toBeInTheDocument()
  })
  it('renders a compact sparkline and an empty chart without invalid SVG coordinates', () => {
    const { container } = render(<UsageChart points={[]} metric="memory" now={now} compact />)
    expect(screen.getByRole('img', { name: 'Memory usage over the last 15 minutes' })).toBeInTheDocument()
    expect(container.innerHTML).not.toMatch(/NaN|Infinity/)
  })
  it('formats absolute units and reporting coverage', () => {
    expect(formatUsage(undefined, 'cpu')).toBe('—')
    expect(formatUsage(0, 'cpu')).toBe('0m')
    expect(formatUsage(125.123, 'cpu')).toBe('125.1m')
    expect(formatUsage(1024 ** 2, 'memory')).toBe('1 MiB')
    expect(formatUsage(1024 ** 3, 'memory')).toBe('1.00 GiB')
    expect(coverage({ reporting: 1, expected: 2 } as never, true)).toBe('1 of 2 pods reporting')
  })
})
