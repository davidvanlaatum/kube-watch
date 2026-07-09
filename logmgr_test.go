package main

import (
	"context"
	"encoding/json"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

func TestPodContainerNamesIncludesAllContainerTypesOnce(t *testing.T) {
	pod := &corev1.Pod{
		Spec: corev1.PodSpec{
			InitContainers: []corev1.Container{{Name: "setup"}},
			Containers:     []corev1.Container{{Name: "app"}, {Name: "sidecar"}},
			EphemeralContainers: []corev1.EphemeralContainer{
				{EphemeralContainerCommon: corev1.EphemeralContainerCommon{Name: "debug"}},
				{EphemeralContainerCommon: corev1.EphemeralContainerCommon{Name: "app"}},
			},
		},
	}

	names := podContainerNames(pod)

	expected := []string{"setup", "app", "sidecar", "debug"}
	if len(names) != len(expected) {
		t.Fatalf("names = %#v, expected %#v", names, expected)
	}
	for i := range expected {
		if names[i] != expected[i] {
			t.Fatalf("name %d = %q, expected %q", i, names[i], expected[i])
		}
	}
}

func TestPodFollowContainerNamesExcludesInitContainers(t *testing.T) {
	pod := &corev1.Pod{
		Spec: corev1.PodSpec{
			InitContainers: []corev1.Container{{Name: "setup"}},
			Containers:     []corev1.Container{{Name: "app"}},
			EphemeralContainers: []corev1.EphemeralContainer{
				{EphemeralContainerCommon: corev1.EphemeralContainerCommon{Name: "debug"}},
			},
		},
	}

	names := podFollowContainerNames(pod)

	expected := []string{"app", "debug"}
	if len(names) != len(expected) {
		t.Fatalf("names = %#v, expected %#v", names, expected)
	}
	for i := range expected {
		if names[i] != expected[i] {
			t.Fatalf("name %d = %q, expected %q", i, names[i], expected[i])
		}
	}
}

func TestParseLogLineExtractsTimestampPrefix(t *testing.T) {
	line := parseLogLine("api-123", "app", "2026-07-08T01:02:03.000000004Z started server")

	if line.Pod != "api-123" || line.Container != "app" || line.Line != "started server" {
		t.Fatalf("line = %#v", line)
	}
	if line.Time != "2026-07-08T01:02:03.000000004Z" {
		t.Fatalf("time = %q", line.Time)
	}
}

func TestSortLogLinesOrdersByTimestampThenPodContainer(t *testing.T) {
	lines := []logLine{
		{Pod: "pod-b", Container: "app", Timestamp: time.Date(2026, 7, 8, 0, 0, 2, 0, time.UTC)},
		{Pod: "pod-b", Container: "sidecar", Timestamp: time.Date(2026, 7, 8, 0, 0, 1, 0, time.UTC)},
		{Pod: "pod-a", Container: "app", Timestamp: time.Date(2026, 7, 8, 0, 0, 1, 0, time.UTC)},
	}

	sortLogLines(lines)

	got := []string{
		lines[0].Pod + "/" + lines[0].Container,
		lines[1].Pod + "/" + lines[1].Container,
		lines[2].Pod + "/" + lines[2].Container,
	}
	expected := []string{"pod-a/app", "pod-b/sidecar", "pod-b/app"}
	for i := range expected {
		if got[i] != expected[i] {
			t.Fatalf("order = %#v, expected %#v", got, expected)
		}
		if lines[i].Seq != int64(i) {
			t.Fatalf("seq %d = %d", i, lines[i].Seq)
		}
	}
}

func TestScanLogLinesAcceptsLargeKubernetesLogLines(t *testing.T) {
	longLine := strings.Repeat("x", 128*1024)
	lines, err := scanLogLines(strings.NewReader("2026-07-08T01:02:03Z "+longLine+"\n"), "api-123", "app")
	if err != nil {
		t.Fatalf("scan large log line: %v", err)
	}
	if len(lines) != 1 {
		t.Fatalf("lines = %d, expected 1", len(lines))
	}
	if lines[0].Line != longLine {
		t.Fatalf("large line length = %d, expected %d", len(lines[0].Line), len(longLine))
	}
}

func TestWatchErrorStatusHandlesMetav1Status(t *testing.T) {
	status, ok := watchErrorStatus(&metav1.Status{Code: 410, Reason: metav1.StatusReasonExpired, Message: "too old"})
	if !ok {
		t.Fatal("expected metav1.Status to be recognized")
	}
	if status.Code != 410 || status.Reason != metav1.StatusReasonExpired {
		t.Fatalf("status = %#v", status)
	}
}

func TestScanFollowLogStreamAssignsMonotonicSeq(t *testing.T) {
	out := make(chan []byte, 2)
	stream := strings.NewReader("2026-07-08T01:02:03Z repeated\n2026-07-08T01:02:03Z repeated\n")

	_, err := scanFollowLogStream(context.Background(), stream, "api-123", "app", out)
	if err != nil {
		t.Fatalf("scan follow stream: %v", err)
	}

	first := decodeLogEnvelope(t, <-out)
	second := decodeLogEnvelope(t, <-out)
	if first.Seq != 0 || second.Seq != 1 {
		t.Fatalf("seq values = %d, %d; expected 0, 1", first.Seq, second.Seq)
	}
}

func decodeLogEnvelope(t *testing.T, data []byte) logEnvelope {
	t.Helper()
	var envelope logEnvelope
	if err := json.Unmarshal(data, &envelope); err != nil {
		t.Fatalf("decode log envelope: %v", err)
	}
	return envelope
}

func TestPodLogStreamCleanupDoesNotRemoveNewerStream(t *testing.T) {
	streams := &podLogStreams{cancels: make(map[string]podLogCancel)}
	firstCancelCalled := atomic.Bool{}
	secondCancelCalled := atomic.Bool{}

	streams.cancels["api"] = podLogCancel{id: 1, cancel: func() { firstCancelCalled.Store(true) }}
	streams.nextID = 1
	staleCleanupID := uint64(1)
	streams.stop("api")
	streams.mu.Lock()
	streams.nextID++
	newID := streams.nextID
	streams.cancels["api"] = podLogCancel{id: newID, cancel: func() { secondCancelCalled.Store(true) }}
	streams.mu.Unlock()

	streams.finish("api", staleCleanupID)
	streams.mu.Lock()
	_, stillTracked := streams.cancels["api"]
	streams.mu.Unlock()

	if !firstCancelCalled.Load() {
		t.Fatal("expected old stream to be cancelled")
	}
	if secondCancelCalled.Load() {
		t.Fatal("newer stream should not be cancelled")
	}
	if !stillTracked {
		t.Fatal("stale cleanup removed newer stream")
	}
}

func TestSleepOrDoneReturnsFalseWhenContextCancelled(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	if sleepOrDone(ctx, time.Hour) {
		t.Fatal("expected cancelled context to stop sleep")
	}
}
