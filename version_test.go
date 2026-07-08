package main

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestIsNewerVersion(t *testing.T) {
	cases := []struct {
		current string
		latest  string
		want    bool
	}{
		{"1.2.3", "v1.2.4", true},
		{"v1.2.3", "1.3.0", true},
		{"1.2.3", "2.0.0", true},
		{"1.2.3", "1.2.3", false},
		{"1.2.3", "1.2.2", false},
		{"dev", "1.2.3", false},
		{"1.2.3-next", "1.2.4", true},
	}
	for _, tc := range cases {
		if got := isNewerVersion(tc.current, tc.latest); got != tc.want {
			t.Fatalf("isNewerVersion(%q, %q) = %v, expected %v", tc.current, tc.latest, got, tc.want)
		}
	}
}

func TestVersionCheckerFetchesAndCachesLatestRelease(t *testing.T) {
	requests := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests++
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprint(w, `{"tag_name":"v1.2.4","html_url":"https://github.com/davidvanlaatum/kube-watch/releases/tag/v1.2.4"}`)
	}))
	defer server.Close()

	oldVersion := version
	version = "1.2.3"
	t.Cleanup(func() { version = oldVersion })
	checker := &versionChecker{
		client: server.Client(),
		url:    server.URL,
		ttl:    time.Hour,
	}

	first := checker.Check(context.Background())
	second := checker.Check(context.Background())

	if !first.UpdateAvailable || first.LatestVersion != "v1.2.4" || first.LatestURL == "" {
		t.Fatalf("first version info = %#v", first)
	}
	if second != first {
		t.Fatalf("expected cached response %#v, got %#v", first, second)
	}
	if requests != 1 {
		t.Fatalf("expected one latest-release request, got %d", requests)
	}
}
