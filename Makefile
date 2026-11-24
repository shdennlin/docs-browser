# docs-browser Makefile. `make help` lists targets.
.DEFAULT_GOAL := help
BIN := docs-browser
ARGS ?=

-include Makefile.local

.PHONY: help build run test clean

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*## ' $(MAKEFILE_LIST) | awk 'BEGIN{FS=":.*## "}{printf "  %-8s %s\n", $$1, $$2}'

build: ## Build the release binary
	cargo build --release

run: build ## Run the release binary (pass flags with ARGS="...")
	./target/release/$(BIN) $(ARGS)

test: ## Run Rust tests, the vendored-file checksum test and frontend unit tests
	cargo test
	./tests/check-vendor.sh --selftest
	@if ls frontend/*.test.js >/dev/null 2>&1; then node --test frontend/*.test.js; else echo "no frontend tests yet"; fi

clean: ## Remove build output
	cargo clean
