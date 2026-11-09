package main

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/client-go/dynamic"
	"k8s.io/client-go/rest"
)

func TestPodMetricsHandlerListsOnlyConfiguredNamespaceAndAggregatesContainers(t *testing.T) {
	list := &unstructured.UnstructuredList{
		Object: map[string]interface{}{
			"apiVersion": "metrics.k8s.io/v1beta1",
			"kind":       "PodMetricsList",
		},
		Items: []unstructured.Unstructured{
			podMetricObject("api", "team-a", "2026-11-06T06:00:00Z",
				containerUsage("250m", "128Mi"),
				containerUsage("75m", "10Ki")),
			podMetricObject("worker", "team-a", "2026-11-06T06:00:15Z",
				containerUsage("1", "1Gi")),
			podMetricObject("outside", "team-b", "2026-11-06T06:00:15Z",
				containerUsage("1", "1Gi")),
		},
	}
	requestPath := make(chan string, 1)
	apiServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requestPath <- r.URL.Path
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(list)
	}))
	defer apiServer.Close()
	client, err := dynamic.NewForConfig(&rest.Config{Host: apiServer.URL})
	if err != nil {
		t.Fatalf("create dynamic client: %v", err)
	}
	manager := &podMetricsManager{
		clients: map[string]podMetricsContextClient{
			"dev": {namespace: "team-a", client: client},
		},
	}

	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodGet, "/api/pod-metrics/dev", nil)
	newPodMetricsHandler(manager).ServeHTTP(recorder, request)

	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", recorder.Code, recorder.Body.String())
	}
	if want, got := "/apis/metrics.k8s.io/v1beta1/namespaces/team-a/pods", <-requestPath; got != want {
		t.Fatalf("metrics API path = %q, want namespace-scoped path %q", got, want)
	}
	if got := recorder.Header().Get("Content-Type"); got != "application/json" {
		t.Fatalf("content type = %q", got)
	}
	var response podMetricsSnapshot
	if err := json.NewDecoder(recorder.Body).Decode(&response); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if response.Namespace != "team-a" {
		t.Fatalf("namespace = %q, want team-a", response.Namespace)
	}
	if response.RetrievedAt.IsZero() {
		t.Fatal("expected a response retrieval timestamp")
	}
	if len(response.Pods) != 2 || response.Pods[0].Name != "api" || response.Pods[1].Name != "worker" {
		t.Fatalf("pods = %#v, warnings = %#v, want sorted api and worker metrics", response.Pods, response.Warnings)
	}
	if response.Pods[0].CPUMilliCores == nil || response.Pods[0].MemoryBytes == nil || response.Pods[0].Timestamp == nil {
		t.Fatalf("api sample is missing a complete CPU, memory, or timestamp value: %#v", response.Pods[0])
	}
	if got, want := *response.Pods[0].CPUMilliCores, int64(325); got != want {
		t.Fatalf("api CPU = %dm, want %dm", got, want)
	}
	if got, want := *response.Pods[0].MemoryBytes, int64(128*1024*1024+10*1024); got != want {
		t.Fatalf("api memory = %d bytes, want %d", got, want)
	}
	if got, want := response.Pods[0].Timestamp.UTC().Format(time.RFC3339), "2026-11-06T06:00:00Z"; got != want {
		t.Fatalf("api timestamp = %q, want %q", got, want)
	}
}

func TestAggregatePodMetricsMarksIncompleteValuesUnavailable(t *testing.T) {
	list := &unstructured.UnstructuredList{
		Items: []unstructured.Unstructured{
			podMetricObject("partial", "team-a", "not-a-timestamp",
				containerUsage("200m", "20Mi"),
				containerUsage("invalid", "10Mi")),
			podMetricObject("missing", "team-a", "2026-11-06T06:00:15Z"),
			podMetricObject("foreign", "team-b", "2026-11-06T06:00:15Z",
				containerUsage("1", "1Gi")),
		},
	}

	response := aggregatePodMetrics("team-a", list)

	if len(response.Pods) != 2 {
		t.Fatalf("pods = %#v, want only the two metrics in team-a", response.Pods)
	}
	if response.Pods[0].Name != "missing" || response.Pods[1].Name != "partial" {
		t.Fatalf("pods are not sorted: %#v", response.Pods)
	}
	if response.Pods[0].CPUMilliCores != nil || response.Pods[0].MemoryBytes != nil {
		t.Fatalf("missing-container values = %#v, want unavailable values", response.Pods[0])
	}
	if response.Pods[1].CPUMilliCores != nil {
		t.Fatalf("partial CPU = %v, want unavailable instead of a partial sum", response.Pods[1].CPUMilliCores)
	}
	if response.Pods[1].MemoryBytes == nil {
		t.Fatalf("partial memory = nil, want available memory to be retained")
	}
	if got, want := *response.Pods[1].MemoryBytes, int64(30*1024*1024); got != want {
		t.Fatalf("partial memory = %d bytes, want %d", got, want)
	}
	if response.Pods[1].Timestamp != nil {
		t.Fatalf("invalid timestamp = %v, want nil", response.Pods[1].Timestamp)
	}
	joinedWarnings := strings.Join(response.Warnings, " ")
	for _, expected := range []string{"outside the configured namespace", "no valid metrics timestamp", "CPU usage is incomplete", "Memory usage is incomplete"} {
		if !strings.Contains(joinedWarnings, expected) {
			t.Errorf("warnings %q do not include %q", joinedWarnings, expected)
		}
	}
}

func TestAggregatePodMetricsSumsQuantitiesBeforeConversion(t *testing.T) {
	list := &unstructured.UnstructuredList{
		Items: []unstructured.Unstructured{
			podMetricObject("sub-millicore", "team-a", "2026-11-06T06:00:00Z",
				containerUsage("400000n", "1Ki"),
				containerUsage("400000n", "2Ki")),
			podMetricObject("units", "team-a", "2026-11-06T06:00:15Z",
				containerUsage("1.5", "1Gi"),
				containerUsage("250m", "1.5Ki"),
				containerUsage("250m", "1G")),
		},
	}

	response := aggregatePodMetrics("team-a", list)

	if len(response.Pods) != 2 {
		t.Fatalf("pods = %#v, want both aggregated metrics", response.Pods)
	}
	if got, want := response.Pods[0].Name, "sub-millicore"; got != want {
		t.Fatalf("first pod = %q, want %q", got, want)
	}
	if got, want := response.Pods[0].CPUMilliCores, int64(1); got == nil || *got != want {
		t.Fatalf("sub-millicore CPU = %v, want %dm after summing quantities", got, want)
	}
	if got, want := response.Pods[0].MemoryBytes, int64(3*1024); got == nil || *got != want {
		t.Fatalf("binary memory = %v, want %d bytes", got, want)
	}
	if got, want := response.Pods[1].CPUMilliCores, int64(2000); got == nil || *got != want {
		t.Fatalf("unit CPU = %v, want %dm", got, want)
	}
	if got, want := response.Pods[1].MemoryBytes, int64(1024*1024*1024+1536+1_000_000_000); got == nil || *got != want {
		t.Fatalf("unit memory = %v, want %d bytes", got, want)
	}
}

func TestAggregatePodMetricsMarksInt64OverflowUnavailable(t *testing.T) {
	list := &unstructured.UnstructuredList{
		Items: []unstructured.Unstructured{
			podMetricObject("cpu-overflow", "team-a", "2026-11-06T06:00:00Z",
				containerUsage("9223372036854776", "1"),
				containerUsage("1", "1")),
			podMetricObject("memory-overflow", "team-a", "2026-11-06T06:00:15Z",
				containerUsage("1", "9223372036854775807"),
				containerUsage("1", "1")),
		},
	}

	response := aggregatePodMetrics("team-a", list)

	if len(response.Pods) != 2 {
		t.Fatalf("pods = %#v, want both overflow cases", response.Pods)
	}
	if got := response.Pods[0].CPUMilliCores; got != nil {
		t.Fatalf("overflow CPU = %v, want unavailable", *got)
	}
	if got := response.Pods[0].MemoryBytes; got == nil || *got != 2 {
		t.Fatalf("non-overflow memory = %v, want 2 bytes", got)
	}
	if got := response.Pods[1].CPUMilliCores; got == nil || *got != 2000 {
		t.Fatalf("non-overflow CPU = %v, want 2000m", got)
	}
	if got := response.Pods[1].MemoryBytes; got != nil {
		t.Fatalf("overflow memory = %v, want unavailable", *got)
	}
}

func TestPodMetricsHandlerDecodesContextAndValidatesRequests(t *testing.T) {
	var requestedContext string
	source := podMetricsSourceFunc(func(_ context.Context, contextName string) (podMetricsSnapshot, error) {
		requestedContext = contextName
		return podMetricsSnapshot{Namespace: "default", Pods: []podMetric{}, Warnings: []string{}}, nil
	})
	handler := newPodMetricsHandler(source)

	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodGet, "/api/pod-metrics/dev%2Fcluster", nil)
	handler.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusOK {
		t.Fatalf("encoded context status = %d, body = %s", recorder.Code, recorder.Body.String())
	}
	if requestedContext != "dev/cluster" {
		t.Fatalf("context passed to source = %q, want dev/cluster", requestedContext)
	}

	recorder = httptest.NewRecorder()
	request = httptest.NewRequest(http.MethodPost, "/api/pod-metrics/dev", nil)
	handler.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusMethodNotAllowed || recorder.Header().Get("Allow") != http.MethodGet {
		t.Fatalf("POST status/Allow = %d/%q, want 405/GET", recorder.Code, recorder.Header().Get("Allow"))
	}

	recorder = httptest.NewRecorder()
	request = httptest.NewRequest(http.MethodGet, "/api/pod-metrics/", nil)
	handler.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("missing context status = %d, want 400", recorder.Code)
	}
}

func TestPodMetricsHandlerSurfacesRBACAndUnavailableMetricsServerErrors(t *testing.T) {
	cases := []struct {
		name        string
		err         error
		status      int
		messagePart string
	}{
		{
			name:        "forbidden",
			err:         apierrors.NewForbidden(podMetricsGVR.GroupResource(), "default", errors.New("forbidden")),
			status:      http.StatusForbidden,
			messagePart: "pods.metrics.k8s.io",
		},
		{
			name:        "metrics API missing",
			err:         apierrors.NewNotFound(podMetricsGVR.GroupResource(), "pods"),
			status:      http.StatusServiceUnavailable,
			messagePart: "metrics-server",
		},
		{
			name:        "request timeout",
			err:         context.DeadlineExceeded,
			status:      http.StatusGatewayTimeout,
			messagePart: "Timed out",
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			source := podMetricsSourceFunc(func(context.Context, string) (podMetricsSnapshot, error) {
				return podMetricsSnapshot{}, tc.err
			})
			recorder := httptest.NewRecorder()
			request := httptest.NewRequest(http.MethodGet, "/api/pod-metrics/dev", nil)
			newPodMetricsHandler(source).ServeHTTP(recorder, request)
			if recorder.Code != tc.status {
				t.Fatalf("status = %d, want %d; body = %s", recorder.Code, tc.status, recorder.Body.String())
			}
			if !strings.Contains(recorder.Body.String(), tc.messagePart) {
				t.Fatalf("body %q does not include %q", recorder.Body.String(), tc.messagePart)
			}
		})
	}
}

func TestPodMetricsHandlerPropagatesRequestCancellation(t *testing.T) {
	started := make(chan struct{})
	source := podMetricsSourceFunc(func(ctx context.Context, _ string) (podMetricsSnapshot, error) {
		close(started)
		<-ctx.Done()
		return podMetricsSnapshot{}, ctx.Err()
	})

	ctx, cancel := context.WithCancel(context.Background())
	request := httptest.NewRequest(http.MethodGet, "/api/pod-metrics/dev", nil).WithContext(ctx)
	recorder := httptest.NewRecorder()
	done := make(chan struct{})
	go func() {
		newPodMetricsHandler(source).ServeHTTP(recorder, request)
		close(done)
	}()

	<-started
	cancel()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("handler did not return after request cancellation")
	}
	if recorder.Body.Len() != 0 {
		t.Fatalf("cancelled request wrote a response: %s", recorder.Body.String())
	}
}

type podMetricsSourceFunc func(context.Context, string) (podMetricsSnapshot, error)

func (f podMetricsSourceFunc) List(ctx context.Context, contextName string) (podMetricsSnapshot, error) {
	return f(ctx, contextName)
}

func podMetricObject(name, namespace, timestamp string, containers ...map[string]interface{}) unstructured.Unstructured {
	return unstructured.Unstructured{Object: map[string]interface{}{
		"apiVersion": "metrics.k8s.io/v1beta1",
		"kind":       "PodMetrics",
		"metadata": map[string]interface{}{
			"name":      name,
			"namespace": namespace,
		},
		"timestamp": timestamp,
		"window":    "30s",
		"containers": func() []interface{} {
			converted := make([]interface{}, len(containers))
			for i, container := range containers {
				converted[i] = container
			}
			return converted
		}(),
	}}
}

func containerUsage(cpu, memory string) map[string]interface{} {
	return map[string]interface{}{
		"name": "container",
		"usage": map[string]interface{}{
			"cpu":    cpu,
			"memory": memory,
		},
	}
}
