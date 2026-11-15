package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/tools/clientcmd"
	"k8s.io/client-go/tools/clientcmd/api"
)

// testClusterRules only points clients at an isolated test server, never the operator's kubeconfig.
func testClusterRules(t *testing.T, serverURL, namespace string) *clientcmd.ClientConfigLoadingRules {
	t.Helper()
	path := filepath.Join(t.TempDir(), "config")
	cfg := api.Config{Clusters: map[string]*api.Cluster{"cluster": {Server: serverURL}}, AuthInfos: map[string]*api.AuthInfo{"user": {}}, Contexts: map[string]*api.Context{"dev/cluster": {Cluster: "cluster", AuthInfo: "user", Namespace: namespace}}}
	if err := clientcmd.WriteToFile(cfg, path); err != nil {
		t.Fatal(err)
	}
	return &clientcmd.ClientConfigLoadingRules{ExplicitPath: path}
}

func TestManagersCreateNamespacedClientsAndReuseEntries(t *testing.T) {
	for _, namespace := range []string{"team", ""} {
		t.Run(namespace, func(t *testing.T) {
			rules := testClusterRules(t, "http://127.0.0.1:1", namespace)
			want := namespace
			if want == "" {
				want = "default"
			}
			wm := NewWatchManager(rules)
			hm := NewHelmManager(rules)
			gvr := supportedResources["pods"]
			entry, created, err := wm.getOrCreateEntry("dev/cluster", gvr)
			if err != nil || !created || entry.namespace != want {
				t.Fatalf("watch entry=%+v created=%v err=%v", entry, created, err)
			}
			again, created, err := wm.getOrCreateEntry("dev/cluster", gvr)
			if err != nil || created || again != entry {
				t.Fatal("watch entry not reused")
			}
			stored, created := wm.storeEntryIfAbsent(watchKey("dev/cluster", gvr), &watchEntry{})
			if created || stored != entry {
				t.Fatal("watch entry overwritten")
			}
			helm, created, err := hm.getOrCreateEntry("dev/cluster")
			if err != nil || !created || helm.namespace != want {
				t.Fatalf("helm entry=%+v created=%v err=%v", helm, created, err)
			}
			same, created, err := hm.getOrCreateEntry("dev/cluster")
			if err != nil || created || same != helm {
				t.Fatal("helm entry not reused")
			}
			if stored, created := hm.storeEntryIfAbsent("dev/cluster", &helmEntry{}); created || stored != helm {
				t.Fatal("helm entry overwritten")
			}
			getter := helmRESTClientGetter{clientCfg: helm.clientCfg}
			if getter.ToRawKubeConfigLoader() != helm.clientCfg {
				t.Fatal("wrong config loader")
			}
			if _, err := getter.ToDiscoveryClient(); err != nil {
				t.Fatal(err)
			}
			if _, err := getter.ToRESTMapper(); err != nil {
				t.Fatal(err)
			}
		})
	}
	if NewWatchManager(nil).loadingRules == nil {
		t.Fatal("missing default loading rules")
	}
}

func TestLogSubscriptionsUseConfiguredContextAndClose(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if r.URL.Path != "/api/v1/namespaces/team/pods/api" {
			t.Errorf("unexpected API request %s", r.URL)
			http.NotFound(w, r)
			return
		}
		json.NewEncoder(w).Encode(corev1.Pod{TypeMeta: metav1.TypeMeta{Kind: "Pod", APIVersion: "v1"}, ObjectMeta: metav1.ObjectMeta{Name: "api", Namespace: "team"}})
	}))
	defer server.Close()
	manager := NewLogManager(testClusterRules(t, server.URL, "team"))
	for _, resource := range []string{"pods", "unsupported"} {
		t.Run(resource, func(t *testing.T) {
			ch, unsub, err := manager.Subscribe("dev/cluster", resource, "team", "api", 12)
			if err != nil {
				t.Fatal(err)
			}
			defer unsub()
			msg := decodeLogEnvelope(t, receiveBehaviorUpdate(t, ch))
			if resource == "pods" && msg.Info != "pod has no containers" {
				t.Fatalf("message: %+v", msg)
			}
			if resource == "unsupported" && !strings.Contains(msg.Error, "unsupported log resource") {
				t.Fatalf("message: %+v", msg)
			}
			select {
			case _, ok := <-ch:
				if ok {
					t.Fatal("expected closed channel")
				}
			case <-time.After(3 * time.Second):
				t.Fatal("subscription did not close")
			}
			unsub()
		})
	}
	if _, _, err := manager.Subscribe("missing", "pods", "team", "api", 10); err == nil {
		t.Fatal("missing context accepted")
	}
}

func TestManagerSubscriptionsReportInvalidKubeconfig(t *testing.T) {
	rules := &clientcmd.ClientConfigLoadingRules{ExplicitPath: filepath.Join(t.TempDir(), "missing")}
	if _, _, err := NewWatchManager(rules).Subscribe("dev", supportedResources["pods"]); err == nil {
		t.Fatal("watch accepted invalid config")
	}
	if _, _, err := NewHelmManager(rules).Subscribe("dev"); err == nil {
		t.Fatal("helm accepted invalid config")
	}
	if _, err := NewHelmManager(rules).History("dev", "api", "configmaps"); err == nil {
		t.Fatal("history accepted invalid config")
	}
}

func TestHTTPLogRouteStreamsAndUnsubscribes(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if r.URL.Query().Get("follow") == "true" {
			w.WriteHeader(200)
			w.(http.Flusher).Flush()
			<-r.Context().Done()
			return
		}
		if strings.HasSuffix(r.URL.Path, "/log") {
			w.Write([]byte("2026-11-15T00:00:00Z hello\n"))
			return
		}
		json.NewEncoder(w).Encode(corev1.Pod{TypeMeta: metav1.TypeMeta{APIVersion: "v1", Kind: "Pod"}, ObjectMeta: metav1.ObjectMeta{Name: "api", Namespace: "team"}, Spec: corev1.PodSpec{Containers: []corev1.Container{{Name: "app"}}}})
	}))
	defer server.Close()
	rules := testClusterRules(t, server.URL, "team")
	handler := newHTTPHandler(nil, NewWatchManager(rules), NewHelmManager(rules), NewLogManager(rules), newVersionChecker(), nil)
	for _, streaming := range []bool{true, false} {
		ctx, cancel := context.WithCancel(context.Background())
		req := httptest.NewRequest("GET", "/logs/dev%2Fcluster/pods/team/api?tailLines=9", nil).WithContext(ctx)
		if streaming {
			w := httptest.NewRecorder()
			handler.ServeHTTP(cancelOnFlush{w, cancel}, req)
			if !strings.Contains(w.Body.String(), "connected") {
				t.Fatal("missing connected event")
			}
		} else {
			w := &nonStreamingWriter{header: make(http.Header)}
			handler.ServeHTTP(w, req)
			if w.code != 500 {
				t.Fatalf("status %d", w.code)
			}
		}
		cancel()
	}
}

func receiveBehaviorUpdate(t *testing.T, updates <-chan []byte) []byte {
	t.Helper()
	select {
	case update, ok := <-updates:
		if !ok {
			t.Fatal("stream closed before expected event")
		}
		return update
	case <-time.After(4 * time.Second):
		t.Fatal("timed out waiting for event")
		return nil
	}
}
