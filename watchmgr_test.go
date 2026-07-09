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

func TestSubscribeUnsubscribeDoesNotCloseSnapshotChannel(t *testing.T) {
	gvr := schema.GroupVersionResource{Version: "v1", Resource: "pods"}
	entry := &watchEntry{
		cluster:   "dev",
		namespace: "default",
		gvr:       gvr,
		clients:   make(map[chan []byte]struct{}),
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
