package main

import (
	"testing"
	"time"
)

func newTestHelmEntry() *helmEntry {
	return &helmEntry{
		cluster:               "dev",
		namespace:             "default",
		clients:               make(map[chan []byte]struct{}),
		cache:                 make(map[string][]byte),
		objects:               make(map[string][]byte),
		stopCh:                make(chan struct{}),
		storageTerminalErrors: make(map[string]storageTerminalError),
	}
}

func TestHelmEntrySubscribeStartsRunOnlyOnce(t *testing.T) {
	entry := newTestHelmEntry()

	ch1, unsubscribe1, stopCh1, shouldStart1 := entry.subscribe(false)
	if !shouldStart1 {
		t.Fatal("first subscribe should request run start")
	}
	ch2, unsubscribe2, stopCh2, shouldStart2 := entry.subscribe(false)
	if shouldStart2 {
		t.Fatal("second subscribe should not request another run start")
	}
	if stopCh1 != stopCh2 {
		t.Fatal("both subscribers should share the same stop channel")
	}
	if len(entry.clients) != 2 {
		t.Fatalf("clients = %d, want 2", len(entry.clients))
	}

	unsubscribe1()
	if len(entry.clients) != 1 {
		t.Fatalf("clients after first unsubscribe = %d, want 1", len(entry.clients))
	}
	unsubscribe1() // idempotent
	if len(entry.clients) != 1 {
		t.Fatalf("clients after repeat unsubscribe = %d, want 1", len(entry.clients))
	}

	unsubscribe2()
	if len(entry.clients) != 0 {
		t.Fatalf("clients after all unsubscribed = %d, want 0", len(entry.clients))
	}
	if entry.idle == nil {
		t.Fatal("expected idle timer to be armed once clients drop to zero")
	}
	_ = ch1
	_ = ch2
}

func TestHelmEntrySubscribeSendsSnapshotAndTerminalError(t *testing.T) {
	entry := newTestHelmEntry()
	entry.cache["k1"] = []byte(`{"type":"ADDED","object":{"metadata":{"uid":"k1"}}}`)
	entry.terminalError = []byte(`{"error":"boom"}`)

	ch, unsubscribe, _, _ := entry.subscribe(true)
	defer unsubscribe()

	select {
	case msg := <-ch:
		if string(msg) != string(entry.cache["k1"]) {
			t.Fatalf("first message = %s, want cache snapshot", msg)
		}
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for cache snapshot")
	}
	select {
	case msg := <-ch:
		if string(msg) != `{"error":"boom"}` {
			t.Fatalf("second message = %s, want terminal error", msg)
		}
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for terminal error")
	}
}

func TestHelmEntryStopIfIdleStopsOnlyWhenNoClients(t *testing.T) {
	entry := newTestHelmEntry()
	entry.running = true
	ch := make(chan []byte, 1)
	entry.clients[ch] = struct{}{}

	entry.stopIfIdle()
	select {
	case <-entry.stopCh:
		t.Fatal("entry should not stop while clients remain")
	default:
	}

	delete(entry.clients, ch)
	entry.stopIfIdle()
	select {
	case <-entry.stopCh:
	default:
		t.Fatal("expected entry to stop once idle with no clients")
	}
}

func TestHelmEntryMarkRunStoppedRestartsWhenClientsRemain(t *testing.T) {
	entry := newTestHelmEntry()
	entry.running = true
	stopCh := entry.stopCh
	close(stopCh)
	entry.clients[make(chan []byte, 1)] = struct{}{}

	restartStopCh, restart := entry.markRunStopped(stopCh)
	if !restart {
		t.Fatal("expected restart when clients remain and stopCh was closed")
	}
	if restartStopCh == stopCh {
		t.Fatal("expected a fresh stop channel on restart")
	}
	if !entry.running {
		t.Fatal("expected entry to be marked running again")
	}
}

func TestHelmEntryMarkRunStoppedNoRestartForStaleStopCh(t *testing.T) {
	entry := newTestHelmEntry()
	entry.running = true
	staleStopCh := make(chan struct{})

	_, restart := entry.markRunStopped(staleStopCh)
	if restart {
		t.Fatal("mismatched stop channel should not trigger restart")
	}
}

func TestHelmEntryRequestRefreshIsNonBlocking(t *testing.T) {
	entry := newTestHelmEntry()
	refresh := make(chan struct{}, 1)

	entry.requestRefresh(refresh)
	entry.requestRefresh(refresh) // second call should not block even though buffer is full

	select {
	case <-refresh:
	default:
		t.Fatal("expected a refresh signal to be queued")
	}
}
