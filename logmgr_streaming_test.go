package main

import (
	"context"
	"testing"
	"time"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/kubernetes/fake"
	"k8s.io/client-go/tools/clientcmd"
)

func TestNewLogManagerDefaultsLoadingRules(t *testing.T) {
	m := NewLogManager(nil)
	if m.loadingRules == nil {
		t.Fatal("expected default loading rules to be set")
	}

	custom := clientcmd.NewDefaultClientConfigLoadingRules()
	m2 := NewLogManager(custom)
	if m2.loadingRules != custom {
		t.Fatal("expected provided loading rules to be used")
	}
}

func TestSendLogErrorAndInfoEnvelopes(t *testing.T) {
	out := make(chan []byte, 2)
	sendLogError(context.Background(), out, "boom")
	sendLogInfo(context.Background(), out, "hello")

	errEnvelope := decodeLogEnvelope(t, <-out)
	if errEnvelope.Type != "ERROR" || errEnvelope.Error != "boom" {
		t.Fatalf("error envelope = %#v", errEnvelope)
	}
	infoEnvelope := decodeLogEnvelope(t, <-out)
	if infoEnvelope.Type != "INFO" || infoEnvelope.Info != "hello" {
		t.Fatalf("info envelope = %#v", infoEnvelope)
	}
}

func TestStreamPodLogsSendsInitialLogsThenFollowsUntilCancelled(t *testing.T) {
	pod := &corev1.Pod{
		ObjectMeta: metav1.ObjectMeta{Name: "api-1", Namespace: "default"},
		Spec:       corev1.PodSpec{Containers: []corev1.Container{{Name: "app"}}},
	}
	client := fake.NewSimpleClientset(pod)
	ctx, cancel := context.WithCancel(context.Background())
	out := make(chan []byte, 32)

	done := make(chan struct{})
	go func() {
		streamPodLogs(ctx, client, pod, 10, out)
		close(done)
	}()

	sawInitialLine := false
	sawFollowingInfo := false
	deadline := time.After(2 * time.Second)
	for !sawFollowingInfo {
		select {
		case msg := <-out:
			envelope := decodeLogEnvelope(t, msg)
			if envelope.Type == "LOG" && envelope.Line == "fake logs" {
				sawInitialLine = true
			}
			if envelope.Type == "INFO" && envelope.Info == "following logs for pod api-1" {
				sawFollowingInfo = true
			}
		case <-deadline:
			t.Fatal("timed out waiting for expected log stream events")
		}
	}
	if !sawInitialLine {
		t.Fatal("expected at least one initial log line before following")
	}

	cancel()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("streamPodLogs did not stop after context cancellation")
	}
}

func TestStreamPodLogsReportsNoContainers(t *testing.T) {
	pod := &corev1.Pod{ObjectMeta: metav1.ObjectMeta{Name: "empty", Namespace: "default"}}
	out := make(chan []byte, 2)

	streamPodLogs(context.Background(), fake.NewSimpleClientset(), pod, 10, out)

	envelope := decodeLogEnvelope(t, <-out)
	if envelope.Type != "INFO" || envelope.Info != "pod has no containers" {
		t.Fatalf("envelope = %#v", envelope)
	}
}

func TestLogManagerStreamPodSendsErrorWhenPodMissing(t *testing.T) {
	m := &LogManager{}
	client := fake.NewSimpleClientset()
	out := make(chan []byte, 2)

	m.streamPod(context.Background(), client, "default", "missing", 10, out)

	envelope := decodeLogEnvelope(t, <-out)
	if envelope.Type != "ERROR" {
		t.Fatalf("envelope = %#v, expected ERROR", envelope)
	}
}

func TestPodLogStreamsStartStopMissingAndStopAll(t *testing.T) {
	pod1 := &corev1.Pod{
		ObjectMeta: metav1.ObjectMeta{Name: "pod-1", Namespace: "default"},
		Spec:       corev1.PodSpec{Containers: []corev1.Container{{Name: "app"}}},
	}
	pod2 := &corev1.Pod{
		ObjectMeta: metav1.ObjectMeta{Name: "pod-2", Namespace: "default"},
		Spec:       corev1.PodSpec{Containers: []corev1.Container{{Name: "app"}}},
	}
	client := fake.NewSimpleClientset(pod1, pod2)
	out := make(chan []byte, 64)
	streams := &podLogStreams{cancels: make(map[string]podLogCancel)}

	ctx := context.Background()
	streams.start(ctx, client, pod1, 5, out)
	streams.start(ctx, client, pod1, 5, out) // duplicate start should be a no-op
	streams.start(ctx, client, pod2, 5, out)

	streams.mu.Lock()
	trackedCount := len(streams.cancels)
	streams.mu.Unlock()
	if trackedCount != 2 {
		t.Fatalf("tracked streams = %d, want 2", trackedCount)
	}

	streams.stopMissing(map[string]struct{}{"pod-1": {}})
	streams.mu.Lock()
	_, pod2Tracked := streams.cancels["pod-2"]
	_, pod1Tracked := streams.cancels["pod-1"]
	streams.mu.Unlock()
	if pod2Tracked {
		t.Fatal("expected pod-2 stream to be stopped by stopMissing")
	}
	if !pod1Tracked {
		t.Fatal("expected pod-1 stream to remain tracked")
	}

	streams.stopAll()
	streams.mu.Lock()
	remaining := len(streams.cancels)
	streams.mu.Unlock()
	if remaining != 0 {
		t.Fatalf("remaining streams after stopAll = %d, want 0", remaining)
	}
}

func TestLogManagerStreamPodObjectReportsNoContainers(t *testing.T) {
	m := &LogManager{}
	pod := &corev1.Pod{ObjectMeta: metav1.ObjectMeta{Name: "empty", Namespace: "default"}}
	out := make(chan []byte, 2)

	m.streamPodObject(context.Background(), fake.NewSimpleClientset(), pod, 10, out)

	envelope := decodeLogEnvelope(t, <-out)
	if envelope.Type != "INFO" || envelope.Info != "pod has no containers" {
		t.Fatalf("envelope = %#v", envelope)
	}
}

func TestWatchErrorStatusRejectsUnrecognizedObject(t *testing.T) {
	if _, ok := watchErrorStatus("not a status"); ok {
		t.Fatal("expected unrecognized object to return ok=false")
	}
}
