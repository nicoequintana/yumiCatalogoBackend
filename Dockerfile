FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY prisma ./prisma
COPY prisma.config.ts ./
RUN npx prisma generate

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

# Corre como el usuario `node` (uid 1000, ya viene en la imagen oficial), no
# como root: si el proceso se compromete (por ejemplo vía una dependencia con
# una RCE), un usuario sin privilegios no puede escribir fuera de lo que ya le
# pertenece ni instalar nada en el sistema del contenedor. `WORKDIR` crea `/app`
# como root, así que se le pasa a `node` junto con cada COPY: hoy el proceso no
# escribe en disco, pero un archivo nuevo en `/app` fallaría con EACCES.
RUN chown node:node /app
COPY --from=deps --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/src/generated ./src/generated
COPY --chown=node:node package.json ./
COPY --chown=node:node prisma ./prisma
COPY --chown=node:node prisma.config.ts ./
COPY --chown=node:node src ./src

USER node

EXPOSE 4000

CMD ["sh", "-c", "npx prisma migrate deploy && node src/server.js"]
