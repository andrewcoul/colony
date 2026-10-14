# The computer each Colony Bot works on: Cua's Ubuntu desktop (XFCE, cua-spacesd for
# screenshots, input and the live viewer) plus Colony's tools. Build: npm run computer:build
FROM node:22-bookworm-slim AS node

FROM ghcr.io/trycua/linux:24.04-slim

# Node 22 (Ubuntu's is older) from the official image.
COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN ln -s ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
 && ln -s ../lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      git jq less nano procps python3-pip python3-venv ripgrep socat tree unzip wget zip \
      fonts-liberation fonts-noto-core fonts-noto-cjk fonts-noto-color-emoji \
 && rm -rf /var/lib/apt/lists/*

COPY colony-browser /usr/local/bin/colony-browser
RUN chmod +x /usr/local/bin/colony-browser \
 && install -d -m 0777 /workspace /browser

# No usage data leaves the computer.
ENV DO_NOT_TRACK=1 \
    CUA_TELEMETRY=0 \
    PIP_BREAK_SYSTEM_PACKAGES=1 \
    TERM=xterm-256color
LABEL org.opencontainers.image.title="colony-computer" \
      colony.computer.version="3"
# The base image's entrypoint starts supervisord: Xvfb, the XFCE desktop and cua-spacesd.
