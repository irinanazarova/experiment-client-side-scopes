# The slice PWA, served by Caddy. Build context is infra/slice (the deploy
# step copies pwa/dist here first), so the image is just Caddy + the static
# bundle (incl. the stripped ~52MB app.wasm) + the Caddyfile.

# Precompress the large static assets (mainly app.wasm) once at build time, so
# Caddy serves a static .br/.gz instead of compressing it on every cold visit.
# Brotli runs once here, so use max quality (-q 11): on the stripped app.wasm
# it lands ~9MB br vs ~13MB gzip, and costs no per-request CPU. The .gz is the
# fallback for the rare client without brotli.
FROM alpine:3 AS compress
RUN apk add --no-cache brotli gzip
COPY dist /srv
RUN set -eux; \
    find /srv -type f \
      \( -name '*.wasm' -o -name '*.data' -o -name '*.js' -o -name '*.css' -o -name '*.html' -o -name '*.json' -o -name '*.svg' \) \
      -size +1k -print0 \
    | while IFS= read -r -d '' f; do \
        brotli -q 11 -f -k "$f"; \
        gzip -9 -f -k "$f"; \
      done

FROM caddy:2-alpine
# Precompressed bundle first (large, changes rarely) so a Caddyfile tweak
# doesn't re-copy it.
COPY --from=compress /srv /srv
COPY Caddyfile /etc/caddy/Caddyfile
