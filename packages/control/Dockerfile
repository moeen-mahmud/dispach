# The control plane's image. FSL-1.1-ALv2, like everything in packages/control, and separate from the
# runtime's image on purpose: it carries none of the runtime and the runtime carries none of it.
#
#   docker build -f packages/control/Dockerfile -t dispach-control:local .
#
# It drives Docker through the host's socket, which is root on that host — run it only where you
# would give it root.

# Only the static CLI binary is taken from here; the daemon is the host's.
FROM docker:29-cli AS docker

FROM node:24-trixie-slim
COPY --from=docker /usr/local/bin/docker /usr/local/bin/docker
WORKDIR /app
COPY packages/control/package.json packages/control/LICENSE.md packages/control/README.md ./
COPY packages/control/src ./src
ENV DISPACH_CONTROL_HOST=0.0.0.0 \
    DISPACH_CONTROL_DB=/data/control.db
VOLUME ["/data"]
EXPOSE 7600
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:7600/v1/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "src/main.ts"]
