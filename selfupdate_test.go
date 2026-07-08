package main

import (
	"archive/tar"
	"archive/zip"
	"bytes"
	"compress/gzip"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestSelectReleaseAssetMatchesPlatformArchive(t *testing.T) {
	asset, err := selectReleaseAsset([]releaseAsset{
		{Name: "kube-watch_1.2.4_linux_amd64.tar.gz", BrowserDownloadURL: "https://example.invalid/linux"},
		{Name: "kube-watch_1.2.4_darwin_arm64.tar.gz", BrowserDownloadURL: "https://example.invalid/darwin"},
	}, "darwin", "arm64")
	if err != nil {
		t.Fatalf("select release asset: %v", err)
	}
	if asset.Name != "kube-watch_1.2.4_darwin_arm64.tar.gz" {
		t.Fatalf("selected asset = %q", asset.Name)
	}

	asset, err = selectReleaseAsset([]releaseAsset{
		{Name: "kube-watch_1.2.4_windows_amd64.zip", BrowserDownloadURL: "https://example.invalid/windows"},
	}, "windows", "amd64")
	if err != nil {
		t.Fatalf("select windows release asset: %v", err)
	}
	if !strings.HasSuffix(asset.Name, ".zip") {
		t.Fatalf("expected windows zip asset, got %q", asset.Name)
	}
}

func TestVerifyAssetChecksumAcceptsMatchingGoReleaserLine(t *testing.T) {
	archiveBytes := []byte("release archive")
	sum := sha256.Sum256(archiveBytes)
	checksums := fmt.Sprintf("%s  *kube-watch_1.2.4_darwin_arm64.tar.gz\n", hex.EncodeToString(sum[:]))

	if err := verifyAssetChecksum("kube-watch_1.2.4_darwin_arm64.tar.gz", archiveBytes, []byte(checksums)); err != nil {
		t.Fatalf("verify checksum: %v", err)
	}
	if err := verifyAssetChecksum("kube-watch_1.2.4_darwin_arm64.tar.gz", []byte("tampered"), []byte(checksums)); err == nil {
		t.Fatalf("expected tampered archive checksum to fail")
	}
}

func TestExtractBinaryFromTarGzAndZip(t *testing.T) {
	want := []byte("new kube-watch binary")

	tarGz := makeTarGz(t, "kube-watch", want)
	got, err := extractBinary("kube-watch_1.2.4_darwin_arm64.tar.gz", tarGz)
	if err != nil {
		t.Fatalf("extract tar.gz binary: %v", err)
	}
	if !bytes.Equal(got, want) {
		t.Fatalf("tar.gz binary = %q, expected %q", got, want)
	}

	zipArchive := makeZip(t, "kube-watch.exe", want)
	got, err = extractBinary("kube-watch_1.2.4_windows_amd64.zip", zipArchive)
	if err != nil {
		t.Fatalf("extract zip binary: %v", err)
	}
	if !bytes.Equal(got, want) {
		t.Fatalf("zip binary = %q, expected %q", got, want)
	}
}

func TestSelfUpdaterDownloadsVerifiesAndReplacesBinary(t *testing.T) {
	oldVersion := version
	version = "1.2.3"
	t.Cleanup(func() { version = oldVersion })

	newBinary := []byte("new binary")
	archiveBytes := makeTarGz(t, "kube-watch", newBinary)
	sum := sha256.Sum256(archiveBytes)
	checksums := fmt.Sprintf("%s  kube-watch_1.2.4_darwin_arm64.tar.gz\n", hex.EncodeToString(sum[:]))

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/latest":
			fmt.Fprintf(w, `{
				"tag_name": "v1.2.4",
				"html_url": "https://github.com/davidvanlaatum/kube-watch/releases/tag/v1.2.4",
				"assets": [
					{"name": "kube-watch_1.2.4_darwin_arm64.tar.gz", "browser_download_url": "%s/archive"},
					{"name": "checksums.txt", "browser_download_url": "%s/checksums"}
				]
			}`, serverURL(r), serverURL(r))
		case "/archive":
			w.Write(archiveBytes)
		case "/checksums":
			fmt.Fprint(w, checksums)
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()

	var replacedPath string
	var replacedBytes []byte
	updater := &selfUpdater{
		client:     server.Client(),
		releaseURL: server.URL + "/latest",
		goos:       "darwin",
		goarch:     "arm64",
		executable: func() (string, error) { return "/tmp/kube-watch", nil },
		replace: func(path string, b []byte) error {
			replacedPath = path
			replacedBytes = append([]byte(nil), b...)
			return nil
		},
	}

	result, err := updater.Update(t.Context(), selfUpdateOptions{})
	if err != nil {
		t.Fatalf("self update: %v", err)
	}
	if !strings.Contains(result, "v1.2.4") {
		t.Fatalf("result = %q", result)
	}
	if replacedPath != "/tmp/kube-watch" || !bytes.Equal(replacedBytes, newBinary) {
		t.Fatalf("replace called with path=%q bytes=%q", replacedPath, replacedBytes)
	}
}

func TestReplaceExecutableSwapsBinary(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "kube-watch")
	if err := os.WriteFile(path, []byte("old"), 0755); err != nil {
		t.Fatalf("write old binary: %v", err)
	}

	if err := replaceExecutable(path, []byte("new")); err != nil {
		t.Fatalf("replace executable: %v", err)
	}
	got, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read updated binary: %v", err)
	}
	if string(got) != "new" {
		t.Fatalf("updated binary = %q", got)
	}
	if _, err := os.Stat(path + ".old"); !os.IsNotExist(err) {
		t.Fatalf("expected backup to be removed, stat err = %v", err)
	}
}

func makeTarGz(t *testing.T, name string, content []byte) []byte {
	t.Helper()
	var buf bytes.Buffer
	gz := gzip.NewWriter(&buf)
	tw := tar.NewWriter(gz)
	if err := tw.WriteHeader(&tar.Header{Name: name, Mode: 0755, Size: int64(len(content))}); err != nil {
		t.Fatalf("write tar header: %v", err)
	}
	if _, err := tw.Write(content); err != nil {
		t.Fatalf("write tar content: %v", err)
	}
	if err := tw.Close(); err != nil {
		t.Fatalf("close tar: %v", err)
	}
	if err := gz.Close(); err != nil {
		t.Fatalf("close gzip: %v", err)
	}
	return buf.Bytes()
}

func makeZip(t *testing.T, name string, content []byte) []byte {
	t.Helper()
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	w, err := zw.Create(name)
	if err != nil {
		t.Fatalf("create zip entry: %v", err)
	}
	if _, err := w.Write(content); err != nil {
		t.Fatalf("write zip content: %v", err)
	}
	if err := zw.Close(); err != nil {
		t.Fatalf("close zip: %v", err)
	}
	return buf.Bytes()
}

func serverURL(r *http.Request) string {
	scheme := "http"
	if r.TLS != nil {
		scheme = "https"
	}
	return scheme + "://" + r.Host
}
