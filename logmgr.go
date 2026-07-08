package main

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"sort"
	"strings"
	"sync"
	"time"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/util/runtime"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/tools/clientcmd"
)

type LogManager struct {
	loadingRules *clientcmd.ClientConfigLoadingRules
}

type logLine struct {
	Pod       string    `json:"pod"`
	Container string    `json:"container"`
	Timestamp time.Time `json:"-"`
	Time      string    `json:"timestamp"`
	Line      string    `json:"line"`
	Seq       int64     `json:"seq"`
}

type logEnvelope struct {
	Type      string `json:"type"`
	Pod       string `json:"pod,omitempty"`
	Container string `json:"container,omitempty"`
	Timestamp string `json:"timestamp,omitempty"`
	Line      string `json:"line,omitempty"`
	Seq       int64  `json:"seq,omitempty"`
	Error     string `json:"error,omitempty"`
	Info      string `json:"info,omitempty"`
}

func NewLogManager(loadingRules *clientcmd.ClientConfigLoadingRules) *LogManager {
	if loadingRules == nil {
		loadingRules = clientcmd.NewDefaultClientConfigLoadingRules()
	}
	return &LogManager{loadingRules: loadingRules}
}

func (m *LogManager) Subscribe(cluster, resource, namespace, name string, tailLines int64) (chan []byte, func(), error) {
	over := &clientcmd.ConfigOverrides{CurrentContext: cluster}
	clientCfg := clientcmd.NewNonInteractiveDeferredLoadingClientConfig(m.loadingRules, over)
	cfg, err := clientCfg.ClientConfig()
	if err != nil {
		slog.Error("failed to build log cluster config", "cluster", cluster, "resource", resource, "namespace", namespace, "name", name, "error", err)
		return nil, nil, fmt.Errorf("failed to build config for %s: %w", cluster, err)
	}
	client, err := kubernetes.NewForConfig(cfg)
	if err != nil {
		slog.Error("failed to create log client", "cluster", cluster, "resource", resource, "namespace", namespace, "name", name, "error", err)
		return nil, nil, fmt.Errorf("failed to create kubernetes client: %w", err)
	}

	ctx, cancel := context.WithCancel(context.Background())
	ch := make(chan []byte, 512)
	go func() {
		defer close(ch)
		slog.Info("log subscription opened", "cluster", cluster, "resource", resource, "namespace", namespace, "name", name, "tailLines", tailLines)
		switch resource {
		case "pods":
			m.streamPod(ctx, client, namespace, name, tailLines, ch)
		case "deployments":
			m.streamDeployment(ctx, client, namespace, name, tailLines, ch)
		default:
			sendLogError(ctx, ch, "unsupported log resource: "+resource)
		}
		slog.Info("log subscription closed", "cluster", cluster, "resource", resource, "namespace", namespace, "name", name)
	}()

	unsubscribe := func() {
		cancel()
	}
	return ch, unsubscribe, nil
}

func (m *LogManager) streamPod(ctx context.Context, client kubernetes.Interface, namespace, podName string, tailLines int64, out chan<- []byte) {
	pod, err := client.CoreV1().Pods(namespace).Get(ctx, podName, metav1.GetOptions{})
	if err != nil {
		slog.Error("failed to get pod for logs", "namespace", namespace, "pod", podName, "error", err)
		sendLogError(ctx, out, "failed to get pod logs target: "+err.Error())
		return
	}
	m.streamPodObject(ctx, client, pod, tailLines, out)
}

func (m *LogManager) streamDeployment(ctx context.Context, client kubernetes.Interface, namespace, deploymentName string, tailLines int64, out chan<- []byte) {
	deployment, err := client.AppsV1().Deployments(namespace).Get(ctx, deploymentName, metav1.GetOptions{})
	if err != nil {
		slog.Error("failed to get deployment for logs", "namespace", namespace, "deployment", deploymentName, "error", err)
		sendLogError(ctx, out, "failed to get deployment logs target: "+err.Error())
		return
	}
	selector, err := metav1.LabelSelectorAsSelector(deployment.Spec.Selector)
	if err != nil {
		slog.Error("failed to build deployment pod selector for logs", "namespace", namespace, "deployment", deploymentName, "error", err)
		sendLogError(ctx, out, "failed to build deployment pod selector: "+err.Error())
		return
	}

	streams := &podLogStreams{cancels: make(map[string]context.CancelFunc)}
	defer streams.stopAll()

	announced := false
	for {
		list, err := client.CoreV1().Pods(namespace).List(ctx, metav1.ListOptions{LabelSelector: selector.String()})
		if err != nil {
			if ctx.Err() != nil {
				return
			}
			slog.Error("failed to list deployment pods for logs", "namespace", namespace, "deployment", deploymentName, "selector", selector.String(), "error", err)
			sendLogError(ctx, out, "failed to list deployment pods: "+err.Error())
			if !sleepOrDone(ctx, 3*time.Second) {
				return
			}
			continue
		}

		currentPods := make(map[string]struct{}, len(list.Items))
		for i := range list.Items {
			currentPods[list.Items[i].Name] = struct{}{}
			streams.start(ctx, client, &list.Items[i], tailLines, out)
		}
		streams.stopMissing(currentPods)
		if !announced {
			sendLogInfo(ctx, out, fmt.Sprintf("watching logs for deployment %s across %d current pod(s)", deploymentName, len(list.Items)))
			announced = true
		}

		opts := metav1.ListOptions{
			LabelSelector:   selector.String(),
			ResourceVersion: list.GetResourceVersion(),
		}
		watcher, err := client.CoreV1().Pods(namespace).Watch(ctx, opts)
		if err != nil {
			if ctx.Err() != nil {
				return
			}
			slog.Error("failed to watch deployment pods for logs", "namespace", namespace, "deployment", deploymentName, "selector", selector.String(), "resourceVersion", opts.ResourceVersion, "error", err)
			sendLogError(ctx, out, "failed to watch deployment pods: "+err.Error())
			if !sleepOrDone(ctx, 3*time.Second) {
				return
			}
			continue
		}

		relist := false
		for !relist {
			select {
			case <-ctx.Done():
				watcher.Stop()
				return
			case event, ok := <-watcher.ResultChan():
				if !ok {
					watcher.Stop()
					slog.Warn("deployment pod watch for logs closed", "namespace", namespace, "deployment", deploymentName)
					relist = true
					break
				}
				pod, ok := event.Object.(*corev1.Pod)
				if !ok {
					runtime.HandleError(fmt.Errorf("unexpected deployment pod watch object %T", event.Object))
					continue
				}
				switch event.Type {
				case "ADDED", "MODIFIED":
					if pod.DeletionTimestamp == nil {
						streams.start(ctx, client, pod, tailLines, out)
					} else {
						streams.stop(pod.Name)
					}
				case "DELETED":
					streams.stop(pod.Name)
				}
			}
		}
		if !sleepOrDone(ctx, time.Second) {
			return
		}
	}
}

type podLogStreams struct {
	mu      sync.Mutex
	cancels map[string]context.CancelFunc
}

func (s *podLogStreams) start(parent context.Context, client kubernetes.Interface, pod *corev1.Pod, tailLines int64, out chan<- []byte) {
	if pod == nil || pod.Name == "" {
		return
	}
	s.mu.Lock()
	if _, ok := s.cancels[pod.Name]; ok {
		s.mu.Unlock()
		return
	}
	ctx, cancel := context.WithCancel(parent)
	s.cancels[pod.Name] = cancel
	s.mu.Unlock()

	go func() {
		defer func() {
			s.mu.Lock()
			delete(s.cancels, pod.Name)
			s.mu.Unlock()
		}()
		streamPodLogs(ctx, client, pod, tailLines, out)
	}()
}

func (s *podLogStreams) stop(podName string) {
	s.mu.Lock()
	cancel := s.cancels[podName]
	delete(s.cancels, podName)
	s.mu.Unlock()
	if cancel != nil {
		cancel()
	}
}

func (s *podLogStreams) stopAll() {
	s.mu.Lock()
	cancels := make([]context.CancelFunc, 0, len(s.cancels))
	for podName, cancel := range s.cancels {
		cancels = append(cancels, cancel)
		delete(s.cancels, podName)
	}
	s.mu.Unlock()
	for _, cancel := range cancels {
		cancel()
	}
}

func (s *podLogStreams) stopMissing(current map[string]struct{}) {
	s.mu.Lock()
	missing := make([]string, 0)
	for podName := range s.cancels {
		if _, ok := current[podName]; !ok {
			missing = append(missing, podName)
		}
	}
	s.mu.Unlock()
	for _, podName := range missing {
		s.stop(podName)
	}
}

func (m *LogManager) streamPodObject(ctx context.Context, client kubernetes.Interface, pod *corev1.Pod, tailLines int64, out chan<- []byte) {
	streamPodLogs(ctx, client, pod, tailLines, out)
}

func streamPodLogs(ctx context.Context, client kubernetes.Interface, pod *corev1.Pod, tailLines int64, out chan<- []byte) {
	containers := podContainerNames(pod)
	if len(containers) == 0 {
		sendLogInfo(ctx, out, "pod has no containers")
		return
	}

	startedAt := time.Now()
	initial := make([]logLine, 0)
	for _, container := range containers {
		lines, err := readContainerLogs(ctx, client, pod.Namespace, pod.Name, container, tailLines)
		if err != nil {
			slog.Warn("failed to read initial container logs", "namespace", pod.Namespace, "pod", pod.Name, "container", container, "error", err)
			sendLogError(ctx, out, fmt.Sprintf("%s/%s initial logs failed: %v", pod.Name, container, err))
			continue
		}
		initial = append(initial, lines...)
	}
	sortLogLines(initial)
	for _, line := range initial {
		sendLogLine(ctx, out, line)
	}
	sendLogInfo(ctx, out, fmt.Sprintf("following logs for pod %s", pod.Name))

	var wg sync.WaitGroup
	for _, container := range containers {
		wg.Add(1)
		go func(container string) {
			defer wg.Done()
			followContainerLogs(ctx, client, pod.Namespace, pod.Name, container, startedAt, out)
		}(container)
	}
	wg.Wait()
}

func readContainerLogs(ctx context.Context, client kubernetes.Interface, namespace, podName, container string, tailLines int64) ([]logLine, error) {
	opts := &corev1.PodLogOptions{
		Container:  container,
		TailLines:  &tailLines,
		Timestamps: true,
	}
	req := client.CoreV1().Pods(namespace).GetLogs(podName, opts)
	stream, err := req.Stream(ctx)
	if err != nil {
		return nil, err
	}
	defer stream.Close()
	return scanLogLines(stream, podName, container)
}

func followContainerLogs(ctx context.Context, client kubernetes.Interface, namespace, podName, container string, since time.Time, out chan<- []byte) {
	sinceTime := metav1.NewTime(since)
	zeroTail := int64(0)
	opts := &corev1.PodLogOptions{
		Container:  container,
		Follow:     true,
		TailLines:  &zeroTail,
		SinceTime:  &sinceTime,
		Timestamps: true,
	}
	req := client.CoreV1().Pods(namespace).GetLogs(podName, opts)
	stream, err := req.Stream(ctx)
	if err != nil {
		if ctx.Err() == nil {
			slog.Warn("failed to follow container logs", "namespace", namespace, "pod", podName, "container", container, "error", err)
			sendLogError(ctx, out, fmt.Sprintf("%s/%s follow logs failed: %v", podName, container, err))
		}
		return
	}
	defer stream.Close()

	scanner := bufio.NewScanner(stream)
	for scanner.Scan() {
		line := parseLogLine(podName, container, scanner.Text())
		sendLogLine(ctx, out, line)
	}
	if err := scanner.Err(); err != nil && ctx.Err() == nil {
		slog.Warn("container log stream ended with scanner error", "namespace", namespace, "pod", podName, "container", container, "error", err)
		sendLogError(ctx, out, fmt.Sprintf("%s/%s log stream error: %v", podName, container, err))
	}
}

func scanLogLines(reader io.Reader, podName, container string) ([]logLine, error) {
	scanner := bufio.NewScanner(reader)
	lines := make([]logLine, 0)
	for scanner.Scan() {
		lines = append(lines, parseLogLine(podName, container, scanner.Text()))
	}
	return lines, scanner.Err()
}

func parseLogLine(podName, container, raw string) logLine {
	timestamp, line, ok := strings.Cut(raw, " ")
	if !ok {
		now := time.Now()
		return logLine{Pod: podName, Container: container, Timestamp: now, Time: now.Format(time.RFC3339Nano), Line: raw}
	}
	parsed, err := time.Parse(time.RFC3339Nano, timestamp)
	if err != nil {
		now := time.Now()
		return logLine{Pod: podName, Container: container, Timestamp: now, Time: now.Format(time.RFC3339Nano), Line: raw}
	}
	return logLine{Pod: podName, Container: container, Timestamp: parsed, Time: parsed.Format(time.RFC3339Nano), Line: line}
}

func sortLogLines(lines []logLine) {
	sort.SliceStable(lines, func(i, j int) bool {
		if lines[i].Timestamp.Equal(lines[j].Timestamp) {
			if lines[i].Pod == lines[j].Pod {
				return lines[i].Container < lines[j].Container
			}
			return lines[i].Pod < lines[j].Pod
		}
		return lines[i].Timestamp.Before(lines[j].Timestamp)
	})
	for i := range lines {
		lines[i].Seq = int64(i)
	}
}

func podContainerNames(pod *corev1.Pod) []string {
	if pod == nil {
		return nil
	}
	seen := make(map[string]struct{})
	names := make([]string, 0, len(pod.Spec.InitContainers)+len(pod.Spec.Containers)+len(pod.Spec.EphemeralContainers))
	add := func(name string) {
		if name == "" {
			return
		}
		if _, ok := seen[name]; ok {
			return
		}
		seen[name] = struct{}{}
		names = append(names, name)
	}
	for _, container := range pod.Spec.InitContainers {
		add(container.Name)
	}
	for _, container := range pod.Spec.Containers {
		add(container.Name)
	}
	for _, container := range pod.Spec.EphemeralContainers {
		add(container.Name)
	}
	return names
}

func sendLogLine(ctx context.Context, out chan<- []byte, line logLine) {
	envelope := logEnvelope{
		Type:      "LOG",
		Pod:       line.Pod,
		Container: line.Container,
		Timestamp: line.Time,
		Line:      line.Line,
		Seq:       line.Seq,
	}
	sendLogEnvelope(ctx, out, envelope)
}

func sendLogError(ctx context.Context, out chan<- []byte, message string) {
	sendLogEnvelope(ctx, out, logEnvelope{Type: "ERROR", Error: message})
}

func sendLogInfo(ctx context.Context, out chan<- []byte, message string) {
	sendLogEnvelope(ctx, out, logEnvelope{Type: "INFO", Info: message})
}

func sendLogEnvelope(ctx context.Context, out chan<- []byte, envelope logEnvelope) {
	data, err := json.Marshal(envelope)
	if err != nil {
		return
	}
	select {
	case out <- data:
	case <-ctx.Done():
	}
}

func sleepOrDone(ctx context.Context, duration time.Duration) bool {
	timer := time.NewTimer(duration)
	defer timer.Stop()
	select {
	case <-timer.C:
		return true
	case <-ctx.Done():
		return false
	}
}
