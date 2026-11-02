package main

import (
	"encoding/json"
	"testing"
	"time"

	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/apimachinery/pkg/watch"
	dynamicfake "k8s.io/client-go/dynamic/fake"
	k8stesting "k8s.io/client-go/testing"
)

func TestWatchEntryRunListsWatchesAndStops(t *testing.T) {
	gvr := schema.GroupVersionResource{Version: "v1", Resource: "pods"}
	initial := &unstructured.Unstructured{Object: map[string]interface{}{
		"apiVersion": "v1",
		"kind":       "Pod",
		"metadata": map[string]interface{}{
			"name":      "api-1",
			"namespace": "default",
			"uid":       "pod-1",
		},
	}}
	client := dynamicfake.NewSimpleDynamicClient(runtime.NewScheme(), initial)
	watcherReady := make(chan *watch.RaceFreeFakeWatcher, 1)
	client.PrependWatchReactor("*", func(action k8stesting.Action) (bool, watch.Interface, error) {
		fakeWatcher := watch.NewRaceFreeFake()
		watcherReady <- fakeWatcher
		return true, fakeWatcher, nil
	})

	entry := &watchEntry{
		cluster:   "dev",
		resource:  "pods",
		namespace: "default",
		gvr:       gvr,
		dyn:       client,
		clients:   make(map[chan []byte]struct{}),
		cache:     make(map[string][]byte),
		stopCh:    make(chan struct{}),
		running:   true,
	}
	updates := make(chan []byte, 8)
	entry.clients[updates] = struct{}{}
	done := make(chan struct{})
	go func() {
		entry.run(entry.stopCh)
		close(done)
	}()

	if got := eventType(t, receiveUpdate(t, updates)); got != "ADDED" {
		t.Fatalf("initial event type = %q, expected ADDED", got)
	}
	if got := eventType(t, receiveUpdate(t, updates)); got != "SNAPSHOT" {
		t.Fatalf("snapshot event type = %q", got)
	}
	if got := eventType(t, receiveUpdate(t, updates)); got != "SYNCED" {
		t.Fatalf("initial sync event type = %q, expected SYNCED", got)
	}
	if _, ok := entry.cache["pod-1"]; !ok {
		t.Fatal("expected initial list object to be cached")
	}

	fakeWatcher := <-watcherReady
	modified := initial.DeepCopy()
	modified.SetResourceVersion("2")
	modified.Object["status"] = map[string]interface{}{"phase": "Running"}
	fakeWatcher.Modify(modified)
	if got := eventType(t, receiveUpdate(t, updates)); got != "MODIFIED" {
		t.Fatalf("watch event type = %q, expected MODIFIED", got)
	}
	if entry.lastRV != "2" {
		t.Fatalf("last resource version = %q, expected 2", entry.lastRV)
	}

	entry.removeClient(updates)
	close(entry.stopCh)
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("watch run did not stop after cancellation")
	}
}

func receiveUpdate(t *testing.T, updates <-chan []byte) []byte {
	t.Helper()
	select {
	case update := <-updates:
		return update
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for watch update")
		return nil
	}
}

func eventType(t *testing.T, update []byte) string {
	t.Helper()
	var event struct {
		Type string `json:"type"`
	}
	if err := json.Unmarshal(update, &event); err != nil {
		t.Fatalf("decode watch update %q: %v", update, err)
	}
	return event.Type
}

func TestPeriodicReconciliationRepairsMissedDeletion(t *testing.T) {
	testWatchReconciliation(t, false)
}

func TestReconnectReconciliationRepairsMissedDeletion(t *testing.T) {
	testWatchReconciliation(t, true)
}

func testWatchReconciliation(t *testing.T, reconnect bool) {
	t.Helper()
	gvr := schema.GroupVersionResource{Version: "v1", Resource: "pods"}
	initial := &unstructured.Unstructured{Object: map[string]interface{}{
		"apiVersion": "v1", "kind": "Pod", "metadata": map[string]interface{}{"name": "api", "namespace": "default", "uid": "pod-1"},
	}}
	client := dynamicfake.NewSimpleDynamicClient(runtime.NewScheme(), initial)
	watching := make(chan *watch.RaceFreeFakeWatcher, 4)
	client.PrependWatchReactor("*", func(k8stesting.Action) (bool, watch.Interface, error) {
		watcher := watch.NewRaceFreeFake()
		watching <- watcher
		return true, watcher, nil
	})
	ch := make(chan []byte, 16)
	entry := &watchEntry{namespace: "default", gvr: gvr, dyn: client, clients: map[chan []byte]struct{}{ch: {}}, cache: make(map[string][]byte), stopCh: make(chan struct{}), running: true, resyncInterval: 20 * time.Millisecond}
	if reconnect {
		entry.resyncInterval = time.Hour
	}
	done := make(chan struct{})
	go func() { entry.run(entry.stopCh); close(done) }()
	defer func() { entry.removeClient(ch); close(entry.stopCh); <-done }()
	watcher := <-watching
	// Remove from authoritative storage without delivering a watch event.
	if err := client.Tracker().Delete(gvr, "default", "api"); err != nil {
		t.Fatal(err)
	}
	if reconnect {
		watcher.Stop()
	}
	timeout := time.After(3 * time.Second)
	for {
		select {
		case msg := <-ch:
			var snapshot struct {
				Type    string            `json:"type"`
				Objects []json.RawMessage `json:"objects"`
			}
			if err := json.Unmarshal(msg, &snapshot); err != nil {
				t.Fatal(err)
			}
			if snapshot.Type == "SNAPSHOT" && len(snapshot.Objects) == 0 {
				return
			}
		case <-timeout:
			t.Fatal("periodic list did not repair missed deletion")
		}
	}
}

func TestListWatchHandoffUsesCollectionResourceVersion(t *testing.T) {
	gvr := schema.GroupVersionResource{Version: "v1", Resource: "pods"}
	initial := &unstructured.Unstructured{Object: map[string]interface{}{
		"apiVersion": "v1", "kind": "Pod", "metadata": map[string]interface{}{"name": "api", "namespace": "default", "uid": "pod-1", "resourceVersion": "7"},
	}}
	client := dynamicfake.NewSimpleDynamicClient(runtime.NewScheme(), initial)
	client.PrependReactor("list", "pods", func(k8stesting.Action) (bool, runtime.Object, error) {
		list := &unstructured.UnstructuredList{Items: []unstructured.Unstructured{*initial.DeepCopy()}}
		list.SetResourceVersion("42") // collection version differs from object version
		return true, list, nil
	})
	watchVersion := make(chan string, 1)
	client.PrependWatchReactor("pods", func(action k8stesting.Action) (bool, watch.Interface, error) {
		watchVersion <- action.(k8stesting.WatchAction).GetWatchRestrictions().ResourceVersion
		watcher := watch.NewRaceFreeFake()
		// The API replays a deletion occurring after the list's version,
		// even though it happened before the watch connection opened.
		deleted := initial.DeepCopy()
		deleted.SetResourceVersion("43")
		watcher.Delete(deleted)
		return true, watcher, nil
	})
	ch := make(chan []byte, 16)
	entry := &watchEntry{namespace: "default", gvr: gvr, dyn: client, clients: map[chan []byte]struct{}{ch: {}}, cache: make(map[string][]byte), stopCh: make(chan struct{}), running: true}
	done := make(chan struct{})
	go func() { entry.run(entry.stopCh); close(done) }()
	defer func() { entry.removeClient(ch); close(entry.stopCh); <-done }()
	select {
	case rv := <-watchVersion:
		if rv != "42" {
			t.Fatalf("watch resourceVersion = %q, want collection version 42", rv)
		}
	case <-time.After(time.Second):
		t.Fatal("watch did not start")
	}
	for _, expected := range []string{"ADDED", "SNAPSHOT", "SYNCED", "DELETED"} {
		if got := eventType(t, receiveUpdate(t, ch)); got != expected {
			t.Fatalf("event = %q, want %q", got, expected)
		}
	}
}
