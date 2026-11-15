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

	"helm.sh/helm/v3/pkg/release"
	"helm.sh/helm/v3/pkg/storage/driver"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/kubernetes/fake"
)

// Use Helm's storage drivers to build real encoded fixtures, then exercise the
// production HTTP client against a local API instead of bypassing list/history.
func helmFixtureServer(t *testing.T) (*httptest.Server, *atomic.Int32) {
	t.Helper()
	client := fake.NewSimpleClientset()
	for _, revision := range []int{1, 2} {
		rel := release.Mock(&release.MockReleaseOptions{Name: "api", Version: revision, Namespace: "team"})
		if err := driver.NewSecrets(client.CoreV1().Secrets("team")).Create(fmt.Sprintf("sh.helm.release.v1.api.v%d", revision), rel); err != nil {
			t.Fatal(err)
		}
	}
	rel := release.Mock(&release.MockReleaseOptions{Name: "api", Version: 1, Namespace: "team"})
	if err := driver.NewConfigMaps(client.CoreV1().ConfigMaps("team")).Create("sh.helm.release.v1.api.v1", rel); err != nil {
		t.Fatal(err)
	}
	secrets, err := client.CoreV1().Secrets("team").List(context.Background(), metav1.ListOptions{})
	if err != nil {
		t.Fatal(err)
	}
	configmaps, err := client.CoreV1().ConfigMaps("team").List(context.Background(), metav1.ListOptions{})
	if err != nil {
		t.Fatal(err)
	}
	secrets.TypeMeta = metav1.TypeMeta{APIVersion: "v1", Kind: "SecretList"}
	secrets.ResourceVersion = "10"
	configmaps.TypeMeta = metav1.TypeMeta{APIVersion: "v1", Kind: "ConfigMapList"}
	configmaps.ResourceVersion = "10"
	mode := &atomic.Int32{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if r.URL.Path == "/version" {
			if err := json.NewEncoder(w).Encode(map[string]string{"major": "1", "minor": "37", "gitVersion": "v1.37.2"}); err != nil {
				t.Errorf("write fixture JSON: %v", err)
			}
			return
		}
		if !strings.HasPrefix(r.URL.Path, "/api/v1/namespaces/team/") {
			t.Errorf("request escaped namespace: %s", r.URL)
			http.NotFound(w, r)
			return
		}
		if r.URL.Query().Get("watch") == "true" {
			w.WriteHeader(200)
			w.(http.Flusher).Flush()
			<-r.Context().Done()
			return
		}
		cm := strings.HasSuffix(r.URL.Path, "/configmaps")
		if !cm && !strings.HasSuffix(r.URL.Path, "/secrets") {
			t.Errorf("unexpected API request: %s", r.URL)
			http.NotFound(w, r)
			return
		}
		if mode.Load() == 3 || (mode.Load() == 1 && cm) {
			w.WriteHeader(403)
			if err := json.NewEncoder(w).Encode(metav1.Status{TypeMeta: metav1.TypeMeta{APIVersion: "v1", Kind: "Status"}, Status: "Failure", Reason: metav1.StatusReasonForbidden, Code: 403, Message: "fixture storage forbidden"}); err != nil {
				t.Errorf("write fixture JSON: %v", err)
			}
			return
		}
		if mode.Load() == 2 {
			if cm {
				if err := json.NewEncoder(w).Encode(corev1.ConfigMapList{TypeMeta: configmaps.TypeMeta}); err != nil {
					t.Errorf("write fixture JSON: %v", err)
				}
			} else {
				if err := json.NewEncoder(w).Encode(corev1.SecretList{TypeMeta: secrets.TypeMeta}); err != nil {
					t.Errorf("write fixture JSON: %v", err)
				}
			}
			return
		}
		if cm {
			if err := json.NewEncoder(w).Encode(configmaps); err != nil {
				t.Errorf("write fixture JSON: %v", err)
			}
		} else {
			if err := json.NewEncoder(w).Encode(secrets); err != nil {
				t.Errorf("write fixture JSON: %v", err)
			}
		}
	}))
	t.Cleanup(server.Close)
	return server, mode
}

func TestHelmRefreshDeduplicatesRevisionsAndReconcilesDeletions(t *testing.T) {
	server, mode := helmFixtureServer(t)
	manager := NewHelmManager(testClusterRules(t, server.URL, "team"))
	entry, _, err := manager.getOrCreateEntry("dev/cluster")
	if err != nil {
		t.Fatal(err)
	}
	releases, authoritative, err := entry.listReleases()
	if err != nil || !authoritative || len(releases) != 1 || releaseRevision(releases[0]) != 2 {
		t.Fatalf("list=%+v authoritative=%v err=%v", releases, authoritative, err)
	}
	updates := make(chan []byte, 32)
	entry.clients[updates] = struct{}{}
	entry.setTerminalError([]byte(`{"error":"old failure"}`))
	if err := entry.refresh(); err != nil {
		t.Fatal(err)
	}
	if eventType(t, receiveBehaviorUpdate(t, updates)) != "ADDED" || eventType(t, receiveBehaviorUpdate(t, updates)) != "SYNCED" {
		t.Fatal("missing initial release and sync")
	}
	if len(entry.terminalError) != 0 {
		t.Fatal("successful refresh retained stale error")
	}
	key := "helmrelease:team:api"
	if len(entry.objects) != 1 || entry.objects[key] == nil {
		t.Fatalf("cache %+v", entry.objects)
	}
	history, err := manager.History("dev/cluster", "api", "secrets")
	if err != nil || len(history) != 2 {
		t.Fatalf("history=%+v err=%v", history, err)
	}
	mode.Store(1)
	if err := entry.refresh(); err != nil {
		t.Fatal(err)
	}
	if eventType(t, receiveBehaviorUpdate(t, updates)) != "SYNCED" || len(entry.objects) != 1 {
		t.Fatal("partial refresh deleted cached release")
	}
	mode.Store(2)
	if err := entry.refresh(); err != nil {
		t.Fatal(err)
	}
	if eventType(t, receiveBehaviorUpdate(t, updates)) != "DELETED" || eventType(t, receiveBehaviorUpdate(t, updates)) != "SYNCED" || len(entry.objects) != 0 {
		t.Fatal("authoritative empty list did not remove release")
	}
	mode.Store(3)
	if err := entry.refresh(); err == nil {
		t.Fatal("all-driver failure accepted")
	}
	entry.setStorageTerminalError("secrets", "secrets denied", true)
	entry.setStorageTerminalError("configmaps", "configmaps denied", true)
	if _, authoritative, err := entry.listReleases(); err == nil || authoritative {
		t.Fatal("all skipped drivers accepted")
	}
}

func TestHelmSubscriptionRefreshesAndStops(t *testing.T) {
	server, _ := helmFixtureServer(t)
	manager := NewHelmManager(testClusterRules(t, server.URL, "team"))
	updates, unsubscribe, err := manager.Subscribe("dev/cluster")
	if err != nil {
		t.Fatal(err)
	}
	entry, ok := manager.lookupEntry("dev/cluster")
	if !ok {
		t.Fatal("entry missing")
	}
	defer func() { unsubscribe(); entry.stopIfIdle() }()
	if eventType(t, receiveBehaviorUpdate(t, updates)) != "ADDED" || eventType(t, receiveBehaviorUpdate(t, updates)) != "SYNCED" {
		t.Fatal("subscription did not populate releases")
	}
	// A second subscriber receives the current snapshot without a second manager entry.
	second, unsub2, err := manager.Subscribe("dev/cluster")
	if err != nil {
		t.Fatal(err)
	}
	defer unsub2()
	if eventType(t, receiveBehaviorUpdate(t, second)) != "ADDED" || eventType(t, receiveBehaviorUpdate(t, second)) != "SYNCED" {
		t.Fatal("late subscriber missing snapshot")
	}
	unsub2()
	unsubscribe()
	entry.stopIfIdle()
	deadline := time.After(3 * time.Second)
	for {
		entry.mu.Lock()
		running := entry.running
		entry.mu.Unlock()
		if !running {
			break
		}
		select {
		case <-deadline:
			t.Fatal("helm worker did not stop")
		case <-time.After(time.Millisecond):
		}
	}
}

func TestHTTPHelmHistoryAndResourceStreams(t *testing.T) {
	server, _ := helmFixtureServer(t)
	rules := testClusterRules(t, server.URL, "team")
	wm := NewWatchManager(rules)
	hm := NewHelmManager(rules)
	// Seed inactive shared entries with snapshots; HTTP disconnection should remove only its subscriber.
	entry, _, err := wm.getOrCreateEntry("dev/cluster", supportedResources["pods"])
	if err != nil {
		t.Fatal(err)
	}
	entry.running = true
	helm, _, err := hm.getOrCreateEntry("dev/cluster")
	if err != nil {
		t.Fatal(err)
	}
	helm.running = true
	handler := newHTTPHandler(nil, wm, hm, NewLogManager(rules), newVersionChecker(), nil)
	for _, resource := range []string{"pods", "helmreleases"} {
		ctx, cancel := context.WithCancel(context.Background())
		w := httptest.NewRecorder()
		handler.ServeHTTP(cancelOnFlush{w, cancel}, httptest.NewRequest("GET", "/sse/dev%2Fcluster/"+resource, nil).WithContext(ctx))
		cancel()
		if !strings.Contains(w.Body.String(), "connected") {
			t.Fatal("missing connection event")
		}
	}
	entry.mu.Lock()
	watchClients := len(entry.clients)
	if entry.idle != nil {
		entry.idle.Stop()
	}
	entry.mu.Unlock()
	helm.mu.Lock()
	helmClients := len(helm.clients)
	if helm.idle != nil {
		helm.idle.Stop()
	}
	helm.mu.Unlock()
	if watchClients != 0 || helmClients != 0 {
		t.Fatalf("leaked HTTP subscribers: watch=%d helm=%d", watchClients, helmClients)
	}
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, httptest.NewRequest("GET", "/api/helm-history/dev%2Fcluster/secrets/api", nil))
	var revisions []map[string]interface{}
	if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &revisions) != nil || len(revisions) != 2 {
		t.Fatalf("history response %d %s", w.Code, w.Body.String())
	}
}
