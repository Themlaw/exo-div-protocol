# Portail de dépôt de pièces

Un avocat demande des pièces à un client **non authentifié**, le client dépose
depuis un lien protégé par un code, et l'avocat suit tout depuis son tableau de
bord.

> **État du document.** Les sections *Installation*, *Architecture*, *Modèle de
> données*, *Stratégie de tests* et *Limites connues* sont rédigées à l'étape 10,
> avec la chaîne de déploiement. La section **Observabilité** ci-dessous est
> complète : elle décrit ce qui tourne aujourd'hui.

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

**Avertissements** : état de file illisible, travaux de scan abandonnés,
balayage de jetons de lien, pic de refus de cadence, dossiers ouverts puis
abandonnés sans aucun dépôt, pièce infectée.

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
├── prometheus/prometheus.yml      # deux cibles, secret lu dans un fichier
├── prometheus/alert_rules.yml     # 3 critiques, 6 avertissements
└── grafana/
    ├── provisioning/              # source de données et tableau de bord, au démarrage
    └── dashboards/portail.json    # versionné : il se relit et se corrige comme du code
```

Prometheus et Grafana vivent sur un réseau `observability` **interne**. Le
collecteur n'atteint ni Postgres ni clamav : il n'a besoin que des deux
processus du portail. Grafana rejoint en plus `proxied` pour être servi en HTTPS
par Traefik, derrière son authentification — inscription et accès anonyme
désactivés, mot de passe admin généré par `install.sh`.
