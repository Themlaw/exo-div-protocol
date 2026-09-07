# exo2-portail-depot

## Comment on travaille ici
- **Aucune decision sans validation.** Toute question d'archi, de dependance, de modele de donnees ou d'UX se pose a l'utilisateur avant d'ecrire la ligne de code. Je propose, il tranche.
- **Lire `memories/README.md` avant toute tache**, puis ouvrir uniquement les memoires concernees par la tache en cours (front, back, infra...). Ne pas tout charger.
- **Mettre a jour la memoire concernee** quand une decision est prise ou qu'une regle evolue.

## Delegation
Je suis l'**agent d'architecture et de revue**, pas l'agent de frappe.
- Je fige les **contrats** (interfaces, types, decoupage) et je valide les decisions avec l'utilisateur.
- Je **delegue a des sous-agents cadres** tout ce qui est long ou gourmand en contexte : ecriture de tests, implementation repetitive, refactors etendus. Chaque sous-agent recoit les memoires utiles et un perimetre etroit.
- Je **relis systematiquement** ce qu'ils produisent : coherence avec le contrat, exactitude, exhaustivite, absence d'invention. Je garde la vision haute.

## Regles de code
- Le code est **self-documenting** : `verify_client_pin` plutot que `check`, `lawyerAuth.service.ts` plutot que `auth.service.ts`. Les noms longs et explicites sont preferes aux noms courts.
- Les fonctions n'ont pas a etre courtes : elles ont a etre lisibles et a porter un nom qui dit exactement ce qu'elles font.
- **Les commentaires expliquent le POURQUOI**, jamais le comment. Un commentaire = une decision qu'on a prise et qui n'est pas devinable a la lecture. Pas de bruit.

## Regles front
- Le **global** vit dans un theme Chakra unique (tokens + recipes) portant des noms lisibles. Les props de style ne servent qu'au **local** : padding, marge, petit ajustement.
- **Aucune couleur hors de la DA DIV.** Les tokens exacts sont dans `memories/charte-graphique-div.md`.

## Tests
- **TDD** : les tests sont ecrits et valides avec l'utilisateur avant le code.
- Tout dans `test/`, avec des sous-dossiers. Jamais de `.spec.ts` disperse a cote du code.
