package main

import (
	"testing"
	"time"

	corev1 "k8s.io/api/core/v1"
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
