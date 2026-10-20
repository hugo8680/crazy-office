package erpflow

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	"crazyoffice/server/internal/model"
)

type recoverableProvider struct {
	model.Provider
	mu                    sync.Mutex
	ready, recover, block bool
	probes                int
	deadline              bool
}

func (p *recoverableProvider) Status(ctx context.Context, probe bool) (model.Status, error) {
	p.mu.Lock()
	if probe {
		p.probes++
		_, p.deadline = ctx.Deadline()
		if p.block {
			p.mu.Unlock()
			<-ctx.Done()
			return model.Status{}, ctx.Err()
		}
		p.ready = p.recover
	}
	status := model.Status{Ready: p.ready, Provider: "tokendance", Model: "fixture-model"}
	p.mu.Unlock()
	return status, nil
}

func TestExplicitSubmitRecoversCachedOfflineModelWithoutLegacyScheduler(t *testing.T) {
	f := newFlow(t)
	p := &recoverableProvider{Provider: f.provider, recover: true}
	f.svc.Provider = p
	// Reading the ERP has no paid connection probe and cannot change readiness.
	if _, e := f.svc.Snapshot(context.Background(), f.employee); e != nil {
		t.Fatal(e)
	}
	if p.probes != 0 {
		t.Fatal("snapshot performed a model probe")
	}
	out, e := f.svc.Create(context.Background(), f.employee, f.payload("project_setup"), "recovery-create-12345")
	if e != nil {
		t.Fatal(e)
	}
	f.wait(S(Map(out["document"])["id"]))
	if p.probes != 1 || !p.deadline {
		t.Fatal("explicit submit did not use one bounded recovery probe")
	}
	if _, e = f.svc.Create(context.Background(), f.employee, f.payload("project_setup"), "recovery-healthy-12345"); e != nil {
		t.Fatal(e)
	}
	if p.probes != 1 {
		t.Fatal("healthy provider was probed again")
	}
}

func TestExplicitRetryRecoversDraftAndFailedProbeNeverCreatesBusinessData(t *testing.T) {
	f := newFlow(t)
	doc := f.command(f.employee, "document.create", f.payload("project_setup"))
	p := &recoverableProvider{Provider: f.provider, recover: true}
	f.svc.Provider = p
	if _, e := f.svc.Start(context.Background(), f.employee, S(doc["id"])); e != nil {
		t.Fatal(e)
	}
	f.wait(S(doc["id"]))
	if p.probes != 1 || !p.deadline {
		t.Fatal("explicit retry failed to reconnect")
	}
	p.mu.Lock()
	p.ready, p.recover = false, false
	p.mu.Unlock()
	before, e := f.svc.Snapshot(context.Background(), f.employee)
	if e != nil {
		t.Fatal(e)
	}
	_, e = f.svc.Create(context.Background(), f.employee, f.payload("project_setup"), "recovery-fails-12345")
	domainStatus(t, e, 503)
	after, e := f.svc.Snapshot(context.Background(), f.employee)
	if e != nil {
		t.Fatal(e)
	}
	if len(Rows(before["documents"])) != len(Rows(after["documents"])) || p.probes != 2 {
		t.Fatal("failed recovery created a business document or failed to probe")
	}
}

func TestExplicitRecoveryHonorsRequestDeadlineAndDoesNotWriteOnCancellation(t *testing.T) {
	f := newFlow(t)
	p := &recoverableProvider{Provider: f.provider, block: true}
	f.svc.Provider = p
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()
	_, e := f.svc.Create(ctx, f.employee, f.payload("project_setup"), "recovery-deadline-12345")
	if !errors.Is(e, context.DeadlineExceeded) || p.probes != 1 || !p.deadline {
		t.Fatal("bounded request cancellation was ignored")
	}
	snap, e := f.svc.Snapshot(context.Background(), f.employee)
	if e != nil || len(Rows(snap["documents"])) != 0 {
		t.Fatal("cancelled probe created business data")
	}
}
