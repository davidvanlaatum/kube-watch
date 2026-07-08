package main

import (
	"crypto/rand"
	"crypto/rsa"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"embed"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"io/fs"
	"log/slog"
	"math/big"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"

	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/client-go/tools/clientcmd"
	"k8s.io/client-go/tools/clientcmd/api"
)

//go:embed web/dist
var embeddedDist embed.FS

var supportedResources = map[string]schema.GroupVersionResource{
	"pods":                 {Group: "", Version: "v1", Resource: "pods"},
	"deployments":          {Group: "apps", Version: "v1", Resource: "deployments"},
	"statefulsets":         {Group: "apps", Version: "v1", Resource: "statefulsets"},
	"replicasets":          {Group: "apps", Version: "v1", Resource: "replicasets"},
	"services":             {Group: "", Version: "v1", Resource: "services"},
	"jobs":                 {Group: "batch", Version: "v1", Resource: "jobs"},
	"cronjobs":             {Group: "batch", Version: "v1", Resource: "cronjobs"},
	"hpas":                 {Group: "autoscaling", Version: "v2", Resource: "horizontalpodautoscalers"},
	"configmaps":           {Group: "", Version: "v1", Resource: "configmaps"},
	"secrets":              {Group: "", Version: "v1", Resource: "secrets"},
	"serviceaccounts":      {Group: "", Version: "v1", Resource: "serviceaccounts"},
	"poddisruptionbudgets": {Group: "policy", Version: "v1", Resource: "poddisruptionbudgets"},
	"networkpolicies":      {Group: "networking.k8s.io", Version: "v1", Resource: "networkpolicies"},
	"events":               {Group: "", Version: "v1", Resource: "events"},
}

func main() {
	loadingRules := clientcmd.NewDefaultClientConfigLoadingRules()
	config, err := loadingRules.Load()
	if err != nil {
		slog.Error("failed to load kubeconfig", "paths", loadingRules.GetLoadingPrecedence(), "existing_paths", existingFiles(loadingRules.GetLoadingPrecedence()), "error", err)
		os.Exit(1)
	}

	contexts := listContexts(config, loadingRules)
	slog.Info("loaded kubeconfig", "paths", loadingRules.GetLoadingPrecedence(), "existing_paths", existingFiles(loadingRules.GetLoadingPrecedence()), "context_count", len(contexts))
	if len(contexts) == 0 {
		slog.Warn("no kubeconfig contexts discovered", "paths", loadingRules.GetLoadingPrecedence(), "existing_paths", existingFiles(loadingRules.GetLoadingPrecedence()), "hint", "confirm the app process has the same KUBECONFIG environment as kubectl")
	} else {
		slog.Info("discovered kubeconfig contexts", "contexts", contextSummaries(contexts))
	}

	// generate self-signed certs if not present
	certPath := filepath.Join("./certs", "cert.pem")
	keyPath := filepath.Join("./certs", "key.pem")
	if _, err := os.Stat(certPath); os.IsNotExist(err) {
		slog.Info("generating self-signed TLS certs", "directory", "./certs")
		if err := generateSelfSignedCert(certPath, keyPath); err != nil {
			slog.Error("failed to generate certs", "error", err)
			os.Exit(1)
		}
	}

	// instantiate watch manager
	wm := NewWatchManager(loadingRules)
	lm := NewLogManager(loadingRules)
	vc := newVersionChecker()

	mux := http.NewServeMux()
	distFS, err := fs.Sub(embeddedDist, "web/dist")
	if err != nil {
		slog.Error("failed to load embedded frontend", "error", err)
		os.Exit(1)
	}
	fileServer := http.FileServer(http.FS(distFS))
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		p := strings.TrimPrefix(r.URL.Path, "/")
		if p == "" || p == "/" {
			http.ServeFileFS(w, r, distFS, "index.html")
			return
		}
		if f, err := distFS.Open(p); err != nil {
			http.ServeFileFS(w, r, distFS, "index.html")
			return
		} else {
			f.Close()
			fileServer.ServeHTTP(w, r)
		}
	})

	mux.HandleFunc("/api/contexts", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(contexts)
	})

	mux.HandleFunc("/api/version", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(vc.Check(r.Context()))
	})

	mux.HandleFunc("/sse/", func(w http.ResponseWriter, r *http.Request) {
		// URL format: /sse/{context}/{resource}
		parts := strings.Split(strings.TrimPrefix(r.URL.Path, "/sse/"), "/")
		if len(parts) < 2 {
			http.Error(w, "expected /sse/{context}/{resource}", http.StatusBadRequest)
			return
		}
		ctxName := parts[0]
		resource := parts[1]
		if _, ok := supportedResources[resource]; !ok {
			http.Error(w, "unsupported resource", http.StatusBadRequest)
			return
		}

		gvr := supportedResources[resource]
		ch, unsub, err := wm.Subscribe(ctxName, gvr)
		if err != nil {
			http.Error(w, fmt.Sprintf("subscribe failed: %v", err), http.StatusInternalServerError)
			return
		}
		defer unsub()

		flusher, ok := w.(http.Flusher)
		if !ok {
			http.Error(w, "streaming unsupported", http.StatusInternalServerError)
			return
		}

		w.Header().Set("Content-Type", "text/event-stream")
		w.Header().Set("Cache-Control", "no-cache")
		w.Header().Set("Connection", "keep-alive")

		// send a short ping
		fmt.Fprintf(w, "data: %s\n\n", []byte("{\"info\":\"connected\"}"))
		flusher.Flush()

		notify := w.(http.CloseNotifier).CloseNotify()
		for {
			select {
			case <-notify:
				return
			case b, ok := <-ch:
				if !ok {
					return
				}
				fmt.Fprintf(w, "data: %s\n\n", b)
				flusher.Flush()
			}
		}
	})

	mux.HandleFunc("/logs/", func(w http.ResponseWriter, r *http.Request) {
		// URL format: /logs/{context}/{resource}/{namespace}/{name}
		parts := strings.Split(strings.TrimPrefix(r.URL.Path, "/logs/"), "/")
		if len(parts) < 4 {
			http.Error(w, "expected /logs/{context}/{resource}/{namespace}/{name}", http.StatusBadRequest)
			return
		}
		ctxName, err := urlPathSegment(parts[0])
		if err != nil {
			http.Error(w, "invalid context", http.StatusBadRequest)
			return
		}
		resource, err := urlPathSegment(parts[1])
		if err != nil {
			http.Error(w, "invalid resource", http.StatusBadRequest)
			return
		}
		namespace, err := urlPathSegment(parts[2])
		if err != nil {
			http.Error(w, "invalid namespace", http.StatusBadRequest)
			return
		}
		name, err := urlPathSegment(parts[3])
		if err != nil {
			http.Error(w, "invalid name", http.StatusBadRequest)
			return
		}
		if resource != "pods" && resource != "deployments" {
			http.Error(w, "logs are supported for pods and deployments", http.StatusBadRequest)
			return
		}
		tailLines := parseTailLines(r.URL.Query().Get("tailLines"))
		ch, unsub, err := lm.Subscribe(ctxName, resource, namespace, name, tailLines)
		if err != nil {
			http.Error(w, fmt.Sprintf("subscribe logs failed: %v", err), http.StatusInternalServerError)
			return
		}
		defer unsub()

		flusher, ok := w.(http.Flusher)
		if !ok {
			http.Error(w, "streaming unsupported", http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "text/event-stream")
		w.Header().Set("Cache-Control", "no-cache")
		w.Header().Set("Connection", "keep-alive")
		fmt.Fprintf(w, "data: %s\n\n", []byte("{\"info\":\"connected\"}"))
		flusher.Flush()

		notify := w.(http.CloseNotifier).CloseNotify()
		for {
			select {
			case <-notify:
				return
			case b, ok := <-ch:
				if !ok {
					return
				}
				fmt.Fprintf(w, "data: %s\n\n", b)
				flusher.Flush()
			}
		}
	})

	srv := &http.Server{
		Addr:    ":9443",
		Handler: cors(mux),
	}

	cert, _ := tls.LoadX509KeyPair(certPath, keyPath)
	srv.TLSConfig = &tls.Config{Certificates: []tls.Certificate{cert}}

	slog.Info("server listening", "addr", "https://localhost:9443", "endpoints", "/api/contexts,/api/version,/sse/{context}/{resource},/logs/{context}/{resource}/{namespace}/{name}")
	if err := srv.ListenAndServeTLS("", ""); err != nil {
		slog.Error("server stopped", "error", err)
		os.Exit(1)
	}
}

func listContexts(cfg *api.Config, loadingRules *clientcmd.ClientConfigLoadingRules) []map[string]string {
	out := make([]map[string]string, 0, len(cfg.Contexts))
	names := make([]string, 0, len(cfg.Contexts))
	for k := range cfg.Contexts {
		names = append(names, k)
	}
	sort.Strings(names)
	for _, k := range names {
		// attempt to read the namespace for this context
		overrides := &clientcmd.ConfigOverrides{CurrentContext: k}
		clientCfg := clientcmd.NewNonInteractiveDeferredLoadingClientConfig(loadingRules, overrides)
		ns, _, err := clientCfg.Namespace()
		if err != nil || ns == "" {
			if err != nil {
				slog.Warn("failed to resolve context namespace; using default namespace", "context", k, "error", err)
			}
			ns = "default"
		}
		out = append(out, map[string]string{"name": k, "namespace": ns})
	}
	return out
}

func existingFiles(paths []string) []string {
	existing := make([]string, 0, len(paths))
	for _, path := range paths {
		if _, err := os.Stat(path); err == nil {
			existing = append(existing, path)
		}
	}
	return existing
}

func contextSummaries(contexts []map[string]string) []string {
	summaries := make([]string, 0, len(contexts))
	for _, ctx := range contexts {
		summaries = append(summaries, fmt.Sprintf("%s namespace=%s", ctx["name"], ctx["namespace"]))
	}
	return summaries
}

func urlPathSegment(segment string) (string, error) {
	value, err := url.PathUnescape(segment)
	if err != nil {
		return "", err
	}
	if value == "" || strings.Contains(value, "/") {
		return "", fmt.Errorf("invalid path segment")
	}
	return value, nil
}

func parseTailLines(value string) int64 {
	if value == "" {
		return 200
	}
	parsed, err := strconv.ParseInt(value, 10, 64)
	if err != nil || parsed < 0 {
		return 200
	}
	if parsed > 5000 {
		return 5000
	}
	return parsed
}

// generate a minimal self-signed cert for localhost
func generateSelfSignedCert(certPath, keyPath string) error {
	priv, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		return err
	}

	now := time.Now()
	serial, _ := rand.Int(rand.Reader, big.NewInt(1<<62))
	tmpl := x509.Certificate{
		SerialNumber: serial,
		Subject: pkix.Name{
			Organization: []string{"kube-watch"},
		},
		NotBefore:   now.Add(-time.Hour),
		NotAfter:    now.AddDate(1, 0, 0),
		DNSNames:    []string{"localhost"},
		KeyUsage:    x509.KeyUsageDigitalSignature | x509.KeyUsageKeyEncipherment,
		ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
	}

	der, err := x509.CreateCertificate(rand.Reader, &tmpl, &tmpl, &priv.PublicKey, priv)
	if err != nil {
		return err
	}

	certOut, err := os.Create(certPath)
	if err != nil {
		return err
	}
	pem.Encode(certOut, &pem.Block{Type: "CERTIFICATE", Bytes: der})
	certOut.Close()

	keyOut, err := os.Create(keyPath)
	if err != nil {
		return err
	}
	pem.Encode(keyOut, &pem.Block{Type: "RSA PRIVATE KEY", Bytes: x509.MarshalPKCS1PrivateKey(priv)})
	keyOut.Close()
	return nil
}

// CORS helper
func cors(h http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Methods", "GET, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
		if r.Method == "OPTIONS" {
			w.WriteHeader(http.StatusOK)
			return
		}
		h.ServeHTTP(w, r)
	})
}
