FROM node:24-bookworm-slim AS build
WORKDIR /build
COPY . .
RUN if [ -f server.ts ]; then npm ci --include=dev --ignore-scripts && npm run build; else test -s dist/server.cjs && test -s dist/index.html; fi \
    && node -e "require('fs').writeFileSync('VERSION',require('./package.json').version+'\n')" \
    && mkdir -p /runtime/scripts \
    && cp -a dist package.json package-lock.json .env.example VERSION /runtime/ \
    && cp scripts/apply-update.mjs /runtime/scripts/ \
    && if [ -f release-public-key.pem ]; then cp release-public-key.pem /runtime/; fi

FROM node:24-bookworm-slim
ENV NODE_ENV=production HOST=0.0.0.0 PORT=1888 PANELARK_DATA_DIR=/app/data PANELARK_DEPLOYMENT_MODE=docker
WORKDIR /app
COPY --from=build /runtime/ ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force \
    && mkdir -p /app/data && chown node:node /app/data && chmod 700 /app/data
USER node
EXPOSE 1888
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 CMD node -e "fetch('http://127.0.0.1:1888/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/server.cjs"]
