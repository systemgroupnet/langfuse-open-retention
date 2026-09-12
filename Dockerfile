# syntax=docker/dockerfile:1

FROM node:22-alpine AS build
WORKDIR /app
COPY package.json ./
RUN npm install --no-audit --no-fund
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

# su-exec drops privileges after the entrypoint has fixed up the data-dir owner and
# joined the docker socket's group (whose gid is only known at run time).
RUN apk add --no-cache su-exec \
 && addgroup -S retention \
 && adduser -S retention -G retention

COPY --from=deps  /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY public ./public
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

EXPOSE 3050
VOLUME ["/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3050)+'/api/session').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["node", "dist/index.js"]
