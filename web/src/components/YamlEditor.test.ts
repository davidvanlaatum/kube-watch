import { EditorState, Text } from '@codemirror/state'
import { foldEffect, foldedRanges, foldGutter } from '@codemirror/language'
import { describe, expect, it } from 'vitest'
import { documentChange, managedFieldsFoldRange } from './YamlEditor'

describe('managedFieldsFoldRange', () => {
  it('folds the complete managedFields block regardless of its size', () => {
    const document = Text.of([
      'metadata:',
      '  name: api',
      '  managedFields:',
      ...Array.from({ length: 10_000 }, (_, index) => `    - manager: controller-${index}`),
      'spec:',
      '  containers: []',
    ])

    const range = managedFieldsFoldRange(document)

    expect(range).not.toBeNull()
    expect(document.sliceString(range!.from, range!.to)).toContain('controller-9999')
    expect(document.sliceString(range!.from, range!.to)).not.toContain('spec:')
  })

  it('does not fold a CRD managedFields property outside object metadata', () => {
    const document = Text.of([
      'spec:',
      '  managedFields:',
      '    enabled: true',
      'metadata:',
      '  name: example',
      '  managedFields:',
      '    - manager: controller',
    ])

    const range = managedFieldsFoldRange(document)

    expect(range).not.toBeNull()
    expect(document.sliceString(range!.from, range!.to)).toContain('manager: controller')
    expect(document.sliceString(range!.from, range!.to)).not.toContain('enabled: true')
  })

  it('preserves unrelated user folds when stream updates change YAML', () => {
    const initial = [
      'metadata:',
      '  name: api',
      'spec:',
      '  containers:',
      '    - name: api',
      'status:',
      '  phase: Running',
    ].join('\n')
    let state = EditorState.create({ doc: initial, extensions: [foldGutter()] })
    const specLine = state.doc.line(3)
    const statusLine = state.doc.line(6)
    state = state.update({
      effects: foldEffect.of({ from: specLine.to, to: statusLine.from - 1 }),
    }).state

    const updated = initial.replace('Running', 'Pending')
    state = state.update({ changes: documentChange(initial, updated) }).state

    let foldCount = 0
    foldedRanges(state).between(0, state.doc.length, () => { foldCount += 1 })
    expect(foldCount).toBe(1)
  })

  it('maps the active selection through stream updates', () => {
    const initial = 'metadata:\n  name: api\nstatus:\n  phase: Running'
    const updated = 'metadata:\n  name: api\n  labels:\n    app: api\nstatus:\n  phase: Running'
    const selection = initial.indexOf('Running')
    let state = EditorState.create({ doc: initial, selection: { anchor: selection } })

    state = state.update({ changes: documentChange(initial, updated) }).state

    expect(state.selection.main.head).toBe(updated.indexOf('Running'))
  })
})
