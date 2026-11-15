package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	appsv1 "k8s.io/api/apps/v1"
	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/apimachinery/pkg/watch"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/kubernetes/fake"
	"k8s.io/client-go/rest"
	k8stesting "k8s.io/client-go/testing"
)

func TestDeploymentLogsRelistAfterExpiryAndStopOnCancellation(t *testing.T) {
	deployment := &appsv1.Deployment{ObjectMeta: metav1.ObjectMeta{Name: "api", Namespace: "team"}, Spec: appsv1.DeploymentSpec{Selector: &metav1.LabelSelector{MatchLabels: map[string]string{"app": "api"}}}}
	client := fake.NewSimpleClientset(deployment)
	var lists atomic.Int32
	client.PrependReactor("list", "pods", func(action k8stesting.Action) (bool, runtime.Object, error) {
		if action.GetNamespace() != "team" || action.(k8stesting.ListAction).GetListRestrictions().Labels.String() != "app=api" {
			t.Errorf("wrong list scope: %+v", action)
		}
		n := lists.Add(1)
		return true, &corev1.PodList{ListMeta: metav1.ListMeta{ResourceVersion: fmt.Sprint(n)}}, nil
	})
	ready := make(chan *watch.RaceFreeFakeWatcher, 4)
	client.PrependWatchReactor("pods", func(action k8stesting.Action) (bool, watch.Interface, error) {
		if action.GetNamespace() != "team" || action.(k8stesting.WatchAction).GetWatchRestrictions().ResourceVersion != fmt.Sprint(lists.Load()) {
			t.Errorf("wrong watch scope or resourceVersion: %+v", action)
		}
		watcher := watch.NewRaceFreeFake()
		ready <- watcher
		return true, watcher, nil
	})
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	out := make(chan []byte, 64)
	done := make(chan struct{})
	go func() { defer close(done); (&LogManager{}).streamDeployment(ctx, client, "team", "api", 10, out) }()
	defer func() {
		cancel()
		select {
		case <-done:
		case <-time.After(3 * time.Second):
			t.Error("deployment stream leaked")
		}
	}()
	waitLog(t, out, func(e logEnvelope) bool { return strings.Contains(e.Info, "across 0 current pod(s)") })
	first := receiveWatcher(t, ready)
	pod := &corev1.Pod{ObjectMeta: metav1.ObjectMeta{Name: "api-1", Namespace: "team"}}
	first.Add(pod)
	waitLog(t, out, func(e logEnvelope) bool { return e.Info == "pod has no containers" })
	// Deleted/terminating pods must not start new log followers.
	terminating := pod.DeepCopy()
	now := metav1.Now()
	terminating.DeletionTimestamp = &now
	first.Modify(terminating)
	first.Delete(pod)
	first.Error(&metav1.Status{Code: 500, Message: "temporary watch error"})
	event := decodeLogEnvelope(t, receiveBehaviorUpdate(t, out))
	if !strings.Contains(event.Error, "temporary watch error") {
		t.Fatalf("terminating/deleted pod unexpectedly started a follower: %+v", event)
	}
	first.Error(&metav1.Status{Code: 410, Reason: metav1.StatusReasonExpired})
	waitLog(t, out, func(e logEnvelope) bool { return strings.Contains(e.Info, "re-listing") })
	second := receiveWatcher(t, ready)
	if lists.Load() != 2 || !first.IsStopped() {
		t.Fatal("expired watch was not replaced by a fresh list/watch")
	}
	cancel()
	select {
	case <-done:
	case <-time.After(3 * time.Second):
		t.Fatal("deployment stream did not stop")
	}
	if !second.IsStopped() {
		t.Fatal("watch not stopped on cancellation")
	}
}

func receiveWatcher(t *testing.T, ch <-chan *watch.RaceFreeFakeWatcher) *watch.RaceFreeFakeWatcher {
	t.Helper()
	select {
	case w := <-ch:
		return w
	case <-time.After(4 * time.Second):
		t.Fatal("watch did not start")
		return nil
	}
}
func waitLog(t *testing.T, ch <-chan []byte, match func(logEnvelope) bool) logEnvelope {
	t.Helper()
	deadline := time.After(4 * time.Second)
	for {
		select {
		case msg, ok := <-ch:
			if !ok {
				t.Fatal("log stream closed before expected event")
			}
			e := decodeLogEnvelope(t, msg)
			if match(e) {
				return e
			}
		case <-deadline:
			t.Fatal("expected log event not received")
			return logEnvelope{}
		}
	}
}

func TestDeploymentLogFailuresAreReportedAndCancelable(t *testing.T) {
	for _, failure := range []string{"get", "selector", "list", "watch"} {
		t.Run(failure, func(t *testing.T) {
			dep := &appsv1.Deployment{ObjectMeta: metav1.ObjectMeta{Name: "api", Namespace: "team"}, Spec: appsv1.DeploymentSpec{Selector: &metav1.LabelSelector{MatchLabels: map[string]string{"app": "api"}}}}
			if failure == "selector" {
				dep.Spec.Selector.MatchExpressions = []metav1.LabelSelectorRequirement{{Key: "app", Operator: "invalid"}}
			}
			client := fake.NewSimpleClientset(dep)
			if failure != "selector" {
				resource := "pods"
				verb := failure
				if failure == "get" {
					resource = "deployments"
				}
				if failure == "watch" {
					client.PrependWatchReactor("pods", func(k8stesting.Action) (bool, watch.Interface, error) {
						return true, nil, fmt.Errorf("watch unavailable")
					})
				} else {
					client.PrependReactor(verb, resource, func(k8stesting.Action) (bool, runtime.Object, error) {
						return true, nil, fmt.Errorf("%s unavailable", failure)
					})
				}
			}
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			out := make(chan []byte, 8)
			done := make(chan struct{})
			go func() { defer close(done); (&LogManager{}).streamDeployment(ctx, client, "team", "api", 10, out) }()
			waitLog(t, out, func(e logEnvelope) bool { return e.Type == "ERROR" })
			cancel()
			select {
			case <-done:
			case <-time.After(3 * time.Second):
				t.Fatal("error path did not stop")
			}
		})
	}
}

func TestFollowContainerLogsResumesAfterLastTimestamp(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	requests := make(chan string, 4)
	var count atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests <- r.URL.Query().Get("sinceTime")
		if r.URL.Path != "/api/v1/namespaces/team/pods/api/log" || r.URL.Query().Get("container") != "app" || r.URL.Query().Get("follow") != "true" || r.URL.Query().Get("tailLines") != "0" {
			t.Errorf("wrong follow request: %s", r.URL)
		}
		if count.Add(1) == 1 {
			w.Write([]byte("2026-11-15T00:00:01Z first line\n"))
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusNotFound)
		json.NewEncoder(w).Encode(metav1.Status{TypeMeta: metav1.TypeMeta{Kind: "Status", APIVersion: "v1"}, Status: "Failure", Reason: metav1.StatusReasonNotFound, Code: 404, Message: "pod removed"})
	}))
	defer server.Close()
	client, err := kubernetes.NewForConfig(&rest.Config{Host: server.URL})
	if err != nil {
		t.Fatal(err)
	}
	out := make(chan []byte, 8)
	done := make(chan struct{})
	go func() {
		defer close(done)
		followContainerLogs(ctx, client, "team", "api", "app", time.Date(2026, 11, 15, 0, 0, 0, 0, time.UTC), out)
	}()
	line := waitLog(t, out, func(e logEnvelope) bool { return e.Type == "LOG" })
	if line.Line != "first line" || line.Pod != "api" || line.Container != "app" {
		t.Fatalf("log: %+v", line)
	}
	waitLog(t, out, func(e logEnvelope) bool { return strings.Contains(e.Error, "pod removed") })
	select {
	case <-done:
	case <-time.After(4 * time.Second):
		t.Fatal("404 must stop following")
	}
	first, second := <-requests, <-requests
	// Kubernetes serializes sinceTime at second precision. It must advance past the old cursor.
	if first != "2026-11-15T00:00:00Z" || second != "2026-11-15T00:00:01Z" {
		t.Fatalf("resume cursors %q then %q", first, second)
	}
}

func TestDeploymentLogSubscriptionClosesWhenTargetMissing(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(404)
		json.NewEncoder(w).Encode(apierrors.NewNotFound(schema.GroupResource{Group: "apps", Resource: "deployments"}, "api").ErrStatus)
	}))
	defer server.Close()
	ch, unsub, err := NewLogManager(testClusterRules(t, server.URL, "team")).Subscribe("dev/cluster", "deployments", "team", "api", 10)
	if err != nil {
		t.Fatal(err)
	}
	defer unsub()
	e := decodeLogEnvelope(t, receiveBehaviorUpdate(t, ch))
	if !strings.Contains(e.Error, "deployment logs target") {
		t.Fatalf("message %+v", e)
	}
	select {
	case _, ok := <-ch:
		if ok {
			t.Fatal("stream not closed")
		}
	case <-time.After(3 * time.Second):
		t.Fatal("stream leaked")
	}
}
