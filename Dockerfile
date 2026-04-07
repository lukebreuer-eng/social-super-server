# ============================================
# Social Engine - Multi-stage Docker Build
# ============================================

# Stage 1: Build
FROM node:20-alpine AS builder

WORKDIR /app

# Install build dependencies for canvas (native module)
RUN apk add --no-cache \
    python3 \
    make \
    g++ \
    cairo-dev \
    pango-dev \
    jpeg-dev \
    giflib-dev \
    librsvg-dev \
    pixman-dev

# Copy package files
COPY package.json ./

# Ensure dev dependencies are installed during build
ENV NODE_ENV=development

# Install all dependencies (including dev for building)
RUN npm install

# Copy source
COPY tsconfig.json ./
COPY src/ ./src/

# Build TypeScript
RUN npm run build

# Stage 2: Production
FROM node:20-alpine AS production

WORKDIR /app

# Install runtime dependencies for canvas
RUN apk add --no-cache \
    cairo \
    pango \
    curl \
    jpeg \
    giflib \
    librsvg \
    pixman \
    fontconfig \
    freetype \
    && mkdir -p /usr/share/fonts/custom

# Copy package files and install production deps only
COPY package.json ./
RUN apk add --no-cache python3 make g++ cairo-dev pango-dev jpeg-dev giflib-dev librsvg-dev pixman-dev \
    && npm install --omit=dev \
    && apk del python3 make g++ cairo-dev pango-dev jpeg-dev giflib-dev librsvg-dev pixman-dev

# Copy built files
COPY --from=builder /app/dist ./dist

# Copy static dashboard files (not compiled by TypeScript)
COPY src/dashboard ./dist/dashboard

# Create logs directory
RUN mkdir -p logs

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=5 \
    CMD curl -f http://127.0.0.1:3001/health || exit 1

# Run as non-root
RUN addgroup -g 1001 -S nodejs && adduser -S social-engine -u 1001
USER social-engine

EXPOSE 3001

CMD ["node", "dist/index.js"]
