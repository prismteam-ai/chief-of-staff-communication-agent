FROM node:20-alpine

# sharp / prisma engines want libc compat on alpine
RUN apk add --no-cache libc6-compat openssl

WORKDIR /app

# deps first for layer caching
COPY package.json package-lock.json* ./
RUN npm ci

COPY . .
RUN npx prisma generate && npm run build

EXPOSE 3000

# Sync the schema + seed the demo users/connections, then serve.
CMD ["sh", "-c", "npx prisma db push --skip-generate && npx tsx prisma/seed.ts && npm run start"]
