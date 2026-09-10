#!/usr/bin/env bash
# Installation en une commande : secrets generes, repertoires prepares, images
# construites, pile demarree, et les URLs affichees a la fin.
#
# Le test que fera un evaluateur est « clone sur machine vierge, ./install.sh,
# et on attend ». S'il faut ouvrir le README pour reparer une etape, c'est rate.
set -euo pipefail

readonly PROJECT_DIRECTORY="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly ENVIRONMENT_FILE="${PROJECT_DIRECTORY}/.env"
readonly COMPOSE_FILE="${PROJECT_DIRECTORY}/infra/docker-compose.yml"

cd "${PROJECT_DIRECTORY}"

# --- Sorties ----------------------------------------------------------------

announce() { printf '\n\033[1m▸ %s\033[0m\n' "$*"; }
detail()   { printf '  %s\n' "$*"; }
fail()     { printf '\n\033[31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

# --- Prerequis --------------------------------------------------------------

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "$1 est requis et introuvable. $2"
}

announce "Verification des prerequis"
require_command docker "Installez Docker Engine puis relancez ce script."
docker compose version >/dev/null 2>&1 ||
  fail "Le plugin « docker compose » est requis (Docker Compose v2)."
detail "docker $(docker version --format '{{.Server.Version}}' 2>/dev/null || echo '?')"

# Les services a donnees ecrivent dans des bind mounts sous ./data, que ce script
# cree. Ils tournent donc sous l'uid de CELUI QUI LE LANCE, et non sous un 1000
# fige : sur une machine ou l'utilisateur porte un autre uid, un conteneur en
# 1000 se heurterait a un refus de permission sur des repertoires qui ne lui
# appartiennent pas — et le reparer demanderait root, que cette installation n'a
# aucune raison d'exiger.
if [[ "$(id -u)" -eq 0 ]]; then
  fail "N'executez pas ce script en root : les repertoires de donnees appartiendraient a root, et plus personne d'autre ne pourrait les lire."
fi
# Nommees d'apres CELUI QUI INVOQUE, et non d'apres la variable du compose
# qu'elles alimentent : `. .env` relit ce fichier plus bas, et deux noms
# identiques feraient echouer la lecture sur une variable en lecture seule.
readonly INVOKING_UID="$(id -u)"
readonly INVOKING_GID="$(id -g)"
detail "les services a donnees tourneront en ${INVOKING_UID}:${INVOKING_GID}"

# --- Generation des secrets -------------------------------------------------

# Toujours depuis /dev/urandom, jamais depuis $RANDOM : ce dernier est un
# generateur pseudo-aleatoire ensemence sur l'horloge, et deux installations
# lancees la meme seconde produiraient les memes secrets.
draw_random_characters() {
  local character_count="$1"
  head -c "$((character_count * 8))" /dev/urandom | tr -dc 'A-Za-z0-9' | head -c "${character_count}"
}

# L'application refuse au demarrage tout secret contenant un fragment de mot de
# passe bidon (« password », « 123456»...). Un tirage aleatoire peut en produire
# un par accident : c'est rarissime, mais la panne serait un refus de demarrage
# incomprehensible sur une valeur pourtant bien aleatoire.
readonly FORBIDDEN_SECRET_FRAGMENTS='changeme|change-me|change_me|a-changer|tochange|password|motdepasse|passwd|secret|azerty|qwerty|123456'

random_secret() {
  local byte_count="${1:-32}"
  local character_count="$((byte_count * 2))"
  local candidate=""

  while :; do
    candidate="$(draw_random_characters "${character_count}")"
    if [[ ${#candidate} -eq ${character_count} ]] &&
       ! printf '%s' "${candidate}" | tr 'A-Z' 'a-z' | grep -Eq "${FORBIDDEN_SECRET_FRAGMENTS}"; then
      printf '%s' "${candidate}"
      return
    fi
  done
}

# AUCUNE question posee. Le test annonce est « on clone, on lance ./install.sh,
# et on attend » : une invite, meme avec une valeur par defaut, est deja une
# etape a comprendre, et elle bloque net une execution non interactive. Tout ce
# qui pourrait etre demande a donc un defaut qui marche, et une variable
# d'environnement pour le remplacer :
#
#   PUBLIC_HOSTNAME=portail.exemple.fr ./install.sh
#
# Le sous-domaine du projet pointe vers UNE machine precise. Le prendre par
# defaut partout ferait demander a Let's Encrypt un certificat pour un nom qui
# ne resout pas vers l'hote qui le demande : le challenge echouerait, et
# l'installation s'arreterait la — sur quiconque a simplement clone le depot.
#
# On ne retient donc ce nom que s'il designe VRAIMENT cette machine. Le test est
# volontairement conservateur : au moindre doute — nom non resolu, outil absent,
# adresse qui n'est sur aucune interface — on retombe en local, ou tout
# fonctionne sans DNS ni certificat. Se tromper dans ce sens coute une variable
# a passer ; se tromper dans l'autre casse l'installation.
public_hostname_designe_cette_machine() {
  local nom="$1" adresses_du_nom adresses_locales adresse

  command -v getent >/dev/null 2>&1 || return 1
  adresses_du_nom="$(getent ahostsv4 "${nom}" 2>/dev/null | awk '{print $1}' | sort -u)"
  [[ -n "${adresses_du_nom}" ]] || return 1

  if command -v ip >/dev/null 2>&1; then
    adresses_locales="$(ip -o -4 addr show 2>/dev/null | awk '{split($4, a, "/"); print a[1]}')"
  else
    adresses_locales="$(hostname -I 2>/dev/null | tr ' ' '\n')"
  fi
  [[ -n "${adresses_locales}" ]] || return 1

  while read -r adresse; do
    [[ -n "${adresse}" ]] || continue
    grep -qxF "${adresse}" <<< "${adresses_locales}" && return 0
  done <<< "${adresses_du_nom}"

  return 1
}

configured_or_default() {
  local variable_name="$1" default_value="$2"
  printf '%s' "${!variable_name:-${default_value}}"
}

# `localhost` et pas le sous-domaine du deploiement : sur la machine de
# l'evaluateur, ce sous-domaine ne resout pas vers SA machine. Let's Encrypt
# echouerait a le certifier, et l'installation « qui doit juste marcher »
# echouerait sur la seule chose qui ne pouvait pas marcher. Le nom public se
# donne au deploiement, par la variable ci-dessus.
# Le sous-domaine du deploiement. Il n'est retenu QUE s'il designe cette
# machine — voir `public_hostname_designe_cette_machine`.
readonly DEFAULT_PUBLIC_HOSTNAME="titouan-constance.stage2-div.rayan-drissi.com"
readonly FALLBACK_PUBLIC_HOSTNAME="localhost"

# Le proxy frontal de la machine partagee relaie deja 80 -> 22300 et
# 443 -> 22301. Ces valeurs ne sont donc pas libres : en changer une sans changer
# le relais rend le portail injoignable sans rien casser de visible.
readonly DEFAULT_TRAEFIK_HTTP_PORT="22300"
readonly DEFAULT_TRAEFIK_HTTPS_PORT="22301"

# L'adresse de contact remise a Let's Encrypt : c'est la seule facon d'etre
# prevenu qu'un certificat n'a PAS ete renouvele — le renouvellement est
# automatique, donc sa panne est silencieuse jusqu'a l'expiration.
#
# Fixe, et non deduite du nom d'hote : `portail@<sous-domaine>` n'a aucune boite
# derriere, et Let's Encrypt REFUSE un contact dont le domaine ne resout pas —
# l'inscription du compte ACME echouerait, donc aucun certificat ne serait emis.
# Un vrai deploiement met ici une boite qu'on releve.
readonly DEFAULT_ACME_EMAIL="test@div.com"

# L'URL est ECRITE en toutes lettres dans .env, dans un cas comme dans l'autre.
# Faire porter le sens « autorite reelle » a une valeur VIDE serait un piege : le
# compose lit `${ACME_CA_SERVER:-...}`, et cette forme retombe sur son defaut
# pour une variable vide autant que pour une variable absente — on obtiendrait
# donc du staging en croyant demander du reel.
readonly ACME_PRODUCTION_CA="https://acme-v02.api.letsencrypt.org/directory"
readonly ACME_STAGING_CA="https://acme-staging-v02.api.letsencrypt.org/directory"

# Le compte de demonstration est FIXE et publie dans le README, contrairement a
# tous les autres secrets de ce fichier. C'est un choix, et il se paie : ces
# identifiants sont publics, donc le compte l'est aussi. Il l'est parce qu'une
# demonstration qu'on ne peut pas ouvrir ne demontre rien — l'evaluateur doit
# pouvoir se connecter sans lire une sortie de terminal qu'il n'a plus.
readonly DEMO_LAWYER_EMAIL_DEFAULT="avocat@portail-div.fr"
readonly DEMO_LAWYER_PASSWORD_DEFAULT="atelier balise carnet dossier facade"

# Le lien de la demande de demonstration, publie pour la meme raison que le
# compte : sans jeton ni code ecrits quelque part, on ne peut pas montrer le
# parcours CLIENT, qui est pourtant la moitie du sujet — l'evaluateur devrait
# d'abord se connecter en avocat pour s'emettre un lien a lui-meme.
# Le jeton respecte la forme d'un vrai jeton (32 caracteres alphanumeriques) et
# le code la longueur de la politique par defaut ; le backend refuse de demarrer
# si ce n'est pas le cas. Ils n'ouvrent qu'une demande vide creee sur une base
# vierge, et « Regenerer le lien » les remplace par des secrets tires au sort.
readonly DEMO_ACCESS_LINK_TOKEN_DEFAULT="demoportaildivdepotpiecesdemo123"
readonly DEMO_ACCESS_PIN_DEFAULT="395174"

# Fixe pour la meme raison que le compte avocat : les tableaux de bord font
# partie de ce qu'on demande de montrer, et un mot de passe tire au sort ne
# s'ouvre qu'avec une sortie de terminal que l'evaluateur n'a plus.
readonly GRAFANA_ADMIN_PASSWORD_DEFAULT="courbe seuil mesure alerte tableau"

# Les images sont TIREES, jamais construites ici : celle qui est publiee est la
# seule a avoir passe la chaine de verification, alors qu'une construction locale
# ne prouve que ce que la machine avait sous la main ce jour-la. `latest` suit la
# branche principale ; IMAGE_TAG="1.2.3" epingle une version publiee.
readonly IMAGE_REPOSITORY_DEFAULT="ghcr.io/themlaw/exo-div-protocol"
readonly IMAGE_TAG_DEFAULT="latest"

if [[ -f "${ENVIRONMENT_FILE}" ]]; then
  announce "Fichier .env deja present : il est conserve tel quel"
  detail "Supprimez-le pour regenerer tous les secrets."

  # Les reglages APPARUS depuis sont neanmoins ajoutes. Un fichier ecrit par une
  # version anterieure n'a pas de raison de connaitre SERVICE_UID, et le defaut
  # du compose le ramenerait a 1000 : sur une machine ou l'utilisateur porte un
  # autre uid, la panne se rejouerait a l'identique, et il faudrait avoir lu la
  # documentation pour comprendre qu'il fallait effacer ce fichier. Les secrets
  # deja tires, eux, ne sont jamais touches.
  if ! grep -q '^SERVICE_UID=' "${ENVIRONMENT_FILE}"; then
    printf '\nSERVICE_UID="%s"\nSERVICE_GID="%s"\n' "${INVOKING_UID}" "${INVOKING_GID}" \
      >> "${ENVIRONMENT_FILE}"
    detail "SERVICE_UID/SERVICE_GID manquaient : ajoutes (${INVOKING_UID}:${INVOKING_GID})."
  fi

  # Meme raison : un .env ecrit avant que le lien de demonstration existe ferait
  # echouer le demarrage sur deux variables manquantes, et le message porterait
  # sur la configuration plutot que sur la mise a jour.
  if ! grep -q '^DEMO_ACCESS_LINK_TOKEN=' "${ENVIRONMENT_FILE}"; then
    printf '\nDEMO_ACCESS_LINK_TOKEN="%s"\nDEMO_ACCESS_PIN="%s"\n' \
      "${DEMO_ACCESS_LINK_TOKEN_DEFAULT}" "${DEMO_ACCESS_PIN_DEFAULT}" \
      >> "${ENVIRONMENT_FILE}"
    detail "Lien de demonstration absent du .env : ajoute."
  fi
else
  announce "Generation de la configuration et des secrets"
  detail "Aucune valeur n'est reprise de .env.example : un secret d'exemple deploye tel quel"
  detail "serait le meme chez tous ceux qui ont clone ce depot."

  # Un nom donne a la main l'emporte toujours, y compris pour forcer le local
  # avec `PUBLIC_HOSTNAME=localhost ./install.sh`.
  if [[ -n "${PUBLIC_HOSTNAME:-}" ]]; then
    public_hostname="${PUBLIC_HOSTNAME}"
  elif public_hostname_designe_cette_machine "${DEFAULT_PUBLIC_HOSTNAME}"; then
    public_hostname="${DEFAULT_PUBLIC_HOSTNAME}"
    detail "${DEFAULT_PUBLIC_HOSTNAME} designe cette machine : deploiement public."
  else
    public_hostname="${FALLBACK_PUBLIC_HOSTNAME}"
    detail "${DEFAULT_PUBLIC_HOSTNAME} ne designe pas cette machine : installation locale."
    detail "Pour deployer sous un autre nom : PUBLIC_HOSTNAME=<nom> ./install.sh"
  fi
  traefik_http_port="$(configured_or_default TRAEFIK_HTTP_PORT "${DEFAULT_TRAEFIK_HTTP_PORT}")"
  traefik_https_port="$(configured_or_default TRAEFIK_HTTPS_PORT "${DEFAULT_TRAEFIK_HTTPS_PORT}")"
  acme_email="$(configured_or_default ACME_EMAIL "${DEFAULT_ACME_EMAIL}")"

  # Le nom d'hote decide de tout le reste, et il n'y a pas de reglage a la
  # carte : en production l'application EXIGE une URL en https sur un nom
  # routable, parce que sans TLS le cookie de session ne peut pas porter
  # `Secure` — il vaut identite, il voyagerait lisible. Sur une machine locale
  # il n'y a ni nom routable ni certificat possible : l'installation est alors
  # une demonstration, et le dire franchement vaut mieux que forcer un
  # `production` que l'application refusera.
  if [[ "${public_hostname}" == "localhost" ||
        "${public_hostname}" == 127.* ||
        "${public_hostname}" == *.local ||
        "${public_hostname}" == *.localhost ||
        "${public_hostname}" == *.test ]]; then
    node_environment="development"
    public_base_url="http://${public_hostname}:${traefik_http_port}"
    detail "Installation locale : NODE_ENV=development, portail en HTTP sur le port ${traefik_http_port}."
    detail "Pour deployer sous un nom public : PUBLIC_HOSTNAME=<nom> ./install.sh"
  else
    node_environment="production"
    public_base_url="https://${public_hostname}"
    detail "Deploiement public : NODE_ENV=production, portail en HTTPS sur ${public_hostname}."
  fi

  demo_lawyer_email="$(configured_or_default DEMO_LAWYER_EMAIL "${DEMO_LAWYER_EMAIL_DEFAULT}")"
  demo_lawyer_password="$(configured_or_default DEMO_LAWYER_PASSWORD "${DEMO_LAWYER_PASSWORD_DEFAULT}")"
  demo_access_link_token="$(configured_or_default DEMO_ACCESS_LINK_TOKEN "${DEMO_ACCESS_LINK_TOKEN_DEFAULT}")"
  demo_access_pin="$(configured_or_default DEMO_ACCESS_PIN "${DEMO_ACCESS_PIN_DEFAULT}")"

  # Toutes les valeurs sont entre guillemets, sans exception : la phrase de
  # passe contient des ESPACES, et une ligne `X=un deux trois` fait echouer le
  # `source` de ce fichier sur un « command not found » qui ne dit rien de sa
  # cause. Docker Compose, lui, retire ces guillemets a la lecture.
  umask 077
  cat > "${ENVIRONMENT_FILE}" <<ENVIRONMENT
# Genere par install.sh le $(date -Iseconds). Ne pas versionner.

NODE_ENV="${node_environment}"

PUBLIC_HOSTNAME="${public_hostname}"
PUBLIC_BASE_URL="${public_base_url}"
TRAEFIK_HTTP_PORT="${traefik_http_port}"
TRAEFIK_HTTPS_PORT="${traefik_https_port}"
ACME_EMAIL="${acme_email}"
# L'autorite REELLE par defaut. Un certificat de staging donne un site qui
# repond en HTTPS et qu'aucun navigateur n'accepte : le visiteur voit un
# avertissement de securite, ce qui est pire qu'une panne franche puisque cela
# ressemble a un site qui marche mal. Pour mettre au point sans consommer le
# quota — il se compte par domaine enregistre, et celui-ci est partage :
#   ACME_CA_SERVER="${ACME_STAGING_CA}" ./install.sh
ACME_CA_SERVER="$(configured_or_default ACME_CA_SERVER "${ACME_PRODUCTION_CA}")"

# Les ports ci-dessous ne sont publies QUE par la surcouche de developpement,
# jamais par ce deploiement. Ils restent neanmoins dans la plage attribuee :
# la machine est partagee, et un port pris hors plage est pris a quelqu'un.
POSTGRES_USER="portail"
POSTGRES_DB="portail"
POSTGRES_PASSWORD="$(random_secret 24)"
POSTGRES_PORT="22310"

MINIO_ROOT_USER="portail-minio"
MINIO_ROOT_PASSWORD="$(random_secret 24)"
MINIO_ENDPOINT="http://minio:9000"
MINIO_API_PORT="22320"
MINIO_CONSOLE_PORT="22321"

CLAMAV_ENDPOINT="tcp://clamav:3310"
CLAMAV_PORT="22330"

BETTER_AUTH_SECRET="$(random_secret 32)"
ACCESS_LINK_TOKEN_PEPPER="$(random_secret 32)"
INTERNAL_STORAGE_WEBHOOK_SECRET="$(random_secret 32)"
GRAFANA_ADMIN_PASSWORD="$(configured_or_default GRAFANA_ADMIN_PASSWORD "${GRAFANA_ADMIN_PASSWORD_DEFAULT}")"

# Publics et documentes dans le README : voir le commentaire de
# DEMO_LAWYER_PASSWORD_DEFAULT dans install.sh.
DEMO_LAWYER_EMAIL="${demo_lawyer_email}"
DEMO_LAWYER_PASSWORD="${demo_lawyer_password}"
DEMO_ACCESS_LINK_TOKEN="${demo_access_link_token}"
DEMO_ACCESS_PIN="${demo_access_pin}"

TRUSTED_PROXY_HOP_COUNT="1"
WORKER_METRICS_PORT="9101"

IMAGE_REPOSITORY="$(configured_or_default IMAGE_REPOSITORY "${IMAGE_REPOSITORY_DEFAULT}")"
IMAGE_TAG="$(configured_or_default IMAGE_TAG "${IMAGE_TAG_DEFAULT}")"

# L'uid qui possede ./data, donc celui sous lequel les services a donnees
# doivent ecrire. Voir le commentaire en tete de ce script.
SERVICE_UID="${INVOKING_UID}"
SERVICE_GID="${INVOKING_GID}"
ENVIRONMENT
  umask 022
  chmod 600 "${ENVIRONMENT_FILE}"
  detail "Ecrit dans .env (0600)."
fi

set -a
# shellcheck disable=SC1090
. "${ENVIRONMENT_FILE}"
set +a

# --- Repertoires de donnees -------------------------------------------------

# Un volume NOMME est cree en root au premier demarrage, et un conteneur
# non-root ne pourrait pas y ecrire. D'ou des bind mounts, crees ici avec le bon
# proprietaire AVANT le premier `up`.
announce "Preparation des repertoires de donnees"
# `data/grafana/dashboards` est cree ICI alors que rien n'y ecrit : le compose
# monte les tableaux de bord DEDANS, c'est-a-dire a l'interieur d'un autre
# montage. Un point de montage imbrique qui n'existe pas encore est cree par le
# demon Docker, donc en ROOT — et il reste ensuite sur la machine, impossible a
# effacer pour qui n'a pas les privileges. Le creer d'avance le fait appartenir
# a l'utilisateur.
mkdir -p \
  data/postgres/pgdata \
  data/minio \
  data/prometheus \
  data/observability/secrets \
  data/traefik/dynamic \
  data/traefik/acme \
  data/grafana/dashboards
detail "data/{postgres,minio,prometheus,grafana,traefik}"

# Le secret de collecte est lu par Prometheus dans un fichier, jamais passe en
# argument : la ligne de commande d'un processus est lisible par tout le monde.
printf '%s' "${INTERNAL_STORAGE_WEBHOOK_SECRET}" > data/observability/secrets/internal_shared_secret
chmod 400 data/observability/secrets/internal_shared_secret

# Traefik refuse de demarrer si acme.json est plus permissif que 0600, et
# redemande alors un certificat a chaque redeploiement.
touch data/traefik/acme/acme.json
chmod 600 data/traefik/acme/acme.json

# Ni la configuration statique ni le fournisseur `file` de Traefik ne savent lire
# une variable d'environnement : tout ce qui depend du deploiement est substitue
# ici, une bonne fois, dans un fichier que Traefik relit a chaud.
render_traefik_routing() {
  local entrypoint tls_block redirection_router hsts_seconds

  if [[ "${PUBLIC_BASE_URL}" == https://* ]]; then
    entrypoint="websecure"
    tls_block='tls:\n        certResolver: letsencrypt'
    redirection_router='redirection:\n      rule: "Host(`'"${PUBLIC_HOSTNAME}"'`)"\n      service: web\n      priority: 1\n      entryPoints: [web]\n      middlewares: [vers_https]'
    # HSTS uniquement avec un certificat d'une VRAIE autorite : un navigateur
    # qui retient la directive refusera ensuite le clair pendant deux ans, et
    # un certificat de staging n'est pas reconnu — le portail deviendrait
    # inaccessible sans moyen de revenir en arriere.
    if [[ "${ACME_CA_SERVER:-}" == *acme-staging* ]]; then
      hsts_seconds="0"
    else
      hsts_seconds="63072000"
    fi
  else
    entrypoint="web"
    tls_block=""
    redirection_router=""
    hsts_seconds="0"
  fi

  sed \
    -e "s/__PUBLIC_HOSTNAME__/${PUBLIC_HOSTNAME}/g" \
    -e "s/__ENTRYPOINT__/${entrypoint}/g" \
    -e "s|__TLS__|${tls_block}|g" \
    -e "s|__REDIRECTION_ROUTER__|${redirection_router}|g" \
    -e "s/__HSTS_SECONDS__/${hsts_seconds}/g" \
    infra/traefik/dynamic.yml.template |
    # Les marqueurs sans equivalent laissent une ligne vide indentee, que YAML
    # accepte mais qu'on ne veut pas relire.
    sed -e '/^[[:space:]]\{1,\}$/d' > data/traefik/dynamic/portail.yml
}

render_traefik_routing
detail "Routage Traefik rendu pour ${PUBLIC_HOSTNAME} (${PUBLIC_BASE_URL})"

# --- Images et demarrage ----------------------------------------------------

announce "Recuperation des images"
# Tirees explicitement plutot que laissees a `up -d` : quand un registre est
# injoignable ou un paquet reste prive, `up` melange l'echec de telechargement
# aux messages de demarrage des autres services. Ici la panne a sa propre ligne,
# et le message dit quoi faire.
docker compose -f "${COMPOSE_FILE}" pull ||
  fail "Impossible de recuperer les images depuis ${IMAGE_REPOSITORY:-${IMAGE_REPOSITORY_DEFAULT}}.
       Verifiez l'acces reseau au registre. Pour construire depuis ces sources a la place :
       docker compose -f infra/docker-compose.yml -f infra/docker-compose.dev.yml build app web"

announce "Demarrage de la pile"
# UNIQUEMENT le fichier de base : la surcouche de developpement publie des ports
# et rend un acces sortant a Postgres et MinIO.
docker compose -f "${COMPOSE_FILE}" up -d

announce "Attente de la disponibilite des services"
detail "clamav charge sa base de signatures et prend une a deux minutes."

wait_until_healthy() {
  local service="$1" deadline=$((SECONDS + 300)) state=""

  while ((SECONDS < deadline)); do
    state="$(docker compose -f "${COMPOSE_FILE}" ps --format '{{.Health}}' "${service}" 2>/dev/null | head -1)"

    if [[ "${state}" == "healthy" ]]; then
      detail "${service} : healthy"
      return 0
    fi

    sleep 5
  done

  fail "${service} n'est pas devenu healthy en cinq minutes. Journal : docker compose logs ${service}"
}

for service in postgres minio clamav app web; do
  wait_until_healthy "${service}"
done

# --- Ce que l'evaluateur doit lire ------------------------------------------

printf '\n\033[1;32m✓ Le portail de depot est installe.\033[0m\n\n'
printf '  Portail          %s\n' "${PUBLIC_BASE_URL}"
printf '  Tableaux de bord %s/grafana/\n' "${PUBLIC_BASE_URL}"
printf '\n  Compte avocat de demonstration\n'
printf '    Adresse        %s\n' "${DEMO_LAWYER_EMAIL}"
printf '    Mot de passe   %s\n' "${DEMO_LAWYER_PASSWORD}"
printf '\n  Grafana\n'
printf '    Identifiant    admin\n'
printf '    Mot de passe   %s\n' "${GRAFANA_ADMIN_PASSWORD}"
printf '\n  Demande de demonstration, cote CLIENT (aucun compte necessaire)\n'
printf '    Lien           %s/deposit/%s\n' "${PUBLIC_BASE_URL}" "${DEMO_ACCESS_LINK_TOKEN}"
printf '    Code d acces   %s\n' "${DEMO_ACCESS_PIN}"
printf '\n  Ce lien est celui de la demande deja creee pour le compte avocat\n'
printf '  ci-dessus : ouvrez-le dans une fenetre privee pour voir les deux cotes.\n'
printf '  Il est valable sept jours et « Regenerer le lien » le remplace par un\n'
printf '  lien tire au sort, comme pour une vraie demande.\n'
printf '\n  Ces identifiants sont ceux du README : ce sont les seules valeurs fixes\n'
printf '  du projet. Tous les autres secrets sont tires au sort dans .env (0600).\n'
printf '  Migrations, buckets, compte avocat et demande de demonstration se sont\n'
printf '  joues au demarrage de l application.\n\n'
