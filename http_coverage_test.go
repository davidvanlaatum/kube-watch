package main

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"testing/fstest"
	"time"

	"k8s.io/client-go/tools/clientcmd"
)

type nonStreamingWriter struct {
	header http.Header
	code   int
	body   strings.Builder
}

func (w *nonStreamingWriter) Header() http.Header         { return w.header }
func (w *nonStreamingWriter) WriteHeader(code int)        { w.code = code }
func (w *nonStreamingWriter) Write(b []byte) (int, error) { return w.body.Write(b) }

type notifyingWriter struct {
	*httptest.ResponseRecorder
	flushed chan struct{}
}

func (w notifyingWriter) Flush() { w.ResponseRecorder.Flush(); w.flushed <- struct{}{} }

type cancelOnFlush struct {
	*httptest.ResponseRecorder
	cancel context.CancelFunc
}

func (w cancelOnFlush) Flush() { w.ResponseRecorder.Flush(); w.cancel() }

func TestSSEDeliveryAndClosedChannel(t *testing.T) {
	ch := make(chan []byte, 2)
	ch <- []byte(`{"type":"SNAPSHOT","objects":[]}`)
	ch <- []byte(`{"type":"SYNCED"}`)
	close(ch)
	w := httptest.NewRecorder()
	streamSSE(w, httptest.NewRequest("GET", "/", nil), ch)
	want := "data: {\"info\":\"connected\"}\n\ndata: {\"type\":\"SNAPSHOT\",\"objects\":[]}\n\ndata: {\"type\":\"SYNCED\"}\n\n"
	if w.Body.String() != want || !w.Flushed || w.Header().Get("Content-Type") != "text/event-stream" || w.Header().Get("Cache-Control") != "no-cache" {
		t.Fatalf("SSE response: %s, headers %v", w.Body.String(), w.Header())
	}
}

func TestStreamsStopOnDisconnectAndRejectNonStreamingWriters(t *testing.T) {
	handlers := map[string]http.HandlerFunc{
		"resources": func(w http.ResponseWriter, r *http.Request) { streamSSE(w, r, make(chan []byte)) },
		"backend":   streamBackendLogs,
	}
	for name, handler := range handlers {
		t.Run(name, func(t *testing.T) {
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			recorder := httptest.NewRecorder()
			handler(cancelOnFlush{recorder, cancel}, httptest.NewRequest("GET", "/", nil).WithContext(ctx))
			if !recorder.Flushed || !strings.Contains(recorder.Body.String(), "connected") {
				t.Fatal("missing connection event")
			}
			w := &nonStreamingWriter{header: make(http.Header)}
			handler(w, httptest.NewRequest("GET", "/", nil))
			if w.code != 500 || !strings.Contains(w.body.String(), "streaming unsupported") {
				t.Fatalf("response: %+v", w)
			}
		})
	}
}

func TestSSEErrorEscapesPayloadAndHasHTTPFallback(t *testing.T) {
	w := httptest.NewRecorder()
	streamSSEError(w, "subscribe failed", errors.New("bad \"context\"\nretry"))
	var event map[string]string
	if err := json.Unmarshal([]byte(strings.TrimSpace(strings.TrimPrefix(w.Body.String(), "data: "))), &event); err != nil {
		t.Fatal(err)
	}
	if event["error"] != "subscribe failed: bad \"context\"\nretry" || !w.Flushed {
		t.Fatalf("event: %#v", event)
	}
	plain := &nonStreamingWriter{header: make(http.Header)}
	streamSSEError(plain, "subscribe failed", errors.New("denied"))
	if plain.code != 500 || !strings.Contains(plain.body.String(), "denied") {
		t.Fatalf("fallback: %+v", plain)
	}
}

func TestBackendLogStreamDeliversAndUnsubscribes(t *testing.T) {
	// Isolate the global hub; no tests using it run in parallel.
	old := backendLogHub
	backendLogHub = newBrowserLogHub()
	ctx, cancel := context.WithCancel(context.Background())
	w := httptest.NewRecorder()
	flushed := make(chan struct{}, 4)
	done := make(chan struct{})
	defer func() {
		cancel()
		select {
		case <-done:
			backendLogHub = old
		case <-time.After(3 * time.Second):
			t.Error("backend log worker leaked")
		}
	}()
	go func() {
		defer close(done)
		streamBackendLogs(notifyingWriter{w, flushed}, httptest.NewRequest("GET", "/", nil).WithContext(ctx))
	}()
	deadline := time.After(3 * time.Second)
	for {
		backendLogHub.mu.Lock()
		n := len(backendLogHub.clients)
		backendLogHub.mu.Unlock()
		if n == 1 {
			break
		}
		select {
		case <-deadline:
			t.Fatal("stream did not subscribe")
		case <-time.After(time.Millisecond):
		}
	}
	backendLogHub.publish(slog.NewRecord(time.Now(), slog.LevelError, "test stream failure", 0))
	for i := 0; i < 2; i++ {
		select {
		case <-flushed:
		case <-time.After(3 * time.Second):
			t.Fatal("missing flushed log event")
		}
	}
	cancel()
	select {
	case <-done:
	case <-time.After(3 * time.Second):
		t.Fatal("stream did not stop")
	}
	backendLogHub.mu.Lock()
	n := len(backendLogHub.clients)
	backendLogHub.mu.Unlock()
	if n != 0 {
		t.Fatalf("subscribers after disconnect: %d", n)
	}
	if !strings.Contains(w.Body.String(), "test stream failure") {
		t.Fatalf("missing log payload: %s", w.Body.String())
	}
}

func TestHTTPRoutesValidateRequestsAndServeFrontend(t *testing.T) {
	rules := &clientcmd.ClientConfigLoadingRules{ExplicitPath: t.TempDir() + "/missing"}
	vc := newVersionChecker()
	vc.cached = VersionInfo{Version: "test"}
	vc.seen = time.Now()
	handler := newHTTPHandler([]map[string]string{{"name": "dev", "namespace": "team"}}, NewWatchManager(rules), NewHelmManager(rules), NewLogManager(rules), vc, fstest.MapFS{
		"index.html":    {Data: []byte("<html>kube-watch fixture</html>")},
		"assets/app.js": {Data: []byte("fixture-javascript")},
	})
	for _, tc := range []struct {
		path string
		code int
		text string
	}{
		{"/", 200, "kube-watch fixture"}, {"/view/dev/pods", 200, "kube-watch fixture"}, {"/assets/app.js", 200, "fixture-javascript"},
		{"/api/contexts", 200, `"namespace":"team"`}, {"/api/version", 200, `"version":"test"`},
		{"/sse/dev", 400, "expected"}, {"/sse//pods", http.StatusTemporaryRedirect, "Temporary Redirect"}, {"/sse/dev/bad%2Fresource", 400, "invalid resource"}, {"/sse/dev/unknown", 400, "unsupported resource"},
		{"/sse/dev/pods", 200, "subscribe failed"}, {"/sse/dev/helmreleases", 200, "subscribe failed"},
		{"/api/helm-history/dev", 400, "expected"}, {"/api/helm-history//secrets/api", http.StatusTemporaryRedirect, "Temporary Redirect"},
		{"/api/helm-history/dev/bad%2Fdriver/api", 400, "invalid driver"}, {"/api/helm-history/dev/secrets/bad%2Fname", 400, "invalid release name"},
		{"/api/helm-history/dev/invalid/api", 500, "unsupported Helm storage driver"}, {"/api/helm-history/dev/secrets/api", 500, "helm history failed"},
		{"/logs/dev", 400, "expected"}, {"/logs//pods/team/api", http.StatusTemporaryRedirect, "Temporary Redirect"}, {"/logs/dev/bad%2Fresource/team/api", 400, "invalid resource"},
		{"/logs/dev/pods/bad%2Fns/api", 400, "invalid namespace"}, {"/logs/dev/pods/team/bad%2Fname", 400, "invalid name"},
		{"/logs/dev/services/team/api", 400, "logs are supported"}, {"/logs/dev/pods/team/api", 200, "subscribe logs failed"},
	} {
		t.Run(tc.path, func(t *testing.T) {
			req := httptest.NewRequest("GET", tc.path, nil)
			w := httptest.NewRecorder()
			handler.ServeHTTP(w, req)
			if w.Code != tc.code || !strings.Contains(w.Body.String(), tc.text) {
				t.Fatalf("status %d body %s; want %d containing %q", w.Code, w.Body.String(), tc.code, tc.text)
			}
		})
	}
	// CORS remains applied to the extracted router.
	req := httptest.NewRequest("GET", "/api/contexts", nil)
	req.Header.Set("Origin", "https://example.com")
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, req)
	if w.Code != http.StatusForbidden {
		t.Fatalf("cross-origin status %d", w.Code)
	}
}

// Simulate a disconnected client before the connection event or a later event.
type failingStreamWriter struct {
	*httptest.ResponseRecorder
	writes int
	failAt int
}

func (w *failingStreamWriter) Write(data []byte) (int, error) {
	w.writes++
	if w.writes >= w.failAt {
		return 0, errors.New("client disconnected")
	}
	return w.ResponseRecorder.Write(data)
}

func TestSSEStopsWhenClientWriteFails(t *testing.T) {
	for _, tc := range []struct {
		name    string
		failAt  int
		handler func(http.ResponseWriter, *http.Request)
	}{
		{"initial resource event", 1, func(w http.ResponseWriter, r *http.Request) { streamSSE(w, r, make(chan []byte)) }},
		{"later resource event", 2, func(w http.ResponseWriter, r *http.Request) {
			ch := make(chan []byte, 1)
			ch <- []byte(`{"type":"SYNCED"}`)
			streamSSE(w, r, ch)
		}},
		{"initial backend event", 1, streamBackendLogs},
		{"error event", 1, func(w http.ResponseWriter, r *http.Request) { streamSSEError(w, "subscribe", errors.New("denied")) }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			w := &failingStreamWriter{ResponseRecorder: httptest.NewRecorder(), failAt: tc.failAt}
			done := make(chan struct{})
			go func() { defer close(done); tc.handler(w, httptest.NewRequest("GET", "/", nil).WithContext(ctx)) }()
			select {
			case <-done:
			case <-time.After(time.Second):
				cancel()
				<-done
				t.Fatal("stream kept waiting after a write failure")
			}
			if w.writes != tc.failAt {
				t.Fatalf("writes=%d, expected %d", w.writes, tc.failAt)
			}
			if tc.failAt == 1 && w.Flushed {
				t.Fatal("failed connection event was flushed")
			}
		})
	}
}
