package identity

import (
	"testing"
	"time"
)

func TestReadActiveSessionsResolvesCopiesAndLinearizesAccountDeactivation(t *testing.T) {
	s, _ := fixture(t)
	a := join(t, s, "session-reader", []string{"employee"})
	entered, release, finished, changing := make(chan struct{}), make(chan struct{}), make(chan error, 1), make(chan error, 1)
	go func() {
		finished <- s.ReadActiveSessions(func(resolve func(string, int64) *Actor) error {
			actual := resolve(a.ID, a.Epoch)
			if actual == nil || actual.Name != a.Name || resolve(a.ID, a.Epoch+1) != nil || resolve("unknown", 1) != nil {
				t.Error("resolver accepted stale or unknown identity")
			}
			actual.Name = "forged"
			actual.Roles[0] = "admin"
			again := resolve(a.ID, a.Epoch)
			if again.Name != a.Name || again.Roles[0] != "employee" {
				t.Error("resolver exposed mutable stored identity")
			}
			close(entered)
			<-release
			return nil
		})
	}()
	<-entered
	go func() {
		_, err := s.UpdateEmployee("bootstrap", a.ID, map[string]any{"active": false})
		changing <- err
	}()
	select {
	case <-changing:
		t.Fatal("deactivation crossed active identity read lock")
	case <-time.After(20 * time.Millisecond):
	}
	close(release)
	if err := <-finished; err != nil {
		t.Fatal(err)
	}
	if err := <-changing; err != nil {
		t.Fatal(err)
	}
	_ = s.ReadActiveSessions(func(resolve func(string, int64) *Actor) error {
		if resolve(a.ID, a.Epoch) != nil {
			t.Fatal("disabled session still resolves")
		}
		return nil
	})
}
