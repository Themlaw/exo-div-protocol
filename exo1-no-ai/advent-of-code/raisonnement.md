Pour le problème Guard Gallivant, l'idée de l'étape 1 c'était simplement de parcourir la grid et voir à quel moment on en sortait.

La principale difficulté sur cette partie c'était de bien penser aux edge cases et à comment parcourir un graphe (sens des indices).

Pour la deuxième étape, l'idée c'est de faire un solve pour regarder où passe le garde, qui sont les seuls endroits pertinents pour placer un obstacle, ensuite on résout pour chaque place possible puis on regarde si ça loop.

La principale difficulté ici c'était de bien définir une condition de loop, ma première idée c'était de simplement mettre un nombre d'étapes maximal mais sur une grande grille la complexité temporelle explose et il faut garder de la marge.

Finalement je me suis rendu compte que si on loopait alors on passait nécessairement deux fois par la même position avec la même direction, mais en faisant attention au fait que là où on loop ne passe pas forcément par le point de départ.