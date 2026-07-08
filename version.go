package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"
)

const latestReleaseURL = "https://api.github.com/repos/davidvanlaatum/kube-watch/releases/latest"

var (
	version = "dev"
	commit  = "unknown"
	date    = "unknown"
)

type VersionInfo struct {
	Version         string `json:"version"`
	Commit          string `json:"commit"`
	Date            string `json:"date"`
	LatestVersion   string `json:"latestVersion,omitempty"`
	LatestURL       string `json:"latestUrl,omitempty"`
	UpdateAvailable bool   `json:"updateAvailable"`
	CheckError      string `json:"checkError,omitempty"`
}

type latestRelease struct {
	TagName string `json:"tag_name"`
	HTMLURL string `json:"html_url"`
}

type versionChecker struct {
	client *http.Client
	url    string
	mu     sync.Mutex
	cached VersionInfo
	seen   time.Time
	ttl    time.Duration
}

func newVersionChecker() *versionChecker {
	return &versionChecker{
		client: &http.Client{Timeout: 3 * time.Second},
		url:    latestReleaseURL,
		ttl:    15 * time.Minute,
	}
}

func (c *versionChecker) Check(ctx context.Context) VersionInfo {
	base := VersionInfo{Version: version, Commit: commit, Date: date}
	c.mu.Lock()
	if !c.seen.IsZero() && time.Since(c.seen) < c.ttl {
		cached := c.cached
		c.mu.Unlock()
		return cached
	}
	c.mu.Unlock()

	info := base
	latest, err := c.fetchLatest(ctx)
	if err != nil {
		info.CheckError = err.Error()
	} else {
		info.LatestVersion = latest.TagName
		info.LatestURL = latest.HTMLURL
		info.UpdateAvailable = isNewerVersion(version, latest.TagName)
	}

	c.mu.Lock()
	c.cached = info
	c.seen = time.Now()
	c.mu.Unlock()
	return info
}

func (c *versionChecker) fetchLatest(ctx context.Context) (latestRelease, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.url, nil)
	if err != nil {
		return latestRelease{}, err
	}
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("User-Agent", "kube-watch/"+version)

	resp, err := c.client.Do(req)
	if err != nil {
		return latestRelease{}, err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return latestRelease{}, fmt.Errorf("latest release check returned %s", resp.Status)
	}

	var latest latestRelease
	if err := json.NewDecoder(resp.Body).Decode(&latest); err != nil {
		return latestRelease{}, err
	}
	if latest.TagName == "" {
		return latestRelease{}, fmt.Errorf("latest release response did not include tag_name")
	}
	return latest, nil
}

func isNewerVersion(current, latest string) bool {
	currentParts, ok := parseVersion(current)
	if !ok {
		return false
	}
	latestParts, ok := parseVersion(latest)
	if !ok {
		return false
	}
	for i := range currentParts {
		if latestParts[i] > currentParts[i] {
			return true
		}
		if latestParts[i] < currentParts[i] {
			return false
		}
	}
	return false
}

func parseVersion(value string) ([3]int, bool) {
	var parsed [3]int
	value = strings.TrimSpace(strings.TrimPrefix(value, "v"))
	value, _, _ = strings.Cut(value, "-")
	parts := strings.Split(value, ".")
	if len(parts) != 3 {
		return parsed, false
	}
	for i, part := range parts {
		n, err := strconv.Atoi(part)
		if err != nil || n < 0 {
			return parsed, false
		}
		parsed[i] = n
	}
	return parsed, true
}
