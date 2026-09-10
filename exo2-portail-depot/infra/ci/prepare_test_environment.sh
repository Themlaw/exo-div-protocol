#!/usr/bin/env bash
# Ecrit un `.env` de TEST et demarre les services dont les tests d'integration et
# les tests de bout en bout ont besoin : Postgres, MinIO, clamav.
#
# Volontairement distinct de install.sh, qui deploie : ici les services sont
# joints depuis l'HOTE (l'API et le worker tournent en dehors de Docker, comme
# sur un poste de developpement), les secrets n'ont aucune valeur puisque rien
# de reel n'y transite, et l'environnement est `development` — le durcissement
# de production exigerait un nom d'hote certifie que la CI n'a pas.
set -euo pipefail

readonly PROJECT_DIRECTORY="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "${PROJECT_DIRECTORY}"

# Aucun secret genere ici : ces valeurs sont publiques par construction, et les
# faire passer pour des secrets rendrait plus difficile de voir lesquels le sont
# vraiment. Elles respectent seulement les longueurs minimales que
# `parse_application_environment` impose.
cat > .env <<'ENVIRONMENT'
NODE_ENV="development"

POSTGRES_USER="portail"
POSTGRES_DB="portail"
POSTGRES_PASSWORD="portail-de-test-sans-valeur"
POSTGRES_PORT="22310"

# Dans la plage attribuee (22300-22399) comme partout ailleurs : ce script
# tourne aussi bien sur un runner isole que sur la machine partagee.
MINIO_ROOT_USER="portail-minio"
MINIO_ROOT_PASSWORD="portail-minio-de-test-sans-valeur"
MINIO_API_PORT="22320"
MINIO_CONSOLE_PORT="22321"
CLAMAV_PORT="22330"

DATABASE_URL="postgres://${POSTGRES_USER}:${POSTGRES_PASSWORD}@127.0.0.1:${POSTGRES_PORT}/${POSTGRES_DB}"
MINIO_ENDPOINT="http://127.0.0.1:${MINIO_API_PORT}"
CLAMAV_ENDPOINT="tcp://127.0.0.1:${CLAMAV_PORT}"

# Le serveur de developpement de Vite : c'est lui que le navigateur de
# Playwright ouvre, et c'est donc lui l'origine de confiance.
PUBLIC_BASE_URL="http://localhost:5173"

ACCESS_LINK_TOKEN_PEPPER="0000000000000000000000000000000000000000000000000000000000000001"
INTERNAL_STORAGE_WEBHOOK_SECRET="0000000000000000000000000000000000000000000000000000000000000002"
BETTER_AUTH_SECRET="0000000000000000000000000000000000000000000000000000000000000003"
GRAFANA_ADMIN_PASSWORD="grafana-de-test-sans-valeur"

DEMO_LAWYER_EMAIL="avocat@demo.local"
DEMO_LAWYER_PASSWORD="action chemin bruit chalet affiche"

# Aucun relais de confiance : les tests parlent directement au serveur, et
# remonter un X-Forwarded-For inexistant ferait porter la limitation de cadence
# sur une adresse choisie par l'appelant.
TRUSTED_PROXY_HOP_COUNT="0"
WORKER_METRICS_PORT="9101"
ENVIRONMENT

# Ajoutees APRES le document : elles seules dependent de la machine, et un
# heredoc en apostrophes ne substitue rien, a dessein.
printf 'SERVICE_UID="%s"\nSERVICE_GID="%s"\n' "$(id -u)" "$(id -g)" >> .env

# Compose ne lit PAS ce fichier tout seul. Son repertoire de projet est celui du
# fichier compose, donc `infra/` : il y chercherait un `infra/.env` qui n'existe
# pas, interpolerait des chaines vides partout, et Postgres demarrerait sans mot
# de passe. C'est install.sh qui fait deja exactement ceci, pour la meme raison.
set -a
# shellcheck disable=SC1091
. ./.env
set +a

# Docker cree un repertoire de montage manquant en ROOT, et un conteneur non
# privilegie ne pourrait alors pas y ecrire : on les cree donc ici, avant le
# premier demarrage, et ils appartiennent de fait a l'utilisateur courant —
# `runner` (uid 1001) sur un runner GitHub. C'est ce meme uid que les services
# porteront, plus bas, si bien qu'aucun `chown` et donc aucun `sudo` n'est
# necessaire.
mkdir -p data/postgres data/minio

# La surcouche de developpement, et elle seule : c'est elle qui publie les ports
# de Postgres, MinIO et clamav sur la boucle locale. Sans elle ces services sont
# sur des reseaux internes et rien, sur l'hote, ne peut les joindre.
docker compose -f infra/docker-compose.yml -f infra/docker-compose.dev.yml up -d postgres minio clamav

wait_until_healthy() {
  local service="$1" deadline=$((SECONDS + 420))

  while ((SECONDS < deadline)); do
    if [[ "$(docker compose -f infra/docker-compose.yml -f infra/docker-compose.dev.yml ps --format '{{.Health}}' "${service}" | head -1)" == "healthy" ]]; then
      printf '%s : healthy\n' "${service}"
      return 0
    fi
    sleep 5
  done

  printf '%s n a pas demarre\n' "${service}" >&2
  docker compose -f infra/docker-compose.yml -f infra/docker-compose.dev.yml logs --tail 50 "${service}" >&2
  exit 1
}

# clamav en dernier : il charge sa base de signatures et met une a deux minutes,
# la ou les deux autres sont prets en quelques secondes.
for service in postgres minio clamav; do
  wait_until_healthy "${service}"
done
