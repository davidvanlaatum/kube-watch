package main

import (
	"context"
	"errors"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/apimachinery/pkg/types"
	"k8s.io/client-go/dynamic"
	"k8s.io/client-go/dynamic/fake"
	ktesting "k8s.io/client-go/testing"
	"k8s.io/client-go/tools/clientcmd"
	"k8s.io/client-go/tools/clientcmd/api"
)

func metricsObject(kind, name, uid string) *unstructured.Unstructured {
	version := "v1"
	if kind == "Deployment" || kind == "ReplicaSet" {
		version = "apps/v1"
	}
	if kind == "PodMetrics" {
		version = "metrics.k8s.io/v1beta1"
	}
	return &unstructured.Unstructured{Object: map[string]interface{}{"apiVersion": version, "kind": kind, "metadata": map[string]interface{}{"name": name, "namespace": "test", "uid": uid}}}
}
func metricOwner(object *unstructured.Unstructured, kind, uid string) {
	controller := true
	object.SetOwnerReferences([]metav1.OwnerReference{{Kind: kind, UID: types.UID(uid), Controller: &controller}})
}
func metricsFixture(t *testing.T) (*MetricsManager, *fake.FakeDynamicClient) {
	t.Helper()
	now := time.Now()
	objects := []runtime.Object{}
	metricObjects := []*unstructured.Unstructured{}
	for i, name := range []string{"old", "new", "unrelated"} {
		pod := metricsObject("Pod", name, name)
		metricOwner(pod, "ReplicaSet", name+"-rs")
		pod.Object["spec"] = map[string]interface{}{"containers": []interface{}{map[string]interface{}{"name": "app", "resources": map[string]interface{}{"requests": map[string]interface{}{"cpu": "100m", "memory": "64Mi"}, "limits": map[string]interface{}{"cpu": "1", "memory": "256Mi"}}}}}
		pod.SetCreationTimestamp(metav1.NewTime(now.Add(-time.Hour)))
		rs := metricsObject("ReplicaSet", name+"-rs", name+"-rs")
		owner := "deployment"
		if i == 2 {
			owner = "other"
		}
		metricOwner(rs, "Deployment", owner)
		metric := metricsObject("PodMetrics", name, "")
		metric.Object["timestamp"] = now.Add(-time.Second).UTC().Format(time.RFC3339Nano)
		metric.Object["containers"] = []interface{}{map[string]interface{}{"name": "app", "usage": map[string]interface{}{"cpu": "125000000n", "memory": "128Mi"}}}
		objects = append(objects, pod, rs)
		metricObjects = append(metricObjects, metric)
	}
	objects = append(objects, metricsObject("Deployment", "web", "deployment"))
	client := fake.NewSimpleDynamicClientWithCustomListKinds(runtime.NewScheme(), map[schema.GroupVersionResource]string{
		supportedResources["pods"]: "PodList", supportedResources["replicasets"]: "ReplicaSetList", supportedResources["deployments"]: "DeploymentList", podMetricsGVR: "PodMetricsList",
		{Group: "metrics.k8s.io", Version: "v1", Resource: "pods"}: "PodMetricsList",
	}, objects...)
	for _, metric := range metricObjects {
		if err := client.Tracker().Create(podMetricsGVR, metric, "test"); err != nil {
			t.Fatal(err)
		}
	}
	m := &MetricsManager{entries: map[string]*metricsEntry{}, newClient: func(string) (dynamic.Interface, string, error) { return client, "test", nil }}
	return m, client
}
func TestMetricsSharedSamplingAndDeploymentRollout(t *testing.T) {
	m, client := metricsFixture(t)
	podSnapshot, err := m.snapshot(context.Background(), "ctx", "pods")
	if err != nil {
		t.Fatal(err)
	}
	if len(podSnapshot.Items) != 3 || podSnapshot.Error != "" {
		t.Fatalf("snapshot: %+v", podSnapshot)
	}
	p := podSnapshot.Items["old"]
	if p.Usage.CPU != 125 || p.Usage.Memory != 128*1024*1024 || p.Requests.CPU != 100 || p.Limits.CPU != 1000 || p.Reporting != 1 {
		t.Fatalf("pod: %+v", p)
	}
	deploymentSnapshot, err := m.snapshot(context.Background(), "ctx", "deployments")
	if err != nil {
		t.Fatal(err)
	}
	d := deploymentSnapshot.Items["deployment"]
	if d.Expected != 2 || d.Reporting != 2 || d.Usage.CPU != 250 || len(d.Pods) != 2 {
		t.Fatalf("deployment: %+v", d)
	}
	before := len(client.Actions())
	var wg sync.WaitGroup
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, err := m.snapshot(context.Background(), "ctx", "deployments")
			if err != nil {
				t.Error(err)
			}
		}()
	}
	wg.Wait()
	if len(client.Actions()) != before {
		t.Fatal("cached subscribers repeated cluster requests")
	}
	for _, action := range client.Actions() {
		if action.GetNamespace() != "test" {
			t.Fatalf("unexpected namespace %q", action.GetNamespace())
		}
	}
	// An unchanged source timestamp must not manufacture another chart sample.
	m.entries["ctx"].polled = time.Now().Add(-metricsInterval)
	again, _ := m.snapshot(context.Background(), "ctx", "pods")
	if len(again.Items["old"].History) != 1 {
		t.Fatal("duplicated source sample")
	}
}
func TestMetricsMissingStaleInvalidAndReplacementSamples(t *testing.T) {
	for _, scenario := range []string{"missing", "stale", "replacement", "invalid", "partial", "recreated"} {
		t.Run(scenario, func(t *testing.T) {
			m, client := metricsFixture(t)
			metric, err := client.Resource(podMetricsGVR).Namespace("test").Get(context.Background(), "old", metav1.GetOptions{})
			if err != nil {
				t.Fatal(err)
			}
			switch scenario {
			case "missing":
				err = client.Resource(podMetricsGVR).Namespace("test").Delete(context.Background(), "old", metav1.DeleteOptions{})
			case "stale":
				metric.Object["timestamp"] = time.Now().Add(-2 * time.Minute).Format(time.RFC3339Nano)
			case "replacement":
				metric.SetUID("previous-pod")
			case "invalid":
				metric.Object["containers"] = []interface{}{map[string]interface{}{"name": "app", "usage": map[string]interface{}{"cpu": "bogus", "memory": "-1"}}}
			case "recreated":
				pod, _ := client.Resource(supportedResources["pods"]).Namespace("test").Get(context.Background(), "old", metav1.GetOptions{})
				pod.SetCreationTimestamp(metav1.NewTime(time.Now()))
				_, err = client.Resource(supportedResources["pods"]).Namespace("test").Update(context.Background(), pod, metav1.UpdateOptions{})
			case "partial":
				pod, _ := client.Resource(supportedResources["pods"]).Namespace("test").Get(context.Background(), "old", metav1.GetOptions{})
				_ = unstructured.SetNestedSlice(pod.Object, []interface{}{map[string]interface{}{"name": "app"}, map[string]interface{}{"name": "sidecar"}}, "spec", "containers")
				_, err = client.Resource(supportedResources["pods"]).Namespace("test").Update(context.Background(), pod, metav1.UpdateOptions{})
			}
			if err != nil {
				t.Fatal(err)
			}
			if scenario != "missing" {
				_, err = client.Resource(podMetricsGVR).Namespace("test").Update(context.Background(), metric, metav1.UpdateOptions{})
				if err != nil {
					t.Fatal(err)
				}
			}
			s, err := m.snapshot(context.Background(), "ctx", "deployments")
			if err != nil {
				t.Fatal(err)
			}
			d := s.Items["deployment"]
			if d.Reporting != 1 || d.Expected != 2 || d.Usage.CPU != 125 {
				t.Fatalf("incomplete total: %+v", d)
			}
			if d.History[len(d.History)-1].Usage != nil {
				t.Fatal("incomplete deployment total plotted as a complete sample")
			}
			if scenario != "partial" && s.Pods["old"].Usage != nil {
				t.Fatal("missing readings reported as usage")
			}
		})
	}
}
func TestMetricsFailuresAndRecovery(t *testing.T) {
	for _, resource := range []string{"pods", "replicasets", "deployments"} {
		t.Run(resource, func(t *testing.T) {
			m, client := metricsFixture(t)
			fail := true
			client.PrependReactor("list", resource, func(action ktesting.Action) (bool, runtime.Object, error) {
				if fail && action.GetResource().Group != "metrics.k8s.io" {
					return true, nil, apierrors.NewForbidden(schema.GroupResource{Resource: resource}, "", errors.New("denied"))
				}
				return false, nil, nil
			})
			snapshot, err := m.snapshot(context.Background(), "ctx", "deployments")
			if err != nil {
				t.Fatal(err)
			}
			if !strings.Contains(snapshot.Error, "denied") {
				t.Fatalf("error not surfaced: %+v", snapshot)
			}
			fail = false
			m.entries["ctx"].polled = time.Now().Add(-metricsInterval)
			snapshot, err = m.snapshot(context.Background(), "ctx", "deployments")
			if err != nil || snapshot.Error != "" || snapshot.Items["deployment"].Reporting != 2 {
				t.Fatalf("recovery: %+v %v", snapshot, err)
			}
		})
	}
	m, client := metricsFixture(t)
	client.PrependReactor("list", "pods", func(action ktesting.Action) (bool, runtime.Object, error) {
		if action.GetResource().Group == "metrics.k8s.io" {
			return true, nil, apierrors.NewForbidden(schema.GroupResource{Group: "metrics.k8s.io", Resource: "pods"}, "", errors.New("denied"))
		}
		return false, nil, nil
	})
	s, _ := m.snapshot(context.Background(), "ctx", "pods")
	if s.Error == "" || s.Items["old"].Usage != nil {
		t.Fatalf("metrics API error: %+v", s)
	}
}
func TestMetricsHistoryRetentionAndGaps(t *testing.T) {
	e := &metricsEntry{histories: map[string][]metricPoint{}}
	now := time.Now()
	for i := 0; i < 100; i++ {
		e.record(&workloadMetrics{UID: "pod"}, now.Add(time.Duration(i)*metricsInterval))
	}
	if len(e.histories["pod"]) != 61 || e.histories["pod"][0].Usage != nil {
		t.Fatal("history not bounded or unavailable converted to zero")
	}
	m, _ := metricsFixture(t)
	m.entries["expired"] = &metricsEntry{lastUsed: now.Add(-metricsRetention - time.Second)}
	_, err := m.snapshot(context.Background(), "ctx", "pods")
	if err != nil {
		t.Fatal(err)
	}
	if m.entries["expired"] != nil {
		t.Fatal("idle context not evicted")
	}
	m.entries["ctx"].histories["deleted-pod"] = []metricPoint{{Time: now.Add(-metricsRetention - time.Second).UnixMilli()}}
	m.entries["ctx"].polled = now.Add(-metricsInterval)
	_, _ = m.snapshot(context.Background(), "ctx", "pods")
	if _, ok := m.entries["ctx"].histories["deleted-pod"]; ok {
		t.Fatal("deleted pod history not expired")
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err = m.snapshot(ctx, "ctx", "pods"); err == nil {
		t.Fatal("ignored cancellation")
	}
}
func TestMetricsHTTPAndClientConfig(t *testing.T) {
	m, _ := metricsFixture(t)
	for _, tc := range []struct {
		path   string
		status int
	}{{"/api/metrics/ctx/pods", 200}, {"/api/metrics/ctx/deployments", 200}, {"/api/metrics/ctx/secrets", 400}, {"/api/metrics/ctx", 400}, {"/api/metrics//pods", 400}} {
		w := httptest.NewRecorder()
		m.ServeHTTP(w, httptest.NewRequest("GET", tc.path, nil))
		if w.Code != tc.status {
			t.Errorf("%s: %d %s", tc.path, w.Code, w.Body.String())
		}
	}
	m.newClient = func(string) (dynamic.Interface, string, error) { return nil, "", errors.New("config error") }
	w := httptest.NewRecorder()
	m.ServeHTTP(w, httptest.NewRequest("GET", "/api/metrics/unknown/pods", nil))
	if w.Code != 502 {
		t.Fatal(w.Code)
	}
	rules := &clientcmd.ClientConfigLoadingRules{ExplicitPath: t.TempDir() + "/missing"}
	configured := NewMetricsManager(rules)
	if _, _, err := configured.newClient("missing"); err == nil {
		t.Fatal("expected config error")
	}
	path := t.TempDir() + "/config"
	cfg := api.Config{Clusters: map[string]*api.Cluster{"cluster": {Server: "https://example.invalid"}}, Contexts: map[string]*api.Context{"ctx": {Cluster: "cluster"}}, CurrentContext: "ctx"}
	if err := clientcmd.WriteToFile(cfg, path); err != nil {
		t.Fatal(err)
	}
	configured = NewMetricsManager(&clientcmd.ClientConfigLoadingRules{ExplicitPath: path})
	if _, ns, err := configured.newClient("ctx"); err != nil || ns != "default" {
		t.Fatalf("namespace=%s err=%v", ns, err)
	}
	_ = NewMetricsManager(nil)
}
func TestMetricsStableAPIFallback(t *testing.T) {
	m, client := metricsFixture(t)
	client.PrependReactor("list", "pods", func(action ktesting.Action) (bool, runtime.Object, error) {
		if action.GetResource() == podMetricsGVR {
			return true, nil, apierrors.NewNotFound(schema.GroupResource{Group: "metrics.k8s.io", Resource: "pods"}, "")
		}
		return false, nil, nil
	})
	s, err := m.snapshot(context.Background(), "ctx", "pods")
	if err != nil || s.Error != "" {
		t.Fatalf("fallback: %+v %v", s, err)
	}
	actions := client.Actions()
	if actions[len(actions)-1].GetResource().Version != "v1" {
		t.Fatal("stable API not attempted")
	}
}

func TestMetricsIncludesRestartableSidecars(t *testing.T) {
	m, client := metricsFixture(t)
	pod, err := client.Resource(supportedResources["pods"]).Namespace("test").Get(context.Background(), "old", metav1.GetOptions{})
	if err != nil {
		t.Fatal(err)
	}
	_ = unstructured.SetNestedSlice(pod.Object, []interface{}{
		map[string]interface{}{"name": "setup"},
		map[string]interface{}{"name": "proxy", "restartPolicy": "Always"},
	}, "spec", "initContainers")
	if _, err = client.Resource(supportedResources["pods"]).Namespace("test").Update(context.Background(), pod, metav1.UpdateOptions{}); err != nil {
		t.Fatal(err)
	}
	metric, err := client.Resource(podMetricsGVR).Namespace("test").Get(context.Background(), "old", metav1.GetOptions{})
	if err != nil {
		t.Fatal(err)
	}
	containers, _, _ := unstructured.NestedSlice(metric.Object, "containers")
	containers = append(containers, map[string]interface{}{"name": "proxy", "usage": map[string]interface{}{"cpu": "25m", "memory": "16Mi"}})
	_ = unstructured.SetNestedSlice(metric.Object, containers, "containers")
	if _, err = client.Resource(podMetricsGVR).Namespace("test").Update(context.Background(), metric, metav1.UpdateOptions{}); err != nil {
		t.Fatal(err)
	}
	s, err := m.snapshot(context.Background(), "ctx", "pods")
	if err != nil {
		t.Fatal(err)
	}
	p := s.Items["old"]
	if p.Expected != 2 || p.Reporting != 2 || p.Usage.CPU != 150 || len(p.Containers) != 2 {
		t.Fatalf("sidecar omitted or completed init counted: %+v", p)
	}
}
