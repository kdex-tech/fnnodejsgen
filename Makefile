REPOSITORY ?=
IMG ?= kdex-tech/fnnodejsgen
TAG ?= $(shell git describe --dirty='-d' --tags 2>/dev/null || echo dev)

# if REPOSITORY is set make sure it ends with a /
ifneq ($(REPOSITORY),)
override REPOSITORY := $(REPOSITORY)/
endif

# if TAG is set make sure it starts with a :
ifneq ($(TAG),)
override TAG := :$(TAG)
endif

CONTAINER_TOOL ?= docker

SHELL = /usr/bin/env bash -o pipefail
.SHELLFLAGS = -ec

.PHONY: all
all: build

##@ General

.PHONY: help
help: ## Display this help.
	@awk 'BEGIN {FS = ":.*##"; printf "\nUsage:\n  make \033[36m<target>\033[0m\n"} /^[a-zA-Z_0-9-]+:.*?##/ { printf "  \033[36m%-15s\033[0m %s\n", $$1, $$2 } /^##@/ { printf "\n\033[1m%s\033[0m\n", substr($$0, 5) } ' $(MAKEFILE_LIST)

##@ Development

node_modules: package.json
	npm install --no-audit --no-fund
	@touch node_modules

.PHONY: fmt
fmt: node_modules ## Format with prettier.
	npx prettier --write src

.PHONY: vet
vet: node_modules ## Type-check TypeScript without emitting.
	npx tsc --noEmit

.PHONY: test
test: vet ## Run vitest.
	npx vitest run

.PHONY: coverage
coverage: node_modules ## Run vitest with coverage.
	npx vitest run --coverage

.PHONY: lint
lint: node_modules ## Run eslint.
	npx eslint src

##@ Build

.PHONY: build
build: vet ## Build dist/.
	npx tsc -p tsconfig.build.json
	chmod +x dist/cli.js

.PHONY: run
run: node_modules ## Run the CLI from source (uses tsx).
	npx tsx src/cli.ts

.PHONY: clean
clean: ## Remove generated output.
	rm -rf dist node_modules coverage tmp

##@ Docker

.PHONY: docker-build
docker-build: ## Build the generator docker image.
	$(CONTAINER_TOOL) build -t ${REPOSITORY}${IMG}${TAG} .

.PHONY: docker-push
docker-push: ## Push the generator docker image.
	$(CONTAINER_TOOL) push ${REPOSITORY}${IMG}${TAG}

PLATFORMS ?= linux/arm64,linux/amd64
.PHONY: docker-buildx
docker-buildx: ## Build and push the generator image for multiple platforms.
	sed -e '1 s/\(^FROM\)/FROM --platform=\$$\{BUILDPLATFORM\}/; t' -e ' 1,// s//FROM --platform=\$$\{BUILDPLATFORM\}/' Dockerfile > Dockerfile.cross
	$(CONTAINER_TOOL) buildx inspect kdex-builder >/dev/null 2>&1 || $(CONTAINER_TOOL) buildx create --name kdex-builder --use
	$(CONTAINER_TOOL) buildx build --push --platform=$(PLATFORMS) --tag ${REPOSITORY}${IMG}${TAG} --tag ${REPOSITORY}${IMG}:latest -f Dockerfile.cross .
	rm Dockerfile.cross
