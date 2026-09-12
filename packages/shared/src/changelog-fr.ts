import type { ChangelogEntry } from "./changelog.js";

export const frEntries: ChangelogEntry[] = [
  {
    "version": "0.14.6",
    "date": "2026-09-10",
    "highlights": [
      "Avertit lorsque cette version est plus ancienne que vos données locales ou que la version Intel tourne sur Apple Silicon, au lieu d'échouer en silence.",
      "Ajoute un plan de contrôle MCP local du bureau ; les plugins vérifiés ne pilotent le bureau qu'après un consentement natif.",
      "Ajoute des modèles prédéfinis de sous-agents, un sélecteur de modèles limité au fournisseur et le niveau de réflexion effectif sur les cartes de délégation.",
      "Attribue des alias aux modèles configurés, copie les identifiants de modèle et privilégie l'API propre au modèle sur le style du fournisseur.",
      "Remplace la correspondance textuelle d'Edit par des opérations ancrées aux lignes, avec des conseils de récupération propres à chaque erreur.",
      "Réessaie les fournisseurs jusqu'à dix fois avec un compte à rebours visible et reprend les tours autonomes de simple progression.",
      "Refonte de l'installateur macOS, ajout d'un exe portable Windows et d'un paquet RPM Linux, et retour des icônes de barre et de dock GNOME.",
      "Copie les identifiants de conversation et ouvre les dossiers de session depuis la barre latérale, avec des infobulles localisées sur les actions à icône seule.",
      "Affiche l'état du processus en direct et les intervalles calmes sur la ligne d'activité, et ajoute un bouton fixe de bascule du panneau de travail.",
      "Applique les règles d'exclusion de l'espace de travail, résout les liens symboliques orphelins et revérifie la sortie réseau des plugins à chaque redirection.",
      "Respecte les règles de contournement de proxy, conserve les glyphes à usage privé collés et charge les aperçus de fichiers sans bloquer l'éditeur.",
    ],
  },
  {
    "version": "0.14.5",
    "date": "2026-09-09",
    "highlights": [
      "Identifiez chaque DMG et ZIP macOS avec son architecture native arm64 ou x64."
    ]
  },
  {
    "version": "0.14.4",
    "date": "2026-09-09",
    "highlights": [
      "Ajoutez aux plugins des lectures par plage limitées pour les gros fichiers et des autorisations de fichiers liées à de vrais gestes de glisser-déposer.",
      "Rendez explicites l’activation de la signature et de la notarisation macOS et ajoutez des indications pour ouvrir les versions non signées de confiance."
    ]
  },
  {
    "version": "0.14.3",
    "date": "2026-09-09",
    "highlights": [
      "Identifiez clairement les téléchargements macOS Intel afin que l’architecture de l’installeur soit évidente."
    ]
  },
  {
    "version": "0.14.2",
    "date": "2026-09-08",
    "highlights": [
      "Ajoutez un inspecteur de consommation du contexte qui suit le modèle sélectionné et affiche des indications de compression.",
      "Améliorez la configuration des fournisseurs et des modèles avec une sélection recherchable, des actions groupées et des erreurs de récupération plus claires.",
      "Résumez automatiquement les titres de session et permettez d’utiliser des noms de projet persistants.",
      "Améliorez le panneau latéral des sous-agents avec l’état en direct, des bulles de tâches compactes, l’identité du modèle et la navigation vers la sortie la plus récente.",
      "Envoyez des notifications natives pour les demandes et validations interactives, sans placer les complétions ordinaires dans la boîte de réception.",
      "Ajoutez la localisation coréenne de l’interface et améliorez les réglages localisés, l’historique du presse-papiers et les liens sécurisés.",
    ]
  },
  {
    "version": "0.14.1",
    "date": "2026-09-08",
    "highlights": [
      "Faites hériter les sous-agents du modèle parent lorsqu’aucun modèle de délégation n’est configuré.",
      "Évitez que les identifiants du modèle parent répétés soient refusés à tort comme modèles de délégation indisponibles.",
    ]
  },
  {
    "version": "0.14.0",
    "date": "2026-09-08",
    "highlights": [
      "Configurez des proxys HTTP sortants par fournisseur, avec validation et gestion claire des identifiants SOCKS4 non pris en charge.",
      "Importez des profils de fournisseurs et des configurations de modèles depuis CC Switch et les stockages locaux des agents.",
      "Ajoutez des en-têtes personnalisés et des paramètres User-Agent par fournisseur, ainsi qu’un préréglage MiniMax et des erreurs de récupération de modèles plus claires.",
      "Joignez des fichiers depuis le sélecteur unifié, avec des copies dans le dossier temporaire de session et la prise en charge des images intégrées.",
      "Ajoutez les interfaces chinois traditionnel, allemand, espagnol et français, ainsi que des réglages d’apparence et de fournisseurs accessibles par recherche.",
      "Ajustez uniformément les tailles de lecture, la typographie et les icônes, et affichez le modèle du sous-agent sélectionné dans les cartes de délégation.",
    ]
  },
  {
    "version": "0.13.11",
    "date": "2026-09-07",
    "highlights": [
      "Laissez les plugins répertorier les modèles, lire le contexte de la session en cours et demander des achèvements appartenant à l'hôte sans recevoir d'informations d'identification."
    ]
  },
  {
    "version": "0.13.10",
    "date": "2026-09-07",
    "highlights": [
      "Confirmez avant de quitter (Cmd+Q, barre d'état ou menu) pour éviter toute perte accidentelle de données."
    ]
  },
  {
    "version": "0.13.9",
    "date": "2026-09-06",
    "highlights": [
      "Modification de la version pour l'infrastructure de publication."
    ]
  },
  {
    "version": "0.13.8",
    "date": "2026-09-06",
    "highlights": [
      "Recherchez et prévisualisez les fichiers de projet, y compris les images, puis ouvrez-les avec l'application par défaut à partir d'une page de visualisation dédiée.",
      "Exécutez le navigateur du panneau de travail en tant que plug-in fourni, avec la même isolation que les autres vues du plug-in.",
      "Conservez les puces du fichier @ après Entrée et pulsez la puce de mode pendant la planification.",
      "Ouvrez uniquement les liens http(s) et mailto à partir du chat, des plugins et des aperçus."
    ]
  },
  {
    "version": "0.13.7",
    "date": "2026-09-06",
    "highlights": [
      "Conservez les réponses AI terminées après le redémarrage, au lieu d'afficher uniquement les messages utilisateur.",
      "Laissez les sous-agents en arrière-plan fonctionner jusqu'à ce que vous les arrêtiez ou que le parent les arrête.",
      "Laissez l'agent choisir un délai d'expiration Bash allant jusqu'à six heures afin que les tâches longues ne soient pas supprimées au bout de 60 secondes."
    ]
  },
  {
    "version": "0.13.6",
    "date": "2026-09-06",
    "highlights": [
      "Conservez les messages utilisateur collés en fonction de leur contenu au lieu de les étendre sur le fil de discussion."
    ]
  },
  {
    "version": "0.13.5",
    "date": "2026-09-06",
    "highlights": [
      "Supprimez le courtier A2A et les outils de conversation peer-to-peer.",
      "Correction des tests d'exécution de l'agent qui ont échoué après la suppression d'A2A."
    ]
  },
  {
    "version": "0.13.4",
    "date": "2026-09-05",
    "highlights": [
      "Ajoutez le turc et un sélecteur de langue consultable dans Paramètres → Général.",
      "Faites du thème un sélecteur de type langage de recherche, y compris les thèmes de plug-in.",
      "Aplatissez la liste des services d'ajout de fournisseurs, ajoutez Xiaomi, Zhipu et Z.AI et rendez le service consultable.",
      "Signaler un problème depuis Paramètres → Infos avec la version et le système d'exploitation déjà renseignés.",
      "Gardez les conversations en streaming dans l'ordre chronologique lorsque la transcription en direct est fusionnée."
    ]
  },
  {
    "version": "0.13.3",
    "date": "2026-09-05",
    "highlights": [
      "Ouvrez immédiatement une nouvelle tâche vers une destination vide, sans conserver la transcription précédente à l'écran.",
      "Traitez une fenêtre de lecture remplie comme complète et conservez la puce tronquée pour les coupes réelles.",
      "Conservez des tours de conversation ultérieurs lors du changement de variantes régénérées, au lieu de restaurer une archive obsolète."
    ]
  },
  {
    "version": "0.13.2",
    "date": "2026-09-05",
    "highlights": [
      "Conservez les brouillons du compositeur non envoyés, y compris les fragments de fichiers, lorsque l'entrée est remontée ou que la fenêtre est masquée.",
      "Démarrez de nouvelles sessions au niveau de réflexion par défaut de la liaison de modèle au lieu de toujours utiliser le plus fort.",
      "Gardez les exécutions de sous-agents développées défilées jusqu'à la dernière sortie, avec un contrôle de passage à la dernière version après avoir fait défiler vers le haut.",
      "Gardez le menu du niveau de réflexion disponible lorsque vous épinglez un niveau pendant qu'un tour est en cours.",
      "Gardez les champs du fournisseur d'ajout entièrement visibles et ciblés dans une fenêtre étroite.",
      "Faites correspondre le splash de démarrage de macOS avec la vitre de la barre latérale afin que la fenêtre ne fasse plus clignoter un panneau opaque."
    ]
  },
  {
    "version": "0.13.1",
    "date": "2026-09-05",
    "highlights": [
      "Insérez des puces de fixation atomiques sur la ligne de saisie du compositeur, avec une hauteur par défaut de trois lignes.",
      "Checkpoint diffuse les réponses afin qu'elles survivent à l'arrêt, à la perte du side-car et à l'arrêt sans réécrire la transcription.",
      "Masquer les réussites dans la boîte de réception de notification.",
      "Supprimez les bordures et les séparateurs d'entrée et affichez les barres de défilement uniquement au survol ou pendant le défilement.",
      "Jouez des mascottes GIF claires et sombres sur l'écran d'accueil vide."
    ]
  },
  {
    "version": "0.13.0",
    "date": "2026-09-04",
    "highlights": [
      "Ajoutez une carte de survol enrichie sur les lignes de session de la barre latérale indiquant l'espace de travail, la branche et l'heure de mise à jour.",
      "Basculez la barre latérale de macOS vers le matériau vibrant sous la fenêtre pour une profondeur de verre plus profonde.",
      "Supprimez la couture du dock de la barre latérale macOS pour un bord en verre sans bordure.",
      "Jouez à des mascottes agitant huit images spécifiques à un thème sur l'écran d'accueil vide.",
      "Correction d'un crash de la barre latérale lors du premier rendu provoqué par une variable référencée vers l'avant."
    ]
  },
  {
    "version": "0.12.4",
    "date": "2026-09-04",
    "highlights": [
      "Conservez le panneau de travail de droite à l'intérieur de la fenêtre de l'application pour que MainChat se redistribue comme la barre latérale gauche.",
      "Redimensionnez le panneau de travail à partir de son séparateur interne avec des commandes de pointeur ou de clavier tout en préservant les limites de la fenêtre.",
      "Déduplication des lectures de transcription paginées pendant le changement de session pour une navigation plus fluide.",
      "Ajoutez un traitement de surface natif de la barre latérale macOS sans modifier le comportement de mise en page de la barre latérale."
    ]
  },
  {
    "version": "0.12.3",
    "date": "2026-09-03",
    "highlights": [
      "Afficher l'utilisation du contexte par rapport à la fenêtre contextuelle publiée du modèle sélectionné.",
      "Maintenez les limites de contexte spécifiques au modèle cohérentes entre les paramètres du fournisseur, Composer et le runtime.",
      "Maintenez le guidage contextuel du Composer stable lors du changement de modèle et pendant les tours actifs."
    ]
  },
  {
    "version": "0.12.2",
    "date": "2026-09-03",
    "highlights": [
      "Correction de la ligne de message utilisateur apparaissant avant la fin de l'aller-retour de l'hôte.",
      "Effacez le brouillon d'invite avant de l'envoyer pour éviter tout contenu obsolète.",
      "Réglez les longues transcriptions sous un voile squelette pour un rendu plus fluide."
    ]
  },
  {
    "version": "0.12.1",
    "date": "2026-09-03",
    "highlights": [
      "Gardez les modèles activés pour la délégation de sous-agents disponibles après avoir enregistré les paramètres du fournisseur et redémarré l'application.",
      "Gardez les réponses en direct visibles lors de la réouverture des sessions."
    ]
  },
  {
    "version": "0.12.0",
    "date": "2026-09-02",
    "highlights": [
      "Coordonnez les sous-agents simultanés via le protocole Agent2Agent (A2A) : découvrez les homologues en cours d'exécution en tant que cartes d'agent, échangez des tâches durables et des messages saisis, et diffusez les mises à jour des tâches, en remplaçant la précédente messagerie des homologues en cours de processus."
    ]
  },
  {
    "version": "0.11.4",
    "date": "2026-09-01",
    "highlights": [
      "Publiez les programmes d'installation natifs macOS Intel DMG et ZIP parallèlement aux versions Apple Silicon.",
      "Gardez les flux de mise à jour macOS unifiés sur les deux architectures natives."
    ]
  },
  {
    "version": "0.11.3",
    "date": "2026-08-31",
    "highlights": [
      "Attribuez à chaque sous-agent son propre modèle à partir d'un catalogue de délégation ou laissez-le hériter du choix de la conversation parent.",
      "Laissez les sous-agents simultanés s'envoyer des messages grâce à des messages d'homologues filtrés par sujets et par thread.",
      "Organisez des tables rondes structurées où plusieurs sous-agents débattent d'un sujet à travers les tours et résument les résultats.",
      "Gardez les contrôles de configuration du modèle (case à cocher de délégation, section de modèle personnalisée et tailles de police) harmonisés entre les panneaux.",
      "Remplacez le texte de l'astuce de délégation par une info-bulle d'icône plus propre."
    ]
  },
  {
    "version": "0.11.2",
    "date": "2026-08-31",
    "highlights": [
      "Basculez entre les conversations récentes sans que la zone de discussion ne clignote : chacune conserve son propre volet et réapparaît exactement comme vous l'avez laissé, position de défilement incluse.",
      "Revenez à une conversation dans laquelle vous aviez fait défiler vers le haut et revenez à cet endroit, alors qu'une session ouverte pour la première fois démarre toujours à son tour le plus récent.",
      "Continuez à lire la conversation en cours pendant qu'une nouvelle se charge, au lieu de regarder la transcription s'assombrir.",
      "Réessayez une invite modifiée même si vous avez laissé le texte inchangé.",
      "Continuez à travailler sur la tâche en cours après un compactage automatique du contexte, au lieu que l'agent ne récupère une demande plus ancienne."
    ]
  },
  {
    "version": "0.11.0",
    "date": "2026-08-30",
    "highlights": [
      "Configurez un fournisseur sous une forme basée sur la découverte qui demande au service d'IA ses propres modèles avant de revenir au catalogue groupé.",
      "Choisissez un modèle dans une liste consultable qui affiche les badges de capacité et la taille du contexte, provenant du catalogue models.dev.",
      "Remplacez les capacités de pièce jointe et le niveau de réflexion par défaut par liaison de modèle, et affichez uniquement les niveaux de réflexion publiés par un modèle.",
      "Lisez une délégation de sous-agent isolée comme sa propre carte avec des lignes de cycle de vie et faites défiler une exécution de délégué étendue au lieu d'étirer la transcription.",
      "Gardez le plan de la conversation accessible pendant le chargement de l'historique et voyez un squelette au lieu d'une liste vide pendant le chargement des sessions.",
      "Collez un gros bloc de texte dans le compositeur et faites-le se répandre dans un fichier de session, en gardant la saisie en dehors du chemin de redistribution.",
      "Conservez une fenêtre là où vous l'avez déposée lorsque vous faites glisser sur les écrans et conservez la bande de la barre de titre réservée sur les pages de destination macOS.",
      "Perdez moins de tours à cause des appels de fichiers et d'outils de recherche rejetés, et à un délai d'expiration de commande donné en millisecondes."
    ]
  },
  {
    "version": "0.10.9",
    "date": "2026-08-28",
    "highlights": [
      "Gérez les compétences, les sous-agents et les serveurs MCP à partir d'un seul atelier de fonctionnalités dans Paramètres, avec des filtres de niveau, une recherche et une suppression confirmée.",
      "Gardez l'atelier de capacités et la bande supérieure des paramètres lisibles dans les deux thèmes, avec une barre d'outils correctement dimensionnée et des contrôles d'état vides.",
      "Gardez les longues conversations réactives tout en faisant défiler, en changeant de session et en survolant la mini-carte, sans que la transcription ne se mette en place.",
      "Chargez chaque ligne de transcription écrite par des versions plus anciennes au lieu d'afficher une session passée comme vide.",
      "Coupez la transcription au niveau du message que vous avez choisi lors de la régénération ou du renvoi d'une modification, et répertoriez toujours une session forkée dans la barre latérale.",
      "Jugez l'activité des sous-agents en fonction de n'importe quelle réponse, limitez les tours de chaque sous-agent intégré et signalez une attente expirée comme étant toujours en cours au lieu d'avoir échoué.",
      "Réessayez un échec transitoire du fournisseur jusqu'à quatre fois avec 1/2/4/8 s d'attente sur un budget partagé par tour, et signalez la tentative réelle à mi-parcours."
    ]
  },
  {
    "version": "0.10.8",
    "date": "2026-08-26",
    "highlights": [
      "Gardez les contrôles de fenêtre natifs de Windows isolés des actions du panneau dans l'ensemble du shell sans cadre.",
      "Offrez aux chats temporaires des espaces de travail isolés afin que leurs fichiers restent séparés du travail du projet.",
      "Restaurez l'amélioration de l'invite dans le lanceur de commandes avec une icône de modèle de bot plus claire.",
      "Révélez les barres de défilement de la barre latérale en survol tout en les gardant silencieuses au repos."
    ]
  },
  {
    "version": "0.10.7",
    "date": "2026-08-25",
    "highlights": [
      "Conservez les commandes d'envoi et d'arrêt du Composer dans un emplacement stable afin que les brouillons et les virages en cours restent alignés.",
      "Conservez l'amélioration des invites disponible à partir du lanceur de commandes sans icône de barre d'outils autonome.",
      "Rendre les barres de défilement latérales plus silencieuses au repos tout en les gardant visibles pendant la navigation."
    ]
  },
  {
    "version": "0.10.6",
    "date": "2026-08-25",
    "highlights": [
      "Afficher les capacités de réflexion pour le modèle exact sélectionné dans Composer, y compris avant la création d'une nouvelle session.",
      "Démarrez de nouvelles sessions au niveau publié le plus fort du modèle de raisonnement sélectionné."
    ]
  },
  {
    "version": "0.10.5",
    "date": "2026-08-25",
    "highlights": [
      "Gardez les contrôles de fenêtre Windows isolés des actions du panneau dans le shell sans cadre.",
      "Ouvrez les dossiers et fichiers de projet Windows de manière fiable, y compris les chemins avec le préfixe de longueur étendue.",
      "Modifiez les fichiers CRLF sans modifier leur style de fin de ligne d'origine."
    ]
  },
  {
    "version": "0.10.4",
    "date": "2026-08-25",
    "highlights": [
      "Afficher uniquement les modèles de fournisseur configurés dans le sélecteur de conversation, tout en gardant les modèles enregistrés disponibles lorsque la découverte n'est pas disponible.",
      "Gardez la bande de contrôle de la fenêtre sans cadre opaque afin que le contenu de la page ne s'affiche jamais via les contrôles natifs.",
      "Maintenez la largeur de la discussion stable lorsque le panneau de travail est ouvert et restaurez les limites de la fenêtre de discussion uniquement après son effondrement."
    ]
  },
  {
    "version": "0.10.3",
    "date": "2026-08-25",
    "highlights": [
      "Améliorez l'amélioration des invites ponctuelles afin de conserver intactes les références de brouillon et de fichier actuelles.",
      "Gardez les actions d'envoi et d'arrêt du compositeur alignées sur le brouillon visible et la session en cours.",
      "Préservez les métadonnées de délégation en arrière-plan pendant les tours de TaskWait et les rechargements du moteur de rendu.",
      "Conservez l'historique et la transcription des sessions forked disponibles immédiatement après le branchement."
    ]
  },
  {
    "version": "0.10.2",
    "date": "2026-08-24",
    "highlights": [
      "Gardez le contenu du chat et le compositeur confortablement centrés lorsque la barre latérale est réduite.",
      "Préparez des pièces jointes volumineuses sans charger l'intégralité du fichier en mémoire, y compris lors de la relecture de l'historique."
    ]
  },
  {
    "version": "0.10.1",
    "date": "2026-08-24",
    "highlights": [
      "Mettez en file d'attente les invites envoyées lorsqu'une exécution est active et diffusez-les dans l'ordre sans perdre le brouillon en cours.",
      "Sous-agents d'arrière-plan liés avec des délais d'inactivité et de durée totale et affichés lorsqu'un délégué expire.",
      "Chargez de longs historiques de sessions dans des pages délimitées et récupérez les messages précédents au fur et à mesure que vous faites défiler vers le haut."
    ]
  },
  {
    "version": "0.10.0",
    "date": "2026-08-21",
    "highlights": [
      "Configurez plusieurs modèles par fournisseur et basculez entre eux directement depuis le compositeur.",
      "Gérez les capacités des agents dans un studio de paramètres repensé avec des blocs de portée et des menus plus clairs.",
      "Exposez l'historique du presse-papiers de l'hôte aux plugins en tant que nouvelle fonctionnalité.",
      "Gardez les sessions vides durables afin qu'elles puissent être affichées et réutilisées après la relance.",
      "Rendre le sélecteur de modèles plus facile à utiliser avec une hiérarchie de fournisseurs plus claire et un défilement régulier.",
      "Indiquez toujours le nombre total de lignes dans les résultats de lecture afin que les fichiers volumineux puissent être paginés de manière fiable.",
      "Récupérez les flux à débit limité de manière plus fiable lors des tentatives.",
      "Révélez les fichiers sélectionnés dans le gestionnaire de fichiers lorsque vous les ouvrez à partir du panneau Fichiers."
    ]
  },
  {
    "version": "0.9.1",
    "date": "2026-08-20",
    "highlights": [
      "Faites en sorte que les icônes de projet épinglées soient distinctes afin qu'elles soient plus faciles à reconnaître dans la barre latérale.",
      "Empêcher l'activité du sous-agent de rester bloquée en cours d'exécution une fois qu'elle est terminée.",
      "Alignez plus étroitement les pages et les panneaux du plugin avec le reste du chrome de l'application.",
      "Réduisez la saisie et la latence d'envoi dans le compositeur.",
      "Faites défiler les longues transcriptions plus facilement et évitez les flashs lorsque vous changez de session.",
      "Restaurez la ligne de support de la maison vide et la disposition du compositeur alignée en bas."
    ]
  },
  {
    "version": "0.9.0",
    "date": "2026-08-20",
    "highlights": [
      "Parcourez les fichiers de projet dans le panneau Fichiers fourni et ouvrez-les avec l'application par défaut du système d'exploitation.",
      "Ajoutez des vues isolées fournies par le plugin au panneau de travail et gardez visibles la provenance du marché et le statut de la version retirée.",
      "Supprimez le terminal interactif intégré tout en conservant la sortie Bash dans la conversation et les shells interactifs dans le terminal externe.",
      "Limites de taux de tentatives du fournisseur en place sans messages d'assistant en double, puis proposez Continuer lorsque le budget de nouvelle tentative est épuisé.",
      "Utilisez un résumé contextuel compact pour voir d'un seul coup d'œil l'utilisation du modèle, des outils, du cache et du compactage.",
      "Enseignez les cinq commandes principales de la session via des astuces de commandes slash localisées dans le compositeur.",
      "Gardez les compositeurs de la maison et des conversations alignés tandis que leurs conseils de bienvenue et de commande tournent en douceur."
    ]
  },
  {
    "version": "0.8.1",
    "date": "2026-08-19",
    "highlights": [
      "Connectez-vous à plusieurs comptes de fournisseurs et choisissez le compte utilisé pour chaque fournisseur.",
      "Utilisez les capacités de chaque modèle pour décider quand les pièces jointes d'images sont prises en charge.",
      "Choisissez l'effort de raisonnement directement auprès du compositeur pour les modèles qui l'exposent.",
      "Conservez une instance PI-Desktop par répertoire de données pour éviter les sessions conflictuelles.",
      "Organisez les paramètres en groupes plus clairs et simplifiez la gestion des comptes des fournisseurs.",
      "Gardez les sous-agents intégrés alignés sur le mode d'autorisation de la conversation parent."
    ]
  },
  {
    "version": "0.8.0",
    "date": "2026-08-17",
    "highlights": [
      "Déléguez les sous-agents d'arrière-plan et attendez leurs résultats sans bloquer la conversation.",
      "Augmentez le nombre maximum de sous-agents en cours d'exécution à 10 et appliquez la portée d'autorisation de chaque agent au travail délégué.",
      "Ajoutez des sous-agents explorateur et fixateur intégrés pour les tâches courantes en arrière-plan.",
      "Demandez une fois si la fermeture de la fenêtre doit être réduite au plateau ou quitter, puis rappelez-vous le choix.",
      "Laissez les panneaux de plugins suivre la langue et le mode couleur de l'application.",
      "Réessayez les erreurs de limite de débit à mi-parcours dans le même tour au lieu d'arrêter la réponse.",
      "Récupérez les exécutions du plan approuvées après une interruption du side-car.",
      "Empêchez les avis d'accident de side-car de briser une vitre déjà disparue."
    ]
  },
  {
    "version": "0.7.0",
    "date": "2026-08-15",
    "highlights": [
      "Restreindre l'accès aux fichiers du plugin à la portée de fichier déclarée de chaque plugin et envoyer les fichiers supprimés à la corbeille pour une récupération facile.",
      "Afficher la portée du fichier déclaré de chaque plugin à côté de ses autorisations.",
      "Confinez les requêtes réseau des plugins à la liste autorisée de domaine déclarée de chaque plugin.",
      "Transférez les canaux inconnus du panneau de plug-in vers le plug-in afin que des intégrations plus approfondies continuent de fonctionner.",
      "Empêche la réduction de la barre latérale de scintiller lorsqu'elle est activée.",
      "Ancrez les modifications de l'agent sur une ligne afin qu'une modification interrompue soit récupérée correctement au lieu de terminer le tour en silence.",
      "Harmonisez la hiérarchie typographique des cartes pour une interface plus cohérente.",
      "Mettez à niveau le shell du bureau et le runtime de l'agent vers les dernières versions d'Electron et de pi."
    ]
  },
  {
    "version": "0.6.0",
    "date": "2026-08-14",
    "highlights": [
      "Ouvrez l'inspecteur d'utilisation du contexte en cliquant pour voir les statistiques des jetons et du cache.",
      "Basculez la visibilité du panneau de travail avec un nouveau raccourci clavier.",
      "Conservez les brouillons de nouvelles tâches hors de l'historique jusqu'à l'envoi du premier message.",
      "Ajoutez un sélecteur de polices global personnalisé avec des polices OFL groupées pour une typographie personnalisée.",
      "Mémorisez les plugins récemment utilisés dans le lanceur pour un accès plus rapide.",
      "Ajoutez le chemin de la session de copie au menu contextuel pour le mode développeur.",
      "Correction des problèmes d'écrêtage du sélecteur de polices et de réinitialisation du système par défaut.",
      "Conservez macOS PI-Desktop dans le Dock et Cmd+Tab après la fermeture de la fenêtre.",
      "Gardez la transcription du chat épinglée lorsque le compositeur s'effondre après l'envoi.",
      "Donnez au panneau de travail un véritable état vide avec des conseils plus clairs."
    ]
  },
  {
    "version": "0.5.11",
    "date": "2026-08-13",
    "highlights": [
      "Ajoutez une disponibilité hors ligne et une actualisation des métadonnées pour le marché des plugins.",
      "Mettez en cache les brouillons du compositeur par conversation pour une récupération de session plus rapide.",
      "Localisez les titres des panneaux du plugin et adaptez le chrome de la fenêtre du panneau.",
      "Correction de la couleur des touches de la mascotte sur les surfaces sombres.",
      "Réduisez la latence des raccourcis du lanceur macOS pour des interactions plus rapides."
    ]
  },
  {
    "version": "0.5.10",
    "date": "2026-08-13",
    "highlights": [
      "Affinez le chrome de la fenêtre du panneau du plugin et les zones de sécurité afin que le contenu du plugin reste à l'écart des contrôles natifs.",
      "Améliorez la hiérarchie des pages Plugins et réduisez la copie de présentation pour un flux de travail d'extension plus clair.",
      "Utilisez l'icône de modèle de barre d'état macOS correcte pour une apparence plus nette de la barre de menus."
    ]
  },
  {
    "version": "0.5.9",
    "date": "2026-08-13",
    "highlights": [
      "Faites en sorte que le mode Objectif utilise la gestion automatique des autorisations pour un flux de travail plus cohérent.",
      "Préchauffez le lanceur global de plugins pour qu'il s'ouvre plus rapidement, y compris lorsqu'une autre application est ciblée.",
      "Donnez aux panneaux de plugins un chrome de fenêtre natif avec des contrôles fiables de réduction, d'agrandissement et de fermeture.",
      "Actualisez le site de documentation bilingue avec des guides et spécifications complets en anglais et en chinois simplifié."
    ]
  },
  {
    "version": "0.5.8",
    "date": "2026-08-12",
    "highlights": [
      "Restaurez le lanceur global de plug-in Windows Alt+Space, y compris lorsqu'une autre application est ciblée.",
      "Gardez PI-Desktop disponible dans la barre d'état système lorsqu'il est réduit sur macOS, Windows et Linux.",
      "Améliorez la lisibilité du menu de sélection natif dans les thèmes clairs et sombres."
    ]
  },
  {
    "version": "0.5.7",
    "date": "2026-08-12",
    "highlights": [
      "Ajoutez des questions Asktool avec des réponses personnalisées à sélection unique, à sélection multiple, des flux de saut et de refus.",
      "Gardez visible la progression de plusieurs questions avec des indicateurs de réponses, de réponses sans réponse et de sauts.",
      "Placez les questions interactives dans la même surface d'approbation du compositeur que les approbations du plan et des objectifs.",
      "Simplifiez les cartes d'approbation et mémorisez le mode d'approbation sélectionné pour la prochaine demande."
    ]
  },
  {
    "version": "0.5.6",
    "date": "2026-08-11",
    "highlights": [
      "Ouvrez les plugins installés à partir d'un lanceur de clavier global sans quitter l'espace de travail actuel.",
      "Réduisez les informations détaillées sur la réflexion, les outils et les sous-agents pour que les longues conversations restent lisibles.",
      "Gardez la configuration des tâches disponible pendant les tours actifs et affichez les statistiques de débit après l'arrêt.",
      "Affinez la hiérarchie des coins dans l'interface pour un regroupement visuel plus clair."
    ]
  },
  {
    "version": "0.5.5",
    "date": "2026-08-11",
    "highlights": [
      "Visualisez les sous-agents parallèles et leurs relations entre les tâches directement dans la conversation.",
      "Gardez les références de fichiers collées compactes et restaurez leurs puces après l'arrêt d'un tour.",
      "Conserver les contrôles de mode disponibles lors de la création de la session et la transcription épinglée après l'envoi.",
      "Récupérez plus facilement lorsque les outils natifs reçoivent un chemin de fichier incorrect.",
      "Améliorez les actions du pied de page de la barre latérale et les liens intégrés dans les messages des utilisateurs."
    ]
  },
  {
    "version": "0.5.4",
    "date": "2026-08-08",
    "highlights": [
      "Affinez la mascotte de la maison vide avec des changements de pose au repos plus lents et une lecture continue en survol."
    ]
  },
  {
    "version": "0.5.0",
    "date": "2026-08-07",
    "highlights": [
      "Exécutez des sous-agents limités derrière un outil de tâches, avec des agents définis par l'utilisateur, des modèles épinglés, une attribution et une persistance de session.",
      "Gérez les sous-agents des extensions avec des recharges de registre et un statut de lecture seule plus clair.",
      "Préparez et installez des points de contrôle contextuels pendant les temps d'inactivité tout en préservant l'historique des transcriptions et en affichant les lignes de compactage et les avertissements.",
      "Ajoutez le mode Objectif comme deuxième mode de contrat et conservez les références de fichiers collées via les commandes de mode.",
      "Restaurez les sous-agents et les panneaux sauvegardés par l'hôte lorsque l'hôte se reconnecte, avec des diagnostics de démontage de routine plus silencieux.",
      "Polissez les surfaces du panneau de travail et des extensions avec des métadonnées, des commandes et un contraste de thème sombre plus clairs."
    ]
  },
  {
    "version": "0.4.3",
    "date": "2026-08-05",
    "highlights": [
      "Complétez le flux de travail du plan Agent uniquement avec des points de contrôle Markdown durables, une approbation et une exécution en file d'attente.",
      "Ajoutez des serveurs MCP et des compétences à l'échelle du projet avec un contrôle de portée d'extensions.",
      "Renforcez les autorisations de chemin externe et la portée de la recherche native dans les espaces de travail.",
      "Fermez les surfaces d'approbation du plan après que les commandes de résolution et de mode ont commuté la session active.",
      "Les longues conversations se compactent automatiquement : la transcription conserve chaque message, marque l'endroit où chaque compactage a eu lieu et vous avertit afin que vous puissiez décider de démarrer ou non une nouvelle session."
    ]
  },
  {
    "version": "0.4.2",
    "date": "2026-08-03",
    "highlights": [
      "Afficher le taux de réussite du cache contextuel dans l'en-tête de la transcription du chat pour une meilleure transparence."
    ]
  },
  {
    "version": "0.4.1",
    "date": "2026-08-02",
    "highlights": [
      "Mettez à jour les versions de GitHub et mettez à jour automatiquement les liens vers le référentiel canonique PI-Desktop.",
      "Actualisez la documentation du projet, du plug-in et de la version pour utiliser le nom du référentiel PI-Desktop."
    ]
  },
  {
    "version": "0.4.0",
    "date": "2026-08-01",
    "highlights": [
      "Les plugins peuvent désormais apporter des compétences, des thèmes, des serveurs MCP, des services résidents et un bus de messages inter-plugin.",
      "Le SDK du plugin déclare tous les nouveaux types de fonctionnalités afin que les auteurs puissent les activer à partir du manifeste.",
      "Le noyau de l'hôte valide les contributions aux capacités et dérive automatiquement les autorisations par plugin.",
      "L'invite système de l'agent inclut désormais les compétences déclarées par le plugin pour les conversations prenant en charge les outils.",
      "Page des plugins repensée avec un sélecteur de modèles, un rechargement à chaud lors de la sauvegarde et des outils de création.",
      "La création d'un plugin à partir d'un modèle ouvre désormais le dossier échafaudé en tant que projet.",
      "Menu d'en-tête du panneau de travail unifié avec des commandes plus claires et des actions contextuelles.",
      "Styles divisés en partiels par surface ; CSS en double et mort supprimé."
    ]
  },
  {
    "version": "0.3.0",
    "date": "2026-07-31",
    "highlights": [
      "L'archive du projet Paramètres affiche désormais les sections groupées (Épinglé/Tout/Archivé) avec le nombre par section, la recherche en direct et les contrôles de tri.",
      "La largeur du quai du panneau de travail est plus étroite pour de meilleures proportions de disposition.",
      "Correction du style du commutateur sur la piste dans le thème clair."
    ]
  },
  {
    "version": "0.2.11",
    "date": "2026-07-31",
    "highlights": [
      "La recherche globale trouve désormais les discussions, les pages, les paramètres et les commandes intégrées ou de plug-in en un seul endroit.",
      "Les contrôles d'apparence utilisent désormais des cartes d'aperçu de thème et de langue, avec une langue automatique suivant correctement les paramètres régionaux du système d'exploitation.",
      "Les paramètres comportent désormais des sections dédiées à l'IA et aux raccourcis pour une navigation plus claire.",
      "L'agent charge désormais les instructions du projet AGENTS.md/CLAUDE.md en couches, avec des éditeurs pour AGENTS.md globaux et du projet.",
      "L'archive du projet recherche désormais les titres de session et affiche l'activité la plus récente en premier, le nombre de sessions, les horodatages et l'historique extensible.",
      "Correction d'un échec de démarrage du bureau causé par la régression de préchargement en bac à sable.",
      "Réduisez d'environ 55 % l'empreinte des applications décompressées macOS auditées tout en conservant la coloration syntaxique hors ligne et la prise en charge native des terminaux."
    ]
  },
  {
    "version": "0.2.10",
    "date": "2026-07-30",
    "highlights": [
      "Ajoutez une barre supérieure de conversation de style Codex/WorkBuddy avec des commandes améliorées.",
      "Actualisez la transcription du chat et le style de prose markdown pour une meilleure lisibilité.",
      "Unifiez l'en-tête du panneau de travail avec le menu contextuel et animez le réduction de la barre latérale.",
      "Combinez les lanceurs d'outils en une seule liste déroulante pour une interface plus propre.",
      "Ancrez le panneau de travail à l'intérieur d'une fenêtre fixe au lieu de l'agrandir.",
      "Améliorer les contrôles de la barre supérieure : bascule de déduplication, protection des contrôles, alignement macOS."
    ]
  },
  {
    "version": "0.2.8",
    "date": "2026-07-29",
    "highlights": [
      "Les invites et paramètres de mise à jour ouvrent désormais les notes de version localisées complètes.",
      "Les animations d'expansion et de réduction du panneau de travail sont plus fluides.",
      "Les longues conversations compactent de manière plus fiable les lots de résultats d'outils surdimensionnés."
    ]
  },
  {
    "version": "0.2.7",
    "date": "2026-07-28",
    "highlights": [
      "Les réponses Markdown peuvent restituer les images, l'audio et la vidéo en ligne.",
      "Les images distantes s'affichent avec une politique de sécurité du contenu mise à jour.",
      "Le balisage des médias est nettoyé afin que seules les balises sûres soient autorisées."
    ]
  },
  {
    "version": "0.2.6",
    "date": "2026-07-28",
    "highlights": [
      "Les points de contrôle contextuels aux limites de virage compactent les longues discussions sans masquer l'historique.",
      "Changement de conversation plus fluide avec des transcriptions mises en cache et un cadre stable.",
      "Les outils ancrés conservent une largeur fixe afin que le chat reste lisible à côté du panneau de travail.",
      "Le menu Projet peut ouvrir le dossier dans votre gestionnaire de fichiers système.",
      "Les lignes d'invite du compositeur n'affichent plus d'icône de marque principale."
    ]
  },
  {
    "version": "0.2.5",
    "date": "2026-07-28",
    "highlights": [
      "Navigation dans le panneau de travail repensée avec un rail d'outils plus clair.",
      "Le redimensionnement des fenêtres s'effectue en fonction des panneaux, de sorte que la disposition reste prévisible.",
      "Les rendus en streaming sont isolés pour une interaction plus vive.",
      "Les nouvelles séances de raisonnement utilisent par défaut la réflexion maximale lorsqu'elles sont disponibles.",
      "La transcription reste épinglée au dernier message après son envoi."
    ]
  },
  {
    "version": "0.2.4",
    "date": "2026-07-28",
    "highlights": [
      "Les puces Composer gardent les descendeurs entièrement visibles.",
      "Pi-ai mis à jour pour les nouveaux modèles Claude, y compris le support Opus 5."
    ]
  },
  {
    "version": "0.2.3",
    "date": "2026-07-28",
    "highlights": [
      "Copie du shell réécrite dans un langage utilisateur simple dans tous les paramètres régionaux.",
      "Sélection, étiquettes CJK et polissage du mouvement de survol.",
      "Surfaces lumineuses du panneau de travail et des paramètres raffinées.",
      "Les installations préliminaires découvrent désormais les nouvelles versions stables de GitHub."
    ]
  },
  {
    "version": "0.2.2",
    "date": "2026-07-27",
    "highlights": [
      "Marché de plugins avec catalogue à distance officiel et volets de détails.",
      "Panneaux de plugins isolés et API fermées à haut risque.",
      "Cliquez avec le bouton droit sur les barres d'outils de section pour créer des projets ou des sessions.",
      "Splash de démarrage, mouvement plus fluide et polissage i18n.",
      "La navigation supérieure du panneau de travail prend en charge le clic droit pour ouvrir les outils."
    ]
  },
  {
    "version": "0.2.1",
    "date": "2026-07-27",
    "highlights": [
      "Les outils du panneau de travail sont conservés par conversation.",
      "L'entrée de révision est limitée à la session qui a effectué les modifications."
    ]
  },
  {
    "version": "0.2.0",
    "date": "2026-07-27",
    "highlights": [
      "La barre latérale sépare les projets et les sessions avec un statut de tâche plus clair.",
      "Forkez ou modifiez les réponses de l'assistant ; barres d'outils de message composées uniquement d'icônes.",
      "Entrée de révision de l'espace de travail après des modifications de fichier réussies.",
      "Mappages de raccourcis clavier et mode développeur pour DevTools.",
      "Le catalogue de modèles pi est l'autorité pour les modèles de fournisseurs.",
      "Le contrôle de réflexion se trouve à côté du mode dans le compositeur."
    ]
  },
  {
    "version": "0.1.1",
    "date": "2026-07-26",
    "highlights": [
      "Première version publique : premier client de bureau local d'agent de codage d'IA.",
      "Modes Chat et Agent avec streaming, niveaux de réflexion et gestion des modèles.",
      "Outils d'espace de travail avec contrôle des autorisations, terminal, navigateur et révision git.",
      "Noyau de l'hôte Rust pour le stockage, les secrets, les sessions et les notifications.",
      "Fondation du plugin et double interface utilisateur anglais/简体中文.",
      "Vérifications des mises à jour par rapport aux versions de GitHub (dans l'application si elles sont prises en charge)."
    ]
  }
];
