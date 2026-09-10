FROM node:24.11.0-bookworm-slim AS build

WORKDIR /application

COPY frontend/package.json frontend/package-lock.json ./
# Playwright figure dans les dependances de developpement mais ne doit JAMAIS
# telecharger de navigateur ici : cent dix megaoctets pour une image qui ne fait
# que compiler des fichiers statiques.
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
RUN npm ci

COPY frontend/tsconfig*.json frontend/vite.config.ts frontend/index.html ./
COPY frontend/src ./src
# Le `build` passe par le `typecheck`, qui inclut le test de derive des
# contrats : une image du front ne peut donc pas se construire sur des types que
# le backend ne rend plus.
COPY frontend/test ./test

# Les sources du backend entrent dans l'etage de COMPILATION, et lui seul : le
# `typecheck` du front comprend le test de derive des contrats, qui les lit. Une
# image du front ne peut donc pas se construire sur des types que le backend ne
# rend plus — c'est le moment ou l'on peut encore reagir.
#
# Ses dependances viennent avec, et il le faut : sans elles le compilateur ne
# resout ni `drizzle-orm` ni `@nestjs/common`, rend des centaines d'erreurs
# `implicitly has an any type` sur du code parfaitement sain, et le test de
# derive ne verifie plus rien de ce qu'il devrait. Elles ne pesent que sur cet
# etage — l'image d'execution ne porte que des fichiers statiques et nginx.
COPY backend/package.json backend/package-lock.json /backend/
RUN npm --prefix /backend ci --ignore-scripts

COPY backend/src /backend/src
RUN npm run build

FROM nginx:1.29.3-alpine AS runtime

COPY --from=build /application/dist /usr/share/nginx/html
COPY infra/nginx/portail.conf /etc/nginx/nginx.conf

USER 1000:1000

EXPOSE 8080
