GO ?= go
GOOS ?= linux
GOARCH ?= amd64
VERSION ?= local
PACKAGE_DIR ?= build/release

.PHONY: check test build build-linux run release clean

check:
	$(GO) vet ./...
	@test -z "$$(gofmt -l cmd internal)" || { echo 'Go files need formatting.' >&2; exit 1; }

test:
	$(GO) test -race ./...

build:
	@mkdir -p bin
	CGO_ENABLED=0 $(GO) build -trimpath -ldflags='-s -w' -o bin/office-api ./cmd/office

build-linux:
	@mkdir -p bin/$(GOOS)-$(GOARCH)
	CGO_ENABLED=0 GOOS=$(GOOS) GOARCH=$(GOARCH) $(GO) build -trimpath -ldflags='-s -w' -o bin/$(GOOS)-$(GOARCH)/office-api ./cmd/office

run:
	$(GO) run ./cmd/office

release: build-linux
	@case "$(PACKAGE_DIR)" in build/?*) ;; *) echo 'PACKAGE_DIR must be inside build/.' >&2; exit 2;; esac; \
	case "/$(PACKAGE_DIR)/" in */../*|*/./*) echo 'PACKAGE_DIR cannot contain traversal segments.' >&2; exit 2;; esac; \
	mkdir -p build "$$(dirname "$(PACKAGE_DIR)")"; \
	stage=$$(mktemp -d build/.release.XXXXXX); previous=$$stage.previous; \
	trap 'rm -rf "$$stage"; if [ -e "$$previous" ] || [ -L "$$previous" ]; then if [ ! -e "$(PACKAGE_DIR)" ] && [ ! -L "$(PACKAGE_DIR)" ]; then mv "$$previous" "$(PACKAGE_DIR)"; else rm -rf "$$previous"; fi; fi' EXIT; \
	trap 'exit 129' HUP; trap 'exit 130' INT; trap 'exit 143' TERM; \
	set -eu; \
	cp bin/$(GOOS)-$(GOARCH)/office-api "$$stage/office-api"; \
	cp -R data config "$$stage/"; \
	printf '%s\n' "$(VERSION)" > "$$stage/RELEASE"; \
	(cd "$$stage" && if command -v sha256sum >/dev/null 2>&1; then find . -type f ! -name SHA256SUMS -exec sha256sum {} + > SHA256SUMS; else find . -type f ! -name SHA256SUMS -exec shasum -a 256 {} + > SHA256SUMS; fi); \
	if [ -e "$(PACKAGE_DIR)" ] || [ -L "$(PACKAGE_DIR)" ]; then mv "$(PACKAGE_DIR)" "$$previous"; fi; \
	if ! mv "$$stage" "$(PACKAGE_DIR)"; then if [ -e "$$previous" ]; then mv "$$previous" "$(PACKAGE_DIR)"; fi; exit 1; fi; \
	echo "Server release prepared: $(PACKAGE_DIR)"

clean:
	rm -rf bin build
