package main

import (
	"fmt"
	"strings"
	"testing"
	"time"

	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/apimachinery/pkg/watch"
	dynamicfake "k8s.io/client-go/dynamic/fake"
	k8stesting "k8s.io/client-go/testing"
)

func TestWatchFailuresReportErrorsAndStop(t *testing.T) {
	for _, tc := range []struct {
		name, verb, text string
		err              error
		terminal         bool
	}{
		{"list forbidden", "list", "namespaced initial list failed", apierrors.NewForbidden(schema.GroupResource{Resource: "pods"}, "", fmt.Errorf("denied")), true},
		{"list unavailable", "list", "namespaced initial list failed", fmt.Errorf("offline"), false},
		{"watch forbidden", "watch", "namespaced watch forbidden", apierrors.NewForbidden(schema.GroupResource{Resource: "pods"}, "", fmt.Errorf("denied")), true},
		{"watch expired", "watch", "resourceVersion expired", apierrors.NewResourceExpired("old cursor"), false},
		{"watch status error", "watch", "namespaced watch failed", apierrors.NewServiceUnavailable("busy"), false},
		{"watch transport error", "watch", "namespaced watch failed", fmt.Errorf("offline"), false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			gvr := supportedResources["pods"]
			client := dynamicfake.NewSimpleDynamicClientWithCustomListKinds(runtime.NewScheme(), map[schema.GroupVersionResource]string{gvr: "PodList"})
			if tc.verb == "list" {
				client.PrependReactor("list", "pods", func(k8stesting.Action) (bool, runtime.Object, error) { return true, nil, tc.err })
			} else {
				client.PrependWatchReactor("pods", func(k8stesting.Action) (bool, watch.Interface, error) { return true, nil, tc.err })
			}
			entry := &watchEntry{resource: "pods", gvr: gvr, dyn: client, clients: make(map[chan []byte]struct{}), cache: make(map[string][]byte), stopCh: make(chan struct{}), running: true}
			updates := make(chan []byte, 16)
			entry.clients[updates] = struct{}{}
			done := make(chan struct{})
			go func() { defer close(done); entry.run(entry.stopCh) }()
			defer func() {
				entry.removeClient(updates)
				close(entry.stopCh)
				select {
				case <-done:
				case <-time.After(3 * time.Second):
					t.Error("watch worker leaked")
				}
				entry.mu.Lock()
				if entry.idle != nil {
					entry.idle.Stop()
				}
				entry.mu.Unlock()
			}()
			deadline := time.After(3 * time.Second)
			for {
				select {
				case msg := <-updates:
					if !strings.Contains(string(msg), tc.text) {
						continue
					}
					if tc.terminal {
						select {
						case <-done:
						case <-deadline:
							t.Fatal("forbidden watch did not terminate")
						}
						entry.mu.Lock()
						cached := string(entry.terminalError)
						entry.mu.Unlock()
						if !strings.Contains(cached, tc.text) {
							t.Fatalf("terminal error not retained: %s", cached)
						}
					}
					return
				case <-deadline:
					t.Fatal("missing expected error")
				}
			}
		})
	}
}

func TestWatchErrorEventsAreForwardedAndExpiryStopsOldWatch(t *testing.T) {
	gvr := supportedResources["pods"]
	client := dynamicfake.NewSimpleDynamicClientWithCustomListKinds(runtime.NewScheme(), map[schema.GroupVersionResource]string{gvr: "PodList"})
	ready := make(chan *watch.RaceFreeFakeWatcher, 2)
	client.PrependWatchReactor("pods", func(k8stesting.Action) (bool, watch.Interface, error) {
		w := watch.NewRaceFreeFake()
		ready <- w
		return true, w, nil
	})
	entry := &watchEntry{namespace: "team", gvr: gvr, dyn: client, clients: make(map[chan []byte]struct{}), cache: make(map[string][]byte), stopCh: make(chan struct{}), running: true}
	updates := make(chan []byte, 16)
	entry.clients[updates] = struct{}{}
	done := make(chan struct{})
	go func() { defer close(done); entry.run(entry.stopCh) }()
	defer func() {
		entry.removeClient(updates)
		close(entry.stopCh)
		select {
		case <-done:
		case <-time.After(3 * time.Second):
			t.Error("watch leaked")
		}
		entry.mu.Lock()
		if entry.idle != nil {
			entry.idle.Stop()
		}
		entry.mu.Unlock()
	}()
	if eventType(t, receiveBehaviorUpdate(t, updates)) != "SNAPSHOT" || eventType(t, receiveBehaviorUpdate(t, updates)) != "SYNCED" {
		t.Fatal("missing initial snapshot")
	}
	watcher := receiveWatcher(t, ready)
	watcher.Error(&metav1.Status{Code: 500, Message: "temporary"})
	if msg := receiveBehaviorUpdate(t, updates); eventType(t, msg) != "ERROR" || !strings.Contains(string(msg), "temporary") {
		t.Fatalf("status not forwarded: %s", msg)
	}
	watcher.Error(&unstructured.Unstructured{Object: map[string]interface{}{"unexpected": "shape"}})
	if msg := receiveBehaviorUpdate(t, updates); eventType(t, msg) != "ERROR" || !strings.Contains(string(msg), "unexpected") {
		t.Fatalf("unknown error not forwarded: %s", msg)
	}
	watcher.Error(&metav1.Status{Code: 410, Reason: metav1.StatusReasonExpired, Message: "old cursor"})
	if msg := receiveBehaviorUpdate(t, updates); !strings.Contains(string(msg), "re-listing") {
		t.Fatalf("expiry not reported: %s", msg)
	}
	// The next snapshot establishes that the old watch was stopped and a fresh list ran.
	if eventType(t, receiveBehaviorUpdate(t, updates)) != "SNAPSHOT" {
		t.Fatal("missing recovery snapshot")
	}
	if !watcher.IsStopped() {
		t.Fatal("expired watch still running")
	}
}
