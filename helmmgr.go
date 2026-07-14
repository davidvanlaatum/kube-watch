package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"sort"
	"strings"
	"sync"
	"time"

	"helm.sh/helm/v3/pkg/action"
	"helm.sh/helm/v3/pkg/release"
	"k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/api/meta"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/apimachinery/pkg/watch"
	"k8s.io/client-go/discovery"
	"k8s.io/client-go/discovery/cached/memory"
	"k8s.io/client-go/dynamic"
	"k8s.io/client-go/rest"
	"k8s.io/client-go/restmapper"
	"k8s.io/client-go/tools/clientcmd"
)

const helmReleasesResource = "helmreleases"
const helmStorageLabelSelector = "owner=helm"

var helmStorageResources = []schema.GroupVersionResource{
	{Version: "v1", Resource: "secrets"},
	{Version: "v1", Resource: "configmaps"},
}

type HelmManager struct {
	loadingRules *clientcmd.ClientConfigLoadingRules
	mu           sync.Mutex
	entries      map[string]*helmEntry
}

type helmEntry struct {
	cluster   string
	namespace string
	dyn       dynamic.Interface
	clientCfg clientcmd.ClientConfig

	clients map[chan []byte]struct{}
	cache   map[string][]byte
	objects map[string][]byte
	stopCh  chan struct{}
	running bool
	mu      sync.Mutex
	idle    *time.Timer

	terminalError         []byte
	storageTerminalErrors map[string]storageTerminalError
}

type storageTerminalError struct {
	message  string
	skipList bool
}

func NewHelmManager(loadingRules *clientcmd.ClientConfigLoadingRules) *HelmManager {
	if loadingRules == nil {
		loadingRules = clientcmd.NewDefaultClientConfigLoadingRules()
	}
	return &HelmManager{loadingRules: loadingRules, entries: make(map[string]*helmEntry)}
}

func (m *HelmManager) Subscribe(cluster string) (chan []byte, func(), error) {
	e, created, err := m.getOrCreateEntry(cluster)
	if err != nil {
		return nil, nil, err
	}

	ch, unsubscribe, stopCh, shouldStart := e.subscribe(!created)
	if shouldStart {
		go e.run(stopCh)
	}
	return ch, unsubscribe, nil
}

func (m *HelmManager) History(cluster string, name string, driver string) ([]map[string]interface{}, error) {
	if driver != "secrets" && driver != "configmaps" {
		return nil, fmt.Errorf("unsupported Helm storage driver %q", driver)
	}
	e, _, err := m.getOrCreateEntry(cluster)
	if err != nil {
		return nil, err
	}
	cfg, err := e.actionConfig(driver)
	if err != nil {
		return nil, err
	}
	return helmHistory(cfg, name)
}

func (m *HelmManager) getOrCreateEntry(cluster string) (*helmEntry, bool, error) {
	if e, ok := m.lookupEntry(cluster); ok {
		return e, false, nil
	}

	created, err := m.newEntry(cluster)
	if err != nil {
		return nil, false, err
	}

	created, stored := m.storeEntryIfAbsent(cluster, created)
	if stored {
		slog.Info("created helm watch entry", "cluster", cluster, "namespace", created.namespace)
	}
	return created, stored, nil
}

func (m *HelmManager) lookupEntry(key string) (*helmEntry, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()

	e, ok := m.entries[key]
	return e, ok
}

func (m *HelmManager) storeEntryIfAbsent(key string, entry *helmEntry) (*helmEntry, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()

	if existing, ok := m.entries[key]; ok {
		return existing, false
	}
	m.entries[key] = entry
	return entry, true
}

func (m *HelmManager) newEntry(cluster string) (*helmEntry, error) {
	over := &clientcmd.ConfigOverrides{CurrentContext: cluster}
	clientCfg := clientcmd.NewNonInteractiveDeferredLoadingClientConfig(m.loadingRules, over)
	cfg, err := clientCfg.ClientConfig()
	if err != nil {
		return nil, fmt.Errorf("failed to build config for %s: %w", cluster, err)
	}
	dyn, err := dynamic.NewForConfig(cfg)
	if err != nil {
		return nil, fmt.Errorf("failed to create dynamic client: %w", err)
	}
	ns, _, nerr := clientCfg.Namespace()
	if nerr != nil || ns == "" {
		ns = "default"
	}

	return &helmEntry{
		cluster:               cluster,
		namespace:             ns,
		dyn:                   dyn,
		clientCfg:             clientCfg,
		clients:               make(map[chan []byte]struct{}),
		cache:                 make(map[string][]byte),
		objects:               make(map[string][]byte),
		stopCh:                make(chan struct{}),
		storageTerminalErrors: make(map[string]storageTerminalError),
	}, nil
}

type helmRESTClientGetter struct {
	clientCfg clientcmd.ClientConfig
}

func (g helmRESTClientGetter) ToRESTConfig() (*rest.Config, error) {
	return g.clientCfg.ClientConfig()
}

func (g helmRESTClientGetter) ToRawKubeConfigLoader() clientcmd.ClientConfig {
	return g.clientCfg
}

func (g helmRESTClientGetter) ToDiscoveryClient() (discovery.CachedDiscoveryInterface, error) {
	cfg, err := g.ToRESTConfig()
	if err != nil {
		return nil, err
	}
	client, err := discovery.NewDiscoveryClientForConfig(cfg)
	if err != nil {
		return nil, err
	}
	return memory.NewMemCacheClient(client), nil
}

func (g helmRESTClientGetter) ToRESTMapper() (meta.RESTMapper, error) {
	client, err := g.ToDiscoveryClient()
	if err != nil {
		return nil, err
	}
	return restmapper.NewDeferredDiscoveryRESTMapper(client), nil
}

func (e *helmEntry) subscribe(sendSnapshot bool) (chan []byte, func(), chan struct{}, bool) {
	ch := make(chan []byte, e.subscriptionBuffer(sendSnapshot))
	done := make(chan struct{})
	var once sync.Once

	cacheSnapshot, terminalError, clientCount, stopCh, shouldStart := e.addClient(ch, sendSnapshot)
	slog.Info("helm sse subscription opened", "cluster", e.cluster, "namespace", e.namespace, "clients", clientCount)
	if sendSnapshot {
		go sendInitialSnapshot(ch, done, cacheSnapshot, terminalError)
	}

	unsubscribe := func() {
		once.Do(func() {
			close(done)
			clientCount := e.removeClient(ch)
			slog.Info("helm sse subscription closed", "cluster", e.cluster, "namespace", e.namespace, "clients", clientCount)
		})
	}

	return ch, unsubscribe, stopCh, shouldStart
}

func (e *helmEntry) subscriptionBuffer(includeSnapshot bool) int {
	if !includeSnapshot {
		return 256
	}
	e.mu.Lock()
	defer e.mu.Unlock()

	return len(e.cache) + 256
}

func (e *helmEntry) addClient(ch chan []byte, includeSnapshot bool) ([][]byte, []byte, int, chan struct{}, bool) {
	e.mu.Lock()
	defer e.mu.Unlock()

	e.clients[ch] = struct{}{}
	clientCount := len(e.clients)
	if e.idle != nil {
		_ = e.idle.Stop()
		e.idle = nil
	}
	shouldStart := false
	if !e.running {
		e.stopCh = make(chan struct{})
		e.running = true
		shouldStart = true
	}

	if !includeSnapshot {
		return nil, nil, clientCount, e.stopCh, shouldStart
	}

	cacheSnapshot := make([][]byte, 0, len(e.cache))
	for _, v := range e.cache {
		cacheSnapshot = append(cacheSnapshot, v)
	}
	return cacheSnapshot, e.terminalErrorSnapshotLocked(), clientCount, e.stopCh, shouldStart
}

func (e *helmEntry) removeClient(ch chan []byte) int {
	e.mu.Lock()
	defer e.mu.Unlock()

	delete(e.clients, ch)
	clientCount := len(e.clients)
	if clientCount == 0 {
		e.idle = time.AfterFunc(30*time.Second, func() {
			e.stopIfIdle()
		})
	}
	return clientCount
}

func (e *helmEntry) stopIfIdle() {
	e.mu.Lock()
	defer e.mu.Unlock()

	e.idle = nil
	if len(e.clients) > 0 {
		return
	}
	e.stopLocked()
}

func (e *helmEntry) stopLocked() {
	if !e.running {
		return
	}
	select {
	case <-e.stopCh:
	default:
		slog.Info("stopping helm watch entry", "cluster", e.cluster, "namespace", e.namespace)
		close(e.stopCh)
	}
}

func (e *helmEntry) run(stopCh chan struct{}) {
	defer func() {
		if restartStopCh, restart := e.markRunStopped(stopCh); restart {
			go e.run(restartStopCh)
		}
	}()

	refresh := make(chan struct{}, 1)
	for _, gvr := range helmStorageResources {
		go e.watchStorage(stopCh, gvr, refresh)
	}
	e.requestRefresh(refresh)

	debounce := time.NewTimer(time.Hour)
	if !debounce.Stop() {
		<-debounce.C
	}

	for {
		select {
		case <-stopCh:
			return
		case <-refresh:
			debounce.Reset(250 * time.Millisecond)
		case <-debounce.C:
			if err := e.refresh(); err != nil {
				slog.Error("helm release refresh failed", "cluster", e.cluster, "namespace", e.namespace, "error", err)
				e.broadcast(errorEvent("helm release refresh failed", err))
			}
		}
	}
}

func (e *helmEntry) markRunStopped(stopCh chan struct{}) (chan struct{}, bool) {
	e.mu.Lock()
	defer e.mu.Unlock()

	if e.stopCh != stopCh {
		return nil, false
	}
	e.running = false
	if len(e.clients) == 0 || !isClosed(stopCh) {
		return nil, false
	}
	e.stopCh = make(chan struct{})
	e.running = true
	return e.stopCh, true
}

func (e *helmEntry) requestRefresh(refresh chan<- struct{}) {
	select {
	case refresh <- struct{}{}:
	default:
	}
}

func (e *helmEntry) watchStorage(stopCh chan struct{}, gvr schema.GroupVersionResource, refresh chan<- struct{}) {
	ns := e.namespace
	if ns == "" {
		ns = "default"
	}
	res := e.dyn.Resource(gvr).Namespace(ns)
	for {
		listCtx, listCancel := contextForStop(stopCh)
		list, err := res.List(listCtx, metav1.ListOptions{LabelSelector: helmStorageLabelSelector})
		listCancel()
		if err != nil {
			if errors.IsForbidden(err) {
				slog.Error("helm storage list forbidden", "cluster", e.cluster, "namespace", ns, "resource", gvr.Resource, "error", err)
				e.broadcastStorageError(gvr.Resource, "helm storage list forbidden: "+err.Error(), true)
				return
			} else {
				slog.Warn("helm storage list failed", "cluster", e.cluster, "namespace", ns, "resource", gvr.Resource, "error", err)
			}
			select {
			case <-time.After(3 * time.Second):
			case <-stopCh:
				return
			}
			continue
		}

		rv := list.GetResourceVersion()
		e.requestRefresh(refresh)

		watchCtx, watchCancel := contextForStop(stopCh)
		watcher, err := res.Watch(watchCtx, metav1.ListOptions{Watch: true, ResourceVersion: rv, LabelSelector: helmStorageLabelSelector})
		if err != nil {
			watchCancel()
			if errors.IsForbidden(err) {
				slog.Error("helm storage watch forbidden", "cluster", e.cluster, "namespace", ns, "resource", gvr.Resource, "error", err)
				e.broadcastStorageError(gvr.Resource, "helm storage watch forbidden: "+err.Error(), false)
				return
			}
			slog.Warn("helm storage watch failed", "cluster", e.cluster, "namespace", ns, "resource", gvr.Resource, "error", err)
			select {
			case <-time.After(3 * time.Second):
			case <-stopCh:
				return
			}
			continue
		}

		e.clearStorageTerminalError(gvr.Resource)
		if !e.consumeStorageEvents(stopCh, watcher, watchCancel, refresh) {
			return
		}
		select {
		case <-time.After(1 * time.Second):
		case <-stopCh:
			return
		}
	}
}

func (e *helmEntry) consumeStorageEvents(stopCh chan struct{}, watcher watch.Interface, watchCancel context.CancelFunc, refresh chan<- struct{}) bool {
	defer watchCancel()
	defer watcher.Stop()

	for {
		select {
		case <-stopCh:
			return false
		case ev, ok := <-watcher.ResultChan():
			if !ok {
				return true
			}
			if string(ev.Type) == "ERROR" {
				if st, ok := watchErrorStatus(ev.Object); ok && (st.Code == 410 || st.Reason == metav1.StatusReasonExpired) {
					return true
				}
				b, _ := json.Marshal(map[string]interface{}{"type": ev.Type, "object": ev.Object})
				e.broadcast(b)
				continue
			}
			if uo, ok := ev.Object.(*unstructured.Unstructured); ok && isHelmStorageObject(uo) {
				e.requestRefresh(refresh)
			}
		}
	}
}

func (e *helmEntry) refresh() error {
	releases, authoritative, err := e.listReleases()
	if err != nil {
		return err
	}
	e.clearTerminalError()

	current := make(map[string][]byte, len(releases))
	for _, obj := range releases {
		key := objectKey(obj)
		if key == "" {
			continue
		}
		objectBytes, err := json.Marshal(obj)
		if err != nil {
			return fmt.Errorf("marshal helm release object: %w", err)
		}
		current[key] = objectBytes
		e.emitObject(key, objectBytes)
	}
	if authoritative {
		e.deleteMissing(current)
	}
	e.broadcast(syncedEvent)
	if msg := e.storageTerminalErrorEvent(); msg != nil {
		e.sendToClients(msg)
	}
	return nil
}

func (e *helmEntry) listReleases() ([]map[string]interface{}, bool, error) {
	var objects []map[string]interface{}
	seen := make(map[string]int)
	var driverErrors []error
	var skippedListErrors []error
	drivers := []string{"secrets", "configmaps"}
	for _, driver := range drivers {
		if terminal, ok := e.storageTerminalError(driver); ok && terminal.skipList {
			skippedListErrors = append(skippedListErrors, fmt.Errorf("%s", terminal.message))
			continue
		}
		cfg, err := e.actionConfig(driver)
		if err != nil {
			driverErrors = append(driverErrors, err)
			continue
		}
		list := action.NewList(cfg)
		list.All = true
		list.StateMask = action.ListAll
		list.Sort = action.ByDateDesc
		releases, err := list.Run()
		if err != nil {
			driverErrors = append(driverErrors, fmt.Errorf("helm list using %s driver: %w", driver, err))
			continue
		}
		for _, rel := range releases {
			if rel == nil {
				continue
			}
			obj := e.releaseObject(cfg, rel, driver)
			key := objectKey(obj)
			if existing, ok := seen[key]; ok {
				if releaseRevision(obj) <= releaseRevision(objects[existing]) {
					continue
				}
				objects[existing] = obj
				continue
			}
			seen[key] = len(objects)
			objects = append(objects, obj)
		}
	}
	attemptedDrivers := len(drivers) - len(skippedListErrors)
	if attemptedDrivers == 0 {
		return nil, false, fmt.Errorf("helm list skipped all storage drivers due to terminal storage list errors: %s", joinErrors(skippedListErrors))
	}
	if len(objects) == 0 && len(driverErrors) > 0 {
		if len(driverErrors) == attemptedDrivers {
			return nil, false, fmt.Errorf("helm list failed for all storage drivers: %s", joinErrors(driverErrors))
		}
	}
	for _, err := range driverErrors {
		slog.Warn("helm list storage driver failed", "cluster", e.cluster, "namespace", e.namespace, "error", err)
	}
	for _, err := range skippedListErrors {
		slog.Warn("helm list storage driver skipped", "cluster", e.cluster, "namespace", e.namespace, "error", err)
	}
	authoritative := len(skippedListErrors) == 0 && len(driverErrors) == 0
	return objects, authoritative, nil
}

func joinErrors(errs []error) string {
	parts := make([]string, 0, len(errs))
	for _, err := range errs {
		if err != nil {
			parts = append(parts, err.Error())
		}
	}
	return strings.Join(parts, "; ")
}

func (e *helmEntry) actionConfig(driver string) (*action.Configuration, error) {
	var cfg action.Configuration
	if err := cfg.Init(helmRESTClientGetter{clientCfg: e.clientCfg}, e.namespace, driver, func(format string, v ...interface{}) {
		slog.Debug(fmt.Sprintf(format, v...), "cluster", e.cluster, "namespace", e.namespace, "driver", driver)
	}); err != nil {
		return nil, fmt.Errorf("initialize helm %s driver: %w", driver, err)
	}
	return &cfg, nil
}

func (e *helmEntry) releaseObject(cfg *action.Configuration, rel *release.Release, driver string) map[string]interface{} {
	ns := rel.Namespace
	if ns == "" {
		ns = e.namespace
	}
	updated := ""
	description := ""
	status := "unknown"
	if rel.Info != nil {
		status = string(rel.Info.Status)
		updated = rel.Info.LastDeployed.Time.Format(time.RFC3339)
		description = rel.Info.Description
	}
	chartName, chartVersion, appVersion := chartDetails(rel)

	statusObj := map[string]interface{}{
		"status":        status,
		"revision":      rel.Version,
		"updated":       updated,
		"description":   description,
		"storageDriver": driver,
	}

	return map[string]interface{}{
		"apiVersion": "helm.sh/v3",
		"kind":       "HelmRelease",
		"metadata": map[string]interface{}{
			"uid":               "helmrelease:" + ns + ":" + rel.Name,
			"name":              rel.Name,
			"namespace":         ns,
			"creationTimestamp": firstDeployed(rel),
			"labels": map[string]string{
				"app.kubernetes.io/managed-by": "Helm",
				"helm.sh/chart":                chartName + "-" + chartVersion,
				"status":                       status,
			},
		},
		"spec": map[string]interface{}{
			"chart":      chartName,
			"version":    chartVersion,
			"appVersion": appVersion,
		},
		"status": statusObj,
	}
}

func helmHistory(cfg *action.Configuration, name string) ([]map[string]interface{}, error) {
	history := action.NewHistory(cfg)
	revisions, err := history.Run(name)
	if err != nil {
		return nil, err
	}
	result := make([]map[string]interface{}, 0, len(revisions))
	for _, rel := range revisions {
		if rel == nil {
			continue
		}
		updated := ""
		description := ""
		status := "unknown"
		if rel.Info != nil {
			status = string(rel.Info.Status)
			updated = rel.Info.LastDeployed.Time.Format(time.RFC3339)
			description = rel.Info.Description
		}
		chartName, chartVersion, appVersion := chartDetails(rel)
		result = append(result, map[string]interface{}{
			"revision":    rel.Version,
			"status":      status,
			"updated":     updated,
			"description": description,
			"chart":       chartName,
			"version":     chartVersion,
			"appVersion":  appVersion,
		})
	}
	return result, nil
}

func chartDetails(rel *release.Release) (string, string, string) {
	if rel == nil || rel.Chart == nil || rel.Chart.Metadata == nil {
		return "", "", ""
	}
	return rel.Chart.Metadata.Name, rel.Chart.Metadata.Version, rel.Chart.Metadata.AppVersion
}

func firstDeployed(rel *release.Release) string {
	if rel == nil || rel.Info == nil {
		return ""
	}
	return rel.Info.FirstDeployed.Time.Format(time.RFC3339)
}

func releaseRevision(obj map[string]interface{}) int {
	status, _ := obj["status"].(map[string]interface{})
	revision, _ := status["revision"].(int)
	return revision
}

func (e *helmEntry) emitObject(key string, objectBytes []byte) {
	e.mu.Lock()
	previous := e.objects[key]
	if string(previous) == string(objectBytes) {
		e.mu.Unlock()
		return
	}
	eventType := "MODIFIED"
	if previous == nil {
		eventType = "ADDED"
	}
	e.objects[key] = objectBytes
	e.mu.Unlock()

	var obj map[string]interface{}
	if err := json.Unmarshal(objectBytes, &obj); err != nil {
		e.broadcast(errorEvent("helm release decode failed", err))
		return
	}
	event, err := json.Marshal(map[string]interface{}{"type": eventType, "object": obj})
	if err != nil {
		e.broadcast(errorEvent("helm release event encode failed", err))
		return
	}
	e.broadcast(event)
}

func (e *helmEntry) deleteMissing(current map[string][]byte) {
	e.mu.Lock()
	missing := make([][]byte, 0)
	for key, objectBytes := range e.objects {
		if _, ok := current[key]; ok {
			continue
		}
		missing = append(missing, objectBytes)
		delete(e.objects, key)
	}
	e.mu.Unlock()

	for _, objectBytes := range missing {
		var obj map[string]interface{}
		if err := json.Unmarshal(objectBytes, &obj); err != nil {
			e.broadcast(errorEvent("helm release delete decode failed", err))
			continue
		}
		event, err := json.Marshal(map[string]interface{}{"type": "DELETED", "object": obj})
		if err != nil {
			e.broadcast(errorEvent("helm release delete encode failed", err))
			continue
		}
		e.broadcast(event)
	}
}

func (e *helmEntry) broadcast(msg []byte) {
	e.updateCache(msg)
	e.sendToClients(msg)
}

func (e *helmEntry) sendToClients(msg []byte) {
	e.mu.Lock()
	clients := make([]chan []byte, 0, len(e.clients))
	for ch := range e.clients {
		clients = append(clients, ch)
	}
	e.mu.Unlock()

	for _, ch := range clients {
		select {
		case ch <- msg:
		default:
		}
	}
}

func (e *helmEntry) updateCache(msg []byte) {
	var envelope struct {
		Type   string                 `json:"type"`
		Object map[string]interface{} `json:"object"`
		Error  string                 `json:"error"`
	}
	if err := json.Unmarshal(msg, &envelope); err != nil {
		return
	}
	if envelope.Error != "" {
		e.setTerminalError(msg)
		return
	}
	if envelope.Object == nil {
		return
	}
	key := objectKey(envelope.Object)
	if key == "" {
		return
	}

	e.mu.Lock()
	defer e.mu.Unlock()
	if envelope.Type == "DELETED" {
		delete(e.cache, key)
		return
	}
	e.cache[key] = msg
}

func (e *helmEntry) setTerminalError(msg []byte) {
	e.mu.Lock()
	defer e.mu.Unlock()

	e.terminalError = msg
}

func (e *helmEntry) clearTerminalError() {
	e.mu.Lock()
	defer e.mu.Unlock()

	e.terminalError = nil
}

func (e *helmEntry) broadcastStorageError(resource string, message string, skipList bool) {
	e.setStorageTerminalError(resource, message, skipList)
	e.sendToClients(errorMessage(message))
}

func (e *helmEntry) setStorageTerminalError(resource string, message string, skipList bool) {
	e.mu.Lock()
	defer e.mu.Unlock()

	e.storageTerminalErrors[resource] = storageTerminalError{message: message, skipList: skipList}
}

func (e *helmEntry) storageTerminalError(resource string) (storageTerminalError, bool) {
	e.mu.Lock()
	defer e.mu.Unlock()

	terminal, ok := e.storageTerminalErrors[resource]
	return terminal, ok
}

func (e *helmEntry) clearStorageTerminalError(resource string) {
	e.mu.Lock()
	defer e.mu.Unlock()

	delete(e.storageTerminalErrors, resource)
}

func (e *helmEntry) storageTerminalErrorEvent() []byte {
	e.mu.Lock()
	defer e.mu.Unlock()

	return e.storageTerminalErrorEventLocked()
}

func (e *helmEntry) terminalErrorSnapshotLocked() []byte {
	if e.terminalError != nil {
		return e.terminalError
	}
	return e.storageTerminalErrorEventLocked()
}

func (e *helmEntry) storageTerminalErrorEventLocked() []byte {
	if len(e.storageTerminalErrors) == 0 {
		return nil
	}
	resources := make([]string, 0, len(e.storageTerminalErrors))
	for resource := range e.storageTerminalErrors {
		resources = append(resources, resource)
	}
	sort.Strings(resources)
	messages := make([]string, 0, len(resources))
	for _, resource := range resources {
		messages = append(messages, e.storageTerminalErrors[resource].message)
	}
	return errorMessage(strings.Join(messages, "; "))
}

func objectKey(obj map[string]interface{}) string {
	meta, _ := obj["metadata"].(map[string]interface{})
	if uid, _ := meta["uid"].(string); uid != "" {
		return uid
	}
	name, _ := meta["name"].(string)
	namespace, _ := meta["namespace"].(string)
	if name == "" {
		return ""
	}
	return name + "/" + namespace
}

func isHelmStorageObject(obj *unstructured.Unstructured) bool {
	if obj == nil {
		return false
	}
	if typ, _ := obj.Object["type"].(string); typ == "helm.sh/release.v1" {
		return true
	}
	labels := obj.GetLabels()
	if labels["owner"] == "helm" {
		return true
	}
	return strings.HasPrefix(obj.GetName(), "sh.helm.release.v1.") && labels["name"] != ""
}
