FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production \
    ARCHIVIST_DIR=/data \
    ARCHIVIST_ARCHIVE_ROOT=/archive
COPY dist ./dist
COPY package.json ./package.json
VOLUME ["/data", "/archive"]
EXPOSE 8470
ENTRYPOINT ["node", "dist/main.mjs", "serve"]
