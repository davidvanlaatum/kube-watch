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
	"net"
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

var backendLogHub = newBrowserLogHub()

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
	slog.SetDefault(slog.New(&browserLogHandler{
		next: slog.NewTextHandler(os.Stderr, nil),
		hub:  backendLogHub,
	}))

	if len(os.Args) > 1 {
		switch os.Args[1] {
		case "selfupdate", "self-update":
			if err := runSelfUpdate(os.Args[2:], os.Stdout); err != nil {
				fmt.Fprintf(os.Stderr, "selfupdate failed: %v\n", err)
				os.Exit(1)
			}
			return
		}
	}

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
	if err := ensureTLSFilePermissions(keyPath); err != nil {
		slog.Error("failed to secure TLS key permissions", "path", keyPath, "error", err)
		os.Exit(1)
	}

	// instantiate watch manager
	wm := NewWatchManager(loadingRules)
	hm := NewHelmManager(loadingRules)
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

	mux.HandleFunc("/api/backend-logs", func(w http.ResponseWriter, r *http.Request) {
		streamBackendLogs(w, r)
	})

	mux.HandleFunc("/api/helm-history/", func(w http.ResponseWriter, r *http.Request) {
		// URL format: /api/helm-history/{context}/{driver}/{name}
		parts := escapedPathSegments(r, "/api/helm-history/")
		if len(parts) < 3 {
			http.Error(w, "expected /api/helm-history/{context}/{driver}/{name}", http.StatusBadRequest)
			return
		}
		ctxName, err := urlPathValue(parts[0])
		if err != nil {
			http.Error(w, "invalid context", http.StatusBadRequest)
			return
		}
		driver, err := urlPathSegment(parts[1])
		if err != nil {
			http.Error(w, "invalid driver", http.StatusBadRequest)
			return
		}
		name, err := urlPathSegment(parts[2])
		if err != nil {
			http.Error(w, "invalid release name", http.StatusBadRequest)
			return
		}
		history, err := hm.History(ctxName, name, driver)
		if err != nil {
			http.Error(w, fmt.Sprintf("helm history failed: %v", err), http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(history)
	})

	mux.HandleFunc("/sse/", func(w http.ResponseWriter, r *http.Request) {
		// URL format: /sse/{context}/{resource}
		parts := escapedPathSegments(r, "/sse/")
		if len(parts) < 2 {
			http.Error(w, "expected /sse/{context}/{resource}", http.StatusBadRequest)
			return
		}
		ctxName, err := urlPathValue(parts[0])
		if err != nil {
			http.Error(w, "invalid context", http.StatusBadRequest)
			return
		}
		resource, err := urlPathSegment(parts[1])
		if err != nil {
			http.Error(w, "invalid resource", http.StatusBadRequest)
			return
		}
		if resource == helmReleasesResource {
			ch, unsub, err := hm.Subscribe(ctxName)
			if err != nil {
				streamSSEError(w, "subscribe failed", err)
				return
			}
			defer unsub()
			streamSSE(w, r, ch)
			return
		}
		if _, ok := supportedResources[resource]; !ok {
			http.Error(w, "unsupported resource", http.StatusBadRequest)
			return
		}

		gvr := supportedResources[resource]
		ch, unsub, err := wm.Subscribe(ctxName, gvr)
		if err != nil {
			streamSSEError(w, "subscribe failed", err)
			return
		}
		defer unsub()

		streamSSE(w, r, ch)
	})

	mux.HandleFunc("/logs/", func(w http.ResponseWriter, r *http.Request) {
		// URL format: /logs/{context}/{resource}/{namespace}/{name}
		parts := escapedPathSegments(r, "/logs/")
		if len(parts) < 4 {
			http.Error(w, "expected /logs/{context}/{resource}/{namespace}/{name}", http.StatusBadRequest)
			return
		}
		ctxName, err := urlPathValue(parts[0])
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
			streamSSEError(w, "subscribe logs failed", err)
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

		for {
			select {
			case <-r.Context().Done():
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
		Addr:    "127.0.0.1:9443",
		Handler: cors(mux),
	}

	cert, err := tls.LoadX509KeyPair(certPath, keyPath)
	if err != nil {
		slog.Error("failed to load TLS certificate", "cert", certPath, "key", keyPath, "error", err)
		os.Exit(1)
	}
	srv.TLSConfig = &tls.Config{Certificates: []tls.Certificate{cert}}

	slog.Info("server listening", "addr", "https://127.0.0.1:9443", "endpoints", "/api/contexts,/api/version,/sse/{context}/{resource},/logs/{context}/{resource}/{namespace}/{name}")
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

func streamSSE(w http.ResponseWriter, r *http.Request, ch <-chan []byte) {
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

	for {
		select {
		case <-r.Context().Done():
			return
		case b, ok := <-ch:
			if !ok {
				return
			}
			fmt.Fprintf(w, "data: %s\n\n", b)
			flusher.Flush()
		}
	}
}

func streamBackendLogs(w http.ResponseWriter, r *http.Request) {
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

	logCh, unsubscribe := backendLogHub.subscribe()
	defer unsubscribe()

	for {
		select {
		case <-r.Context().Done():
			return
		case b := <-logCh:
			fmt.Fprintf(w, "data: %s\n\n", b)
			flusher.Flush()
		}
	}
}

func streamSSEError(w http.ResponseWriter, prefix string, err error) {
	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, fmt.Sprintf("%s: %v", prefix, err), http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	fmt.Fprintf(w, "data: %s\n\n", errorEvent(prefix, err))
	flusher.Flush()
}

func urlPathSegment(segment string) (string, error) {
	value, err := urlPathValue(segment)
	if err != nil {
		return "", err
	}
	if strings.Contains(value, "/") {
		return "", fmt.Errorf("invalid path segment")
	}
	return value, nil
}

func urlPathValue(segment string) (string, error) {
	value, err := url.PathUnescape(segment)
	if err != nil {
		return "", err
	}
	if value == "" {
		return "", fmt.Errorf("invalid path segment")
	}
	return value, nil
}

func escapedPathSegments(r *http.Request, prefix string) []string {
	path := strings.TrimPrefix(r.URL.EscapedPath(), prefix)
	return strings.Split(path, "/")
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
	if err := os.MkdirAll(filepath.Dir(keyPath), 0700); err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(certPath), 0755); err != nil {
		return err
	}

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
		IPAddresses: []net.IP{net.ParseIP("127.0.0.1"), net.ParseIP("::1")},
		KeyUsage:    x509.KeyUsageDigitalSignature | x509.KeyUsageKeyEncipherment,
		ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
	}

	der, err := x509.CreateCertificate(rand.Reader, &tmpl, &tmpl, &priv.PublicKey, priv)
	if err != nil {
		return err
	}

	certOut, err := os.OpenFile(certPath, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0644)
	if err != nil {
		return err
	}
	if err := pem.Encode(certOut, &pem.Block{Type: "CERTIFICATE", Bytes: der}); err != nil {
		certOut.Close()
		return err
	}
	if err := certOut.Close(); err != nil {
		return err
	}

	keyOut, err := os.OpenFile(keyPath, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0600)
	if err != nil {
		return err
	}
	if err := pem.Encode(keyOut, &pem.Block{Type: "RSA PRIVATE KEY", Bytes: x509.MarshalPKCS1PrivateKey(priv)}); err != nil {
		keyOut.Close()
		return err
	}
	return keyOut.Close()
}

func ensureTLSFilePermissions(keyPath string) error {
	if _, err := os.Stat(keyPath); err != nil {
		return err
	}
	return os.Chmod(keyPath, 0600)
}

// CORS helper
func cors(h http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if origin := r.Header.Get("Origin"); origin != "" {
			if !allowedCORSOrigin(origin) {
				http.Error(w, "origin not allowed", http.StatusForbidden)
				return
			} else {
				w.Header().Set("Access-Control-Allow-Origin", origin)
				w.Header().Set("Vary", "Origin")
			}
		}
		w.Header().Set("Access-Control-Allow-Methods", "GET, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
		if r.Method == "OPTIONS" {
			w.WriteHeader(http.StatusOK)
			return
		}
		h.ServeHTTP(w, r)
	})
}

func allowedCORSOrigin(origin string) bool {
	parsed, err := url.Parse(origin)
	if err != nil {
		return false
	}
	if parsed.Scheme != "http" && parsed.Scheme != "https" {
		return false
	}
	host := parsed.Hostname()
	return host == "localhost" || host == "127.0.0.1" || host == "::1"
}
