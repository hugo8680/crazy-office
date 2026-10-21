package identity

// ReadActiveSessions holds a directory read lock while an in-memory resource
// validates and updates its leases. The resolver returns copies of current
// identities, never caller-supplied department or role metadata. The callback
// must not call another Store method or retain the resolver after it returns.
func (s *Store) ReadActiveSessions(work func(resolve func(string, int64) *Actor) error) error {
	s.mu.RLock()
	defer s.mu.RUnlock()
	active := make(map[string]*employee, len(s.data.Employees))
	for i := range s.data.Employees {
		if e := &s.data.Employees[i]; e.Status == "active" {
			active[e.ID] = e
		}
	}
	return work(func(id string, epoch int64) *Actor {
		if e := active[id]; e != nil && e.Epoch == epoch {
			return trusted(*e)
		}
		return nil
	})
}
