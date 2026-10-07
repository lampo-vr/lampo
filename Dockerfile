# Lampo's server image: server mode (accounts, uploads), everything it needs to analyse renders offline.
#   docker build -t lampo .
#   docker run -p 4747:4747 -v vr-data:/data -e LAMPO_PUBLIC_URL=http://localhost:4747 lampo
# Store, renders, cache, the speech model and footage search's model live in the /data volume. See docs/docker.md.

FROM node:24-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
# onnxruntime-node (footage search): its install script would fetch the CUDA providers on Linux x64 (~500 MB); the model
# runs on the CPU. Its package carries every platform's binaries: the image keeps only its own (~45 MB of ~290).
ENV ONNXRUNTIME_NODE_INSTALL=skip
RUN npm ci --no-audit --no-fund
COPY . .
RUN LAMPO_STYLEGUIDE=0 npm run build && npm prune --omit=dev --no-audit --no-fund \
  && ort=node_modules/onnxruntime-node/bin/napi-v6 \
  && if [ -d "$ort" ]; then rm -rf "$ort/darwin" "$ort/win32" \
       && find "$ort/linux" -mindepth 1 -maxdepth 1 ! -name "$(node -p process.arch)" -exec rm -rf {} +; fi

FROM node:24-slim
# What the image is and where its source is (OCI labels; AGPL-3.0 §13 asks a modified copy run for others to offer its
# source, so a fork builds with --build-arg SOURCE_URL=<its repository>). REVISION: the commit it was built from,
#   docker build --build-arg REVISION=$(git rev-parse HEAD) -t lampo .
ARG SOURCE_URL=https://github.com/lampo-vr/lampo
ARG REVISION=unknown
LABEL org.opencontainers.image.title="Lampo" \
      org.opencontainers.image.description="Frame-exact video review for AI video agents, self-hosted" \
      org.opencontainers.image.source="${SOURCE_URL}" \
      org.opencontainers.image.url="${SOURCE_URL}" \
      org.opencontainers.image.licenses="AGPL-3.0-only" \
      org.opencontainers.image.revision="${REVISION}"
# ffmpeg: frames, proxies, analysis · tesseract + hunspell (German, English): the pre-review's text checks ·
# tini: signals and zombie reaping for the ffmpeg / speech worker children.
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates ffmpeg tini \
    tesseract-ocr tesseract-ocr-deu tesseract-ocr-eng \
    hunspell hunspell-de-de hunspell-en-us \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/web/dist ./web/dist
COPY --from=build /app/web/dist-mcp ./web/dist-mcp
COPY --from=build /app/bin ./bin
COPY --from=build /app/lib ./lib
COPY --from=build /app/server ./server
COPY --from=build /app/mcp ./mcp
COPY --from=build /app/LICENSE /app/NOTICE.md ./
RUN ln -s /app/bin/lampo /usr/local/bin/lampo && ln -s /app/bin/vr /usr/local/bin/vr && mkdir -p /data && chown node:node /data

# VR_USER: what `lampo` run inside the container signs as (the OS account here is just "node").
# The defaults keep the older VR_ spelling on purpose: lib/env.ts reads LAMPO_ first, so a default named LAMPO_ would
# win over an env file's VR_ setting; this way either spelling given at run time wins over the image's.
# TMPDIR on the volume: Auto-check's frames and incoming previews can be large, and the root file system may be
# read-only (docker-compose.yml runs it that way).
ENV NODE_ENV=production \
    VR_MODE=server \
    VR_HOME=/data \
    VR_PORT=4747 \
    VR_STT_PREFETCH=1 \
    VR_USER=admin \
    TMPDIR=/data/tmp
USER node
VOLUME ["/data"]
EXPOSE 4747
# Ready, not just alive: data writable, free disk, ffmpeg, storage credentials, public URL (see /readyz).
HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.LAMPO_PORT || process.env.VR_PORT || 4747) + '/readyz').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "server/index.ts"]
