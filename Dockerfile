FROM node:22-alpine AS builder
WORKDIR /build
COPY package.json package-lock.json* tsconfig.json tsconfig.build.json ./
RUN npm ci --no-audit --no-fund
COPY src ./src
RUN npx tsc -p tsconfig.build.json && \
    chmod +x dist/cli.js && \
    npm prune --omit=dev

FROM node:22-alpine
RUN apk add --no-cache tree bash

# Default HOME is / (root-owned). Codegen Jobs run this image as a
# non-root user (UID 65532 under host-manager's PSSRestricted pod
# spec); npm uses $HOME for cache (.npm) and userconfig (.config/npm)
# defaults, so without this every `npm install` / `npx tsc` from
# entry-point.sh fails with "EACCES: permission denied, mkdir
# '/.npm'". /tmp is always writable. See kdex-tech/fnnodejsgen#1.
ENV HOME=/tmp

WORKDIR /opt/kdex-fnnodejsgen
COPY --from=builder /build/node_modules ./node_modules
COPY --from=builder /build/dist ./dist
COPY --from=builder /build/package.json ./
RUN ln -s /opt/kdex-fnnodejsgen/dist/cli.js /usr/local/bin/kdex-fnnodejsgen && \
    chmod +x /opt/kdex-fnnodejsgen/dist/cli.js
COPY entry-point.sh /usr/local/bin/entry-point.sh
RUN chmod +x /usr/local/bin/entry-point.sh
ENTRYPOINT ["/usr/local/bin/entry-point.sh"]
