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
	rules := &clientcmd.ClientConfigLoadingRules{ExplicitPath: kubeconfigPath}

	contexts := listContexts(cfg, rules)

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

func TestDefaultLoadingRulesMergeMultipleKubeconfigFiles(t *testing.T) {
	dir := t.TempDir()
	firstPath := filepath.Join(dir, "first")
	secondPath := filepath.Join(dir, "second")
	first := api.Config{
		Clusters: map[string]*api.Cluster{
			"first-cluster": {Server: "https://first.example.invalid"},
		},
		AuthInfos: map[string]*api.AuthInfo{
			"first-user": {},
		},
		Contexts: map[string]*api.Context{
			"first": {Cluster: "first-cluster", AuthInfo: "first-user", Namespace: "one"},
		},
	}
	second := api.Config{
		Clusters: map[string]*api.Cluster{
			"second-cluster": {Server: "https://second.example.invalid"},
		},
		AuthInfos: map[string]*api.AuthInfo{
			"second-user": {},
		},
		Contexts: map[string]*api.Context{
			"second": {Cluster: "second-cluster", AuthInfo: "second-user", Namespace: "two"},
		},
	}
	if err := clientcmd.WriteToFile(first, firstPath); err != nil {
		t.Fatalf("write first kubeconfig: %v", err)
	}
	if err := clientcmd.WriteToFile(second, secondPath); err != nil {
		t.Fatalf("write second kubeconfig: %v", err)
	}
	rules := &clientcmd.ClientConfigLoadingRules{Precedence: []string{firstPath, secondPath}}
	cfg, err := rules.Load()
	if err != nil {
		t.Fatalf("load merged kubeconfigs: %v", err)
	}

	contexts := listContexts(cfg, rules)

	if len(contexts) != 2 {
		t.Fatalf("expected 2 merged contexts, got %d: %#v", len(contexts), contexts)
	}
	if contexts[0]["name"] != "first" || contexts[0]["namespace"] != "one" {
		t.Fatalf("first context = %#v", contexts[0])
	}
	if contexts[1]["name"] != "second" || contexts[1]["namespace"] != "two" {
		t.Fatalf("second context = %#v", contexts[1])
	}
}

func TestExistingFilesFiltersMissingPaths(t *testing.T) {
	dir := t.TempDir()
	existingPath := filepath.Join(dir, "config")
	missingPath := filepath.Join(dir, "missing")
	if err := os.WriteFile(existingPath, []byte("apiVersion: v1\nkind: Config\n"), 0600); err != nil {
		t.Fatalf("write existing file: %v", err)
	}

	files := existingFiles([]string{missingPath, existingPath})

	if len(files) != 1 || files[0] != existingPath {
		t.Fatalf("existing files = %#v, expected only %q", files, existingPath)
	}
}

func TestContextSummariesIncludesNameAndNamespace(t *testing.T) {
	contexts := []map[string]string{
		{"name": "alpha", "namespace": "default"},
		{"name": "prod", "namespace": "payments"},
	}

	summaries := contextSummaries(contexts)

	expected := []string{"alpha namespace=default", "prod namespace=payments"}
	if len(summaries) != len(expected) {
		t.Fatalf("summaries = %#v, expected %#v", summaries, expected)
	}
	for i := range expected {
		if summaries[i] != expected[i] {
			t.Fatalf("summary %d = %q, expected %q", i, summaries[i], expected[i])
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
