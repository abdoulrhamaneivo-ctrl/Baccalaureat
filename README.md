# Petit Bac

Trois jeux en français — Petit Bac, Capitales du monde et Culture générale — jouables en solo ou en groupe selon le mode.

**[Jouer en ligne](https://petit-bac-ivory.vercel.app)**

## Modes de jeu

### Solo

Le mode Solo reste disponible sur un appareil, sans compte : 2 à 10 joueurs jouent à tour de rôle.

- Six catégories : Prénom, Pays, Ville, Fruit, Légume et Animal.
- Chronomètre réglable à 15, 30 ou 60 secondes.
- Nombre de manches libre, ordre des joueurs tournant et lettres aléatoires.
- Correction après le passage de tous les joueurs, contestation et validation par le groupe.
- 10 points par réponse reconnue ; les doublons entre joueurs sont autorisés.

### Multijoueur

Chaque joueur utilise son propre appareil. L’hôte crée une salle, partage son code ou son lien d’invitation, configure la partie et démarre dès que deux joueurs sont présents. Jusqu’à 20 joueurs peuvent rejoindre une salle, uniquement avant le début.

- Configuration centralisée : 1 à 50 manches, 30/60/90/120 secondes, catégories choisies, lettres exclues et première lettre choisie par l’hôte ou tirage aléatoire.
- Même lettre, heure de début et heure de fin pour toute la salle. Le compte à rebours affiché par les appareils est calculé à partir de l’échéance du serveur.
- Les réponses sont enregistrées au fil de la saisie et verrouillées par le serveur à l’expiration du chrono.
- Une réponse correcte et unique vaut 10 points. Une réponse correcte identique dans la même catégorie vaut 0 point pour tous ses auteurs. Les réponses incorrectes ou vides valent 0 point.
- Les joueurs peuvent corriger les réponses ambiguës : un avis adverse suffit dans une salle de deux joueurs; deux joueurs distincts doivent valider la réponse dans une salle de trois joueurs ou plus. Un joueur ne peut voter qu’une fois par réponse. Chaque correction recalcule les doublons et les scores côté serveur.
- Les mots validés sont ajoutés au dictionnaire multijoueur partagé et pourront compter comme reconnus dans les parties suivantes.
- La correction dure au plus 20 secondes, puis la pause synchronisée de 10 secondes lance automatiquement la manche suivante.
- Une reconnexion dans le même navigateur restaure la salle et la partie. Si l’hôte se déconnecte, un joueur connecté reprend son rôle.

### Capitales du monde

Le quiz des drapeaux se joue seul, ou en multijoueur sur un appareil par joueur.

- Un drapeau différent est tiré à chaque question. Le quiz demande aléatoirement le nom du pays ou celui de sa capitale.
- En solo, une partie contient 10 questions avec 20 secondes par réponse.
- En solo comme en groupe, on peut choisir 5, 10, 15, 20 ou 30 questions, 10, 15, 20 ou 30 secondes par question, les continents et le mode de question : pays, capitale ou aléatoire.
- Toutes les personnes d’une salle reçoivent le même drapeau, la même question et le même chronomètre. Chaque réponse correcte rapporte 10 points, même si plusieurs joueurs trouvent la réponse.
- Les réponses sont comparées sans tenir compte des accents, des majuscules ou des séparateurs. Les pays et capitales acceptés comprennent les formes françaises et les noms alternatifs disponibles dans les données.

### Culture générale

Le quiz de culture générale se joue seul ou en salle multijoueur.

- 90 questions à choix multiples et plus de 30 questions Vrai/Faux.
- Thèmes : Côte d’Ivoire, histoire africaine et mondiale, géographie, sciences, arts et culture, sports et monde contemporain.
- En solo, choisissez 5 à 30 questions et 10, 15, 20 ou 30 secondes par question. Les erreurs peuvent être rejouées à la fin de la partie.
- En groupe, l’hôte choisit le format et les thèmes ; tous les joueurs reçoivent les mêmes questions et les mêmes choix.
- Une explication s’affiche après chaque réponse pour aider à retenir le fait.
- Les questions contemporaines portent sur des événements datés et des connaissances durables, pas sur un fil d’actualité en direct.

### Historique et classements

Les parties multijoueurs terminées sont conservées dans Redis. La page d’accueil affiche les 10 pseudos ayant le plus de points cumulés, séparément pour Petit Bac et Capitales du monde, ainsi que les 10 parties récentes de chaque jeu. Le pseudo sert d’identifiant public : il n’est pas lié à un compte vérifié. Les parties Solo restent locales à l’appareil et ne sont pas ajoutées aux classements en ligne.

Les noms de pays et les capitales proviennent de [mledoze/countries](https://github.com/mledoze/countries), sous licence ODbL-1.0. Les drapeaux SVG proviennent de [flag-icons](https://github.com/lipis/flag-icons), sous licence MIT. Les attributions et copies des licences sont dans `dist/world-data-ATTRIBUTION.txt`, `dist/world-data-ODbL-LICENSE.txt` et `dist/flags/LICENSE.txt`.

Pour régénérer le répertoire et les fichiers de drapeaux après une mise à jour des dépendances :

```bash
npm run build:world-data
```

## Lancer le jeu

Le projet utilise Node.js 18 ou plus récent pour servir le site et le serveur Socket.IO sur la même origine :

```bash
npm install
npm start
```

Ouvrir **http://localhost:3000**. Pour jouer sur plusieurs appareils du même réseau Wi-Fi, ouvrir l’adresse IP locale de l’ordinateur qui héberge le serveur, par exemple **http://192.168.1.25:3000**. Le port 3000 doit être accessible depuis ces appareils.

## Déploiement Vercel

Le site statique est hébergé sur Vercel. Socket.IO se connecte au serveur Render configuré par `PETIT_BAC_SOCKET_URL`. Upstash Redis conserve les salles en cours; Neon stocke les parties terminées, les classements et les mots validés. Les URL Redis et PostgreSQL restent des variables secrètes et ne doivent pas être copiées dans le dépôt.

Depuis le compte Vercel lié au projet :

```bash
npm install
npm run build
vercel --prod
```

Le client utilise le transport WebSocket et reprend la session après une reconnexion. Les salles sont conservées dans Redis pendant 24 heures lorsqu’un joueur est connecté, puis dix minutes après la déconnexion de tous les joueurs.

## Temps réel et persistance

Le serveur temps réel tourne sur le Web Service Render `petit-bac-temps-reel`, avec `npm ci` comme commande de build, `npm run start:render` comme commande de démarrage et `/health` comme chemin de vérification. Render utilise `KV_URL` pour les salles et `DATABASE_URL` pour Neon. Vercel utilise `PETIT_BAC_SOCKET_URL` avec l’origine Render, par exemple `https://petit-bac-temps-reel.onrender.com`.

Sur Render, les clics et les saisies sont traités par le processus Node actif. Les salles restent en mémoire pendant le jeu et sont sauvegardées dans Redis en arrière-plan toutes les cinq secondes pour permettre une reprise après un redémarrage. Gardez une seule instance Render : l’état actif des salles est local au processus.

Les écritures de scores et les lectures d’historique passent par Neon; elles sont séparées du traitement temps réel des réponses et des minuteurs. Le démarrage du serveur importe aussi les anciens classements Upstash vers Neon une seule fois.

## Vérifications

```bash
npm test
node --check server.js
node --check dist/app.js
node --check dist/multiplayer.js
node --check dist/capitals.js
node --check dist/data.js
node --check server/game-rules.js
```

La suite existante vérifie le barème du Petit Bac (réponses uniques, doublons, normalisation, réponses invalides), la validation de configuration, les salles multijoueurs, les permissions de l’hôte, la correction manuelle, les scores finaux et les transitions synchronisées. Elle ne couvre pas encore le nouveau quiz Capitales du monde.

Pour vérifier l’interface complète, ouvrir le serveur sur deux navigateurs ou appareils, créer une salle, rejoindre avec le code, démarrer une partie et vérifier la correction ainsi que le classement.

## Organisation des fichiers

| Fichier | Rôle |
| --- | --- |
| `dist/index.html` | Page, métadonnées, règles |
| `dist/style.css` | Présentation du mode Solo et styles communs |
| `dist/multiplayer.css` | Accueil des modes et interface multijoueur responsive |
| `dist/capitals.js` et `dist/capitals.css` | Quiz solo des drapeaux et styles du mini-jeu |
| `dist/culture-data.js`, `dist/culture.js` et `dist/culture.css` | Questions et interface du quiz de culture générale |
| `dist/world-data.js` et `dist/flags/` | Données locales des pays, capitales et drapeaux |
| `dist/app.js` | Mode Solo existant et choix du mode à l’accueil |
| `dist/multiplayer.js` | Interface multijoueur, Socket.IO et reconnexion |
| `dist/data.js` | Catégories, répertoire de mots et validation partagés |
| `server.js` | Serveur HTTP/Socket.IO, salles, transactions Redis et transitions de partie |
| `api/socket-io.js` | Point d’entrée Socket.IO pour Vercel et répartiteur Redis |
| `server/render.js` | Serveur Socket.IO permanent pour Render; Redis ne bloque pas les réponses en temps réel |
| `server/stats-store.js` | Historique, classements cumulés et dictionnaire partagé |
| `api/health.js` | Vérification de disponibilité du déploiement |
| `vercel.json` | Paramètres Vercel pour les fichiers statiques et la Function |
| `scripts/build-vercel.js` | Préparation des fichiers statiques et du client Socket.IO pour Vercel |
| `server/game-rules.js` | Validation serveur et calcul autoritaire des scores |
| `test/multiplayer.test.js` | Vérifications des règles et du protocole temps réel Petit Bac |
| `scripts/build-world-data.js` | Génération des données et copies de licences du quiz |

Les sources frontend sont servies directement depuis `dist` ; aucune compilation n’est nécessaire.

## Correction Solo

La correction Solo utilise un répertoire local et n’appelle ni IA ni API. Il n’est pas exhaustif, notamment pour les prénoms et les villes. Un mot absent reçoit initialement 0 point mais peut être validé par le groupe s’il commence par la bonne lettre et correspond à la catégorie. Les accents, majuscules et séparateurs sont normalisés. Pour enrichir le répertoire, modifier les listes de `dist/data.js` en conservant l’ordre des six catégories.
