FROM node:24-bookworm-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends git ca-certificates bash \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /opt/agent-tools/pi /home/node/.pi/agent /data/jobs \
    && ln -s /opt/agent-tools/pi/current/bin/pi /usr/local/bin/pi \
    && chown -R node:node /home/node/.pi /data

WORKDIR /app
COPY server.mjs reconcile.sh ./
USER node
ENV PI_CODING_AGENT_DIR=/home/node/.pi/agent \
    PI_SKIP_VERSION_CHECK=1 \
    HOME=/home/node
EXPOSE 8787
CMD ["node", "/app/server.mjs"]
