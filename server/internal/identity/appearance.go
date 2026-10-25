package identity

// These stable IDs correspond to the shared employee wardrobe in the client.
// Appearance is a personal preference, independent of department and authority.
func validOutfit(id string) bool {
	return contains([]string{"atelier", "linen", "marine", "terracotta", "plum", "cloud"}, id)
}

// SetAppearance uses the authenticated identity and epoch, never a form's user
// ID. Saving a preference must not revoke a session or move its office avatar.
func (s *Store) SetAppearance(actor *Actor, outfitID string) (*Actor, error) {
	if actor == nil || actor.ID == "" {
		return nil, Fail(401, "请先登录。")
	}
	if !validOutfit(outfitID) {
		return nil, Fail(400, "请选择有效搭配。")
	}
	value, err := s.transact(func(d *state) (any, error) {
		person, err := active(d, actor.ID)
		if err != nil {
			return nil, err
		}
		if person.Epoch != actor.Epoch {
			return nil, Fail(401, "登录信息已变更，请重新登录。")
		}
		person.OutfitID = outfitID
		person.UpdatedAt = timestamp(s.now())
		return trusted(*person), nil
	})
	if err != nil {
		return nil, err
	}
	return value.(*Actor), nil
}
