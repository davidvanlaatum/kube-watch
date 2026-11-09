package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"math"
	"net/http"
	"sort"
	"strings"
	"sync"
	"time"

	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/api/resource"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/client-go/dynamic"
	"k8s.io/client-go/tools/clientcmd"
)

const podMetricsRequestTimeout = 10 * time.Second

var podMetricsGVR = schema.GroupVersionResource{
	Group:    "metrics.k8s.io",
	Version:  "v1beta1",
	Resource: "pods",
}

type podMetricsSnapshot struct {
	Namespace   string      `json:"namespace"`
	RetrievedAt time.Time   `json:"retrievedAt"`
	Pods        []podMetric `json:"pods"`
	Warnings    []string    `json:"warnings"`
}

type podMetric struct {
	Name          string     `json:"name"`
	Timestamp     *time.Time `json:"timestamp"`
	Window        string     `json:"window"`
	CPUMilliCores *int64     `json:"cpuMilliCores"`
	MemoryBytes   *int64     `json:"memoryBytes"`
}

type podMetricsSource interface {
	List(context.Context, string) (podMetricsSnapshot, error)
}

type podMetricsContextClient struct {
	namespace string
	client    dynamic.Interface
}

type podMetricsManager struct {
	loadingRules *clientcmd.ClientConfigLoadingRules
	mu           sync.Mutex
	clients      map[string]podMetricsContextClient
}

func newPodMetricsManager(loadingRules *clientcmd.ClientConfigLoadingRules) *podMetricsManager {
	if loadingRules == nil {
		loadingRules = clientcmd.NewDefaultClientConfigLoadingRules()
	}
	return &podMetricsManager{
		loadingRules: loadingRules,
		clients:      make(map[string]podMetricsContextClient),
	}
}

func (m *podMetricsManager) List(ctx context.Context, contextName string) (podMetricsSnapshot, error) {
	contextClient, err := m.clientForContext(contextName)
	if err != nil {
		return podMetricsSnapshot{}, err
	}

	requestCtx, cancel := context.WithTimeout(ctx, podMetricsRequestTimeout)
	defer cancel()

	list, err := contextClient.client.Resource(podMetricsGVR).
		Namespace(contextClient.namespace).
		List(requestCtx, metav1.ListOptions{})
	if err != nil {
		return podMetricsSnapshot{}, fmt.Errorf("list pod metrics in namespace %q for context %q: %w", contextClient.namespace, contextName, err)
	}

	return aggregatePodMetrics(contextClient.namespace, list), nil
}

func (m *podMetricsManager) clientForContext(contextName string) (podMetricsContextClient, error) {
	m.mu.Lock()
	defer m.mu.Unlock()

	if existing, ok := m.clients[contextName]; ok {
		return existing, nil
	}

	overrides := &clientcmd.ConfigOverrides{CurrentContext: contextName}
	clientConfig := clientcmd.NewNonInteractiveDeferredLoadingClientConfig(m.loadingRules, overrides)
	namespace, _, err := clientConfig.Namespace()
	if err != nil {
		return podMetricsContextClient{}, fmt.Errorf("resolve namespace for context %q: %w", contextName, err)
	}
	if namespace == "" {
		namespace = "default"
	}

	config, err := clientConfig.ClientConfig()
	if err != nil {
		return podMetricsContextClient{}, fmt.Errorf("build Kubernetes config for context %q: %w", contextName, err)
	}
	client, err := dynamic.NewForConfig(config)
	if err != nil {
		return podMetricsContextClient{}, fmt.Errorf("create Kubernetes client for context %q: %w", contextName, err)
	}

	contextClient := podMetricsContextClient{namespace: namespace, client: client}
	m.clients[contextName] = contextClient
	slog.Info("created pod metrics client", "context", contextName, "namespace", namespace)
	return contextClient, nil
}

func aggregatePodMetrics(namespace string, list *unstructured.UnstructuredList) podMetricsSnapshot {
	items := []unstructured.Unstructured(nil)
	if list != nil {
		items = list.Items
	}
	snapshot := podMetricsSnapshot{
		Namespace:   namespace,
		RetrievedAt: time.Now().UTC(),
		Pods:        make([]podMetric, 0, len(items)),
		Warnings:    make([]string, 0),
	}
	var missingNamespace, missingName, missingTimestamp, incompleteCPU, incompleteMemory int

	for _, item := range items {
		if item.GetNamespace() != namespace {
			missingNamespace++
			continue
		}
		name := item.GetName()
		if name == "" {
			missingName++
			continue
		}

		metric := podMetric{
			Name:      name,
			Timestamp: parseMetricsTimestamp(item.Object["timestamp"]),
		}
		metric.Window, _, _ = unstructured.NestedString(item.Object, "window")
		if metric.Timestamp == nil {
			missingTimestamp++
		}
		metric.CPUMilliCores, metric.MemoryBytes = aggregateContainerUsage(item.Object)
		if metric.CPUMilliCores == nil {
			incompleteCPU++
		}
		if metric.MemoryBytes == nil {
			incompleteMemory++
		}
		snapshot.Pods = append(snapshot.Pods, metric)
	}

	sort.Slice(snapshot.Pods, func(i, j int) bool {
		return snapshot.Pods[i].Name < snapshot.Pods[j].Name
	})

	if missingNamespace > 0 {
		snapshot.Warnings = append(snapshot.Warnings, fmt.Sprintf("Ignored %d pod metric(s) outside the configured namespace.", missingNamespace))
	}
	if missingName > 0 {
		snapshot.Warnings = append(snapshot.Warnings, fmt.Sprintf("Ignored %d pod metric(s) without a pod name.", missingName))
	}
	if missingTimestamp > 0 {
		snapshot.Warnings = append(snapshot.Warnings, fmt.Sprintf("%d pod sample(s) have no valid metrics timestamp; their current values are shown but not added to history.", missingTimestamp))
	}
	if incompleteCPU > 0 {
		snapshot.Warnings = append(snapshot.Warnings, fmt.Sprintf("CPU usage is incomplete for %d pod(s); those values are shown as unavailable.", incompleteCPU))
	}
	if incompleteMemory > 0 {
		snapshot.Warnings = append(snapshot.Warnings, fmt.Sprintf("Memory usage is incomplete for %d pod(s); those values are shown as unavailable.", incompleteMemory))
	}

	return snapshot
}

func aggregateContainerUsage(pod map[string]interface{}) (*int64, *int64) {
	containers, found, err := unstructured.NestedSlice(pod, "containers")
	if err != nil || !found || len(containers) == 0 {
		return nil, nil
	}

	cpuTotal := resource.Quantity{}
	memoryTotal := resource.Quantity{}
	cpuComplete := true
	memoryComplete := true

	for _, rawContainer := range containers {
		container, ok := rawContainer.(map[string]interface{})
		if !ok {
			cpuComplete = false
			memoryComplete = false
			continue
		}
		cpuValue, cpuOK := nestedQuantity(container, "cpu")
		if !cpuOK {
			cpuComplete = false
		} else {
			cpuTotal.Add(cpuValue)
		}
		memoryValue, memoryOK := nestedQuantity(container, "memory")
		if !memoryOK {
			memoryComplete = false
		} else {
			memoryTotal.Add(memoryValue)
		}
	}

	var cpu *int64
	if cpuComplete {
		if value, ok := quantityValue(cpuTotal, true); ok {
			cpu = &value
		}
	}
	var memory *int64
	if memoryComplete {
		if value, ok := quantityValue(memoryTotal, false); ok {
			memory = &value
		}
	}
	return cpu, memory
}

func nestedQuantity(object map[string]interface{}, resourceName string) (resource.Quantity, bool) {
	value, found, err := unstructured.NestedString(object, "usage", resourceName)
	if err != nil || !found {
		return resource.Quantity{}, false
	}
	quantity, err := resource.ParseQuantity(value)
	if err != nil || quantity.Sign() < 0 {
		return resource.Quantity{}, false
	}
	return quantity, true
}

func quantityValue(quantity resource.Quantity, milli bool) (int64, bool) {
	var maximum resource.Quantity
	if milli {
		maximum = *resource.NewMilliQuantity(math.MaxInt64, resource.DecimalSI)
	} else {
		maximum = *resource.NewQuantity(math.MaxInt64, resource.DecimalSI)
	}
	if quantity.Sign() < 0 || quantity.Cmp(maximum) > 0 {
		return 0, false
	}
	if milli {
		return quantity.MilliValue(), true
	}
	return quantity.Value(), true
}

func parseMetricsTimestamp(value interface{}) *time.Time {
	raw, ok := value.(string)
	if !ok || strings.TrimSpace(raw) == "" {
		return nil
	}
	timestamp, err := time.Parse(time.RFC3339Nano, raw)
	if err != nil {
		return nil
	}
	timestamp = timestamp.UTC()
	return &timestamp
}

func newPodMetricsHandler(source podMetricsSource) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			w.Header().Set("Allow", http.MethodGet)
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}

		parts := escapedPathSegments(r, "/api/pod-metrics/")
		if len(parts) != 1 {
			http.Error(w, "expected /api/pod-metrics/{context}", http.StatusBadRequest)
			return
		}
		contextName, err := urlPathValue(parts[0])
		if err != nil {
			http.Error(w, "invalid context", http.StatusBadRequest)
			return
		}

		snapshot, err := source.List(r.Context(), contextName)
		if err != nil {
			writePodMetricsError(w, r, err)
			return
		}

		w.Header().Set("Content-Type", "application/json")
		if err := json.NewEncoder(w).Encode(snapshot); err != nil {
			slog.Error("failed to encode pod metrics response", "context", contextName, "error", err)
		}
	})
}

func writePodMetricsError(w http.ResponseWriter, r *http.Request, err error) {
	if errors.Is(err, context.Canceled) || r.Context().Err() != nil {
		return
	}

	status := http.StatusInternalServerError
	message := err.Error()
	switch {
	case errors.Is(err, context.DeadlineExceeded):
		status = http.StatusGatewayTimeout
		message = "Timed out while requesting pod metrics. Try again."
	case apierrors.IsForbidden(err):
		status = http.StatusForbidden
		message = "Permission denied reading pod metrics. Check list access for pods.metrics.k8s.io in the selected namespace."
	case apierrors.IsUnauthorized(err):
		status = http.StatusUnauthorized
		message = "Kubernetes authentication failed while reading pod metrics."
	case apierrors.IsNotFound(err), apierrors.IsServiceUnavailable(err):
		status = http.StatusServiceUnavailable
		message = "The Pod Metrics API is unavailable. Check that metrics-server is installed and healthy."
	}

	slog.Error("failed to retrieve pod metrics", "status", status, "error", err)
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	if encodeErr := json.NewEncoder(w).Encode(map[string]string{"error": message}); encodeErr != nil {
		slog.Error("failed to encode pod metrics error response", "error", encodeErr)
	}
}
