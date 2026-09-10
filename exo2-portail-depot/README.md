# Portail de dépôt de pièces

Un avocat demande des pièces à un client **non authentifié**, le client dépose
depuis un lien protégé par un code, et l'avocat suit tout depuis son tableau de
bord.

**Déploiement en ligne : <https://titouan-constance.stage2-div.rayan-drissi.com>**

## Identifiants de démonstration

**Compte avocat** — <https://titouan-constance.stage2-div.rayan-drissi.com/login>

| | |
|---|---|
| Adresse | `avocat@portail-div.fr` |
| Mot de passe | `atelier balise carnet dossier facade` |

Ce compte est amorcé au démarrage, avec **une demande déjà créée** — *Dossier de
démonstration — succession Martin*, trois emplacements attendus. De quoi émettre
un lien et le suivre sans rien avoir à préparer.

**Grafana** — <https://titouan-constance.stage2-div.rayan-drissi.com/grafana/>

| | |
|---|---|
| Identifiant | `admin` |
| Mot de passe | `courbe seuil mesure alerte tableau` |

Le tableau de bord du portail y est provisionné au démarrage, et la source de
données Prometheus avec lui : rien à brancher. L'inscription et l'accès anonyme
sont désactivés — une pile d'alerting qu'on ne peut pas montrer ne prouve rien,
mais elle reste derrière son authentification.

Grafana est servie **sous un chemin**, pas sous un sous-domaine : une seule
entrée DNS est relayée vers cette machine, et `grafana.<domaine>` ne résoudrait
nulle part. Son `root_url` est composée à partir de la même variable que tout le
reste — `${PUBLIC_BASE_URL}/grafana/` — et `serve_from_sub_path` est activé,
sans quoi Grafana renverrait des liens absolus vers la racine et se casserait
elle-même derrière le proxy.

Ces quatre valeurs sont les seules de tout le projet à être fixes et publiées.
C'est un choix, et il se paie : ces identifiants étant publics, les deux comptes
le sont aussi. Ils le sont parce qu'une démonstration qu'on ne peut pas ouvrir ne
démontre rien. Tout le reste — poivre des jetons, secret de session, secret de
collecte, mots de passe de Postgres et de MinIO — est tiré au sort à
l'installation et n'existe que dans le `.env` de la machine. Un déploiement réel
remplacerait cet amorçage par une invitation ;
`DEMO_LAWYER_PASSWORD=... GRAFANA_ADMIN_PASSWORD=... ./install.sh` suffit à
refermer les deux dès maintenant.

---

## Installation

```bash
git clone <ce dépôt> && cd exo2-portail-depot
./install.sh
```

**Aucune question n'est posée.** Le script génère tous les secrets, prépare les
répertoires, tire les images publiées, démarre la pile, attend que chaque
service soit sain, et affiche les URL. Les migrations, la création des buckets, le compte
avocat et la demande de démonstration se jouent **au démarrage de
l'application**, pas dans une commande séparée : après une installation,
personne n'a de terminal à ouvrir, et une étape qu'on oublie de lancer est une
installation qui ne sert à rien.

Aucune valeur n'est reprise de `.env.example`. Un secret d'exemple déployé tel
quel serait le même chez tous ceux qui ont cloné le dépôt — ce n'est pas un
secret, c'est une constante publique.

### Repartir de zéro

```bash
docker compose -f infra/docker-compose.yml down --volumes
rm -rf data .env && ./install.sh
```

Si `rm` répond `Permission denied`, c'est que des fichiers appartiennent à un
autre utilisateur — un conteneur qui a écrit sous un uid différent du vôtre, ou
un point de montage créé par le démon Docker. **Aucun `sudo` n'est nécessaire**,
et c'est heureux : sur une machine partagée on ne l'a pas toujours. Docker, lui,
tourne en root, et il suffit de le lui demander :

```bash
docker run --rm --volume "$PWD:/cible" alpine:3.20 chown -R "$(id -u):$(id -g)" /cible
```

### Sur votre machine : `http://localhost:22300`

C'est le défaut, et c'est délibéré. Le sous-domaine ci-dessus pointe vers **ma**
machine : l'y mettre par défaut ferait demander à Let's Encrypt un certificat
pour un nom qui ne résout pas vers la vôtre, et l'installation « qui doit juste
marcher » échouerait sur la seule chose qui ne pouvait pas marcher. `localhost`
marche partout, sans DNS et sans certificat.

### Pour déployer sous un nom public

```bash
PUBLIC_HOSTNAME=titouan-constance.stage2-div.rayan-drissi.com ./install.sh
```

Tout ce qui pourrait être demandé a un défaut qui marche et une variable
d'environnement pour le remplacer : `PUBLIC_HOSTNAME`, `TRAEFIK_HTTP_PORT`,
`TRAEFIK_HTTPS_PORT`, `ACME_EMAIL`, `ACME_CA_SERVER`, `DEMO_LAWYER_EMAIL`,
`DEMO_LAWYER_PASSWORD`. Une invite, même avec une valeur par défaut, est déjà
une étape à comprendre — et elle bloque net une exécution non interactive.

### Ce que le nom d'hôte décide, et pourquoi

| Nom d'hôte | `NODE_ENV` | Portail | Traefik |
|---|---|---|---|
| `localhost` (défaut) | `development` | `http://localhost:22300` | écoute en clair |
| un nom public | `production` | `https://<nom>` | TLS, ACME, redirection du clair |

Ce n'est pas un contournement du durcissement, c'est son corollaire. En
production l'application **refuse de démarrer** sur une URL en clair : sans TLS,
le cookie de session ne peut pas porter `Secure`, et il vaut identité. Aucune
autorité ne certifiant `localhost`, une installation locale ne peut pas
satisfaire cette règle — et l'annoncer vaut mieux que la taire.

`ACME_CA_SERVER` pointe par défaut sur le **staging** de Let's Encrypt : le
quota de certificats est par domaine et par semaine, et ce domaine est partagé.
Une fois le déploiement vérifié, vider la variable et relancer. HSTS n'est
activé **que** dans ce cas : un navigateur qui a retenu la directive refuse
ensuite toute connexion en clair pendant deux ans, et un certificat de staging
n'est pas reconnu — le portail deviendrait inaccessible sans moyen de revenir en
arrière.

### Les ports

La machine d'exercice est **partagée** : une plage y est attribuée, et un port
pris hors plage est pris à quelqu'un d'autre. Tout ce que ce projet publie tient
dans `22300-22399`, et **rien n'est publié ailleurs que sur `127.0.0.1`**.

| Port | Publié par | Ce qu'il sert |
|---|---|---|
| `22300` | le déploiement | Traefik en clair — le proxy frontal y relaie le `80` |
| `22301` | le déploiement | Traefik en TLS — le proxy frontal y relaie le `443`, en passthrough |
| `22310` | la surcouche de dev | Postgres |
| `22320` / `22321` | la surcouche de dev | l'API et la console MinIO |
| `22330` | la surcouche de dev | clamd, pour le worker lancé sur l'hôte |

Les deux premiers ne sont pas libres : le relais existe déjà. En changer un sans
changer le relais rend le portail injoignable **sans rien casser de visible** —
la pile démarre parfaitement, elle écoute simplement ailleurs. Les quatre autres
ne sont publiés qu'en développement ; en production, Postgres et MinIO vivent
sur des réseaux `internal` et ne sont joignables que par les services de la pile.

À l'intérieur des conteneurs, les ports ne suivent pas cette plage et n'ont pas
à la suivre : Traefik écoute en `8000`/`8443`, nginx en `8080`, l'API en `3000`.
Un port sous 1024 exigerait `CAP_NET_BIND_SERVICE`, que cette pile abandonne
partout.

Le `443` étant relayé **en passthrough TLS**, le proxy frontal ne déchiffre
rien : c'est notre Traefik qui termine le TLS et pose `X-Forwarded-For`. Toutes
les requêtes lui arrivent donc depuis la même adresse, celle du relais — la
limitation de cadence par couple (compte, adresse) retombe de fait sur la
limitation par compte, qui **retarde** sans jamais refuser. C'est assumé : sans
cela, n'importe qui fermerait le portail à tout le monde.

### Développer sur l'hôte

```bash
./infra/ci/prepare_test_environment.sh   # .env de test + Postgres, MinIO, clamav
cd backend  && npm ci && npm run start          # l'API
cd backend  && npm run start:worker             # le scanner
cd frontend && npm ci && npm run dev            # le front, sur :5173
```

La surcouche `infra/docker-compose.dev.yml` attache Postgres et MinIO à un second
réseau non interne pour que l'hôte puisse les joindre. Elle n'est **jamais**
déployée : `install.sh` n'utilise que le fichier de base. Son nom n'est
volontairement pas `docker-compose.override.yml`, qui serait chargé
automatiquement et pourrait relâcher la production sans qu'on le voie.

---

## Architecture

### Les processus

```
        navigateur
            │
            ▼
     ┌─────────────┐   le seul service exposé
     │   Traefik   │   TLS, ACME, en-têtes de sécurité
     └──┬───┬───┬──┘
        │   │   └──────────────────────┐
        ▼   ▼                          ▼
   ┌──────┐ ┌────────┐          ┌─────────────┐
   │ web  │ │  app   │          │    minio    │  les octets ne passent
   │nginx │ │ NestJS │          │  (2 seaux)  │  jamais par l'API
   └──────┘ └───┬────┘          └──────┬──────┘
                │                      │ notification d'objet
                ▼                      ▼
          ┌──────────┐           ┌──────────┐
          │ postgres │◄──────────│  worker  │──────► clamav
          │          │  file de  │  NestJS  │
          └──────────┘  travaux  └──────────┘
```

**Deux processus, une seule image.** Le worker partage tout le domaine — statuts,
journal, stockage — et deux images divergeraient au premier correctif appliqué
d'un seul côté. Ils se distinguent par leur point d'entrée, et par ce qu'ils
servent : l'API répond aux requêtes, le worker n'en sert aucune et ne rejoint
donc jamais le réseau du proxy.

**Le déploiement tire, le développement construit.** `infra/docker-compose.yml`
ne contient aucune directive `build` : il désigne `ghcr.io/themlaw/exo-div-protocol/portail-app`
et `.../portail-web`. L'image publiée est la seule à avoir traversé toute la chaîne de
vérification ; une construction locale ne prouve que ce que la machine avait
sous la main ce jour-là. La surcouche `infra/docker-compose.dev.yml` rend leur
`build` aux trois services, pour essayer un correctif avant de le publier :

```bash
docker compose -f infra/docker-compose.yml -f infra/docker-compose.dev.yml build app web
```

**Pourquoi GHCR et pas Docker Hub.** Deux raisons, et la première est un risque
qu'on ne maîtrise pas. Docker Hub plafonne les téléchargements anonymes par
adresse IP ; une installation lancée depuis un réseau partagé dont le quota est
déjà consommé échoue sur un `toomanyrequests`, c'est-à-dire sur la seule chose
que l'installation ne peut pas réparer elle-même. GHCR n'impose pas ce plafond
sur un paquet public. La seconde est un choix de sécurité : le travail de
publication s'authentifie avec le jeton que GitHub fabrique pour la durée du
job, avec la seule permission `packages: write`. Aucun secret de longue durée ne
dort dans le dépôt. Le prix payé est un nom d'image plus long, et un piège qu'il
faut connaître — **un paquet poussé pour la première fois est privé par
défaut**, et il faut le passer public à la main, une fois. C'est vérifié ici par
un `docker logout` suivi d'un `docker pull`, parce que le vérifier depuis une
machine déjà authentifiée ne vérifie rien.

**Étiquettes.** `latest` suit la branche principale. Une étiquette git `v1.2.3`
publie en plus `1.2.3`, ce qui permet d'épingler une version et d'y revenir
(`IMAGE_TAG=1.2.3 ./install.sh`). Le commit exact n'est pas une étiquette de
plus : il voyage dans le label `org.opencontainers.image.revision`, où il répond
à « quel code tourne dans cette image » sans encombrer la liste des versions.

**Cinq réseaux, dont un seul atteint Internet.** `edge` ne porte que Traefik ;
`proxied`, `datastore` et `observability` sont `internal: true`, ce qui coupe
tout accès sortant — un conteneur compromis n'a pas de chemin direct
d'exfiltration. `signatures` est réservé à `freshclam`, qui a besoin, lui, de
télécharger ses définitions. Conséquence à connaître : Docker **ne peut pas
publier de port** pour un conteneur attaché au seul réseau interne, et il ignore
la directive `ports` en silence.

**Traefik n'utilise aucun label Docker**, et c'est le point de sécurité de cette
brique. Le provider `docker` de Traefik exige le **socket Docker** monté dans le
conteneur ; or ce conteneur est le seul exposé sur Internet, et le socket Docker
vaut la machine — qui l'a peut démarrer un conteneur privilégié montant `/`.
Toute la configuration statique tient donc dans les arguments du service, et le
routage dans `data/traefik/dynamic/portail.yml`, monté **en lecture seule** et
rendu par `install.sh` depuis `infra/traefik/dynamic.yml.template`. Le prix à
payer est réel : un service ne s'auto-déclare pas, il faut l'écrire dans le
fichier. Sur une pile de quatre routeurs qui ne bougent pas, c'est un prix
dérisoire face à ce qu'il achète.

**Aucun conteneur ne tourne en `root`**, tous sont en `read_only`, sans aucune
capacité (`cap_drop: ALL`) et avec `no-new-privileges`. Ce qui doit écrire écrit
dans un `tmpfs` borné.

Les cinq services qui écrivent dans `./data` — Postgres, MinIO, Prometheus,
Grafana, Traefik — portent l'**uid de l'utilisateur qui a lancé `./install.sh`**,
et non un `1000` figé. C'est ce script qui crée ces répertoires, donc ils lui
appartiennent : un conteneur qui y écrit doit porter le même uid, sinon il se
heurte à un refus de permission que seul `root` pourrait réparer — et une
installation en une commande n'a aucune raison d'exiger `root`. Le script refuse
d'ailleurs de tourner en `root`, ce qui garantit que cet uid n'est jamais `0`.
Les trois autres services n'écrivent dans aucun répertoire de l'hôte et gardent
un uid fixe ; `clamav` porte celui que son image impose. Traefik n'a **pas** le socket Docker : sa configuration
statique tient dans ses arguments, son routage dans un fichier monté en lecture
seule. Donner le socket à un service exposé sur Internet, c'est lui donner la
machine.

### Le dépôt, de bout en bout

1. L'avocat crée une demande : un titre, des emplacements attendus, une
   politique de sécurité (`10` essais, `7` jours, `6` chiffres par défaut).
2. Le serveur émet un lien et un code. **Le token n'est stocké qu'en HMAC**
   (poivré par `ACCESS_LINK_TOKEN_PEPPER`), le PIN en argon2id : ni l'un ni
   l'autre ne peut être redit, ce qui est aussi pourquoi la popup de remise
   prévient qu'on ne les reverra pas.
3. Le client ouvre le lien, saisit le code, obtient une **session de dépôt** de
   30 minutes dans un cookie `HttpOnly`. L'écran ne porte aucun drapeau
   « déverrouillé » : c'est la réponse du serveur qui décide, le cookie étant
   illisible depuis le script.
4. Pour chaque pièce, l'API signe une **autorisation d'écriture** et le
   navigateur poste les octets **directement** à MinIO. Ils ne traversent jamais
   l'API — qui n'a donc ni à les mettre en tampon, ni à les relayer.
5. MinIO notifie l'application, qui met un travail en file (`graphile-worker`,
   dans la même base : une file dans un autre système, c'est une transaction de
   plus à réconcilier). Le worker fait passer le flux à clamav.
6. Propre, la pièce est déplacée en `depot-verified` et devient téléchargeable.
   Infectée, elle est marquée et n'est jamais servie. Le seau de quarantaine
   n'est **jamais** lisible autrement que par nous.
7. Le client déclare son dépôt terminé ; l'avocat voit la demande passer en
   `processing` et télécharge — chaque téléchargement étant journalisé.

### Une règle qui traverse tout : ne rien apprendre à qui n'a rien

Un identifiant qui n'existe pas et un identifiant qui appartient à quelqu'un
d'autre rendent **la même** réponse : `404`. La seule exception est le `409` que
l'avocat reçoit sur **sa propre** pièce non téléchargeable — il sait déjà
qu'elle existe. Les refus de déverrouillage sont tous `401 {"state":"invalid"}`,
octet pour octet : mauvais code, lien expiré, lien révoqué, lien inexistant ne
se distinguent pas. Seul `blocked` diffère, parce qu'il faut bien dire au client
qu'il doit demander un nouveau lien.

Le même principe vaut pour les chemins : un chemin qu'aucun contrôleur ne sert
rend `401` quand personne n'est connecté — sans quoi la différence `404`/`401`
dessinerait la carte de ce qui existe.

### L'autorisation, par défaut fermée

Chaque route déclare son **genre d'accès** : `lawyer`, `client_link`,
`client_session`, `internal`, `health`, `public_auth`. L'absence de décorateur
vaut `lawyer`. Une route ajoutée demain est donc fermée sans que son auteur ait
à y penser, et l'application **recense au démarrage** toutes les routes ouvertes
au-delà du défaut — un audit qu'on lit dans les journaux plutôt qu'un document
qu'on oublie de mettre à jour.

---

## Modèle de données

Trois schémas Postgres, et la séparation dit à quoi chacun sert.

**`deposit`** — le métier.

| Table | Ce qu'elle porte |
|---|---|
| `deposit_request` | la demande : titre, client, statut, politique de sécurité |
| `expected_document` | un emplacement attendu : libellé, position, types et taille admis |
| `access_link` | un lien : **HMAC** du token, **hash argon2id** du PIN, échéance, essais restants, révocation |
| `deposit_session` | une session client ouverte par un déverrouillage réussi |
| `deposited_file` | une pièce déposée : clef d'objet, statut de scan, empreinte, taille |
| `activity_event` | le journal, en ajout seul |

**`auth`** — les tables de BetterAuth (`user`, `session`, `account`,
`verification`). À part, parce qu'elles ne nous appartiennent pas : leur forme
est celle de la bibliothèque, et les mêler au métier ferait passer une migration
de dépendance pour une évolution du domaine.

**`security`** — les compteurs de limitation de cadence, par IP, par compte, et
par couple compte/IP. À part également : ce sont des données de **défense**, à
durée de vie courte, écrites sur des chemins que l'authentification n'a pas
encore franchis.

Un lien est **historisé, jamais écrasé** : régénérer révoque l'ancien et en crée
un autre. C'est ce qui permet au journal de dire *quel* lien a servi, et à un
lien révoqué de rester révoqué.

Les statuts d'une pièce sont `pending_upload → pending_scan → clean | infected |
rejected`. Ceux d'une demande sont `incomplete → processing → validated`, plus
`blocked` et `expired_incomplete`. Un emplacement n'est considéré **occupé**
qu'à partir de `pending_scan` : une autorisation d'écriture qui n'a jamais été
suivie d'octets ne doit pas condamner l'emplacement.


---

## Observabilité — ce qu'on mesure, et pourquoi

La consigne ne donne pas la liste des métriques. C'est volontaire, et c'est là
que se joue la différence : **une alerte qui se déclenche sur quelque chose qui
compte vaut mieux que douze tableaux de bord décoratifs.** Ce qui suit justifie
donc chaque série exposée — et, tout aussi important, celles qu'on a écartées.

### Le principe de sélection

Une métrique n'est retenue que si elle répond **oui** à l'une de ces trois
questions :

1. **Est-ce que le produit peut être cassé pendant que toutes les sondes
   d'infrastructure sont vertes ?** C'est le cas le plus dangereux, parce que
   personne ne le voit venir.
2. **Est-ce qu'une défense du portail agit sans qu'on puisse le constater ?**
   Une protection qui tient en silence ne permet à personne de savoir qu'on est
   attaqué.
3. **Est-ce que le produit peut échouer sans qu'aucune machine ne tombe ?** Un
   lien qui n'arrive pas au client est une panne, même si tout répond 200.

### La panne qui a dicté le périmètre

Le chemin nominal d'un dépôt repose sur des **événements** : une notification
`s3:ObjectCreated` de MinIO, puis un travail en file. Un événement se perd. Le
jour où la notification ne part plus, ou bien où clamd ne répond plus :

- le client dépose, son navigateur reçoit un `204`, il n'a rien à signaler ;
- l'objet est bien dans le bucket de quarantaine ;
- l'avocat ne voit jamais la pièce arriver, et attend ;
- **Postgres, MinIO, l'API et le worker répondent tous parfaitement.**

Aucune sonde d'infrastructure ne détecte cela. C'est la raison d'être de la
métrique la plus importante du portail :

```
portail_scan_queue_oldest_pending_job_age_seconds
```

L'alerte `FileDeScanFigee` se déclenche au-delà de quinze minutes. Un scan dure
quelques secondes et la réconciliation repasse tous les quarts d'heure : au-delà,
ce n'est plus un retard, c'est une chaîne cassée.

> **Détail qui compte** : l'âge se mesure depuis `run_at`, pas depuis
> `created_at`. Un travail replanifié après un échec a *réellement* recommencé à
> attendre à ce moment-là. Le compter depuis sa création ferait hurler l'alerte
> sur une file qui rejoue normalement — et une alerte qui crie à tort est une
> alerte qu'on finit par couper.

### Les séries exposées

| Série | Ce qu'elle répond |
|---|---|
| `portail_activity_events_total{type}` | Le cycle de vie complet d'un dossier : lien émis, session ouverte, pièce déposée, verdict du scan, retrait, demande validée ou expirée. |
| `portail_scan_queue_depth{state}` | La file de scan par état — `pending`, `running`, `failed`. |
| `portail_scan_queue_oldest_pending_job_age_seconds` | Depuis combien de temps le dépôt le plus ancien attend son scan. |
| `portail_clamav_up` | Est-ce que clamd répond, mesuré par un vrai PING sur la connexion qu'un scan utiliserait. |
| `portail_rate_limited_requests_total{surface}` | Les refus de cadence, ventilés entre le PIN client et la connexion avocat. |
| `portail_unknown_access_link_attempts_total` | Les tentatives sur un jeton qui ne désigne aucune demande. |

### Trois règles de modélisation, tenues partout

**On expose des compteurs bruts, jamais des taux ni des ratios.** « Échecs de
PIN par seconde » et « ratio échecs/succès » se calculent en PromQL à partir de
deux compteurs. Précalculer un taux le rend inexploitable sur une autre fenêtre
— et c'est toujours sur une autre fenêtre qu'on regarde en incident.

**Jamais d'identifiant en étiquette.** Ni demande, ni jeton, ni nom de fichier,
ni adresse. Deux raisons, et la seconde est la vraie : la cardinalité d'abord,
mais surtout la page de métriques est atteignable par tout ce qui présente le
secret de collecte — c'est une surface de lecture, pas un journal d'audit. Les
étiquettes sont donc des **énumérations fermées**, et un test le vérifie.

**Toutes les séries sont posées à zéro au démarrage.** Sans cela une série
n'apparaît qu'au premier événement : `rate()` n'a aucun point de départ, et une
alerte du type « plus aucun dépôt depuis une heure » ne peut pas se déclencher,
faute de série à interroger.

### Compter ne doit pas être un geste à ne pas oublier

Les compteurs métier ne sont **pas** posés à la main sur chaque site
d'écriture. Le journal d'activité est enveloppé par un décorateur
(`MeteredActivityEventRepository`) : **écrire au journal suffit à être compté.**
Un événement ajouté demain est compté sans que personne y pense, et il ne peut
pas exister de chemin qui journalise sans mesurer.

Le corollaire est un test de bout en bout qui joue la vie entière de trois
dossiers et vérifie que **chaque type du domaine est réellement produit par un
chemin réel**. C'est ce test qui a révélé qu'un type d'événement était mort —
et, à travers lui, qu'une pièce au type maquillé gelait la file de scan pour
toujours.

### Deux processus, deux expositions

L'API et le worker exposent chacun `/metrics`, et Prometheus somme par `job`.

Ce n'est pas une redondance : **le worker écrit lui-même au journal d'activité
pendant un scan.** Sans sa propre exposition, tous les verdicts de scan étaient
comptés dans un registre que personne ne collectait.

En revanche, les jauges de file ne sont exposées **que par le worker**. L'API
partage la même base et pourrait techniquement les lire — les exposer des deux
côtés ferait doubler un `sum()`. La décision « qui possède la file » tient en
une ligne, à la racine du processus qui a le droit de la prendre :

```ts
// worker_main.ts, et nulle part ailleurs
metrics.attach_worker_health_source(new ScanChainHealthSource({ ... }));
```

### Quand la mesure elle-même tombe en panne

Si la lecture en base échoue, les séries de file **disparaissent** de
l'exposition. Elles ne gardent pas leur dernière valeur et ne tombent pas à
zéro : les deux mentiraient, et un zéro se lit « rien n'attend », soit
exactement l'inverse de la vérité. `absent()` est une condition d'alerte
parfaitement lisible, et c'est celle qu'on utilise.

De même, une sonde clamd qui n'a pas pu s'exécuter vaut `0`, jamais vert — le
même *fail closed* que le scanner lui-même, qui rend `scanner_unavailable` et
jamais `clean`.

Et une base injoignable ne doit pas emporter la page entière : les compteurs
métier restent lisibles, puisque ce sont eux qu'on lira pour comprendre
l'incident.

### Les alertes

On réveille quelqu'un pour ce qui est **critique et actionnable**. Le reste
reste en tableau de bord.

**Critiques**

| Alerte | Condition | Pourquoi |
|---|---|---|
| `ServiceInjoignable` | `up == 0` pendant 2 min | Le contrôle le plus bête et le plus utile. |
| `FileDeScanFigee` | plus vieux travail > 15 min | La seule panne où tout est vert et où le produit ne marche plus. |
| `ScannerAntiviralInjoignable` | `portail_clamav_up == 0` pendant 5 min | En *fail closed*, plus rien n'est publié — et le client ne voit aucune erreur. |
| `ProxyRendDesErreurs` | > 0,1 réponse 5xx/s par routeur, 5 min | Ce que le **visiteur** voit. L'application ne compte que les requêtes qu'elle a traitées : celles que le proxy n'a pas pu lui transmettre n'existent dans aucune de ses séries. |
| `CertificatBientotExpire` | échéance < 14 jours pendant 1 h | Le renouvellement ACME est automatique, donc sa panne est **silencieuse** jusqu'au jour où plus personne n'entre. Traefik renouvelle à 30 jours : sous 14, il a déjà échoué. |

**Avertissements** : état de file illisible, travaux de scan abandonnés,
balayage de jetons de lien, pic de refus de cadence, dossiers ouverts puis
abandonnés sans aucun dépôt, pièce infectée, et rechargement de configuration
du proxy refusé (Traefik continue alors de servir la **précédente**, sans rien
dire — la panne n'apparaîtrait qu'au redémarrage suivant, longtemps après sa
cause).

Ce dernier groupe mérite un mot. **Les dossiers abandonnés sans dépôt sont le
signal produit le plus parlant du portail.** Il ne dit pas qu'une machine est en
panne : il dit que le lien n'arrive pas au client, ou qu'il n'est pas compris.
C'est la seule métrique de cette liste qui parle du métier de l'avocat plutôt
que de l'état des machines.

### Ce qu'on a écarté, et pourquoi

**Durée et taille des uploads.** Non mesurables côté application : le navigateur
poste les octets **directement** vers MinIO via une URL pré-signée, le backend
ne les voit jamais passer. Les inventer côté serveur donnerait un chiffre faux.
Elles viendront de l'endpoint natif de MinIO.

**Métriques de MinIO** (espace disque, échecs de stockage). Elles exigent
d'ouvrir `/minio/v2/metrics/*`. L'option simple — `MINIO_PROMETHEUS_AUTH_TYPE=public`
— est **écartée** : MinIO est routé par Traefik pour l'upload direct, donc une
exposition sans authentification ne resterait pas confinée au réseau
d'observabilité. Ce sera un jeton signé, à l'étape 10.

**Sonde blackbox sur l'URL HTTPS publique.** C'est le seul contrôle réellement
de bout en bout — il traverse Traefik et le certificat. Il arrive avec Traefik.

**Épuisement du pool de connexions Postgres**, partagé entre l'API et le worker.
Le symptôme réaliste d'une base saturée n'est pas le CPU mais celui-là. Il exige
un exportateur dédié, à l'étape 10.

Ces quatre-là sont **absentes du fichier de règles**, et c'est délibéré : une
règle qui interroge une série qu'aucun chemin ne produit ne se déclenche jamais
et donne l'illusion d'une couverture. C'est pire que son absence.

### Accès aux surfaces de collecte

`GET /metrics` — sur l'API comme sur le worker — est servie **hors du préfixe
versionné** (une surface d'exploitation n'est pas l'API du produit) et derrière
l'accès `internal`, avec le secret partagé.

Prometheus ne peut pas envoyer un en-tête `Authorization` brut : sa
configuration impose un schéma. Les deux formes sont donc acceptées —
`Bearer <secret>` pour le collecteur, brute pour MinIO, le seul émetteur qu'on
ne puisse pas configurer. Le secret lui-même n'est **jamais** dans un fichier
versionné : Prometheus le lit dans un fichier écrit par `install.sh`.

Le worker sert son exposition sur un `node:http` nu — aucune dépendance
ajoutée, une seule route, un seul verbe. Tout le reste répond **404 muet**, y
compris avec le bon secret : un `405` confirmerait que le chemin existe.

### Ce qui tourne

```
observability/
├── prometheus/prometheus.yml      # quatre cibles, secret lu dans un fichier
├── prometheus/alert_rules.yml     # 5 critiques, 7 avertissements
└── grafana/
    ├── provisioning/              # source de données et tableau de bord, au démarrage
    └── dashboards/portail.json    # versionné : il se relit et se corrige comme du code
```

Quatre cibles : l'API, le worker, **Traefik** et Prometheus lui-même. Traefik
parce qu'il est le seul à mesurer ce que l'extérieur reçoit réellement —
l'application compte ses propres réponses, mais elle ne sait rien d'une requête
que le proxy a refusée avant elle, ni d'un certificat sur le point d'expirer.
Ses séries portent le routeur et le code de réponse, donc la différence entre
« le portail est lent » et « le stockage est lent ». Prometheus lui-même parce
que sans cela `up == 0` ne dirait rien du collecteur, et qu'une chaîne d'alerte
aveugle sur elle-même n'alerte de rien.

Prometheus et Grafana vivent sur un réseau `observability` **interne**. Le
collecteur n'atteint ni Postgres ni clamav : il n'a besoin que des deux
processus du portail et du proxy. Grafana rejoint en plus `proxied` pour être servi en HTTPS
par Traefik, derrière son authentification — inscription et accès anonyme
désactivés, mot de passe admin généré par `install.sh`.

---

## Stratégie de tests

Cinq étages, et chacun répond à une question que les autres ne peuvent pas
poser.

| Suite | Volume | Question |
|---|---|---|
| Unitaires backend | 818 | la règle est-elle juste ? |
| Intégration backend | 290 | la règle survit-elle à Postgres, MinIO et clamav ? |
| Unitaires front | 75 | l'écran rend-il ce que l'API dit ? |
| Playwright | 4 parcours | un vrai navigateur va-t-il du lien au dépôt terminé ? |
| Règles d'alerte | 6 cas | l'alerte se déclencherait-elle vraiment le jour venu ? |

```bash
cd backend  && NODE_OPTIONS=--experimental-vm-modules npx jest              # unitaires
cd backend  && set -a; . ../.env; set +a; \
               NODE_OPTIONS=--experimental-vm-modules npx jest --config ./test/jest-integration.json
cd frontend && npx vitest run && npm run typecheck
cd frontend && npm run test:e2e                                            # démarre sa propre pile
docker run --rm --volume "$PWD/observability/prometheus:/regles:ro" \
  --entrypoint promtool prom/prometheus:v3.5.0 test rules /regles/alert_rules_test.yml
```

Le dernier étage mérite un mot. Une règle d'alerte ne s'exécute qu'au moment de
la panne : tant qu'il ne se passe rien, une règle juste et une règle muette sont
indiscernables. Les six cas de `alert_rules_test.yml` rejouent des séries
synthétiques — un routeur qui rend des 502, un certificat à dix jours, un
rechargement de configuration refusé — et exigent des règles qu'elles parlent
sur la panne **et se taisent sur le fonctionnement normal**, parce qu'une alerte
qui crie pour un `5xx` isolé finit par être ignorée le jour où elle a raison.

### Un test qui ne peut pas échouer ne prouve rien

Chaque test écrit ici a été **muté** : on casse volontairement le code qu'il
couvre, et on vérifie qu'il devient rouge. Ce n'est pas un principe décoratif —
il a servi. Le test de dérive des contrats, celui qui compare les types du front
à ceux du backend, ne compilait **aucun fichier** : son `tsconfig` héritait d'un
`exclude` qui filtrait son propre `include`. Il passait depuis le début, et il
ne regardait rien.

### Ce que chaque étage a réellement attrapé

- **L'intégration** a montré qu'un `409` ne devient `file_not_downloadable` que
  s'il *porte* un statut de pièce ; sinon c'est un conflit ordinaire.
- **Playwright** a trouvé un bug que ni les tests unitaires ni l'intégration ne
  pouvaient voir : après l'envoi des octets, le tableau du client restait vide.
  L'emplacement n'étant occupé qu'à partir de `pending_scan`, la relecture
  périodique ne démarrait jamais. Un vrai navigateur, un vrai POST, un vrai
  délai — c'est le seul étage où ces trois-là existent ensemble.
- **Le déploiement** en a trouvé deux autres, que même Playwright ne pouvait pas
  voir. Le client MinIO va **demander** sa région au serveur avant de signer, et
  le client signeur est configuré sur l'adresse publique, que l'application ne
  peut pas joindre depuis son réseau interne : en développement les deux adresses
  sont la même, en production la demande d'autorisation d'envoi rendait `500` sur
  une pile parfaitement saine. Et `app` et `worker` partageant l'image partagent
  l'amorçage des buckets : démarrant **ensemble**, tous deux constataient
  l'absence du bucket, tous deux le créaient, et le perdant faisait échouer
  l'installation entière. Deux pannes de course et de topologie — le genre que
  seule une installation réelle, faite deux fois de suite sur une machine vierge,
  peut produire.

### Intégration continue

`../.github/workflows/ci.yml` — à la racine du dépôt, parce que GitHub n'exécute
que les workflows qui s'y trouvent, et tous ses chemins sont donc préfixés par
`exo2-portail-depot/`. Six travaux : analyse statique et unitaires
backend, types et unitaires front, intégration, **Playwright dans son propre
travail**, règles d'alerte, et construction des deux images. Les séparer donne le retour rapide
tout de suite au lieu de le faire attendre derrière le plus lent. Sur une
proposition de fusion, les images sont construites sans être publiées : la
question à laquelle ce travail répond est « le déploiement compile-t-il
encore », et elle mérite une réponse en quelques minutes.

Un septième travail, `publication`, pousse les deux images sur GHCR — mais
**uniquement sur la branche principale, et uniquement derrière tous les
autres**. Une image publiée est celle que `./install.sh` déploiera sans rien
reconstruire : la publier avant d'avoir vérifié reviendrait à livrer le défaut.

---

## Limites connues

Elles sont listées parce qu'elles sont connues, et non parce qu'elles sont
petites.

**Le formulaire de création n'expose pas la politique de sécurité.** Le nombre
d'essais, la durée du lien et la longueur du code sont validés et appliqués
côté serveur, mais l'écran n'offre pas encore de les régler : il envoie les
valeurs par défaut. Le scénario Playwright qui vérifie le blocage après N essais
crée donc sa demande par l'API.

**Le journal d'activité n'a pas de curseur.** `GET /requests/:id/activity` rend
`has_more`, mais pas de quoi demander la page suivante. Le tableau de bord
annonce donc qu'il existe une activité plus ancienne sans proposer un bouton qui
ne mènerait nulle part.

**Le compte de démonstration est amorcé au démarrage, avec un mot de passe fixe
et publié.** C'est voulu pour un exercice qui doit s'installer en une commande et
s'ouvrir sans lire une sortie de terminal — mais c'est bien un compte public sur
un portail public. Un vrai déploiement remplacerait cet amorçage par une
invitation ; en attendant, `DEMO_LAWYER_PASSWORD=... ./install.sh` suffit à le
refermer.

**La demande de démonstration n'est amorcée que sur une base vierge**, et son
lien n'est pas amorcé du tout. Le jeton n'étant stocké qu'en HMAC et le code
qu'en argon2id, les publier supposerait de les fixer — donc de livrer un lien de
dépôt ouvert à qui lit le README. L'avocat en émet un depuis son tableau de bord,
en un clic.

**Aucune reprise sur un objet arrivé pendant une panne longue.** La file de
notifications de MinIO est persistée sur disque et rejouée, et une réconciliation
périodique rattrape les pièces restées en `pending_scan`. Mais un objet posé
dans le seau *sans* passer par une autorisation de l'application n'a pas de ligne
en base, et rien ne le réclamera.

**`npm audit` signale 8 vulnérabilités** dans les dépendances transitives, dont
la chaîne de `minio@8.0.7`. Aucune n'est atteignable depuis nos chemins d'appel,
et les corriger demanderait des changements majeurs de version qu'un exercice ne
justifie pas de tenter à l'aveugle.

**Le paramètre argon2 `t=8` n'a pas été remesuré** sur la machine de
déploiement. Il a été calibré en local ; une machine plus lente rendrait la
vérification du PIN plus coûteuse qu'on ne l'a mesurée.
