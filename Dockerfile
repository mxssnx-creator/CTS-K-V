FROM node:18-alpine

# Install dependencies for native modules
RUN apk add --no-cache curl libc6-compat python3 make g++

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci --only=production && npm cache clean --force

# Copy application code
COPY . .

# Build the application
RUN npm run build

# Create non-root user
RUN addgroup --system --gid 1001 nodejs
RUN adduser --system --uid 1001 nextjs

# Set permissions
RUN chown -R nextjs:nodejs /app
USER nextjs

# Expose port
EXPOSE 3001

# Set environment
ENV NODE_ENV=production
ENV PORT=3001

# Production coordination memory hint (completeStartup + auto-start self-heal for bingx-x01)
ENV NODE_OPTIONS="--max-old-space-size=4096"

# Health check (includes engine coordination status)
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -f http://localhost:3001/api/health && curl -f http://localhost:3001/api/trade-engine/status || exit 1

# Start the application
CMD ["npm", "start"]