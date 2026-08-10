# Kelvia MCP server — hosted (Streamable HTTP) mode.
# Set PORT to enable HTTP mode; without it the process serves stdio instead.
FROM node:22-alpine AS build

WORKDIR /app
RUN corepack enable

COPY package.json ./
# No lockfile here: this package is developed in the Kelvia monorepo, which owns
# it. --ignore-scripts keeps postinstall scripts of build-only devDependencies
# from running, and nothing in the runtime image needs them.
RUN pnpm install --no-frozen-lockfile --ignore-scripts

COPY tsconfig.json ./
COPY src ./src
RUN pnpm run build && pnpm prune --prod --ignore-scripts

FROM node:22-alpine AS runtime

WORKDIR /app
ENV NODE_ENV=production
ENV PORT=8080

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./

# Never run the server as root: it holds users' Kelvia tokens in memory.
USER node
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/index.js"]
