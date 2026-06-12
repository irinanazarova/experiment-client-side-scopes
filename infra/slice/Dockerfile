# The slice PWA, served by Caddy. Build context is infra/slice (the deploy
# step copies pwa/dist here first), so the image is just Caddy + the static
# bundle (incl. the ~130MB app.wasm) + the Caddyfile.

# Precompress the large static assets (mainly app.wasm) once at build time, so
# Caddy serves a static .br/.gz instead of compressing 130MB on every cold
# visit. Brotli beats on-the-fly gzip (the wasm goes ~40MB gzip -> ~32MB br)
# and costs no per-request CPU; the .gz is the fallback for the rare client
# without brotli.
FROM alpine:3 AS compress
RUN apk add --no-cache brotli gzip
COPY dist /srv
RUN set -eux; \
    find /srv -type f \
      \( -name '*.wasm' -o -name '*.js' -o -name '*.css' -o -name '*.html' -o -name '*.json' -o -name '*.svg' \) \
      -size +1k -print0 \
    | while IFS= read -r -d '' f; do \
        brotli -q 9 -f -k "$f"; \
        gzip -9 -f -k "$f"; \
      done

FROM caddy:2-alpine
# Precompressed bundle first (large, changes rarely) so a Caddyfile tweak
# doesn't re-copy it.
COPY --from=compress /srv /srv
COPY Caddyfile /etc/caddy/Caddyfile
