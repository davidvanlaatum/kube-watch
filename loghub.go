package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"strings"
	"sync"
	"time"
)

type browserLogHub struct {
	mu      sync.Mutex
	clients map[chan []byte]struct{}
}

func newBrowserLogHub() *browserLogHub {
	return &browserLogHub{clients: make(map[chan []byte]struct{})}
}

func (h *browserLogHub) subscribe() (chan []byte, func()) {
	ch := make(chan []byte, 32)
	h.mu.Lock()
	h.clients[ch] = struct{}{}
	h.mu.Unlock()

	var once sync.Once
	return ch, func() {
		once.Do(func() {
			h.mu.Lock()
			delete(h.clients, ch)
			h.mu.Unlock()
		})
	}
}

func (h *browserLogHub) publish(record slog.Record) {
	if record.Level < slog.LevelError {
		return
	}
	msg := browserLogMessage(record)
	payload, err := json.Marshal(map[string]interface{}{
		"type":  "BACKEND_LOG",
		"error": msg,
		"log": map[string]interface{}{
			"level":   record.Level.String(),
			"message": record.Message,
			"time":    record.Time.Format(time.RFC3339),
			"attrs":   slogAttrs(record),
		},
	})
	if err != nil {
		return
	}

	h.mu.Lock()
	clients := make([]chan []byte, 0, len(h.clients))
	for ch := range h.clients {
		clients = append(clients, ch)
	}
	h.mu.Unlock()

	for _, ch := range clients {
		select {
		case ch <- payload:
		default:
		}
	}
}

type browserLogHandler struct {
	next slog.Handler
	hub  *browserLogHub
}

func (h *browserLogHandler) Enabled(ctx context.Context, level slog.Level) bool {
	return h.next.Enabled(ctx, level)
}

func (h *browserLogHandler) Handle(ctx context.Context, record slog.Record) error {
	err := h.next.Handle(ctx, record)
	h.hub.publish(record)
	return err
}

func (h *browserLogHandler) WithAttrs(attrs []slog.Attr) slog.Handler {
	return &browserLogHandler{next: h.next.WithAttrs(attrs), hub: h.hub}
}

func (h *browserLogHandler) WithGroup(name string) slog.Handler {
	return &browserLogHandler{next: h.next.WithGroup(name), hub: h.hub}
}

func slogAttrs(record slog.Record) map[string]string {
	attrs := make(map[string]string)
	record.Attrs(func(attr slog.Attr) bool {
		attr.Value = attr.Value.Resolve()
		attrs[attr.Key] = attr.Value.String()
		return true
	})
	return attrs
}

func browserLogMessage(record slog.Record) string {
	parts := []string{record.Message}
	record.Attrs(func(attr slog.Attr) bool {
		attr.Value = attr.Value.Resolve()
		value := attr.Value.String()
		if value != "" {
			parts = append(parts, fmt.Sprintf("%s=%s", attr.Key, value))
		}
		return true
	})
	return "Backend error: " + strings.Join(parts, " ")
}
