package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"sync"
	"time"

	"k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/client-go/dynamic"
	"k8s.io/client-go/tools/clientcmd"
)

// WatchManager manages shared watches per cluster+resource and broadcasts events to subscribers.
type WatchManager struct {
	loadingRules *clientcmd.ClientConfigLoadingRules
	mu           sync.Mutex
	entries      map[string]*watchEntry
}

type watchEntry struct {
	cluster   string
	resource  string
	namespace string
	gvr       schema.GroupVersionResource
	dyn       dynamic.Interface
	lastRV    string

	clients map[chan []byte]struct{}
	cache   map[string][]byte // uid -> last ADDED/MODIFIED event bytes
	stopCh  chan struct{}
	running bool
	mu      sync.Mutex
	idle    *time.Timer

	terminalError []byte
}

var syncedEvent = []byte(`{"type":"SYNCED"}`)

func NewWatchManager(loadingRules *clientcmd.ClientConfigLoadingRules) *WatchManager {
	if loadingRules == nil {
		loadingRules = clientcmd.NewDefaultClientConfigLoadingRules()
	}
	return &WatchManager{loadingRules: loadingRules, entries: make(map[string]*watchEntry)}
}

func (m *WatchManager) Subscribe(cluster string, gvr schema.GroupVersionResource) (chan []byte, func(), error) {
	e, created, err := m.getOrCreateEntry(cluster, gvr)
	if err != nil {
		return nil, nil, err
	}

	ch, unsubscribe, stopCh, shouldStart := e.subscribe(!created)
	if shouldStart {
		go e.run(stopCh)
	}
	return ch, unsubscribe, nil
}

func (m *WatchManager) getOrCreateEntry(cluster string, gvr schema.GroupVersionResource) (*watchEntry, bool, error) {
	key := watchKey(cluster, gvr)
	if e, ok := m.lookupEntry(key); ok {
		return e, false, nil
	}

	created, err := m.newEntry(cluster, gvr)
	if err != nil {
		return nil, false, err
	}

	created, stored := m.storeEntryIfAbsent(key, created)
	if stored {
		slog.Info("created cluster watch entry", "cluster", cluster, "namespace", created.namespace, "resource", gvr.Resource, "group", gvr.Group, "version", gvr.Version)
	}
	return created, stored, nil
}

func (m *WatchManager) lookupEntry(key string) (*watchEntry, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()

	e, ok := m.entries[key]
	return e, ok
}

func (m *WatchManager) storeEntryIfAbsent(key string, entry *watchEntry) (*watchEntry, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()

	if existing, ok := m.entries[key]; ok {
		return existing, false
	}
	m.entries[key] = entry
	return entry, true
}

func watchKey(cluster string, gvr schema.GroupVersionResource) string {
	return cluster + "|" + gvr.Group + "/" + gvr.Version + "/" + gvr.Resource
}

func (m *WatchManager) newEntry(cluster string, gvr schema.GroupVersionResource) (*watchEntry, error) {
	over := &clientcmd.ConfigOverrides{CurrentContext: cluster}
	clientCfg := clientcmd.NewNonInteractiveDeferredLoadingClientConfig(m.loadingRules, over)
	cfg, err := clientCfg.ClientConfig()
	if err != nil {
		slog.Error("failed to build cluster config", "cluster", cluster, "resource", gvr.Resource, "error", err)
		return nil, fmt.Errorf("failed to build config for %s: %w", cluster, err)
	}
	dyn, err := dynamic.NewForConfig(cfg)
	if err != nil {
		slog.Error("failed to create cluster client", "cluster", cluster, "resource", gvr.Resource, "error", err)
		return nil, fmt.Errorf("failed to create dynamic client: %w", err)
	}
	ns, _, nerr := clientCfg.Namespace()
	if nerr != nil || ns == "" {
		ns = "default"
	}

	return &watchEntry{
		cluster:   cluster,
		resource:  gvr.Resource,
		namespace: ns,
		gvr:       gvr,
		dyn:       dyn,
		clients:   make(map[chan []byte]struct{}),
		cache:     make(map[string][]byte),
		stopCh:    make(chan struct{}),
	}, nil
}

func (e *watchEntry) subscribe(sendSnapshot bool) (chan []byte, func(), chan struct{}, bool) {
	ch := make(chan []byte, 256)
	done := make(chan struct{})
	var once sync.Once

	cacheSnapshot, terminalError, clientCount, stopCh, shouldStart := e.addClient(ch, sendSnapshot)
	slog.Info("sse subscription opened", "cluster", e.cluster, "namespace", e.namespace, "resource", e.gvr.Resource, "clients", clientCount)
	if sendSnapshot {
		go sendInitialSnapshot(ch, done, cacheSnapshot, terminalError)
	}

	unsubscribe := func() {
		once.Do(func() {
			close(done)
			clientCount := e.removeClient(ch)
			slog.Info("sse subscription closed", "cluster", e.cluster, "namespace", e.namespace, "resource", e.gvr.Resource, "clients", clientCount)
		})
	}

	return ch, unsubscribe, stopCh, shouldStart
}

func (e *watchEntry) addClient(ch chan []byte, includeSnapshot bool) ([][]byte, []byte, int, chan struct{}, bool) {
	e.mu.Lock()
	defer e.mu.Unlock()

	e.clients[ch] = struct{}{}
	clientCount := len(e.clients)
	if e.idle != nil {
		_ = e.idle.Stop()
		e.idle = nil
	}
	shouldStart := false
	if !e.running {
		e.stopCh = make(chan struct{})
		e.running = true
		shouldStart = true
	}

	if !includeSnapshot {
		return nil, nil, clientCount, e.stopCh, shouldStart
	}

	cacheSnapshot := make([][]byte, 0, len(e.cache))
	for _, v := range e.cache {
		cacheSnapshot = append(cacheSnapshot, v)
	}
	return cacheSnapshot, e.terminalError, clientCount, e.stopCh, shouldStart
}

func (e *watchEntry) removeClient(ch chan []byte) int {
	e.mu.Lock()
	defer e.mu.Unlock()

	delete(e.clients, ch)
	clientCount := len(e.clients)
	if clientCount == 0 {
		e.idle = time.AfterFunc(30*time.Second, func() {
			e.stopIfIdle()
		})
	}
	return clientCount
}

func sendInitialSnapshot(ch chan []byte, done <-chan struct{}, cacheSnapshot [][]byte, terminalError []byte) {
	for _, v := range cacheSnapshot {
		select {
		case <-done:
			return
		case ch <- v:
		default:
		}
	}
	if terminalError != nil {
		select {
		case <-done:
			return
		case ch <- terminalError:
		default:
		}
		return
	}
	select {
	case <-done:
		return
	case ch <- syncedEvent:
	default:
	}
}

func (e *watchEntry) stop() {
	e.mu.Lock()
	defer e.mu.Unlock()

	e.stopLocked()
}

func (e *watchEntry) stopIfIdle() {
	e.mu.Lock()
	defer e.mu.Unlock()

	e.idle = nil
	if len(e.clients) > 0 {
		return
	}
	e.stopLocked()
}

func (e *watchEntry) stopLocked() {
	if !e.running {
		return
	}
	select {
	case <-e.stopCh:
		// already closed
	default:
		slog.Info("stopping cluster watch entry", "cluster", e.cluster, "namespace", e.namespace, "resource", e.gvr.Resource)
		close(e.stopCh)
	}
	e.running = false
}

func (e *watchEntry) run(stopCh chan struct{}) {
	defer e.markRunStopped(stopCh)
	res := e.dyn.Resource(e.gvr)
	ns := e.namespace
	if ns == "" {
		ns = "default"
	}
	for {
		// initial list to prime state and set resourceVersion if available (namespaced)
		ulist, err := res.Namespace(ns).List(context.Background(), metav1.ListOptions{})
		if err == nil {
			if rv := ulist.GetResourceVersion(); rv != "" {
				e.lastRV = rv
			}
			for _, item := range ulist.Items {
				b, _ := json.Marshal(map[string]interface{}{"type": "ADDED", "object": item.Object})
				e.broadcast(b)
			}
			e.broadcast(syncedEvent)
		} else {
			slog.Error("namespaced initial list failed", "cluster", e.cluster, "namespace", e.namespace, "resource", e.gvr.Resource, "error", err)
			msg := errorEvent("namespaced initial list failed", err)
			if errors.IsForbidden(err) {
				e.setTerminalError(msg)
				e.broadcast(msg)
				slog.Info("cluster watch closed", "cluster", e.cluster, "namespace", e.namespace, "resource", e.gvr.Resource, "reason", "forbidden")
				return
			}
			e.broadcast(msg)
			select {
			case <-time.After(3 * time.Second):
			case <-stopCh:
				return
			}
			continue
		}

		ctx, cancel := context.WithCancel(context.Background())
		opts := metav1.ListOptions{Watch: true}
		if e.lastRV != "" {
			opts.ResourceVersion = e.lastRV
		}
		watcher, err := res.Namespace(ns).Watch(ctx, opts)
		if err != nil {
			// log and broadcast error to clients with details
			if errors.IsForbidden(err) {
				slog.Error("namespaced watch start forbidden", "cluster", e.cluster, "namespace", e.namespace, "resource", e.gvr.Resource, "resourceVersion", opts.ResourceVersion, "error", err)
				msg := errorEvent("namespaced watch forbidden", err)
				e.setTerminalError(msg)
				e.broadcast(msg)
				cancel()
				slog.Info("cluster watch closed", "cluster", e.cluster, "namespace", e.namespace, "resource", e.gvr.Resource, "reason", "forbidden")
				return
			} else {
				if se, ok := err.(errors.APIStatus); ok {
					st := se.Status()
					// if resourceVersion is too old, clear lastRV to force a fresh list before retry
					if st.Code == 410 || st.Reason == metav1.StatusReasonExpired {
						slog.Warn("namespaced watch resourceVersion expired on start", "cluster", e.cluster, "namespace", e.namespace, "resource", e.gvr.Resource, "resourceVersion", opts.ResourceVersion, "message", st.Message)
						e.broadcast(errorMessage("namespaced watch resourceVersion expired: " + st.Message + "; re-listing"))
						// reset lastRV to force a full re-list on next loop
						e.lastRV = ""
					} else {
						slog.Error("namespaced watch start failed", "cluster", e.cluster, "namespace", e.namespace, "resource", e.gvr.Resource, "resourceVersion", opts.ResourceVersion, "message", st.Message)
						e.broadcast(errorMessage("namespaced watch failed: " + st.Message))
					}
				} else {
					slog.Error("namespaced watch start failed", "cluster", e.cluster, "namespace", e.namespace, "resource", e.gvr.Resource, "resourceVersion", opts.ResourceVersion, "error", err)
					e.broadcast(errorEvent("namespaced watch failed", err))
				}
			}
			cancel()
			// backoff
			select {
			case <-time.After(3 * time.Second):
			case <-stopCh:
				return
			}
			continue
		}
		slog.Info("cluster watch opened", "cluster", e.cluster, "namespace", e.namespace, "resource", e.gvr.Resource, "resourceVersion", opts.ResourceVersion)

		ch := watcher.ResultChan()
		running := true
		for running {
			select {
			case <-stopCh:
				running = false
				watcher.Stop()
				cancel()
				slog.Info("cluster watch closed", "cluster", e.cluster, "namespace", e.namespace, "resource", e.gvr.Resource, "reason", "stop requested")
				return
			case ev, ok := <-ch:
				if !ok {
					running = false
					watcher.Stop()
					cancel()
					slog.Warn("cluster watch channel closed", "cluster", e.cluster, "namespace", e.namespace, "resource", e.gvr.Resource)
					// will loop and recreate watch
					break
				}
				// handle error events that may indicate resourceVersion expiry (410)
				if string(ev.Type) == "ERROR" {
					if se, ok := ev.Object.(errors.APIStatus); ok {
						st := se.Status()
						if st.Code == 410 || st.Reason == metav1.StatusReasonExpired {
							slog.Warn("received watch resourceVersion expired", "cluster", e.cluster, "namespace", e.namespace, "resource", e.gvr.Resource, "message", st.Message)
							e.broadcast(errorMessage("watch resourceVersion expired: " + st.Message + "; re-listing"))
							// clear lastRV to force a fresh list on next iteration
							e.lastRV = ""
							// stop watcher and recreate by breaking out of loop
							running = false
							w := watcher
							w.Stop()
							cancel()
							slog.Info("cluster watch closed", "cluster", e.cluster, "namespace", e.namespace, "resource", e.gvr.Resource, "reason", "resourceVersion expired")
							break
						}
						// not an expiry - broadcast the status message
						b, _ := json.Marshal(map[string]interface{}{"type": ev.Type, "object": ev.Object})
						e.broadcast(b)
						continue
					} else {
						// unknown error object shape - forward it upstream
						b, _ := json.Marshal(map[string]interface{}{"type": ev.Type, "object": ev.Object})
						e.broadcast(b)
						continue
					}
				}
				// update last RV when possible
				if uo, ok := ev.Object.(*unstructured.Unstructured); ok {
					if rv := uo.GetResourceVersion(); rv != "" {
						e.lastRV = rv
					}
				}
				b, _ := json.Marshal(map[string]interface{}{"type": ev.Type, "object": ev.Object})
				e.broadcast(b)
			}
		}
		// small pause before re-establishing
		select {
		case <-time.After(1 * time.Second):
		case <-stopCh:
			return
		}
	}
}

func (e *watchEntry) markRunStopped(stopCh chan struct{}) {
	e.mu.Lock()
	defer e.mu.Unlock()

	if e.stopCh == stopCh {
		e.running = false
	}
}

// runNamespaced runs a single namespace list+watch (blocking until stop)
func (e *watchEntry) runNamespaced(ns string) error {
	res := e.dyn.Resource(e.gvr)
	for {
		ulist, err := res.Namespace(ns).List(context.Background(), metav1.ListOptions{})
		if err == nil {
			for _, item := range ulist.Items {
				b, _ := json.Marshal(map[string]interface{}{"type": "ADDED", "object": item.Object})
				e.broadcast(b)
			}
			e.broadcast(syncedEvent)
		} else {
			slog.Error("namespaced list failed", "cluster", e.cluster, "namespace", ns, "resource", e.gvr.Resource, "error", err)
			e.broadcast(errorEvent(fmt.Sprintf("namespaced list %s failed", ns), err))
			// if this namespace is forbidden, return error so caller can try others
			return err
		}

		ctx, cancel := context.WithCancel(context.Background())
		opts := metav1.ListOptions{Watch: true}
		watcher, err := res.Namespace(ns).Watch(ctx, opts)
		if err != nil {
			slog.Error("namespaced watch failed", "cluster", e.cluster, "namespace", ns, "resource", e.gvr.Resource, "error", err)
			e.broadcast(errorEvent(fmt.Sprintf("namespaced watch %s failed", ns), err))
			cancel()
			select {
			case <-time.After(3 * time.Second):
			case <-e.stopCh:
				return nil
			}
			continue
		}
		slog.Info("cluster watch opened", "cluster", e.cluster, "namespace", ns, "resource", e.gvr.Resource)

		ch := watcher.ResultChan()
		for {
			select {
			case <-e.stopCh:
				watcher.Stop()
				cancel()
				slog.Info("cluster watch closed", "cluster", e.cluster, "namespace", ns, "resource", e.gvr.Resource, "reason", "stop requested")
				return nil
			case ev, ok := <-ch:
				if !ok {
					watcher.Stop()
					cancel()
					slog.Warn("cluster watch channel closed", "cluster", e.cluster, "namespace", ns, "resource", e.gvr.Resource)
					break
				}
				// handle ERROR events signaling resourceVersion expiry
				if string(ev.Type) == "ERROR" {
					if se, ok := ev.Object.(errors.APIStatus); ok {
						st := se.Status()
						if st.Code == 410 || st.Reason == metav1.StatusReasonExpired {
							slog.Warn("received watch resourceVersion expired", "cluster", e.cluster, "namespace", ns, "resource", e.gvr.Resource, "message", st.Message)
							e.broadcast(errorMessage(fmt.Sprintf("watch resourceVersion expired for %s: %s; re-listing", ns, st.Message)))
							e.lastRV = ""
							w := watcher
							w.Stop()
							cancel()
							break
						}
					}
					b, _ := json.Marshal(map[string]interface{}{"type": ev.Type, "object": ev.Object})
					e.broadcast(b)
					continue
				}
				if uo, ok := ev.Object.(*unstructured.Unstructured); ok {
					if rv := uo.GetResourceVersion(); rv != "" {
						e.lastRV = rv
					}
				}
				b, _ := json.Marshal(map[string]interface{}{"type": ev.Type, "object": ev.Object})
				e.broadcast(b)
			}
		}
		select {
		case <-time.After(1 * time.Second):
		case <-e.stopCh:
			return nil
		}
	}
}

// runNamespacedMultiple runs watches for multiple namespaces concurrently
func (e *watchEntry) runNamespacedMultiple(names []string) error {
	// limit to first 10
	if len(names) > 10 {
		names = names[:10]
	}
	slog.Info("starting namespaced watchers", "cluster", e.cluster, "resource", e.gvr.Resource, "namespaces", names)
	var wg sync.WaitGroup
	for _, ns := range names {
		wg.Add(1)
		ns := ns
		go func() {
			defer wg.Done()
			_ = e.runNamespaced(ns)
		}()
	}
	// wait until stop requested
	<-e.stopCh
	wg.Wait()
	return nil
}

func (e *watchEntry) setTerminalError(msg []byte) {
	e.mu.Lock()
	defer e.mu.Unlock()

	e.terminalError = msg
}

func errorEvent(prefix string, err error) []byte {
	return errorMessage(prefix + ": " + err.Error())
}

func errorMessage(message string) []byte {
	b, err := json.Marshal(map[string]string{"error": message})
	if err != nil {
		return []byte(`{"error":"failed to encode error message"}`)
	}
	return b
}

func (e *watchEntry) broadcast(msg []byte) {
	// attempt to update cache based on event type and object's uid
	var envelope struct {
		Type   string                 `json:"type"`
		Object map[string]interface{} `json:"object"`
	}
	if err := json.Unmarshal(msg, &envelope); err == nil {
		uid := ""
		if md, ok := envelope.Object["metadata"].(map[string]interface{}); ok {
			if u, ok := md["uid"].(string); ok && u != "" {
				uid = u
			} else if n, nok := md["name"].(string); nok {
				ns := ""
				if nsval, nsok := md["namespace"].(string); nsok {
					ns = nsval
				}
				uid = n + "/" + ns
			}
		}
		switch envelope.Type {
		case "DELETED":
			if uid != "" {
				e.deleteCached(uid)
			}
		case "ADDED", "MODIFIED":
			if uid != "" {
				e.setCached(uid, msg)
			}
		}
	}

	// broadcast to clients
	e.mu.Lock()
	defer e.mu.Unlock()
	for ch := range e.clients {
		select {
		case ch <- msg:
		default:
			// drop if the client is slow
		}
	}
}

func (e *watchEntry) setCached(uid string, msg []byte) {
	e.mu.Lock()
	defer e.mu.Unlock()

	e.cache[uid] = msg
}

func (e *watchEntry) deleteCached(uid string) {
	e.mu.Lock()
	defer e.mu.Unlock()

	delete(e.cache, uid)
}
