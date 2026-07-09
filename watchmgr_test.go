package main

import (
	"encoding/json"
	"errors"
	"testing"
	"time"

	"k8s.io/apimachinery/pkg/runtime/schema"
)

func TestBroadcastCachesAddedModifiedAndDeletesByUID(t *testing.T) {
	entry := &watchEntry{
		clients: make(map[chan []byte]struct{}),
		cache:   make(map[string][]byte),
	}

	added := []byte(`{"type":"ADDED","object":{"metadata":{"uid":"pod-1","name":"api","namespace":"default"}}}`)
	entry.broadcast(added)
	if got := string(entry.cache["pod-1"]); got != string(added) {
		t.Fatalf("cache after add = %q, expected %q", got, added)
	}

	modified := []byte(`{"type":"MODIFIED","object":{"metadata":{"uid":"pod-1","name":"api","namespace":"default"},"status":{"phase":"Running"}}}`)
	entry.broadcast(modified)
	if got := string(entry.cache["pod-1"]); got != string(modified) {
		t.Fatalf("cache after modify = %q, expected %q", got, modified)
	}

	entry.broadcast([]byte(`{"type":"DELETED","object":{"metadata":{"uid":"pod-1","name":"api","namespace":"default"}}}`))
	if _, ok := entry.cache["pod-1"]; ok {
		t.Fatal("expected deleted object to be removed from cache")
	}
}

func TestBroadcastCachesObjectsWithoutUIDByNameNamespace(t *testing.T) {
	entry := &watchEntry{
		clients: make(map[chan []byte]struct{}),
		cache:   make(map[string][]byte),
	}

	msg := []byte(`{"type":"ADDED","object":{"metadata":{"name":"api","namespace":"default"}}}`)
	entry.broadcast(msg)

	if got := string(entry.cache["api/default"]); got != string(msg) {
		t.Fatalf("cache fallback key = %q, expected %q", got, msg)
	}
}

func TestDeleteMissingCachedReturnsDeletionEvents(t *testing.T) {
	entry := &watchEntry{
		clients: make(map[chan []byte]struct{}),
		cache: map[string][]byte{
			"pod-1": []byte(`{"type":"ADDED","object":{"metadata":{"uid":"pod-1","name":"api","namespace":"default"}}}`),
			"pod-2": []byte(`{"type":"ADDED","object":{"metadata":{"uid":"pod-2","name":"worker","namespace":"default"}}}`),
		},
	}

	deleted := entry.deleteMissingCached(map[string]struct{}{"pod-2": {}})

	if len(deleted) != 1 {
		t.Fatalf("deleted events = %d, expected 1", len(deleted))
	}
	var envelope struct {
		Type   string `json:"type"`
		Object struct {
			Metadata struct {
				UID string `json:"uid"`
			} `json:"metadata"`
		} `json:"object"`
	}
	if err := json.Unmarshal(deleted[0], &envelope); err != nil {
		t.Fatalf("deleted event should be JSON: %v", err)
	}
	if envelope.Type != "DELETED" || envelope.Object.Metadata.UID != "pod-1" {
		t.Fatalf("deleted envelope = %#v", envelope)
	}
	if _, ok := entry.cache["pod-1"]; ok {
		t.Fatal("expected missing pod to be removed from cache")
	}
	if _, ok := entry.cache["pod-2"]; !ok {
		t.Fatal("expected current pod to remain cached")
	}
}

func TestErrorEventEscapesJSON(t *testing.T) {
	msg := errorEvent("failed", errors.New(`bad "quote"`))

	var envelope map[string]string
	if err := json.Unmarshal(msg, &envelope); err != nil {
		t.Fatalf("error event should be valid JSON: %v; payload=%s", err, msg)
	}
	if envelope["error"] != `failed: bad "quote"` {
		t.Fatalf("error = %q", envelope["error"])
	}
}

func TestClearTerminalErrorRemovesStaleError(t *testing.T) {
	entry := &watchEntry{terminalError: []byte(`{"error":"forbidden"}`)}

	entry.clearTerminalError()

	if entry.terminalError != nil {
		t.Fatalf("terminalError = %s, expected nil", entry.terminalError)
	}
}

func TestSubscribeUnsubscribeDoesNotCloseSnapshotChannel(t *testing.T) {
	gvr := schema.GroupVersionResource{Version: "v1", Resource: "pods"}
	entry := &watchEntry{
		cluster:   "dev",
		namespace: "default",
		gvr:       gvr,
		clients:   make(map[chan []byte]struct{}),
		running:   true,
		cache: map[string][]byte{
			"pod-1": []byte(`{"type":"ADDED","object":{"metadata":{"uid":"pod-1","name":"api","namespace":"default"}}}`),
		},
		stopCh: make(chan struct{}),
	}

	manager := &WatchManager{
		entries: map[string]*watchEntry{
			"dev|/v1/pods": entry,
		},
	}

	ch, unsubscribe, err := manager.Subscribe("dev", gvr)
	if err != nil {
		t.Fatalf("subscribe: %v", err)
	}
	unsubscribe()

	select {
	case _, ok := <-ch:
		if !ok {
			t.Fatal("unsubscribe closed subscriber channel; snapshot sender can panic when racing with disconnect")
		}
	case <-time.After(100 * time.Millisecond):
	}
}

func TestSendInitialSnapshotWaitsForSlowConsumers(t *testing.T) {
	ch := make(chan []byte)
	done := make(chan struct{})
	snapshot := [][]byte{[]byte(`{"type":"ADDED","object":{"metadata":{"uid":"pod-1"}}}`)}
	finished := make(chan struct{})

	go func() {
		sendInitialSnapshot(ch, done, snapshot, nil)
		close(finished)
	}()

	select {
	case <-finished:
		t.Fatal("snapshot sender finished before consumer received the item")
	case <-time.After(20 * time.Millisecond):
	}

	if got := <-ch; string(got) != string(snapshot[0]) {
		t.Fatalf("snapshot item = %s", got)
	}
	if got := <-ch; string(got) != string(syncedEvent) {
		t.Fatalf("sync item = %s", got)
	}
	select {
	case <-finished:
	case <-time.After(100 * time.Millisecond):
		t.Fatal("snapshot sender did not finish after consumer drained items")
	}
}

func TestSubscriptionBufferIncludesSnapshotCapacity(t *testing.T) {
	entry := &watchEntry{
		cache: map[string][]byte{
			"pod-1": []byte(`{"type":"ADDED","object":{"metadata":{"uid":"pod-1"}}}`),
			"pod-2": []byte(`{"type":"ADDED","object":{"metadata":{"uid":"pod-2"}}}`),
		},
	}

	if got := entry.subscriptionBuffer(true); got != 258 {
		t.Fatalf("snapshot subscription buffer = %d, expected 258", got)
	}
	if got := entry.subscriptionBuffer(false); got != 256 {
		t.Fatalf("non-snapshot subscription buffer = %d, expected 256", got)
	}
}

func TestStopIfIdleDoesNotStopWhenClientReconnected(t *testing.T) {
	stopCh := make(chan struct{})
	client := make(chan []byte, 1)
	entry := &watchEntry{
		cluster:   "dev",
		namespace: "default",
		gvr:       schema.GroupVersionResource{Version: "v1", Resource: "pods"},
		clients: map[chan []byte]struct{}{
			client: {},
		},
		stopCh:  stopCh,
		running: true,
	}

	entry.stopIfIdle()

	if !entry.running {
		t.Fatal("expected watcher to remain running with an active client")
	}
	select {
	case <-stopCh:
		t.Fatal("expected stop channel to remain open with an active client")
	default:
	}
}

func TestAddClientRestartsStoppedEntry(t *testing.T) {
	oldStopCh := make(chan struct{})
	close(oldStopCh)
	entry := &watchEntry{
		cluster:   "dev",
		namespace: "default",
		gvr:       schema.GroupVersionResource{Version: "v1", Resource: "pods"},
		clients:   make(map[chan []byte]struct{}),
		stopCh:    oldStopCh,
		running:   false,
	}

	_, _, clientCount, newStopCh, shouldStart := entry.addClient(make(chan []byte, 1), false)

	if clientCount != 1 {
		t.Fatalf("client count = %d, expected 1", clientCount)
	}
	if !shouldStart {
		t.Fatal("expected stopped entry to request a watch restart")
	}
	if !entry.running {
		t.Fatal("expected entry to be marked running after restart")
	}
	if newStopCh == oldStopCh {
		t.Fatal("expected restart to use a fresh stop channel")
	}
	select {
	case <-newStopCh:
		t.Fatal("expected fresh stop channel to be open")
	default:
	}
}

func TestAddClientDoesNotRestartWhilePreviousRunIsStopping(t *testing.T) {
	oldStopCh := make(chan struct{})
	entry := &watchEntry{
		cluster:   "dev",
		namespace: "default",
		gvr:       schema.GroupVersionResource{Version: "v1", Resource: "pods"},
		clients:   make(map[chan []byte]struct{}),
		stopCh:    oldStopCh,
		running:   true,
	}

	entry.stop()
	_, _, _, newStopCh, shouldStart := entry.addClient(make(chan []byte, 1), false)

	if shouldStart {
		t.Fatal("expected no restart until previous run marks itself stopped")
	}
	if newStopCh != oldStopCh {
		t.Fatal("expected stop channel to remain unchanged while previous run is stopping")
	}
	restartStopCh, restart := entry.markRunStopped(oldStopCh)
	if !restart {
		t.Fatal("expected restart when previous run stops with active clients")
	}
	if restartStopCh == oldStopCh {
		t.Fatal("expected fresh stop channel for restarted run")
	}
	_, _, _, restartedStopCh, shouldStart := entry.addClient(make(chan []byte, 1), false)
	if shouldStart {
		t.Fatal("expected no extra restart after handoff restart was requested")
	}
	if restartedStopCh != restartStopCh {
		t.Fatal("expected subscribers after handoff to use restarted stop channel")
	}
}

func TestTerminalRunExitDoesNotRestartWithActiveClients(t *testing.T) {
	stopCh := make(chan struct{})
	entry := &watchEntry{
		cluster:   "dev",
		namespace: "default",
		gvr:       schema.GroupVersionResource{Version: "v1", Resource: "pods"},
		clients:   map[chan []byte]struct{}{make(chan []byte, 1): {}},
		stopCh:    stopCh,
		running:   true,
	}

	restartStopCh, restart := entry.markRunStopped(stopCh)
	if restart {
		t.Fatal("expected terminal run exit to stay stopped without handoff restart")
	}
	if restartStopCh != nil {
		t.Fatal("expected no restart stop channel for terminal run exit")
	}
	if entry.running {
		t.Fatal("expected entry to be marked stopped after terminal run exit")
	}
}
