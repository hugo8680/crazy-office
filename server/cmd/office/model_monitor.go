package main

import (
	"context"
	"log"
	"time"

	"crazyoffice/server/internal/model"
)

type recoveryPolicy struct {
	next     time.Time
	interval time.Duration
}

func (p *recoveryPolicy) record(now time.Time, ready bool) {
	if ready || p.interval == 0 {
		p.interval = 5 * time.Minute
	} else {
		p.interval = min(30*time.Minute, 2*p.interval)
	}
	p.next = now.Add(p.interval)
}
func (p *recoveryPolicy) due(now time.Time, ready, enabled bool) bool {
	if ready {
		p.interval = 5 * time.Minute
		p.next = now.Add(p.interval)
		return false
	}
	return enabled && !now.Before(p.next)
}

// Ordinary status reads never incur a paid probe. A failed provider is retried
// only when automatic dispatch is enabled, with a bounded exponential backoff.
func monitorModels(ctx context.Context, provider model.Provider, automation func(context.Context) (map[string]any, error)) {
	probe := func() bool {
		probeCtx, cancel := context.WithTimeout(ctx, 35*time.Second)
		defer cancel()
		status, e := provider.Status(probeCtx, true)
		if e != nil || !status.Ready {
			log.Print("Model connection check failed")
			return false
		}
		log.Printf("Model provider=%s ready=%v model=%s", status.Provider, status.Ready, status.Model)
		return true
	}
	policy := recoveryPolicy{}
	policy.record(time.Now(), probe())
	ticker := time.NewTicker(time.Minute)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case now := <-ticker.C:
			status, e := provider.Status(ctx, false)
			if e != nil {
				continue
			}
			state, e := automation(ctx)
			if e != nil {
				continue
			}
			if policy.due(now, status.Ready, state["enabled"] == true) {
				policy.record(now, probe())
			}
		}
	}
}
