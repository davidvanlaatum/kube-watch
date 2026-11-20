package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
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

var podMetricsGVR = schema.GroupVersionResource{Group: "metrics.k8s.io", Version: "v1beta1", Resource: "pods"}

type usage struct {
	CPU    float64 `json:"cpu"`    // millicores
	Memory float64 `json:"memory"` // bytes
}
type metricPoint struct {
	Time  int64  `json:"time"`
	Usage *usage `json:"usage"`
}
type containerUsage struct {
	Name     string `json:"name"`
	Usage    *usage `json:"usage"`
	Requests usage  `json:"requests"`
	Limits   usage  `json:"limits"`
}
type workloadMetrics struct {
	UID        string           `json:"uid"`
	Name       string           `json:"name"`
	Usage      *usage           `json:"usage"`
	Requests   usage            `json:"requests"`
	Limits     usage            `json:"limits"`
	Reporting  int              `json:"reporting"`
	Expected   int              `json:"expected"`
	Containers []containerUsage `json:"containers,omitempty"`
	Pods       []string         `json:"pods,omitempty"`
	History    []metricPoint    `json:"history"`
	Updated    int64            `json:"updated"`
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
		rest.Timeout = 10 * time.Second
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
		e.refreshPods(ctx, now)
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
			e.refreshDeployments(ctx, now)
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
	// Do not turn repeated Metrics API readings into new observations.
	if len(points) > 0 && sampleTime <= points[len(points)-1].Time {
		w.History = points
		return
	}
	point := metricPoint{Time: sampleTime}
	if w.Reporting == w.Expected {
		point.Usage = w.Usage
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
	pods, err := e.client.Resource(supportedResources["pods"]).Namespace(e.namespace).List(ctx, metav1.ListOptions{})
	if err != nil {
		e.err = fmt.Sprintf("Cannot read pods for metrics: %v", err)
		e.pods = nil
		e.podObjects = nil
		return
	}
	e.podObjects = pods.Items
	metrics, err := e.client.Resource(podMetricsGVR).Namespace(e.namespace).List(ctx, metav1.ListOptions{})
	if apierrors.IsNotFound(err) {
		stable := podMetricsGVR
		stable.Version = "v1"
		metrics, err = e.client.Resource(stable).Namespace(e.namespace).List(ctx, metav1.ListOptions{})
	}
	byName := make(map[string]unstructured.Unstructured)
	if err != nil {
		e.err = fmt.Sprintf("CPU/memory metrics unavailable (Metrics API and pods.metrics.k8s.io list permission are required): %v", err)
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
	replicas, err := e.client.Resource(supportedResources["replicasets"]).Namespace(e.namespace).List(ctx, metav1.ListOptions{})
	if err != nil {
		e.deploymentErr = fmt.Sprintf("Cannot resolve deployment metrics: %v", err)
		return
	}
	deployments, err := e.client.Resource(supportedResources["deployments"]).Namespace(e.namespace).List(ctx, metav1.ListOptions{})
	if err != nil {
		e.deploymentErr = fmt.Sprintf("Cannot read deployments for metrics: %v", err)
		return
	}
	owners := make(map[string]string)
	for _, rs := range replicas.Items {
		owners[string(rs.GetUID())] = controllerUID(rs, "Deployment")
	}
	e.deployments = make(map[string]*workloadMetrics)
	for _, deployment := range deployments.Items {
		w := &workloadMetrics{UID: string(deployment.GetUID()), Name: deployment.GetName()}
		for _, pod := range e.podObjects {
			if owners[controllerUID(pod, "ReplicaSet")] != w.UID {
				continue
			}
			p := e.pods[string(pod.GetUID())]
			if p == nil {
				continue
			}
			w.Pods = append(w.Pods, p.UID)
			addUsage(&w.Requests, p.Requests)
			addUsage(&w.Limits, p.Limits)
			w.Expected++
			if p.Usage != nil && p.Reporting == p.Expected {
				if w.Usage == nil {
					w.Usage = &usage{}
				}
				addUsage(w.Usage, *p.Usage)
				w.Reporting++
				if w.Updated == 0 || p.Updated < w.Updated {
					w.Updated = p.Updated
				}
			}
		}
		e.record(w, now)
		e.deployments[w.UID] = w
	}
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
	ctx, cancel := context.WithTimeout(r.Context(), 12*time.Second)
	defer cancel()
	snapshot, err := m.snapshot(ctx, cluster, kind)
	if err != nil {
		http.Error(w, fmt.Sprintf("metrics unavailable: %v", err), http.StatusBadGateway)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	_ = json.NewEncoder(w).Encode(snapshot)
}
