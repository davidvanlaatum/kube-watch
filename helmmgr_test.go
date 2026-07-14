package main

import (
	"encoding/json"
	"testing"

	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
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
