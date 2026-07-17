import { memo } from 'react'
import type { ReactNode } from 'react'

const maximumJsonLogBytes = 16_384
const maximumJsonTokens = 100
const jsonTokenPattern = String.raw`"(?:\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4})|[^"\\])*"|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|\b(?:true|false|null)\b`
const textEncoder = new TextEncoder()
const jsonLogByteBuffer = new Uint8Array(maximumJsonLogBytes + 1)

export const JsonLogMessage = memo(function JsonLogMessage({ line, highlight = true }: { line: string; highlight?: boolean }) {
  if (!highlight) return <>{line}</>

  const tokens = jsonLogTokens(line)
  if (tokens === null) return <>{line}</>

  return <span className="json-log-message">{tokens}</span>
})

function jsonLogTokens(line: string): ReactNode[] | null {
  const { read, written } = textEncoder.encodeInto(line, jsonLogByteBuffer)
  if (read < line.length || written > maximumJsonLogBytes) return null

  const trimmed = line.trim()
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return null

  try {
    JSON.parse(trimmed)
  } catch {
    return null
  }

  const tokens: ReactNode[] = []
  const jsonToken = new RegExp(jsonTokenPattern, 'g')
  const prefix = line.slice(0, line.indexOf(trimmed))
  const suffix = line.slice(prefix.length + trimmed.length)
  if (prefix) tokens.push(prefix)
  let cursor = 0
  let match: RegExpExecArray | null
  let count = 0

  while ((match = jsonToken.exec(trimmed)) !== null) {
    count += 1
    if (count > maximumJsonTokens) return null

    if (cursor < match.index) tokens.push(trimmed.slice(cursor, match.index))
    tokens.push(
      <span key={match.index} className={jsonTokenClass(match[0], trimmed, match.index + match[0].length)}>
        {match[0]}
      </span>,
    )
    cursor = match.index + match[0].length
  }
  if (cursor < trimmed.length) tokens.push(trimmed.slice(cursor))
  if (suffix) tokens.push(suffix)
  return tokens
}

function jsonTokenClass(token: string, line: string, tokenEnd: number) {
  if (token.startsWith('"')) {
    return /^\s*:/.test(line.slice(tokenEnd)) ? 'json-log-key' : 'json-log-string'
  }
  if (token === 'true' || token === 'false') return 'json-log-boolean'
  if (token === 'null') return 'json-log-null'
  return 'json-log-number'
}
