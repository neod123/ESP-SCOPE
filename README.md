
ESP-SCOPE

- separer l html en sous-fichier
- rajoute un cadrigage qui correspond aux division, et les buttons des division scale/div doivent eagelemtn udpate le graph

- dans general, ajoute un slider horizontal pour deplacer le point de trigger
- si trigger, affiche une ligne vertical estompé
- reduit la largeur moyenne des channels
- bouger les slides doit update toute la courbe, pas jsute les nouveaux points





a rajouter:

les interface message entre ino-core et la page web.

les messages:
la page web doit renvoyer vers ino les config message suivant:

- ajout/retrait d un canal de mesure:
 add;GPIO10;
 del;GPIO10;
    fait moi la fonction de config du ino egalement


- la page web dois recevoir les mesure du ino:
data;timestamp;value-ch1-brute;value-ch2-brute;etc...
 fait moi egalement la loop de  mesure et d envoi de ces valeurs








- prepare gpio pour les 3 cibles (une match table pour chaque cibles)et update les checkbox en focntion

- interfacer la reception depuis le ino

- le changement de io doit etre appliqué sur le ino








- peut etre ajouter une possibilité de mesuré le courant utilisé sur une longue periode (unité: V, W, A)
- peut etre ajouter une possibilité de convertir la valeur arrivé avant display 

- ajouter un champs qui affiche l echantillonage

- remember settings (coockies)





- les données sont recu par la page sous la forme suivante:
ADC;timestamp;adc_value1;adc_value2
il est possible de recevoir d un coup plusieurs chaine de ce type separé par \n

Le graph doit reagir en ajoutant les valeurs a chaque courbe correspondante.
le timestamp doit egalement etre utilisé pour positioné le point.

Pour l instant affiche les valeurs brutes mais prevoit de convertir les valeurs a reception avec une fonction "convert() qui pour l instant renverront in = out



