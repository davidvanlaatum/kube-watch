package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
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
	kubeconfigPath string
	mu             sync.Mutex
	entries        map[string]*watchEntry
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
	mu      sync.Mutex
	idle    *time.Timer
}

func NewWatchManager(kubeconfigPath string) *WatchManager {
	return &WatchManager{kubeconfigPath: kubeconfigPath, entries: make(map[string]*watchEntry)}
}

func (m *WatchManager) Subscribe(cluster string, gvr schema.GroupVersionResource) (chan []byte, func(), error) {
	key := cluster + "|" + gvr.Group + "/" + gvr.Version + "/" + gvr.Resource
	m.mu.Lock()
	e, ok := m.entries[key]
	if !ok {
		// create entry
		// build a client config loader so we can extract the default namespace for this context
		rules := &clientcmd.ClientConfigLoadingRules{ExplicitPath: m.kubeconfigPath}
		over := &clientcmd.ConfigOverrides{CurrentContext: cluster}
		clientCfg := clientcmd.NewNonInteractiveDeferredLoadingClientConfig(rules, over)
		cfg, err := clientCfg.ClientConfig()
		if err != nil {
			m.mu.Unlock()
			return nil, nil, fmt.Errorf("failed to build config for %s: %w", cluster, err)
		}
		dyn, err := dynamic.NewForConfig(cfg)
		if err != nil {
			m.mu.Unlock()
			return nil, nil, fmt.Errorf("failed to create dynamic client: %w", err)
		}
		ns, _, nerr := clientCfg.Namespace()
		if nerr != nil || ns == "" {
			ns = "default"
		}
		e = &watchEntry{
			cluster:   cluster,
			resource:  gvr.Resource,
			namespace: ns,
			gvr:       gvr,
			dyn:       dyn,
			clients:   make(map[chan []byte]struct{}),
			cache:     make(map[string][]byte),
			stopCh:    make(chan struct{}),
		}
		m.entries[key] = e
		// add subscriber channel before starting run to avoid race
		m.mu.Unlock()
		ch := make(chan []byte, 256)
		e.mu.Lock()
		e.clients[ch] = struct{}{}
		if e.idle != nil {
			_ = e.idle.Stop()
			e.idle = nil
		}
		e.mu.Unlock()
		go e.run(m.kubeconfigPath)
		// return subscription
		unsubscribe := func() {
			e.mu.Lock()
			delete(e.clients, ch)
			close(ch)
			if len(e.clients) == 0 {
				e.idle = time.AfterFunc(30*time.Second, func() { e.stop() })
			}
			e.mu.Unlock()
		}
		return ch, unsubscribe, nil
	} else {
		m.mu.Unlock()
	}

	// add subscriber (existing entry)
	ch := make(chan []byte, 256)
	e.mu.Lock()
	e.clients[ch] = struct{}{}
	// stop idle timer if running
	if e.idle != nil {
		_ = e.idle.Stop()
		e.idle = nil
	}
	// send cached snapshot to new subscriber
	cacheSnapshot := make([][]byte, 0, len(e.cache))
	for _, v := range e.cache {
		cacheSnapshot = append(cacheSnapshot, v)
	}
	e.mu.Unlock()
	go func() {
		// send cached entries (non-blocking per item)
		for _, v := range cacheSnapshot {
			select {
			case ch <- v:
			default:
			}
		}
	}()

	unsubscribe := func() {
		e.mu.Lock()
		delete(e.clients, ch)
		close(ch)
		// if no clients, start idle timer to stop watch
		if len(e.clients) == 0 {
			e.idle = time.AfterFunc(30*time.Second, func() {
				e.stop()
			})
		}
		e.mu.Unlock()
	}

	return ch, unsubscribe, nil
}

func (e *watchEntry) stop() {
	e.mu.Lock()
	select {
	case <-e.stopCh:
		// already closed
	default:
		close(e.stopCh)
	}
	e.mu.Unlock()
}

func (e *watchEntry) run(kubeconfigPath string) {
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
		} else {
			log.Printf("[%s][%s][%s] namespaced initial list failed: %v", e.cluster, e.namespace, e.gvr.Resource, err)
			// notify clients of list error and backoff
			e.broadcast([]byte(fmt.Sprintf(`{"error":"namespaced initial list failed: %s"}`, err.Error())))
			select {
			case <-time.After(3 * time.Second):
			case <-e.stopCh:
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
				log.Printf("[%s][%s][%s] namespaced watch start forbidden (rv=%s): %v", e.cluster, e.namespace, e.gvr.Resource, opts.ResourceVersion, err)
				e.broadcast([]byte(fmt.Sprintf(`{"error":"namespaced watch forbidden: %s"}`, err.Error())))
			} else {
				if se, ok := err.(errors.APIStatus); ok {
					st := se.Status()
					// if resourceVersion is too old, clear lastRV to force a fresh list before retry
					if st.Code == 410 || st.Reason == metav1.StatusReasonExpired {
						log.Printf("[%s][%s][%s] namespaced watch start returned 410/Expired (rv=%s): %s; will re-list", e.cluster, e.namespace, e.gvr.Resource, opts.ResourceVersion, st.Message)
						e.broadcast([]byte(fmt.Sprintf(`{"error":"namespaced watch resourceVersion expired: %s; re-listing"}`, st.Message)))
						// reset lastRV to force a full re-list on next loop
						e.lastRV = ""
					} else {
						log.Printf("[%s][%s][%s] namespaced watch start failed (rv=%s): %s", e.cluster, e.namespace, e.gvr.Resource, opts.ResourceVersion, st.Message)
						e.broadcast([]byte(fmt.Sprintf(`{"error":"namespaced watch failed: %s"}`, st.Message)))
					}
				} else {
					log.Printf("[%s][%s][%s] namespaced watch start failed (rv=%s): %v", e.cluster, e.namespace, e.gvr.Resource, opts.ResourceVersion, err)
					e.broadcast([]byte(fmt.Sprintf(`{"error":"namespaced watch failed: %s"}`, err.Error())))
				}
			}
			cancel()
			// backoff
			select {
			case <-time.After(3 * time.Second):
			case <-e.stopCh:
				return
			}
			continue
		}

		ch := watcher.ResultChan()
		running := true
		for running {
			select {
			case <-e.stopCh:
				running = false
				watcher.Stop()
				cancel()
				return
			case ev, ok := <-ch:
				if !ok {
					running = false
					watcher.Stop()
					cancel()
					log.Printf("[%s][%s][%s] namespaced watch channel closed, will recreate", e.cluster, e.namespace, e.gvr.Resource)
					// will loop and recreate watch
					break
				}
				// handle error events that may indicate resourceVersion expiry (410)
				if string(ev.Type) == "ERROR" {
					if se, ok := ev.Object.(errors.APIStatus); ok {
						st := se.Status()
						if st.Code == 410 || st.Reason == metav1.StatusReasonExpired {
							log.Printf("[%s][%s][%s] received watch ERROR 410/Expired: %s; will re-list", e.cluster, e.namespace, e.gvr.Resource, st.Message)
							e.broadcast([]byte(fmt.Sprintf(`{"error":"watch resourceVersion expired: %s; re-listing"}`, st.Message)))
							// clear lastRV to force a fresh list on next iteration
							e.lastRV = ""
							// stop watcher and recreate by breaking out of loop
							running = false
							w := watcher
							w.Stop()
							cancel()
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
		case <-e.stopCh:
			return
		}
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
		} else {
			log.Printf("[%s][%s] namespaced list %s failed: %v", e.cluster, e.gvr.Resource, ns, err)
			e.broadcast([]byte(fmt.Sprintf(`{"error":"namespaced list %s failed: %s"}`, ns, err.Error())))
			// if this namespace is forbidden, return error so caller can try others
			return err
		}

		ctx, cancel := context.WithCancel(context.Background())
		opts := metav1.ListOptions{Watch: true}
		watcher, err := res.Namespace(ns).Watch(ctx, opts)
		if err != nil {
			log.Printf("[%s][%s] namespaced watch %s failed: %v", e.cluster, e.gvr.Resource, ns, err)
			e.broadcast([]byte(fmt.Sprintf(`{"error":"namespaced watch %s failed: %s"}`, ns, err.Error())))
			cancel()
			select {
			case <-time.After(3 * time.Second):
			case <-e.stopCh:
				return nil
			}
			continue
		}

		ch := watcher.ResultChan()
		for {
			select {
			case <-e.stopCh:
				watcher.Stop()
				cancel()
				return nil
			case ev, ok := <-ch:
				if !ok {
					watcher.Stop()
					cancel()
					break
				}
				// handle ERROR events signaling resourceVersion expiry
				if string(ev.Type) == "ERROR" {
					if se, ok := ev.Object.(errors.APIStatus); ok {
						st := se.Status()
						if st.Code == 410 || st.Reason == metav1.StatusReasonExpired {
							log.Printf("[%s][%s] received watch ERROR 410/Expired for %s: %s; will re-list", e.cluster, ns, e.gvr.Resource, st.Message)
							e.broadcast([]byte(fmt.Sprintf(`{"error":"watch resourceVersion expired for %s: %s; re-listing"}`, ns, st.Message)))
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
	log.Printf("[%s][%s] starting namespaced watchers for: %v", e.cluster, e.gvr.Resource, names)
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
				e.mu.Lock()
				delete(e.cache, uid)
				e.mu.Unlock()
			}
		case "ADDED", "MODIFIED":
			if uid != "" {
				e.mu.Lock()
				e.cache[uid] = msg
				e.mu.Unlock()
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
