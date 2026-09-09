package main

import (
	"encoding/json"
	"errors"
	"testing"

	"helm.sh/helm/v3/pkg/action"
	kubefake "helm.sh/helm/v3/pkg/kube/fake"
	"helm.sh/helm/v3/pkg/release"
	"helm.sh/helm/v3/pkg/storage"
	"helm.sh/helm/v3/pkg/storage/driver"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/client-go/tools/clientcmd"
)

func TestIsHelmStorageObjectRecognizesSecretsAndConfigMaps(t *testing.T) {
	cases := []struct {
		name string
		obj  *unstructured.Unstructured
		want bool
	}{
		{
			name: "helm secret type",
			obj: &unstructured.Unstructured{Object: map[string]interface{}{
				"metadata": map[string]interface{}{"name": "sh.helm.release.v1.api.v1"},
				"type":     "helm.sh/release.v1",
			}},
			want: true,
		},
		{
			name: "helm configmap label",
			obj: &unstructured.Unstructured{Object: map[string]interface{}{
				"metadata": map[string]interface{}{
					"name":   "sh.helm.release.v1.api.v1",
					"labels": map[string]interface{}{"owner": "helm", "name": "api"},
				},
			}},
			want: true,
		},
		{
			name: "regular configmap",
			obj: &unstructured.Unstructured{Object: map[string]interface{}{
				"metadata": map[string]interface{}{"name": "app-config"},
			}},
			want: false,
		},
	}

	for _, tt := range cases {
		t.Run(tt.name, func(t *testing.T) {
			if got := isHelmStorageObject(tt.obj); got != tt.want {
				t.Fatalf("isHelmStorageObject() = %v, want %v", got, tt.want)
			}
		})
	}
}

func TestHelmEntryUpdateCacheUsesSyntheticUID(t *testing.T) {
	entry := &helmEntry{
		clients: make(map[chan []byte]struct{}),
		cache:   make(map[string][]byte),
		objects: make(map[string][]byte),
	}
	msg := []byte(`{"type":"ADDED","object":{"metadata":{"uid":"helmrelease:default:api","name":"api","namespace":"default"}}}`)

	entry.updateCache(msg)

	if got := string(entry.cache["helmrelease:default:api"]); got != string(msg) {
		t.Fatalf("cached event = %q, want %q", got, msg)
	}
	entry.updateCache([]byte(`{"type":"DELETED","object":{"metadata":{"uid":"helmrelease:default:api","name":"api","namespace":"default"}}}`))
	if _, ok := entry.cache["helmrelease:default:api"]; ok {
		t.Fatal("expected delete event to remove cached release")
	}
}

func TestHelmStorageTerminalErrorsPersistOutsideRefreshErrors(t *testing.T) {
	entry := &helmEntry{
		clients:               make(map[chan []byte]struct{}),
		cache:                 make(map[string][]byte),
		objects:               make(map[string][]byte),
		storageTerminalErrors: make(map[string]storageTerminalError),
	}

	entry.setStorageTerminalError("configmaps", "helm storage watch forbidden: configmaps is forbidden", false)
	entry.clearTerminalError()

	var envelope map[string]string
	if err := json.Unmarshal(entry.storageTerminalErrorEvent(), &envelope); err != nil {
		t.Fatalf("storage terminal error should be JSON: %v", err)
	}
	if envelope["error"] != "helm storage watch forbidden: configmaps is forbidden" {
		t.Fatalf("storage error = %q", envelope["error"])
	}

	entry.clearStorageTerminalError("configmaps")
	if msg := entry.storageTerminalErrorEvent(); msg != nil {
		t.Fatalf("storage terminal error after clear = %s, expected nil", msg)
	}
}

func TestChartDetailsAndFirstDeployedHandleNilFields(t *testing.T) {
	if name, version, app := chartDetails(nil); name != "" || version != "" || app != "" {
		t.Fatalf("chartDetails(nil) = %q %q %q, expected empty", name, version, app)
	}
	if got := firstDeployed(nil); got != "" {
		t.Fatalf("firstDeployed(nil) = %q, expected empty", got)
	}

	rel := release.Mock(&release.MockReleaseOptions{Name: "api", Version: 3, Namespace: "prod"})
	name, version, app := chartDetails(rel)
	if name != "foo" || version != "0.1.0-beta.1" || app != "1.0" {
		t.Fatalf("chartDetails = %q %q %q", name, version, app)
	}
	if got := firstDeployed(rel); got == "" {
		t.Fatal("expected non-empty firstDeployed timestamp")
	}
}

func TestReleaseObjectBuildsExpectedShape(t *testing.T) {
	rel := release.Mock(&release.MockReleaseOptions{Name: "api", Version: 2, Namespace: "prod"})
	entry := &helmEntry{namespace: "default"}

	obj := entry.releaseObject(nil, rel, "secrets")

	meta, _ := obj["metadata"].(map[string]interface{})
	if meta["name"] != "api" || meta["namespace"] != "prod" {
		t.Fatalf("metadata = %#v", meta)
	}
	if meta["uid"] != "helmrelease:prod:api" {
		t.Fatalf("uid = %v", meta["uid"])
	}
	status, _ := obj["status"].(map[string]interface{})
	if status["storageDriver"] != "secrets" || status["revision"] != 2 {
		t.Fatalf("status = %#v", status)
	}
	if key := objectKey(obj); key != "helmrelease:prod:api" {
		t.Fatalf("objectKey = %q", key)
	}
	if got := releaseRevision(obj); got != 2 {
		t.Fatalf("releaseRevision = %d, want 2", got)
	}
}

func TestReleaseObjectFallsBackToEntryNamespace(t *testing.T) {
	rel := release.Mock(&release.MockReleaseOptions{Name: "api", Version: 1})
	rel.Namespace = ""
	entry := &helmEntry{namespace: "fallback-ns"}

	obj := entry.releaseObject(nil, rel, "configmaps")
	meta, _ := obj["metadata"].(map[string]interface{})
	if meta["namespace"] != "fallback-ns" {
		t.Fatalf("namespace = %v, want fallback-ns", meta["namespace"])
	}
}

func TestObjectKeyFallsBackToNameNamespace(t *testing.T) {
	obj := map[string]interface{}{
		"metadata": map[string]interface{}{"name": "api", "namespace": "prod"},
	}
	if got := objectKey(obj); got != "api/prod" {
		t.Fatalf("objectKey = %q, want api/prod", got)
	}
	if got := objectKey(map[string]interface{}{"metadata": map[string]interface{}{}}); got != "" {
		t.Fatalf("objectKey with no name = %q, want empty", got)
	}
}

func TestHelmHistoryReturnsRevisionsFromStorage(t *testing.T) {
	cfg := &action.Configuration{
		Releases:   storage.Init(driver.NewMemory()),
		KubeClient: &kubefake.PrintingKubeClient{},
		Log:        func(string, ...interface{}) {},
	}
	for _, version := range []int{1, 2} {
		rel := release.Mock(&release.MockReleaseOptions{Name: "api", Version: version, Namespace: "prod"})
		if err := cfg.Releases.Create(rel); err != nil {
			t.Fatalf("create mock release: %v", err)
		}
	}

	history, err := helmHistory(cfg, "api")
	if err != nil {
		t.Fatalf("helmHistory: %v", err)
	}
	if len(history) != 2 {
		t.Fatalf("history entries = %d, want 2", len(history))
	}
	for _, entry := range history {
		if entry["chart"] != "foo" {
			t.Fatalf("history entry chart = %v", entry["chart"])
		}
	}
}

func TestJoinErrorsJoinsNonNilMessages(t *testing.T) {
	got := joinErrors([]error{errors.New("a"), nil, errors.New("b")})
	if got != "a; b" {
		t.Fatalf("joinErrors = %q, want %q", got, "a; b")
	}
}

func TestHelmEntryEmitObjectBroadcastsAddedThenModified(t *testing.T) {
	entry := &helmEntry{
		clients:               make(map[chan []byte]struct{}),
		cache:                 make(map[string][]byte),
		objects:               make(map[string][]byte),
		storageTerminalErrors: make(map[string]storageTerminalError),
	}
	ch := make(chan []byte, 4)
	entry.clients[ch] = struct{}{}

	entry.emitObject("k1", []byte(`{"metadata":{"uid":"k1","name":"api","namespace":"default"}}`))
	added := decodeEnvelopeType(t, <-ch)
	if added != "ADDED" {
		t.Fatalf("first event type = %q, want ADDED", added)
	}

	entry.emitObject("k1", []byte(`{"metadata":{"uid":"k1","name":"api","namespace":"default"},"status":{"revision":2}}`))
	modified := decodeEnvelopeType(t, <-ch)
	if modified != "MODIFIED" {
		t.Fatalf("second event type = %q, want MODIFIED", modified)
	}

	entry.emitObject("k1", []byte(`{"metadata":{"uid":"k1","name":"api","namespace":"default"},"status":{"revision":2}}`))
	select {
	case msg := <-ch:
		t.Fatalf("unexpected event for unchanged object: %s", msg)
	default:
	}
}

func TestHelmEntryDeleteMissingBroadcastsDeletedEvents(t *testing.T) {
	entry := &helmEntry{
		clients: make(map[chan []byte]struct{}),
		cache:   make(map[string][]byte),
		objects: map[string][]byte{
			"k1": []byte(`{"metadata":{"uid":"k1","name":"api","namespace":"default"}}`),
		},
	}
	ch := make(chan []byte, 4)
	entry.clients[ch] = struct{}{}

	entry.deleteMissing(map[string][]byte{})

	deleted := decodeEnvelopeType(t, <-ch)
	if deleted != "DELETED" {
		t.Fatalf("event type = %q, want DELETED", deleted)
	}
	if _, ok := entry.objects["k1"]; ok {
		t.Fatal("expected object to be removed from tracked objects")
	}
}

func TestHelmEntryTerminalErrorSnapshotPrefersTerminalError(t *testing.T) {
	entry := &helmEntry{
		terminalError:         []byte(`{"error":"fatal"}`),
		storageTerminalErrors: map[string]storageTerminalError{"secrets": {message: "storage down"}},
	}
	if got := string(entry.terminalErrorSnapshotLocked()); got != `{"error":"fatal"}` {
		t.Fatalf("terminalErrorSnapshotLocked = %s", got)
	}

	entry.terminalError = nil
	var envelope map[string]string
	if err := json.Unmarshal(entry.terminalErrorSnapshotLocked(), &envelope); err != nil {
		t.Fatalf("decode fallback snapshot: %v", err)
	}
	if envelope["error"] != "storage down" {
		t.Fatalf("fallback error = %q", envelope["error"])
	}
}

func TestHelmEntryStorageTerminalErrorEventSortsResources(t *testing.T) {
	entry := &helmEntry{
		storageTerminalErrors: map[string]storageTerminalError{
			"secrets":    {message: "secrets failed"},
			"configmaps": {message: "configmaps failed"},
		},
	}
	var envelope map[string]string
	if err := json.Unmarshal(entry.storageTerminalErrorEventLocked(), &envelope); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if envelope["error"] != "configmaps failed; secrets failed" {
		t.Fatalf("error = %q", envelope["error"])
	}
}

func TestNewHelmManagerDefaultsLoadingRules(t *testing.T) {
	m := NewHelmManager(nil)
	if m.loadingRules == nil {
		t.Fatal("expected default loading rules to be set")
	}
	if m.entries == nil {
		t.Fatal("expected entries map to be initialized")
	}
}

func TestHelmEntrySetTerminalError(t *testing.T) {
	entry := newTestHelmEntry()
	entry.setTerminalError([]byte(`{"error":"boom"}`))
	if string(entry.terminalError) != `{"error":"boom"}` {
		t.Fatalf("terminalError = %s", entry.terminalError)
	}
	entry.clearTerminalError()
	if entry.terminalError != nil {
		t.Fatalf("terminalError after clear = %s, want nil", entry.terminalError)
	}
}

func TestHelmManagerListReleasesFailsWhenAllDriversUnreachable(t *testing.T) {
	over := &clientcmd.ConfigOverrides{CurrentContext: "missing-context"}
	badCfg := clientcmd.NewNonInteractiveDeferredLoadingClientConfig(
		clientcmd.NewDefaultClientConfigLoadingRules(), over)

	entry := newTestHelmEntry()
	entry.clientCfg = badCfg

	_, _, err := entry.listReleases()
	if err == nil {
		t.Fatal("expected listReleases to fail when the cluster config cannot be built")
	}
}

func decodeEnvelopeType(t *testing.T, msg []byte) string {
	t.Helper()
	var envelope struct {
		Type string `json:"type"`
	}
	if err := json.Unmarshal(msg, &envelope); err != nil {
		t.Fatalf("decode envelope %q: %v", msg, err)
	}
	return envelope.Type
}
