package main

import (
	"testing"
	"time"
)

func TestRecoveryBackoffOnlyWhenNeeded(t *testing.T) {
	now := time.Date(2026, 10, 20, 0, 0, 0, 0, time.UTC)
	p := recoveryPolicy{}
	p.record(now, false)
	if p.due(now.Add(4*time.Minute), false, true) || p.due(now.Add(5*time.Minute), false, false) {
		t.Fatal("probe before backoff or while paused")
	}
	if !p.due(now.Add(5*time.Minute), false, true) {
		t.Fatal("failed enabled provider never recovered")
	}
	for _, want := range []time.Duration{10, 20, 30, 30} {
		p.record(now, false)
		if p.interval != want*time.Minute {
			t.Fatalf("got %s want %s", p.interval, want*time.Minute)
		}
	}
	if p.due(now, true, true) {
		t.Fatal("probed healthy provider")
	}
	if p.interval != 5*time.Minute {
		t.Fatal("did not reset recovered backoff")
	}
}
