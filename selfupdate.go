package main

import (
	"archive/tar"
	"archive/zip"
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

const checksumsAssetName = "checksums.txt"

type selfUpdateOptions struct {
	force bool
}

func runSelfUpdate(args []string, out io.Writer) error {
	fs := flag.NewFlagSet("selfupdate", flag.ContinueOnError)
	fs.SetOutput(out)
	opts := selfUpdateOptions{}
	fs.BoolVar(&opts.force, "force", false, "install latest release even when the current version is already up to date")
	if err := fs.Parse(args); err != nil {
		return err
	}

	updater := newSelfUpdater()
	result, err := updater.Update(context.Background(), opts)
	if err != nil {
		return err
	}
	fmt.Fprintln(out, result)
	return nil
}

type selfUpdater struct {
	client     *http.Client
	releaseURL string
	goos       string
	goarch     string
	executable func() (string, error)
	replace    func(string, []byte) error
}

func newSelfUpdater() *selfUpdater {
	return &selfUpdater{
		client:     &http.Client{Timeout: 2 * time.Minute},
		releaseURL: latestReleaseURL,
		goos:       runtime.GOOS,
		goarch:     runtime.GOARCH,
		executable: currentExecutablePath,
		replace:    replaceExecutable,
	}
}

func (u *selfUpdater) Update(ctx context.Context, opts selfUpdateOptions) (string, error) {
	if u.goos == "windows" {
		return "", errors.New("selfupdate is not supported on Windows; download the latest Windows archive from GitHub Releases and replace kube-watch.exe manually")
	}

	latest, err := fetchLatestRelease(ctx, u.client, u.releaseURL)
	if err != nil {
		return "", err
	}
	if latest.TagName == "" {
		return "", errors.New("latest release response did not include tag_name")
	}
	if !shouldInstallSelfUpdate(version, latest.TagName, opts.force) {
		return fmt.Sprintf("kube-watch is already up to date (%s)", version), nil
	}

	asset, err := selectReleaseAsset(latest.Assets, u.goos, u.goarch)
	if err != nil {
		return "", err
	}

	checksumAsset, err := selectChecksumsAsset(latest.Assets)
	if err != nil {
		return "", err
	}

	archiveBytes, err := downloadReleaseAsset(ctx, u.client, asset)
	if err != nil {
		return "", err
	}
	checksumsBytes, err := downloadReleaseAsset(ctx, u.client, checksumAsset)
	if err != nil {
		return "", err
	}
	if err := verifyAssetChecksum(asset.Name, archiveBytes, checksumsBytes); err != nil {
		return "", err
	}

	binaryBytes, err := extractBinary(asset.Name, archiveBytes)
	if err != nil {
		return "", err
	}
	exePath, err := u.executable()
	if err != nil {
		return "", err
	}
	if err := u.replace(exePath, binaryBytes); err != nil {
		return "", err
	}
	return fmt.Sprintf("updated kube-watch from %s to %s", version, latest.TagName), nil
}

func shouldInstallSelfUpdate(current, latest string, force bool) bool {
	if force || isNewerVersion(current, latest) {
		return true
	}
	if _, currentOK := parseVersion(current); currentOK {
		return false
	}
	_, latestOK := parseVersion(latest)
	return latestOK
}

func fetchLatestRelease(ctx context.Context, client *http.Client, url string) (latestRelease, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return latestRelease{}, err
	}
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("User-Agent", "kube-watch/"+version)

	resp, err := client.Do(req)
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
	return latest, nil
}

func selectReleaseAsset(assets []releaseAsset, goos, goarch string) (releaseAsset, error) {
	archiveSuffix := ".tar.gz"
	if goos == "windows" {
		archiveSuffix = ".zip"
	}
	platform := "_" + goos + "_" + goarch
	for _, asset := range assets {
		if strings.Contains(asset.Name, platform) && strings.HasSuffix(asset.Name, archiveSuffix) && asset.BrowserDownloadURL != "" {
			return asset, nil
		}
	}
	return releaseAsset{}, fmt.Errorf("no release asset found for %s/%s", goos, goarch)
}

func selectChecksumsAsset(assets []releaseAsset) (releaseAsset, error) {
	for _, asset := range assets {
		if asset.Name == checksumsAssetName && asset.BrowserDownloadURL != "" {
			return asset, nil
		}
	}
	return releaseAsset{}, fmt.Errorf("release does not include %s", checksumsAssetName)
}

func downloadReleaseAsset(ctx context.Context, client *http.Client, asset releaseAsset) ([]byte, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, asset.BrowserDownloadURL, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", "kube-watch/"+version)

	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, fmt.Errorf("download %s returned %s", asset.Name, resp.Status)
	}
	return io.ReadAll(resp.Body)
}

func verifyAssetChecksum(assetName string, archiveBytes, checksumsBytes []byte) error {
	want := checksumForAsset(assetName, string(checksumsBytes))
	if want == "" {
		return fmt.Errorf("%s did not include a checksum for %s", checksumsAssetName, assetName)
	}
	sum := sha256.Sum256(archiveBytes)
	got := hex.EncodeToString(sum[:])
	if !strings.EqualFold(got, want) {
		return fmt.Errorf("checksum mismatch for %s", assetName)
	}
	return nil
}

func checksumForAsset(assetName, checksums string) string {
	for _, line := range strings.Split(checksums, "\n") {
		fields := strings.Fields(line)
		if len(fields) >= 2 && strings.TrimPrefix(fields[len(fields)-1], "*") == assetName {
			return fields[0]
		}
	}
	return ""
}

func extractBinary(assetName string, archiveBytes []byte) ([]byte, error) {
	if strings.HasSuffix(assetName, ".zip") {
		return extractBinaryFromZip(archiveBytes)
	}
	if strings.HasSuffix(assetName, ".tar.gz") {
		return extractBinaryFromTarGz(archiveBytes)
	}
	return nil, fmt.Errorf("unsupported release archive %s", assetName)
}

func extractBinaryFromTarGz(archiveBytes []byte) ([]byte, error) {
	gz, err := gzip.NewReader(bytes.NewReader(archiveBytes))
	if err != nil {
		return nil, err
	}
	defer gz.Close()

	tr := tar.NewReader(gz)
	for {
		header, err := tr.Next()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return nil, err
		}
		if header.FileInfo().IsDir() || !isKubeWatchBinaryName(header.Name) {
			continue
		}
		return io.ReadAll(tr)
	}
	return nil, errors.New("release archive did not contain kube-watch binary")
}

func extractBinaryFromZip(archiveBytes []byte) ([]byte, error) {
	zr, err := zip.NewReader(bytes.NewReader(archiveBytes), int64(len(archiveBytes)))
	if err != nil {
		return nil, err
	}
	for _, file := range zr.File {
		if file.FileInfo().IsDir() || !isKubeWatchBinaryName(file.Name) {
			continue
		}
		rc, err := file.Open()
		if err != nil {
			return nil, err
		}
		binaryBytes, readErr := io.ReadAll(rc)
		closeErr := rc.Close()
		if readErr != nil {
			return nil, readErr
		}
		if closeErr != nil {
			return nil, closeErr
		}
		return binaryBytes, nil
	}
	return nil, errors.New("release archive did not contain kube-watch binary")
}

func isKubeWatchBinaryName(name string) bool {
	base := filepath.Base(name)
	return base == "kube-watch" || base == "kube-watch.exe"
}

func currentExecutablePath() (string, error) {
	path, err := os.Executable()
	if err != nil {
		return "", err
	}
	if resolved, err := filepath.EvalSymlinks(path); err == nil {
		return resolved, nil
	}
	return path, nil
}

func replaceExecutable(path string, binaryBytes []byte) error {
	info, err := os.Stat(path)
	if err != nil {
		return err
	}
	dir := filepath.Dir(path)
	tmp, err := os.CreateTemp(dir, ".kube-watch-update-*")
	if err != nil {
		return err
	}
	tmpPath := tmp.Name()
	defer os.Remove(tmpPath)

	mode := info.Mode().Perm()
	if mode == 0 {
		mode = 0755
	}
	if _, err := tmp.Write(binaryBytes); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Chmod(mode); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}

	backupPath := path + ".old"
	_ = os.Remove(backupPath)
	if err := os.Rename(path, backupPath); err != nil {
		return err
	}
	if err := os.Rename(tmpPath, path); err != nil {
		_ = os.Rename(backupPath, path)
		return err
	}
	_ = os.Remove(backupPath)
	return nil
}
