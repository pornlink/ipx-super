FROM  node:20.9.0-alpine3.18 AS base
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN apk add --no-cache npm && \
    npm install -g pnpm
FROM base AS prod-deps
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --prod --frozen-lockfile
RUN  find ./node_modules -type f \( -name ".ts" -o -name "*.test.js" -o -name "*.js.map" -o -name "*.md" -o -name ".github" \) -exec rm -f {} \;
RUN  find ./node_modules/.pnpm -type f \( -name ".ts" -o -name "*.test.js" -o -name "*.js.map" -o -name "*.md" -o -name ".github" \) -exec rm -f {} \;
FROM base AS build-deps
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile
FROM build-deps AS build
COPY . .
RUN npm run build
RUN ls

FROM base AS runtime
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
RUN npm install pm2 -g
#COPY --from=build /app/.env.production ./.env

RUN npm uninstall -g pnpm && \
    apk del npm
ENV HOST=0.0.0.0
ENV PORT=4000
ENV NODE_ENV=production
EXPOSE 4000
CMD ["pm2-runtime", "ecosystem.config.js"]
