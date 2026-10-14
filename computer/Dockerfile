# The computer each Colony Bot works on. Build: npm run computer:build
FROM node:22-bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      bash ca-certificates curl git jq less nano procps python3 python3-pip python3-venv ripgrep tree unzip wget zip \
      chromium fonts-liberation fonts-noto-core fonts-noto-cjk fonts-noto-color-emoji socat \
 && rm -rf /var/lib/apt/lists/*

COPY colony-browser /usr/local/bin/colony-browser
RUN chmod +x /usr/local/bin/colony-browser

ENV HOME=/workspace \
    PIP_BREAK_SYSTEM_PACKAGES=1 \
    TERM=xterm-256color \
    PS1='\u@colony:\w$ '
WORKDIR /workspace
LABEL org.opencontainers.image.title="colony-computer" \
      colony.computer.version="2"
# Stays up; the Colony server runs commands with `docker exec`.
CMD ["sleep", "infinity"]
