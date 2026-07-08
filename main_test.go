package main

import (
	"os"
	"path/filepath"
	"testing"

	"k8s.io/client-go/tools/clientcmd"
	"k8s.io/client-go/tools/clientcmd/api"
)

func TestListContextsReturnsStableSortedContexts(t *testing.T) {
	cfg := &api.Config{
		Clusters: map[string]*api.Cluster{
			"cluster": {Server: "https://example.invalid"},
		},
		AuthInfos: map[string]*api.AuthInfo{
			"user": {},
		},
		Contexts: map[string]*api.Context{
			"zeta":  {Cluster: "cluster", AuthInfo: "user", Namespace: "z-ns"},
			"alpha": {Cluster: "cluster", AuthInfo: "user", Namespace: "a-ns"},
			"beta":  {Cluster: "cluster", AuthInfo: "user"},
		},
	}
	kubeconfigPath := filepath.Join(t.TempDir(), "config")
	if err := clientcmd.WriteToFile(*cfg, kubeconfigPath); err != nil {
		t.Fatalf("write kubeconfig: %v", err)
	}

	contexts := listContexts(cfg, kubeconfigPath)

	if len(contexts) != 3 {
		t.Fatalf("expected 3 contexts, got %d", len(contexts))
	}
	expected := []map[string]string{
		{"name": "alpha", "namespace": "a-ns"},
		{"name": "beta", "namespace": "default"},
		{"name": "zeta", "namespace": "z-ns"},
	}
	for i := range expected {
		if contexts[i]["name"] != expected[i]["name"] || contexts[i]["namespace"] != expected[i]["namespace"] {
			t.Fatalf("context %d = %#v, expected %#v", i, contexts[i], expected[i])
		}
	}
}

func TestGenerateSelfSignedCertCreatesParentDirectoryFiles(t *testing.T) {
	dir := t.TempDir()
	certPath := filepath.Join(dir, "cert.pem")
	keyPath := filepath.Join(dir, "key.pem")

	if err := generateSelfSignedCert(certPath, keyPath); err != nil {
		t.Fatalf("generate cert: %v", err)
	}
	for _, path := range []string{certPath, keyPath} {
		info, err := os.Stat(path)
		if err != nil {
			t.Fatalf("expected %s to exist: %v", path, err)
		}
		if info.Size() == 0 {
			t.Fatalf("expected %s to be non-empty", path)
		}
	}
}
