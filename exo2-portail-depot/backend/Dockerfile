# Version EXACTE, jamais une etiquette flottante : `docker pull` doit rendre le
# meme binaire dans six mois qu'aujourd'hui.
FROM node:24.11.0-bookworm-slim AS build

WORKDIR /application

# Les manifestes seuls d'abord : tant qu'ils ne changent pas, Docker reutilise
# la couche d'installation, et un `npm ci` de plusieurs minutes ne se rejoue pas
# a chaque modification d'une ligne de source.
COPY backend/package.json backend/package-lock.json ./
RUN npm ci

COPY backend/tsconfig*.json backend/nest-cli.json ./
COPY backend/src ./src
COPY backend/drizzle ./drizzle
RUN npm run build

# Les dependances de developpement sortent APRES la compilation : TypeScript et
# Nest CLI n'ont rien a faire dans une image qui tourne en production.
RUN npm prune --omit=dev

FROM node:24.11.0-bookworm-slim AS runtime

# L'utilisateur `node` de l'image officielle porte deja 1000:1000. Le reutiliser
# plutot qu'en creer un evite un `useradd` de plus et garde le meme uid que les
# repertoires que `install.sh` prepare sur l'hote.
ENV NODE_ENV=production

WORKDIR /application

COPY --from=build --chown=1000:1000 /application/node_modules ./node_modules
COPY --from=build --chown=1000:1000 /application/dist ./dist
COPY --from=build --chown=1000:1000 /application/package.json ./package.json
# Les migrations sont jouees par l'application a son demarrage : elles doivent
# donc voyager DANS l'image, sinon un deploiement sur une base neuve echoue au
# premier lancement.
COPY --from=build --chown=1000:1000 /application/drizzle ./drizzle

USER 1000:1000

# `node dist/main` et non `npm start` : npm ajoute un processus intermediaire qui
# ne relaie pas SIGTERM, et l'arret du conteneur deviendrait un kill au bout de
# dix secondes — au milieu d'une transaction, le cas echeant.
CMD ["node", "dist/main"]
