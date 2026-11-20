package main

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"log/slog"
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

const metricsInterval = 15 * time.Second
const metricsRetention = 15 * time.Minute
const metricsFreshness = time.Minute
const metricsAPITimeout = 10 * time.Second

// Include setup and waiting for a shared refresh, in addition to two pairs of API calls.
const metricsRequestTimeout = 4*metricsAPITimeout + 5*time.Second

var podMetricsGVR = schema.GroupVersionResource{Group: "metrics.k8s.io", Version: "v1beta1", Resource: "pods"}

type usage struct {
	CPU    float64 `json:"cpu"`    // millicores
	Memory float64 `json:"memory"` // bytes
}
type metricPoint struct {
	sampleID     [32]byte
	Time         int64             `json:"time"`
	Usage        *usage            `json:"usage"`
	Aggregations map[string]*usage `json:"aggregations,omitempty"`
}
type containerUsage struct {
	Name     string `json:"name"`
	Usage    *usage `json:"usage"`
	Requests usage  `json:"requests"`
	Limits   usage  `json:"limits"`
}
type workloadMetrics struct {
	sampleID     [32]byte
	UID          string            `json:"uid"`
	Name         string            `json:"name"`
	Usage        *usage            `json:"usage"`
	Requests     usage             `json:"requests"`
	Limits       usage             `json:"limits"`
	Reporting    int               `json:"reporting"`
	Expected     int               `json:"expected"`
	Containers   []containerUsage  `json:"containers,omitempty"`
	Pods         []string          `json:"pods,omitempty"`
	History      []metricPoint     `json:"history"`
	Updated      int64             `json:"updated"`
	Aggregations map[string]*usage `json:"aggregations,omitempty"`
}
type metricsSnapshot struct {
	Time  int64                       `json:"time"`
	Items map[string]*workloadMetrics `json:"items"`
	Pods  map[string]*workloadMetrics `json:"pods"`
	Error string                      `json:"error,omitempty"`
}
type metricsEntry struct {
	mu               sync.Mutex
	client           dynamic.Interface
	namespace        string
	lastUsed         time.Time
	polled           time.Time
	deploymentPolled time.Time
	pods             map[string]*workloadMetrics
	deployments      map[string]*workloadMetrics
	podObjects       []unstructured.Unstructured
	histories        map[string][]metricPoint
	err              string
	deploymentErr    string
}
type MetricsManager struct {
	mu        sync.Mutex
	entries   map[string]*metricsEntry
	newClient func(string) (dynamic.Interface, string, error)
}

func NewMetricsManager(rules *clientcmd.ClientConfigLoadingRules) *MetricsManager {
	if rules == nil {
		rules = clientcmd.NewDefaultClientConfigLoadingRules()
	}
	return &MetricsManager{entries: make(map[string]*metricsEntry), newClient: func(cluster string) (dynamic.Interface, string, error) {
		cfg := clientcmd.NewNonInteractiveDeferredLoadingClientConfig(rules, &clientcmd.ConfigOverrides{CurrentContext: cluster})
		rest, err := cfg.ClientConfig()
		if err != nil {
			return nil, "", err
		}
		rest.Timeout = metricsAPITimeout
		ns, _, err := cfg.Namespace()
		if err != nil {
			return nil, "", err
		}
		if ns == "" {
			ns = "default"
		}
		client, err := dynamic.NewForConfig(rest)
		return client, ns, err
	}}
}

func (m *MetricsManager) snapshot(ctx context.Context, cluster, kind string) (metricsSnapshot, error) {
	now := time.Now()
	m.mu.Lock()
	for key, entry := range m.entries {
		if now.Sub(entry.lastUsed) > metricsRetention {
			delete(m.entries, key)
		}
	}
	e := m.entries[cluster]
	if e == nil {
		client, ns, err := m.newClient(cluster)
		if err != nil {
			m.mu.Unlock()
			return metricsSnapshot{}, err
		}
		e = &metricsEntry{client: client, namespace: ns, histories: make(map[string][]metricPoint)}
		m.entries[cluster] = e
	}
	e.lastUsed = now
	m.mu.Unlock()
	e.mu.Lock()
	defer e.mu.Unlock()
	if err := ctx.Err(); err != nil {
		return metricsSnapshot{}, err
	}
	if now.Sub(e.polled) >= metricsInterval {
		phaseStarted := time.Now()
		e.refreshPods(ctx, now)
		if err := ctx.Err(); err != nil {
			// A cancelled browser request must not poison the shared cache.
			e.polled = time.Time{}
			e.deploymentPolled = time.Time{}
			return metricsSnapshot{}, fmt.Errorf("collect pod metrics after %s: %w", time.Since(phaseStarted).Round(time.Millisecond), err)
		}
		if e.err != "" {
			slog.Warn("pod metrics unavailable", "cluster", cluster, "namespace", e.namespace, "error", e.err)
		}
		e.polled = now
		for key, points := range e.histories {
			for len(points) > 0 && points[0].Time < now.Add(-metricsRetention).UnixMilli() {
				points = points[1:]
			}
			if len(points) == 0 {
				delete(e.histories, key)
			} else {
				e.histories[key] = points
			}
		}
	}
	items, message := e.pods, e.err
	if kind == "deployments" {
		if e.deploymentPolled.Before(e.polled) {
			phaseStarted := time.Now()
			e.refreshDeployments(ctx, now)
			if err := ctx.Err(); err != nil {
				e.deploymentPolled = time.Time{}
				return metricsSnapshot{}, fmt.Errorf("resolve deployment metrics after %s: %w", time.Since(phaseStarted).Round(time.Millisecond), err)
			}
			if e.deploymentErr != "" {
				slog.Warn("deployment metrics unavailable", "cluster", cluster, "namespace", e.namespace, "error", e.deploymentErr)
			}
			e.deploymentPolled = e.polled
		}
		items = e.deployments
		if e.deploymentErr != "" {
			message = e.deploymentErr
		}
	}
	return metricsSnapshot{Time: now.UnixMilli(), Items: items, Pods: e.pods, Error: message}, nil
}

func (e *metricsEntry) record(w *workloadMetrics, now time.Time) {
	points := e.histories[w.UID]
	for len(points) > 0 && points[0].Time < now.Add(-metricsRetention).UnixMilli() {
		points = points[1:]
	}
	sampleTime := now.UnixMilli()
	if w.Usage != nil && w.Reporting == w.Expected {
		sampleTime = w.Updated
	}
	// Deployment readings span pods with independent source timestamps. Deduplicate
	// the full set, rather than dropping updates when only the oldest timestamp is unchanged.
	if w.sampleID != ([32]byte{}) {
		sampleTime = now.UnixMilli()
		if len(points) > 0 && w.sampleID == points[len(points)-1].sampleID {
			w.History = points
			return
		}
	} else if len(points) > 0 && sampleTime <= points[len(points)-1].Time {
		w.History = points
		return
	}
	point := metricPoint{Time: sampleTime, sampleID: w.sampleID}
	if w.Reporting == w.Expected {
		point.Usage = w.Usage
		point.Aggregations = w.Aggregations
	}
	// Keep unavailable and incomplete samples as gaps rather than implying usage dropped.
	points = append(points, point)
	if len(points) > 61 {
		points = points[len(points)-61:]
	}
	e.histories[w.UID] = points
	w.History = points
}

func (e *metricsEntry) refreshPods(ctx context.Context, now time.Time) {
	e.err = ""
	var pods, metrics *unstructured.UnstructuredList
	var podErr, metricErr error
	var requests sync.WaitGroup
	requests.Add(2)
	go func() {
		defer requests.Done()
		pods, podErr = e.client.Resource(supportedResources["pods"]).Namespace(e.namespace).List(ctx, metav1.ListOptions{})
	}()
	go func() {
		defer requests.Done()
		metrics, metricErr = e.client.Resource(podMetricsGVR).Namespace(e.namespace).List(ctx, metav1.ListOptions{})
		if apierrors.IsNotFound(metricErr) {
			stable := podMetricsGVR
			stable.Version = "v1"
			metrics, metricErr = e.client.Resource(stable).Namespace(e.namespace).List(ctx, metav1.ListOptions{})
		}
	}()
	requests.Wait()
	if ctx.Err() != nil {
		return
	}
	if podErr != nil {
		e.err = fmt.Sprintf("Cannot read pods for metrics: %v", podErr)
		e.pods = nil
		e.podObjects = nil
		return
	}
	e.podObjects = pods.Items
	byName := make(map[string]unstructured.Unstructured)
	if metricErr != nil {
		e.err = fmt.Sprintf("CPU/memory metrics unavailable (Metrics API and pods.metrics.k8s.io list permission are required): %v", metricErr)
	} else {
		for _, item := range metrics.Items {
			byName[item.GetName()] = item
		}
	}
	e.pods = make(map[string]*workloadMetrics)
	for _, pod := range pods.Items {
		w := &workloadMetrics{UID: string(pod.GetUID()), Name: pod.GetName()}
		metric := byName[pod.GetName()]
		timestamp, _, _ := unstructured.NestedString(metric.Object, "timestamp")
		sampled, parseErr := time.Parse(time.RFC3339Nano, timestamp)
		creation := pod.GetCreationTimestamp()
		fresh := parseErr == nil && now.Sub(sampled) <= metricsFreshness && !sampled.After(now.Add(metricsInterval)) && !sampled.Before(creation.Time) && (metric.GetUID() == "" || metric.GetUID() == pod.GetUID())
		observed := make(map[string]usage)
		if fresh {
			containers, _, _ := unstructured.NestedSlice(metric.Object, "containers")
			for _, raw := range containers {
				c, ok := raw.(map[string]interface{})
				if !ok {
					continue
				}
				name, _ := c["name"].(string)
				values, _, _ := unstructured.NestedStringMap(c, "usage")
				u, valid := parseUsage(values)
				if valid {
					observed[name] = u
				}
			}
			w.Updated = sampled.UnixMilli()
		}
		containers, _, _ := unstructured.NestedSlice(pod.Object, "spec", "containers")
		init, _, _ := unstructured.NestedSlice(pod.Object, "spec", "initContainers")
		for _, raw := range init {
			c, ok := raw.(map[string]interface{})
			if ok && c["restartPolicy"] == "Always" {
				containers = append(containers, raw)
			}
		}
		for _, raw := range containers {
			c, ok := raw.(map[string]interface{})
			if !ok {
				continue
			}
			name, _ := c["name"].(string)
			requests, _, _ := unstructured.NestedStringMap(c, "resources", "requests")
			limits, _, _ := unstructured.NestedStringMap(c, "resources", "limits")
			requested, _ := parseUsage(requests)
			limited, _ := parseUsage(limits)
			detail := containerUsage{Name: name, Requests: requested, Limits: limited}
			addUsage(&w.Requests, requested)
			addUsage(&w.Limits, limited)
			w.Expected++
			if u, ok := observed[name]; ok {
				detail.Usage = &u
				if w.Usage == nil {
					w.Usage = &usage{}
				}
				addUsage(w.Usage, u)
				w.Reporting++
			}
			w.Containers = append(w.Containers, detail)
		}
		e.record(w, now)
		e.pods[w.UID] = w
	}
}

func (e *metricsEntry) refreshDeployments(ctx context.Context, now time.Time) {
	e.deploymentErr = ""
	e.deployments = nil
	var replicas, deployments *unstructured.UnstructuredList
	var replicaErr, deploymentErr error
	var requests sync.WaitGroup
	requests.Add(2)
	go func() {
		defer requests.Done()
		replicas, replicaErr = e.client.Resource(supportedResources["replicasets"]).Namespace(e.namespace).List(ctx, metav1.ListOptions{})
	}()
	go func() {
		defer requests.Done()
		deployments, deploymentErr = e.client.Resource(supportedResources["deployments"]).Namespace(e.namespace).List(ctx, metav1.ListOptions{})
	}()
	requests.Wait()
	if ctx.Err() != nil {
		return
	}
	if replicaErr != nil {
		e.deploymentErr = fmt.Sprintf("Cannot resolve deployment metrics: %v", replicaErr)
		return
	}
	if deploymentErr != nil {
		e.deploymentErr = fmt.Sprintf("Cannot read deployments for metrics: %v", deploymentErr)
		return
	}
	owners := make(map[string]string)
	for _, rs := range replicas.Items {
		owners[string(rs.GetUID())] = controllerUID(rs, "Deployment")
	}
	e.deployments = make(map[string]*workloadMetrics)
	for _, deployment := range deployments.Items {
		w := &workloadMetrics{UID: string(deployment.GetUID()), Name: deployment.GetName()}
		var readings []usage
		var sampleKeys []string
		for _, pod := range e.podObjects {
			if owners[controllerUID(pod, "ReplicaSet")] != w.UID {
				continue
			}
			p := e.pods[string(pod.GetUID())]
			if p == nil {
				continue
			}
			w.Pods = append(w.Pods, p.UID)
			sampleKeys = append(sampleKeys, fmt.Sprintf("%s:%d:%d/%d", p.UID, p.Updated, p.Reporting, p.Expected))
			addUsage(&w.Requests, p.Requests)
			addUsage(&w.Limits, p.Limits)
			w.Expected++
			if p.Usage != nil && p.Reporting == p.Expected {
				readings = append(readings, *p.Usage)
				w.Reporting++
				if w.Updated == 0 || p.Updated < w.Updated {
					w.Updated = p.Updated
				}
			}
		}
		sort.Strings(sampleKeys)
		w.sampleID = sha256.Sum256([]byte(strings.Join(sampleKeys, "|")))
		w.Aggregations = aggregatePodUsage(readings)
		w.Usage = w.Aggregations["sum"]
		e.record(w, now)
		e.deployments[w.UID] = w
	}
}

// Aggregate CPU and memory independently across fully reporting pods.
func aggregatePodUsage(readings []usage) map[string]*usage {
	if len(readings) == 0 {
		return nil
	}
	total, minimum, maximum := usage{}, readings[0], readings[0]
	for _, reading := range readings {
		addUsage(&total, reading)
		minimum.CPU = min(minimum.CPU, reading.CPU)
		minimum.Memory = min(minimum.Memory, reading.Memory)
		maximum.CPU = max(maximum.CPU, reading.CPU)
		maximum.Memory = max(maximum.Memory, reading.Memory)
	}
	average := usage{CPU: total.CPU / float64(len(readings)), Memory: total.Memory / float64(len(readings))}
	return map[string]*usage{"sum": &total, "avg": &average, "min": &minimum, "max": &maximum}
}

func controllerUID(object unstructured.Unstructured, kind string) string {
	for _, owner := range object.GetOwnerReferences() {
		if owner.Kind == kind && owner.Controller != nil && *owner.Controller {
			return string(owner.UID)
		}
	}
	return ""
}
func addUsage(to *usage, from usage) { to.CPU += from.CPU; to.Memory += from.Memory }
func parseUsage(values map[string]string) (usage, bool) {
	u := usage{}
	valid := true
	for name, target := range map[string]*float64{"cpu": &u.CPU, "memory": &u.Memory} {
		raw, exists := values[name]
		if !exists {
			valid = false
			continue
		}
		q, err := resource.ParseQuantity(raw)
		if err != nil || q.Sign() < 0 {
			valid = false
			continue
		}
		*target = q.AsApproximateFloat64()
		if name == "cpu" {
			*target *= 1000
		}
	}
	return u, valid
}

func (m *MetricsManager) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	parts := escapedPathSegments(r, "/api/metrics/")
	if len(parts) != 2 {
		http.Error(w, "expected /api/metrics/{context}/{pods|deployments}", http.StatusBadRequest)
		return
	}
	cluster, err := urlPathValue(parts[0])
	if err != nil {
		http.Error(w, "invalid context", http.StatusBadRequest)
		return
	}
	kind := parts[1]
	if kind != "pods" && kind != "deployments" {
		http.Error(w, "unsupported metrics resource", http.StatusBadRequest)
		return
	}
	started := time.Now()
	ctx, cancel := context.WithTimeout(r.Context(), metricsRequestTimeout)
	defer cancel()
	snapshot, err := m.snapshot(ctx, cluster, kind)
	if err != nil {
		if r.Context().Err() != nil {
			return
		}
		slog.Error("metrics request failed", "cluster", cluster, "resource", kind, "duration", time.Since(started), "error", err)
		http.Error(w, fmt.Sprintf("metrics unavailable: %v", err), http.StatusBadGateway)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	_ = json.NewEncoder(w).Encode(snapshot)
}
