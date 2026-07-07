import React, { useEffect, useState, useRef } from 'react'

type ContextInfo = { name: string; namespace: string }
type Envelope = { type: string; object: any }

export default function App() {
  const [contexts, setContexts] = useState<ContextInfo[]>([])
  const [ctx, setCtx] = useState<string>('')
  const [resource, setResource] = useState<string>('pods')
  const [items, setItems] = useState<Map<string, any>>(new Map())
  const esRef = useRef<EventSource | null>(null)

  useEffect(() => {
    fetch('/api/contexts').then(r => r.json()).then(setContexts).catch(console.error)
  }, [])

  useEffect(() => {
    if (!ctx) return
    // close existing
    if (esRef.current) {
      esRef.current.close()
      esRef.current = null
    }
    setItems(new Map())
    const url = `/sse/${encodeURIComponent(ctx)}/${encodeURIComponent(resource)}`
    const es = new EventSource(url)
    es.onmessage = (ev) => {
      try {
        const env: Envelope = JSON.parse(ev.data)
        if (env.type === 'ADDED' || env.type === 'MODIFIED') {
          const md = env.object.metadata || {}
          const uid = md.uid || (md.name + '/' + (md.namespace||''))
          setItems(prev => {
            const next = new Map(prev)
            next.set(uid, env.object)
            return next
          })
        } else if (env.type === 'DELETED') {
          const md = env.object.metadata || {}
          const uid = md.uid || (md.name + '/' + (md.namespace||''))
          setItems(prev => {
            const next = new Map(prev)
            next.delete(uid)
            return next
          })
        } else if (env.error) {
          console.warn('sse error', env)
        }
      } catch (e) {
        console.warn('sse parse', e)
      }
    }
    es.onerror = (e) => {
      console.warn('sse error', e)
    }
    esRef.current = es
    return () => {
      es.close()
      esRef.current = null
    }
  }, [ctx, resource])

  return (
    <div className="app">
      <header>
        <h1>kube-watch</h1>
        <div className="controls">
          <select value={ctx} onChange={e=>setCtx(e.target.value)}>
            <option value="">Select context</option>
            {contexts.map(c=> <option key={c.name} value={c.name}>{c.name} ({c.namespace})</option>)}
          </select>
          <select value={resource} onChange={e=>setResource(e.target.value)}>
            <option value="pods">pods</option>
            <option value="deployments">deployments</option>
            <option value="services">services</option>
            <option value="jobs">jobs</option>
            <option value="cronjobs">cronjobs</option>
            <option value="configmaps">configmaps</option>
            <option value="secrets">secrets</option>
            <option value="events">events</option>
          </select>
        </div>
      </header>
      <main>
        <table>
          <thead>
            <tr><th>NAME</th><th>NAMESPACE</th><th>AGE</th></tr>
          </thead>
          <tbody>
            {[...items.values()].map((o:any) => {
              const md = o.metadata || {}
              const key = md.uid || (md.name + '/' + (md.namespace||''))
              return (
                <tr key={key}>
                  <td>{md.name}</td>
                  <td>{md.namespace}</td>
                  <td>{/* TODO: compute age */}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </main>
    </div>
  )
}
