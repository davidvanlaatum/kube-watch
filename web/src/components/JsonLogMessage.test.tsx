import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { JsonLogMessage } from './JsonLogMessage'

describe('JsonLogMessage', () => {
  it('colorizes valid JSON log objects without changing their compact format', () => {
    const { container } = render(
      <JsonLogMessage line={'{"level":"info","retries":2,"ready":true,"error":null}'} />,
    )

    expect(screen.getByText('"level"')).toHaveClass('json-log-key')
    expect(screen.getByText('"info"')).toHaveClass('json-log-string')
    expect(screen.getByText('2')).toHaveClass('json-log-number')
    expect(screen.getByText('true')).toHaveClass('json-log-boolean')
    expect(screen.getByText('null')).toHaveClass('json-log-null')
    expect(container.textContent).toBe('{"level":"info","retries":2,"ready":true,"error":null}')
  })

  it('leaves plain text and invalid JSON unchanged', () => {
    const { rerender } = render(<JsonLogMessage line="application started" />)
    expect(screen.getByText('application started')).not.toHaveClass('json-log-message')

    rerender(<JsonLogMessage line='{"level": invalid}' />)
    expect(screen.getByText('{"level": invalid}')).not.toHaveClass('json-log-message')
  })

  it('leaves oversized JSON lines unhighlighted', () => {
    const line = `{"message":"${'x'.repeat(16_384)}"}`
    const { container } = render(<JsonLogMessage line={line} />)

    expect(container.textContent).toBe(line)
    expect(container.querySelector('.json-log-message')).toBeNull()
  })

  it('preserves outer whitespace around valid JSON', () => {
    const line = '  {"level":"info"}  '
    const { container } = render(<JsonLogMessage line={line} />)

    expect(container.textContent).toBe(line)
    expect(container.querySelector('.json-log-message')).not.toBeNull()
  })

  it('uses UTF-8 bytes when enforcing the JSON line limit', () => {
    const line = `{"message":"${'界'.repeat(6_000)}"}`
    const { container } = render(<JsonLogMessage line={line} />)

    expect(container.textContent).toBe(line)
    expect(container.querySelector('.json-log-message')).toBeNull()
  })

  it('does not affect highlighting after token-limit fallback', () => {
    const oversizedTokenList = `[${Array.from({ length: 101 }, () => 'true').join(',')}]`
    const { container } = render(
      <>
        <JsonLogMessage line={oversizedTokenList} />
        <JsonLogMessage line='{"level":"info"}' />
      </>,
    )

    expect(container.querySelectorAll('.json-log-message')).toHaveLength(1)
    expect(container.querySelector('.json-log-key')).toHaveTextContent('"level"')
  })
})
