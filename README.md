# Exercices DIV Protocol — Titouan Constance

Deux exercices, deux dossiers, un seul dépôt. Chacun se lit et se lance
indépendamment de l'autre.

| Dossier | Exercice |
|---|---|
| [`exo1-no-ai/`](exo1-no-ai/) | Résolution d'énigmes CodinGame sans assistance d'IA — solutions, raisonnement écrit et captures. |
| [`exo2-portail-depot/`](exo2-portail-depot/) | **Portail de dépôt de pièces** : un avocat demande des documents à un client non authentifié et suit tout depuis un tableau de bord. |

**Portail déployé : <https://titouan-constance.stage2-div.rayan-drissi.com>** —
identifiants de démonstration dans
[le README de l'exercice](exo2-portail-depot/README.md).

## Lancer le portail de dépôt

```bash
git clone https://github.com/Themlaw/exo-div-protocol.git
cd exo-div-protocol/exo2-portail-depot
./install.sh
```

**Aucune question n'est posée.** Le script génère les secrets, tire les images
publiées, démarre la pile, attend que chaque service soit sain et affiche les
URL. Les identifiants de démonstration, l'architecture, le modèle de données, la
stratégie de tests et les limites connues sont dans
[`exo2-portail-depot/README.md`](exo2-portail-depot/README.md).

Le `cd` est délibéré : chaque exercice garde son point d'entrée chez lui. Un
script d'installation à la racine devrait deviner lequel des deux on veut, et se
tromper en silence une fois sur deux.

## Pourquoi un seul dépôt et pas des sous-modules

Un sous-module rend un dossier **vide** à qui clone sans `--recursive`. On entre
dans `exo2-portail-depot/`, `install.sh` n'existe pas, et rien dans le dépôt ne
peut prévenir : c'est la commande de clonage qui décide. Les sous-modules se
justifient quand deux projets ont des cycles de vie ou des droits d'accès
distincts — ce n'est pas le cas ici, et le seul avantage réel, des historiques
séparés, ne pèse rien face à un dossier vide le jour de la lecture.
