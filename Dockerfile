# Stage 1: Build the React client
FROM node:20-alpine AS client-build
WORKDIR /app/client
COPY client/package.json client/package-lock.json* ./
RUN npm install
COPY client/ ./
ARG VITE_API_URL
ARG VITE_GOOGLE_CLIENT_ID
ENV VITE_API_URL=$VITE_API_URL
ENV VITE_GOOGLE_CLIENT_ID=$VITE_GOOGLE_CLIENT_ID
RUN npm run build

# Stage 2: Server + serve client
FROM node:20-alpine
WORKDIR /app

# Install server dependencies
COPY server/package.json server/package-lock.json* ./server/
RUN cd server && npm install --production

# Copy server source
COPY server/ ./server/

# Copy built client
COPY --from=client-build /app/client/dist ./client/dist

# Serve client static files from Express
RUN echo 'const path = require("path");' > server/static.js && \
    echo 'module.exports = function(app) {' >> server/static.js && \
    echo '  app.use(require("express").static(path.join(__dirname, "../client/dist")));' >> server/static.js && \
    echo '  app.get("*", (req, res) => {' >> server/static.js && \
    echo '    if (!req.path.startsWith("/api") && !req.path.startsWith("/mcp") && !req.path.startsWith("/ws")) {' >> server/static.js && \
    echo '      res.sendFile(path.join(__dirname, "../client/dist/index.html"));' >> server/static.js && \
    echo '    }' >> server/static.js && \
    echo '  });' >> server/static.js && \
    echo '};' >> server/static.js

EXPOSE 4000

CMD ["node", "server/index.js"]
