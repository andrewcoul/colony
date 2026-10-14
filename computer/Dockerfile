# The computer each Colony Bot works on. Build: npm run computer:build
FROM node:22-bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      bash ca-certificates curl git jq less nano procps python3 python3-pip python3-venv ripgrep tree unzip wget zip \
 && rm -rf /var/lib/apt/lists/*

ENV HOME=/workspace \
    PIP_BREAK_SYSTEM_PACKAGES=1 \
    TERM=xterm-256color \
    PS1='\u@colony:\w$ '
WORKDIR /workspace
LABEL org.opencontainers.image.title="colony-computer"
# Stays up; the Colony server runs commands with `docker exec`.
CMD ["sleep", "infinity"]
