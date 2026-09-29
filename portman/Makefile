.PHONY: help python

UV ?= uv

help: ## Show targets
	@grep -hE '^[a-zA-Z_-]+:.*?##' $(MAKEFILE_LIST) | sort | awk 'BEGIN {FS = ":.*?##"}; {printf "  %-10s %s\n", $$1, $$2}'

python: ## Create/sync .venv and install editable core (requires uv)
	@command -v $(UV) >/dev/null 2>&1 || { printf '%s\n' 'uv not found: https://docs.astral.sh/uv/getting-started/installation/'; exit 1; }
	$(UV) sync
