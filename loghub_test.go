package main

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"testing"
	"time"
)

func TestBrowserLogHubPublishesErrorRecords(t *testing.T) {
	hub := newBrowserLogHub()
	ch, unsubscribe := hub.subscribe()
	defer unsubscribe()

	record := slog.NewRecord(time.Date(2026, 7, 14, 12, 0, 0, 0, time.UTC), slog.LevelError, "gcloud token expired", 0)
	record.AddAttrs(slog.String("cluster", "dev"), slog.String("error", "exec plugin failed"))
	hub.publish(record)

	select {
	case msg := <-ch:
		var envelope struct {
			Type  string `json:"type"`
			Error string `json:"error"`
			Log   struct {
				Message string            `json:"message"`
				Attrs   map[string]string `json:"attrs"`
			} `json:"log"`
		}
		if err := json.Unmarshal(msg, &envelope); err != nil {
			t.Fatalf("log event should be JSON: %v", err)
		}
		if envelope.Type != "BACKEND_LOG" {
			t.Fatalf("type = %q, want BACKEND_LOG", envelope.Type)
		}
		if envelope.Error == "" || envelope.Log.Message != "gcloud token expired" || envelope.Log.Attrs["cluster"] != "dev" {
			t.Fatalf("unexpected envelope: %#v", envelope)
		}
	case <-time.After(100 * time.Millisecond):
		t.Fatal("expected error log event")
	}
}

func TestBrowserLogHandlerDelegatesToNextHandler(t *testing.T) {
	hub := newBrowserLogHub()
	next := slog.NewTextHandler(io.Discard, nil)
	handler := &browserLogHandler{next: next, hub: hub}

	if got := handler.Enabled(context.Background(), slog.LevelInfo); got != next.Enabled(context.Background(), slog.LevelInfo) {
		t.Fatalf("Enabled() = %v, want %v", got, next.Enabled(context.Background(), slog.LevelInfo))
	}

	withAttrs := handler.WithAttrs([]slog.Attr{slog.String("k", "v")})
	wrapped, ok := withAttrs.(*browserLogHandler)
	if !ok || wrapped.hub != hub {
		t.Fatalf("WithAttrs() = %#v, expected *browserLogHandler sharing the same hub", withAttrs)
	}

	withGroup := handler.WithGroup("g")
	groupWrapped, ok := withGroup.(*browserLogHandler)
	if !ok || groupWrapped.hub != hub {
		t.Fatalf("WithGroup() = %#v, expected *browserLogHandler sharing the same hub", withGroup)
	}
}

func TestBrowserLogHandlerIgnoresNonErrorRecords(t *testing.T) {
	hub := newBrowserLogHub()
	ch, unsubscribe := hub.subscribe()
	defer unsubscribe()
	handler := &browserLogHandler{next: slog.NewTextHandler(io.Discard, nil), hub: hub}

	if err := handler.Handle(context.Background(), slog.NewRecord(time.Now(), slog.LevelWarn, "warning", 0)); err != nil {
		t.Fatalf("handle warning: %v", err)
	}

	select {
	case msg := <-ch:
		t.Fatalf("unexpected non-error log event: %s", msg)
	case <-time.After(20 * time.Millisecond):
	}
}
