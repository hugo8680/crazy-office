package httpapi

import (
	"crypto/sha256"
	"encoding/hex"
	"net/http"

	"crazyoffice/server/internal/access"
)

// The hash binds an in-memory avatar lease to its authenticated browser. It is
// never accepted from JSON, returned to clients or used as an access credential.
func officeSessionLease(r *http.Request) string {
	token := access.CookieToken(r)
	if token == "" {
		return ""
	}
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}
