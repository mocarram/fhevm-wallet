.PHONY: help build run shell clean lint format dev install docker-build docker-run docker-shell docker-clean

# Default target
.DEFAULT_GOAL := help

# Colors
CYAN := \033[36m
GREEN := \033[32m
YELLOW := \033[33m
RESET := \033[0m

# Docker image name
IMAGE_NAME := fhevm-wallet
CONTAINER_NAME := fhevm-wallet

##@ General

help: ## Show this help message
	@awk 'BEGIN {FS = ":.*##"; printf "\n$(CYAN)fhEVM Wallet CLI$(RESET)\n\nUsage:\n  make $(GREEN)<target>$(RESET)\n"} /^[a-zA-Z_-]+:.*?##/ { printf "  $(GREEN)%-15s$(RESET) %s\n", $$1, $$2 } /^##@/ { printf "\n$(YELLOW)%s$(RESET)\n", substr($$0, 5) }' $(MAKEFILE_LIST)

##@ Development

install: ## Install dependencies
	npm ci

build: ## Build TypeScript
	npm run build

dev: ## Run in development mode
	npm run dev

run: build ## Build and run the CLI
	npm run start

interactive: build ## Run in interactive mode
	npm run start

lint: ## Run ESLint
	npm run lint

lint-fix: ## Run ESLint with auto-fix
	npm run lint:fix

format: ## Format code with Prettier
	npm run format

format-check: ## Check code formatting
	npm run format:check

clean: ## Clean build artifacts
	npm run clean
	rm -rf node_modules

##@ Docker

docker-build: ## Build Docker image
	docker build -t $(IMAGE_NAME):latest .

docker-run: docker-build ## Run CLI in Docker (interactive mode)
	docker run -it --rm \
		--name $(CONTAINER_NAME) \
		--env-file .env \
		-v $(PWD)/data:/app/data \
		$(IMAGE_NAME):latest

docker-shell: docker-build ## Open shell in Docker container
	docker run -it --rm \
		--name $(CONTAINER_NAME)-shell \
		--env-file .env \
		-v $(PWD)/data:/app/data \
		--entrypoint /bin/sh \
		$(IMAGE_NAME):latest

docker-send: docker-build ## Send tokens via Docker (usage: make docker-send ARGS="0x... 100")
	docker run -it --rm \
		--name $(CONTAINER_NAME) \
		--env-file .env \
		-v $(PWD)/data:/app/data \
		$(IMAGE_NAME):latest send $(ARGS)

docker-balance: docker-build ## Check balance via Docker
	docker run -it --rm \
		--name $(CONTAINER_NAME) \
		--env-file .env \
		-v $(PWD)/data:/app/data \
		$(IMAGE_NAME):latest balance

docker-history: docker-build ## View history via Docker
	docker run -it --rm \
		--name $(CONTAINER_NAME) \
		--env-file .env \
		-v $(PWD)/data:/app/data \
		$(IMAGE_NAME):latest history

docker-clean: ## Remove Docker image and containers
	docker rm -f $(CONTAINER_NAME) 2>/dev/null || true
	docker rmi -f $(IMAGE_NAME):latest 2>/dev/null || true

##@ Docker Compose

up: ## Start with docker-compose (interactive)
	docker-compose run --rm fhevm-wallet

down: ## Stop docker-compose services
	docker-compose down

compose-build: ## Build with docker-compose
	docker-compose build

compose-clean: ## Clean docker-compose resources
	docker-compose down --rmi all --volumes --remove-orphans

##@ Utilities

env: ## Create .env from .env.example if not exists
	@if [ ! -f .env ]; then \
		cp .env.example .env; \
		echo "Created .env from .env.example - please edit with your values"; \
	else \
		echo ".env already exists"; \
	fi

check: lint format-check build ## Run all checks (lint, format, build)
	@echo "$(GREEN)All checks passed!$(RESET)"
