# router-monitor-backend/Dockerfile
# One image, used for BOTH the "api" and "worker" containers.
# docker-compose.yml just tells each container to run a different file.

FROM node:20-alpine

# The "ping" npm package needs the real system ping command — Alpine
# doesn't include it by default, so we add it here.
RUN apk add --no-cache iputils tzdata

WORKDIR /app

# Install dependencies first (Docker caches this layer, so rebuilds
# are much faster when you only change code, not package.json)
COPY package*.json ./
RUN npm install

# Now copy the rest of the backend code
COPY . .

ENV NODE_ENV=production

# Default: run the API. The "worker" container in docker-compose.yml
# overrides this line to run pingWorker.js instead.
CMD ["node", "src/server.js"]
