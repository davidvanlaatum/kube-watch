import { defaultKeymap } from '@codemirror/commands'
import { yaml } from '@codemirror/lang-yaml'
import {
  defaultHighlightStyle,
  foldEffect,
  foldGutter,
  foldKeymap,
  foldedRanges,
  syntaxHighlighting,
} from '@codemirror/language'
import { searchKeymap } from '@codemirror/search'
import { Compartment, EditorState } from '@codemirror/state'
import { oneDarkHighlightStyle } from '@codemirror/theme-one-dark'
import { drawSelection, EditorView, highlightActiveLine, highlightActiveLineGutter, highlightSpecialChars, keymap, lineNumbers } from '@codemirror/view'
import { Box, useTheme } from '@mui/material'
import { useDeferredValue, useEffect, useMemo, useRef } from 'react'
import type { Extension, Text } from '@codemirror/state'
import { stringify } from 'yaml'

export function managedFieldsFoldRange(document: Text) {
  let metadataIndentation: number | null = null
  let metadataChildIndentation: number | null = null
  for (let number = 1; number <= document.lines; number += 1) {
    const line = document.line(number)
    if (!line.text.trim()) continue
    const indentation = line.text.length - line.text.trimStart().length
    if (metadataIndentation === null) {
      if (indentation === 0 && line.text.trim() === 'metadata:') {
        metadataIndentation = indentation
        metadataChildIndentation = null
      }
      continue
    }
    if (indentation <= metadataIndentation) {
      metadataIndentation = null
      metadataChildIndentation = null
      continue
    }
    if (metadataChildIndentation === null) metadataChildIndentation = indentation
    if (indentation !== metadataChildIndentation || line.text.trim() !== 'managedFields:') continue
    let to = document.length
    for (let nextNumber = number + 1; nextNumber <= document.lines; nextNumber += 1) {
      const next = document.line(nextNumber)
      if (!next.text.trim()) continue
      const nextIndentation = next.text.length - next.text.trimStart().length
      if (nextIndentation <= indentation) {
        to = next.from - 1
        break
      }
    }
    return to > line.to ? { from: line.to, to } : null
  }
  return null
}

export function documentChange(previous: string, next: string) {
  let from = 0
  while (from < previous.length && from < next.length && previous[from] === next[from]) from += 1

  let previousTo = previous.length
  let nextTo = next.length
  while (previousTo > from && nextTo > from && previous[previousTo - 1] === next[nextTo - 1]) {
    previousTo -= 1
    nextTo -= 1
  }

  return { from, to: previousTo, insert: next.slice(from, nextTo) }
}

function collapseManagedFields(view: EditorView) {
  const range = managedFieldsFoldRange(view.state.doc)
  if (range) view.dispatch({ effects: foldEffect.of(range) })
}

function isFolded(view: EditorView, range: { from: number; to: number } | null) {
  if (!range) return false
  let folded = false
  foldedRanges(view.state).between(range.from, range.to, (from, to) => {
    if (from === range.from && to === range.to) folded = true
  })
  return folded
}

export function YamlEditor({ value }: { value: unknown }) {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const viewRef = useRef<EditorView | null>(null)
  const themeCompartment = useRef(new Compartment())
  const appliedContentRef = useRef('')
  const pendingContentRef = useRef('')
  const updateFrameRef = useRef<number | null>(null)
  const scrollRestoreFrameRef = useRef<number | null>(null)
  const theme = useTheme()
  const deferredValue = useDeferredValue(value)
  const content = useMemo(() => stringify(deferredValue), [deferredValue])
  pendingContentRef.current = content
  const themeExtension = useMemo<Extension>(() => [
    EditorView.theme({
      '&': {
        height: '100%',
        backgroundColor: theme.palette.background.paper,
        color: theme.palette.text.primary,
      },
      '.cm-scroller': {
        overflow: 'auto',
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace',
        fontSize: '13px',
      },
      '.cm-gutters': {
        backgroundColor: theme.palette.background.paper,
        borderRightColor: theme.palette.divider,
        color: theme.palette.text.secondary,
      },
      '.cm-activeLine, .cm-activeLineGutter': {
        backgroundColor: theme.palette.action.hover,
      },
      '.cm-foldPlaceholder': {
        backgroundColor: 'transparent',
        borderColor: theme.palette.divider,
        color: theme.palette.primary.main,
      },
    }, { dark: theme.palette.mode === 'dark' }),
    syntaxHighlighting(theme.palette.mode === 'dark' ? oneDarkHighlightStyle : defaultHighlightStyle),
  ], [theme])

  useEffect(() => {
    if (!hostRef.current) return
    const view = new EditorView({
      state: EditorState.create({
        doc: content,
        extensions: [
          lineNumbers(),
          highlightSpecialChars(),
          drawSelection(),
          highlightActiveLine(),
          highlightActiveLineGutter(),
          foldGutter(),
          keymap.of([...defaultKeymap, ...foldKeymap, ...searchKeymap]),
          yaml(),
          EditorState.readOnly.of(true),
          EditorView.editable.of(false),
          EditorView.contentAttributes.of({ 'aria-label': 'YAML editor', tabindex: '0' }),
          themeCompartment.current.of(themeExtension),
        ],
      }),
      parent: hostRef.current,
    })
    viewRef.current = view
    appliedContentRef.current = content
    collapseManagedFields(view)
    return () => {
      if (updateFrameRef.current !== null) window.cancelAnimationFrame(updateFrameRef.current)
      if (scrollRestoreFrameRef.current !== null) window.cancelAnimationFrame(scrollRestoreFrameRef.current)
      view.destroy()
      viewRef.current = null
    }
  }, [])

  useEffect(() => {
    const view = viewRef.current
    if (!view || appliedContentRef.current === content || updateFrameRef.current !== null) return
    updateFrameRef.current = window.requestAnimationFrame(() => {
      updateFrameRef.current = null
      const nextContent = pendingContentRef.current
      if (appliedContentRef.current === nextContent) return

      const managedFieldsWereFolded = isFolded(view, managedFieldsFoldRange(view.state.doc))
      const { scrollTop, scrollLeft } = view.scrollDOM
      view.dispatch({
        changes: documentChange(appliedContentRef.current, nextContent),
      })
      appliedContentRef.current = nextContent
      if (managedFieldsWereFolded) collapseManagedFields(view)

      if (scrollRestoreFrameRef.current !== null) window.cancelAnimationFrame(scrollRestoreFrameRef.current)
      scrollRestoreFrameRef.current = window.requestAnimationFrame(() => {
        if (viewRef.current !== view) return
        view.scrollDOM.scrollLeft = scrollLeft
        view.scrollDOM.scrollTop = Math.min(scrollTop, view.scrollDOM.scrollHeight - view.scrollDOM.clientHeight)
      })
    })
  }, [content])

  useEffect(() => {
    viewRef.current?.dispatch({
      effects: themeCompartment.current.reconfigure(themeExtension),
    })
  }, [themeExtension])

  return <Box ref={hostRef} className="yaml-editor" />
}
