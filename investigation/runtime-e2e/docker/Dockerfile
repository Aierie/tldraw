FROM mcr.microsoft.com/playwright:v1.50.1-jammy

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y --no-install-recommends \
	git \
	curl \
	ca-certificates \
	jq \
	ripgrep \
	python3 \
	make \
	g++ \
	postgresql-client \
	docker.io \
	&& rm -rf /var/lib/apt/lists/*

# Enable corepack; actual Yarn version is activated at runtime from package.json#packageManager
RUN corepack enable

COPY investigation/runtime-e2e/docker/entrypoint.sh /usr/local/bin/tldraw-e2e-entrypoint
RUN chmod +x /usr/local/bin/tldraw-e2e-entrypoint

WORKDIR /workspace

ENTRYPOINT ["tldraw-e2e-entrypoint"]
CMD ["bash"]
