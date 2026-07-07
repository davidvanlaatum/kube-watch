package main

import (
	"context"
	"crypto/rand"
	"crypto/rsa"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"log"
	"math/big"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/client-go/dynamic"
	"k8s.io/client-go/rest"
	"k8s.io/client-go/tools/clientcmd"
	"k8s.io/client-go/tools/clientcmd/api"
)

var supportedResources = map[string]schema.GroupVersionResource{
	"pods":        {Group: "", Version: "v1", Resource: "pods"},
	"deployments": {Group: "apps", Version: "v1", Resource: "deployments"},
	"services":    {Group: "", Version: "v1", Resource: "services"},
	"jobs":        {Group: "batch", Version: "v1", Resource: "jobs"},
	"cronjobs":    {Group: "batch", Version: "v1", Resource: "cronjobs"},
	"configmaps":  {Group: "", Version: "v1", Resource: "configmaps"},
	"secrets":     {Group: "", Version: "v1", Resource: "secrets"},
	"events":      {Group: "", Version: "v1", Resource: "events"},
}

func main() {
	kubeconfig := os.Getenv("KUBECONFIG")
	if kubeconfig == "" {
		home := os.Getenv("HOME")
		kubeconfig = filepath.Join(home, ".kube", "config")
	}

	configBytes, err := os.ReadFile(kubeconfig)
	if err != nil {
		log.Fatalf("failed to read kubeconfig: %v", err)
	}

	config, err := clientcmd.Load(configBytes)
	if err != nil {
		log.Fatalf("failed to parse kubeconfig: %v", err)
	}

	contexts := listContexts(config, kubeconfig)

	// generate self-signed certs if not present
	certPath := filepath.Join("./certs", "cert.pem")
	keyPath := filepath.Join("./certs", "key.pem")
	if _, err := os.Stat(certPath); os.IsNotExist(err) {
		log.Println("generating self-signed TLS certs in ./certs")
		if err := generateSelfSignedCert(certPath, keyPath); err != nil {
			log.Fatalf("failed to generate certs: %v", err)
		}
	}


	// instantiate watch manager
	wm := NewWatchManager(kubeconfig)

	mux := http.NewServeMux()
	mux.HandleFunc("/api/contexts", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(contexts)
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
				if !ok { return }
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

	log.Println("Go SSE backend listening https://localhost:9443 — endpoints: /api/contexts and /sse/{context}/{resource}")
	log.Fatal(srv.ListenAndServeTLS("", ""))
}

func listContexts(cfg *api.Config, kubeconfigPath string) []map[string]string {
	out := make([]map[string]string, 0, len(cfg.Contexts))
	for k := range cfg.Contexts {
		// attempt to read the namespace for this context
		rules := &clientcmd.ClientConfigLoadingRules{ExplicitPath: kubeconfigPath}
		overrides := &clientcmd.ConfigOverrides{CurrentContext: k}
		clientCfg := clientcmd.NewNonInteractiveDeferredLoadingClientConfig(rules, overrides)
		ns, _, err := clientCfg.Namespace()
		if err != nil || ns == "" {
			ns = "default"
		}
		out = append(out, map[string]string{"name": k, "namespace": ns})
	}
	return out
}

// small wrapper that actually builds a rest.Config for a named context
func getRestConfigForContext(kubeconfigPath string, contextName string) (*rest.Config, error) {
	rules := &clientcmd.ClientConfigLoadingRules{ExplicitPath: kubeconfigPath}
	overrides := &clientcmd.ConfigOverrides{CurrentContext: contextName}
	clientCfg := clientcmd.NewNonInteractiveDeferredLoadingClientConfig(rules, overrides)
	cfg, err := clientCfg.ClientConfig()
	if err != nil {
		return nil, err
	}
	return cfg, nil
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
		NotBefore: now.Add(-time.Hour),
		NotAfter:  now.AddDate(1, 0, 0),
		DNSNames:  []string{"localhost"},
		KeyUsage:  x509.KeyUsageDigitalSignature | x509.KeyUsageKeyEncipherment,
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

// serveSSEWatch opens a watch and streams events as SSE to the http.ResponseWriter
func serveSSEWatch(ctx context.Context, w http.ResponseWriter, dyn dynamic.Interface, gvr schema.GroupVersionResource) {
	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "streaming unsupported", http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")

	// simple list then watch pattern — list first to get current state
	res := dyn.Resource(gvr)
	list, err := res.List(ctx, metav1.ListOptions{})
	if err == nil {
		for _, item := range list.Items {
			b, _ := json.Marshal(map[string]interface{}{"type": "ADDED", "object": item.Object})
			fmt.Fprintf(w, "data: %s\n\n", b)
		}
		flusher.Flush()
	}

	// start watch
	opts := metav1.ListOptions{Watch: true}
	watcher, err := res.Watch(ctx, opts)
	if err != nil {
		fmt.Fprintf(w, "data: %s\n\n", []byte("{\"error\":\"watch failed\"}"))
		flusher.Flush()
		return
	}

	ch := watcher.ResultChan()
	for {
		select {
		case <-ctx.Done():
			watcher.Stop()
			return
		case ev, ok := <-ch:
			if !ok {
				// watcher closed; attempt to re-establish after short delay
				fmt.Fprintf(w, "data: %s\n\n", []byte("{\"info\":\"watch closed, reconnecting\"}"))
				flusher.Flush()
				time.Sleep(2 * time.Second)
				watcher, err = res.Watch(ctx, opts)
				if err != nil {
					fmt.Fprintf(w, "data: %s\n\n", []byte("{\"error\":\"re-watch failed\"}"))
					flusher.Flush()
					return
				}
				ch = watcher.ResultChan()
				continue
			}
			b, _ := json.Marshal(map[string]interface{}{"type": ev.Type, "object": ev.Object})
			fmt.Fprintf(w, "data: %s\n\n", b)
			flusher.Flush()
		}
	}
}
