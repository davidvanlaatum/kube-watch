package main

import (
	"testing"
	"time"

	"k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/apimachinery/pkg/watch"
	dynamicfake "k8s.io/client-go/dynamic/fake"
	k8stesting "k8s.io/client-go/testing"
)

func TestHelmEntryWatchStorageRequestsRefreshOnHelmSecret(t *testing.T) {
	gvr := schema.GroupVersionResource{Version: "v1", Resource: "secrets"}
	client := dynamicfake.NewSimpleDynamicClientWithCustomListKinds(runtime.NewScheme(), map[schema.GroupVersionResource]string{
		gvr: "SecretList",
	})
	watcherReady := make(chan *watch.RaceFreeFakeWatcher, 1)
	client.PrependWatchReactor("*", func(action k8stesting.Action) (bool, watch.Interface, error) {
		fakeWatcher := watch.NewRaceFreeFake()
		watcherReady <- fakeWatcher
		return true, fakeWatcher, nil
	})

	entry := newTestHelmEntry()
	entry.dyn = client
	stopCh := make(chan struct{})
	refresh := make(chan struct{}, 4)

	go entry.watchStorage(stopCh, gvr, refresh)

	drainRefresh(t, refresh) // initial refresh request before watch starts

	fakeWatcher := <-watcherReady
	secret := &unstructured.Unstructured{Object: map[string]interface{}{
		"apiVersion": "v1",
		"kind":       "Secret",
		"metadata": map[string]interface{}{
			"name":      "sh.helm.release.v1.api.v1",
			"namespace": "default",
			"labels":    map[string]interface{}{"owner": "helm", "name": "api"},
		},
		"type": "helm.sh/release.v1",
	}}
	fakeWatcher.Add(secret)

	drainRefresh(t, refresh)

	close(stopCh)
}

func drainRefresh(t *testing.T, refresh <-chan struct{}) {
	t.Helper()
	select {
	case <-refresh:
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for refresh request")
	}
}

func TestHelmEntryWatchStorageStopsOnForbiddenList(t *testing.T) {
	gvr := schema.GroupVersionResource{Version: "v1", Resource: "configmaps"}
	client := dynamicfake.NewSimpleDynamicClientWithCustomListKinds(runtime.NewScheme(), map[schema.GroupVersionResource]string{
		gvr: "ConfigMapList",
	})
	client.PrependReactor("list", "configmaps", func(action k8stesting.Action) (bool, runtime.Object, error) {
		return true, nil, errors.NewForbidden(schema.GroupResource{Resource: "configmaps"}, "", nil)
	})

	entry := newTestHelmEntry()
	entry.dyn = client
	stopCh := make(chan struct{})
	refresh := make(chan struct{}, 4)

	done := make(chan struct{})
	go func() {
		entry.watchStorage(stopCh, gvr, refresh)
		close(done)
	}()

	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("expected watchStorage to return after forbidden list error")
	}

	if terminal, ok := entry.storageTerminalError("configmaps"); !ok || terminal.skipList != true {
		t.Fatalf("terminal error = %#v, ok=%v; expected skipList=true", terminal, ok)
	}
}

func TestHelmEntryConsumeStorageEventsHandlesExpiryAndErrors(t *testing.T) {
	entry := newTestHelmEntry()
	stopCh := make(chan struct{})
	refresh := make(chan struct{}, 4)
	fakeWatcher := watch.NewRaceFreeFake()
	ctx, cancel := contextForStop(stopCh)

	done := make(chan bool, 1)
	go func() {
		done <- entry.consumeStorageEvents(stopCh, fakeWatcher, cancel, refresh)
	}()

	fakeWatcher.Error(&metav1.Status{Code: 410, Reason: metav1.StatusReasonExpired, Message: "too old"})

	select {
	case shouldContinue := <-done:
		if !shouldContinue {
			t.Fatal("expected consumeStorageEvents to signal a retry (true) on resourceVersion expiry")
		}
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for consumeStorageEvents to return")
	}
	_ = ctx
}
