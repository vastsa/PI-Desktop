import type { ChangelogEntry } from "./changelog.js";

export const deEntries: ChangelogEntry[] = [
  {
    "version": "0.14.6",
    "date": "2026-09-10",
    "highlights": [
      "Warnt, wenn diese Version älter ist als Ihre lokalen Daten oder die Intel-Version auf Apple Silicon läuft, statt stumm zu scheitern.",
      "Fügt eine lokale MCP-Desktop-Steuerebene hinzu; geprüfte Plugins steuern den Desktop nur nach nativer Zustimmung.",
      "Fügt Subagent-Vorlagen, eine anbietergebundene Modellauswahl und die effektive Denkstufe auf Delegationskarten hinzu.",
      "Konfigurierte Modelle mit Alias versehen, Modell-IDs kopieren und das modell-eigene Wire-API vor dem Anbieterstil bevorzugen.",
      "Ersetzt textuelles Edit-Matching durch zeilenverankerte Operationen mit fehlerspezifischen Wiederherstellungshinweisen.",
      "Wiederholt Anbieteranfragen bis zu zehnmal mit sichtbarem Countdown und setzt autonome Fortschrittsrunden fort.",
      "Neu gestalteter macOS-Installer, portable Windows-Exe und Linux-RPM-Paket, GNOME-Tray- und Dock-Symbole wiederhergestellt.",
      "Konversations-IDs kopieren und Sitzungsordner aus der Seitenleiste öffnen, mit lokalisierten Tooltips für Symbolaktionen.",
      "Zeigt Live-Prozessstatus und ruhige Intervalle in der Aktivitätszeile und fügt einen fixierten Arbeitsbereich-Umschalter hinzu.",
      "Erzwingt Ignore-Regeln im Arbeitsbereich, löst hängende Symlinks auf und prüft Plugin-Netzwerkausgang bei jeder Umleitung neu.",
      "Beachtet Proxy-Bypass-Regeln, behält eingefügte Private-Use-Glyphen und lädt Dateivorschauen ohne den Editor zu blockieren.",
    ],
  },
  {
    "version": "0.14.5",
    "date": "2026-09-09",
    "highlights": [
      "Kennzeichnen Sie jedes macOS-DMG und jede ZIP-Datei mit der nativen arm64- oder x64-Architektur."
    ]
  },
  {
    "version": "0.14.4",
    "date": "2026-09-09",
    "highlights": [
      "Fügen Sie begrenzte Bereichslesevorgänge für große Dateien und an echte Zieh-und-Ablegen-Gesten gebundene Dateifreigaben für Plugins hinzu.",
      "Verlangen Sie für macOS-Signierung und Notarisierung eine ausdrückliche Aktivierung und liefern Sie Hinweise zum Öffnen vertrauenswürdiger unsignierter Builds."
    ]
  },
  {
    "version": "0.14.3",
    "date": "2026-09-09",
    "highlights": [
      "Kennzeichnen Sie Intel-macOS-Downloads eindeutig, damit die Architektur des Installationsprogramms klar erkennbar ist."
    ]
  },
  {
    "version": "0.14.2",
    "date": "2026-09-08",
    "highlights": [
      "Fügen Sie einen Kontextverbrauch-Inspektor hinzu, der dem ausgewählten Modell folgt und Hinweise zur Komprimierung anzeigt.",
      "Verbessern Sie die Anbieter- und Modelleinstellungen mit durchsuchbarer Auswahl, Sammelaktionen und klareren Abruffehlern.",
      "Fassen Sie Sitzungstitel automatisch zusammen und erlauben Sie dauerhafte Projektnamen.",
      "Überarbeiten Sie das Subagent-Seitenpanel mit Live-Status, kompakten Aufgabenblasen, Modellinformationen und Navigation zur neuesten Ausgabe.",
      "Senden Sie native Benachrichtigungen für interaktive Fragen und Freigaben, während normale Abschlüsse aus dem Posteingang fernbleiben.",
      "Fügen Sie eine koreanische Oberflächenlokalisierung hinzu und verbessern Sie lokalisierte Einstellungen, Zwischenablageverlauf und sichere Links.",
    ]
  },
  {
    "version": "0.14.1",
    "date": "2026-09-08",
    "highlights": [
      "Ermöglichen Sie die Vererbung des Elternmodells für Subagenten, wenn kein Delegationsmodell konfiguriert ist.",
      "Verhindern Sie, dass zurückgegebene IDs des Elternmodells fälschlich als nicht verfügbare Delegationsmodelle abgelehnt werden.",
    ]
  },
  {
    "version": "0.14.0",
    "date": "2026-09-08",
    "highlights": [
      "Konfigurieren Sie ausgehende HTTP-Proxys pro Anbieter, einschließlich Validierung und klarer Behandlung nicht unterstützter SOCKS4-Anmeldedaten.",
      "Importieren Sie Anbieterprofile und Modellkonfigurationen aus CC Switch und lokalen Agentenspeichern.",
      "Fügen Sie benutzerdefinierte Anbieter-Header und User-Agent-Einstellungen sowie ein MiniMax-Voreinstellung hinzu, mit klareren Fehlern beim Abruf von Modellen.",
      "Hängen Sie Dateien über den einheitlichen Dateiauswahldialog an, mit Kopien im Sitzungsspeicher und Unterstützung für Inline-Bilder.",
      "Fügen Sie die Benutzeroberflächen für traditionelles Chinesisch, Deutsch, Spanisch und Französisch sowie durchsuchbare Erscheinungsbild- und Anbietereinstellungen hinzu.",
      "Passen Sie Leseschriftgrößen, Typografie und Symbole einheitlich an und zeigen Sie das ausgewählte Subagent-Modell in Delegationskarten an.",
    ]
  },
  {
    "version": "0.13.11",
    "date": "2026-09-07",
    "highlights": [
      "Ermöglichen Sie Plugins, Modelle aufzulisten, den Sitzungskontext während der Übertragung zu lesen und hosteigene Vervollständigungen anzufordern, ohne Anmeldeinformationen zu erhalten."
    ]
  },
  {
    "version": "0.13.10",
    "date": "2026-09-07",
    "highlights": [
      "Bestätigen Sie vor dem Beenden (Befehl+Q, Taskleiste oder Menü), um versehentlichen Datenverlust zu verhindern."
    ]
  },
  {
    "version": "0.13.9",
    "date": "2026-09-06",
    "highlights": [
      "Versionssprung für die Release-Infrastruktur."
    ]
  },
  {
    "version": "0.13.8",
    "date": "2026-09-06",
    "highlights": [
      "Suchen Sie nach Projektdateien, einschließlich Bildern, zeigen Sie eine Vorschau an und öffnen Sie sie dann mit der Standard-App auf einer speziellen Viewer-Seite.",
      "Führen Sie den Work-Panel-Browser als gebündeltes Plugin aus, mit der gleichen Isolation wie andere Plugin-Ansichten.",
      "Behalten Sie die @-Datei-Chips nach der Eingabetaste bei und aktivieren Sie den Modus-Chip während der Planung.",
      "Öffnen Sie nur http(s)- und Mailto-Links aus Chat, Plugins und Vorschauen."
    ]
  },
  {
    "version": "0.13.7",
    "date": "2026-09-06",
    "highlights": [
      "Behalten Sie abgeschlossene KI-Antworten nach dem Neustart bei, anstatt nur die Benutzernachrichten anzuzeigen.",
      "Lassen Sie Hintergrund-Subagenten laufen, bis Sie sie stoppen oder der übergeordnete Agent sie stoppt.",
      "Lassen Sie den Agenten ein Bash-Timeout von bis zu sechs Stunden wählen, damit lange Jobs nicht nach 60 Sekunden beendet werden."
    ]
  },
  {
    "version": "0.13.6",
    "date": "2026-09-06",
    "highlights": [
      "Passen Sie die Größe der Benutzernachrichten in eingefügte Dateien an ihren Inhalt an, anstatt sie über den gesamten Thread zu verteilen."
    ]
  },
  {
    "version": "0.13.5",
    "date": "2026-09-06",
    "highlights": [
      "Entfernen Sie den A2A-Broker und die Peer-to-Peer-Konversationstools.",
      "Behebung von Agent-Laufzeittests, die nach der A2A-Entfernung fehlschlugen."
    ]
  },
  {
    "version": "0.13.4",
    "date": "2026-09-05",
    "highlights": [
      "Fügen Sie Türkisch und eine durchsuchbare Sprachauswahl unter Einstellungen → Allgemein hinzu.",
      "Machen Sie das Thema zu einer durchsuchbaren Auswahl-ähnlichen Sprache, einschließlich Plugin-Themen.",
      "Reduzieren Sie die Liste der Add-Provider-Dienste, fügen Sie Xiaomi, Zhipu und Z.AI hinzu und machen Sie den Dienst durchsuchbar.",
      "Melden Sie ein Problem über Einstellungen → Informationen, wobei Version und Betriebssystem bereits ausgefüllt sind.",
      "Streamen Sie die Gesprächsrunden weiterhin in chronologischer Reihenfolge, wenn das Live-Transkript zusammengeführt wird."
    ]
  },
  {
    "version": "0.13.3",
    "date": "2026-09-05",
    "highlights": [
      "Neue Aufgabe sofort an einem leeren Ziel öffnen, ohne dass das vorherige Transkript auf dem Bildschirm bleibt.",
      "Behandeln Sie ein gefülltes Lesefenster als vollständig und behalten Sie den abgeschnittenen Chip für tatsächliche Schnitte.",
      "Behalten Sie spätere Konversationsrunden bei, wenn Sie die Neugenerierungsvariante wechseln, anstatt ein veraltetes Archiv wiederherzustellen."
    ]
  },
  {
    "version": "0.13.2",
    "date": "2026-09-05",
    "highlights": [
      "Behalten Sie nicht gesendete Composer-Entwürfe, einschließlich Dateichips, bei, wenn die Eingabe erneut bereitgestellt oder das Fenster ausgeblendet wird.",
      "Starten Sie neue Sitzungen auf der Standard-Denkebene der Modellbindung, anstatt immer die stärkste zu verwenden.",
      "Erweiterte Subagentenausführungen werden bis zur neuesten Ausgabe gescrollt, mit einem Steuerelement „Zur neuesten Version springen“, nachdem Sie nach oben gescrollt haben.",
      "Halten Sie das Denkebenenmenü verfügbar, wenn Sie eine Ebene während einer laufenden Runde fixieren.",
      "Halten Sie die Add-Provider-Felder in einem schmalen Fenster vollständig sichtbar und fokussiert.",
      "Passen Sie den macOS-Startup-Splash an das Seitenleistenglas an, damit im Fenster kein undurchsichtiges Panel mehr blinkt."
    ]
  },
  {
    "version": "0.13.1",
    "date": "2026-09-05",
    "highlights": [
      "Fügen Sie atomare Anhangschips in der Composer-Eingabezeile mit einer Standardhöhe von drei Zeilen ein.",
      "Checkpoint-Streaming-Antworten, damit sie Quit, Sidecar-Verlust und Stop überstehen, ohne das Transkript neu zu schreiben.",
      "Erfolgreiche Abschlüsse im Benachrichtigungseingang ausblenden.",
      "Entfernen Sie Einlaufränder und Trennlinien und zeigen Sie Bildlaufleisten nur beim Schweben oder beim Scrollen an.",
      "Spielen Sie helle und dunkle GIF-Maskottchen auf dem leeren Startbildschirm ab."
    ]
  },
  {
    "version": "0.13.0",
    "date": "2026-09-04",
    "highlights": [
      "Fügen Sie in den Sitzungszeilen der Seitenleiste eine umfangreiche Hover-Karte hinzu, die Arbeitsbereich, Zweig und Aktualisierungszeit anzeigt.",
      "Schalten Sie die macOS-Seitenleiste auf das Lebendigkeitsmaterial unter dem Fenster um, um eine größere Glastiefe zu erzielen.",
      "Entfernen Sie die Dock-Naht der macOS-Seitenleiste, um eine randlose Glaskante zu erhalten.",
      "Spielen Sie themenspezifische winkende Maskottchen mit acht Bildern auf dem leeren Startbildschirm.",
      "Behebung eines Absturzes der Seitenleiste beim ersten Rendern, der durch eine vorwärtsreferenzierte Variable verursacht wurde."
    ]
  },
  {
    "version": "0.12.4",
    "date": "2026-09-04",
    "highlights": [
      "Behalten Sie das rechte Arbeitsfeld im Anwendungsfenster, damit MainChat wie die linke Seitenleiste umfließt.",
      "Ändern Sie die Größe des Arbeitsfelds von seiner inneren Trennlinie aus mit Zeiger- oder Tastatursteuerungen unter Beibehaltung der Fenstergrenzen.",
      "Deduplizieren Sie seitenweise gelesene Transkripte während des Sitzungswechsels für eine reibungslosere Navigation.",
      "Fügen Sie eine native macOS-Oberflächenbehandlung für die Seitenleiste hinzu, ohne das Layoutverhalten der Seitenleiste zu ändern."
    ]
  },
  {
    "version": "0.12.3",
    "date": "2026-09-03",
    "highlights": [
      "Zeigt die Kontextverwendung im veröffentlichten Kontextfenster des ausgewählten Modells an.",
      "Sorgen Sie dafür, dass modellspezifische Kontextgrenzen über die Anbietereinstellungen, den Composer und die Laufzeit hinweg konsistent bleiben.",
      "Halten Sie die kontextbezogene Führung des Composer beim Modellwechsel und während aktiver Runden stabil."
    ]
  },
  {
    "version": "0.12.2",
    "date": "2026-09-03",
    "highlights": [
      "Problem behoben, bei dem die Benutzernachrichtenzeile angezeigt wurde, bevor der Host-Roundtrip abgeschlossen war.",
      "Löschen Sie die Entwurfsaufforderung vor dem Senden, um veraltete Inhalte zu verhindern.",
      "Legen Sie lange Transkripte für eine reibungslosere Wiedergabe unter einen Skelettschleier."
    ]
  },
  {
    "version": "0.12.1",
    "date": "2026-09-03",
    "highlights": [
      "Halten Sie die für die Subagentendelegierung aktivierten Modelle verfügbar, nachdem Sie die Anbietereinstellungen gespeichert und die App neu gestartet haben.",
      "Halten Sie Live-Antworten sichtbar, wenn Sie Sitzungen erneut öffnen."
    ]
  },
  {
    "version": "0.12.0",
    "date": "2026-09-02",
    "highlights": [
      "Koordinieren Sie gleichzeitige Subagenten über das Agent2Agent (A2A)-Protokoll: Erkennen Sie laufende Peers als Agentenkarten, tauschen Sie dauerhafte Aufgaben und eingegebene Nachrichten aus und streamen Sie Aufgabenaktualisierungen – ersetzen Sie die bisherige prozessinterne Peer-Nachrichtenübermittlung."
    ]
  },
  {
    "version": "0.11.4",
    "date": "2026-09-01",
    "highlights": [
      "Veröffentlichen Sie native macOS Intel DMG- und ZIP-Installationsprogramme neben Apple Silicon-Builds.",
      "Halten Sie die macOS-Updater-Feeds in beiden nativen Architekturen einheitlich."
    ]
  },
  {
    "version": "0.11.3",
    "date": "2026-08-31",
    "highlights": [
      "Weisen Sie jedem Subagenten sein eigenes Modell aus einem Delegationskatalog zu oder lassen Sie ihn die Auswahl der übergeordneten Konversation erben.",
      "Ermöglichen Sie gleichzeitigen Subagenten, sich gegenseitig Nachrichten mit themengefilterten Peer-Messaging-Threads zu senden.",
      "Führen Sie strukturierte Diskussionsrunden durch, bei denen mehrere Subagenten rundenübergreifend ein Thema diskutieren und das Ergebnis zusammenfassen.",
      "Halten Sie die Steuerelemente für die Modellkonfiguration – Delegierungs-Kontrollkästchen, benutzerdefinierter Modellabschnitt und Schriftgrößen – in allen Bereichen harmonisiert.",
      "Ersetzen Sie den Delegierungshinweistext durch einen übersichtlicheren Symbol-Tooltip."
    ]
  },
  {
    "version": "0.11.2",
    "date": "2026-08-31",
    "highlights": [
      "Wechseln Sie zwischen den letzten Konversationen, ohne dass der Chatbereich blinkt: Jede Konversation behält ihren eigenen Bereich und wird genau dort wieder angezeigt, wo Sie sie verlassen haben, einschließlich der Bildlaufposition.",
      "Kehren Sie zu einer Konversation zurück, in der Sie nach oben gescrollt haben, und landen Sie wieder an dieser Stelle, während eine zum ersten Mal geöffnete Sitzung immer noch an der neuesten Stelle beginnt.",
      "Lesen Sie die aktuelle Konversation weiter, während eine neue geladen wird, anstatt zuzusehen, wie das Transkript dunkler wird.",
      "Wiederholen Sie eine bearbeitete Eingabeaufforderung, auch wenn Sie den Text unverändert gelassen haben.",
      "Arbeiten Sie nach einer automatischen Kontextkomprimierung weiter an der aktuellen Aufgabe, anstatt dass der Agent eine ältere Anfrage aufnimmt."
    ]
  },
  {
    "version": "0.11.0",
    "date": "2026-08-30",
    "highlights": [
      "Richten Sie einen Anbieter in einer entdeckungsgesteuerten Form ein, der den KI-Dienst nach seinen eigenen Modellen fragt, bevor er auf den gebündelten Katalog zurückgreift.",
      "Wählen Sie ein Modell aus einer durchsuchbaren Liste aus, die Fähigkeitsabzeichen und Kontextgröße anzeigt und aus dem Katalog models.dev stammt.",
      "Überschreiben Sie Anhangfunktionen und die Standard-Denkebene pro Modellbindung und sehen Sie nur die Denkebenen, die ein Modell veröffentlicht.",
      "Lesen Sie eine einzelne Subagentendelegation als eigene Karte mit Lebenszykluszeilen und scrollen Sie durch einen erweiterten Delegatenlauf, anstatt das Transkript zu strecken.",
      "Halten Sie die Konversationsübersicht erreichbar, während der Verlauf noch geladen wird, und sehen Sie ein Gerüst statt einer leeren Liste, während die Sitzungen geladen werden.",
      "Fügen Sie einen großen Textblock in den Composer ein und lassen Sie ihn in eine Sitzungsdatei überlaufen, wobei die Eingabe vom Reflow-Pfad ferngehalten wird.",
      "Behalten Sie ein Fenster dort bei, wo Sie es beim Ziehen über Anzeigen abgelegt haben, und behalten Sie den Titelleistenbereich auf macOS-Zielseiten bei.",
      "Verlieren Sie weniger Durchgänge durch abgelehnte Datei- und Suchtoolaufrufe und durch ein in Millisekunden angegebenes Befehls-Timeout."
    ]
  },
  {
    "version": "0.10.9",
    "date": "2026-08-28",
    "highlights": [
      "Verwalten Sie Skills, Subagenten und MCP-Server über eine Capability Workbench in den Einstellungen, mit Ebenenfiltern, Suche und bestätigter Entfernung.",
      "Sorgen Sie dafür, dass die Funktions-Workbench und das obere Einstellungsband in beiden Themes lesbar sind, mit der korrekten Symbolleiste und den Steuerelementen für den leeren Zustand.",
      "Halten Sie lange Gespräche reaktionsfähig, während Sie scrollen, Sitzungen wechseln und mit der Maus über die Minikarte fahren, ohne dass das Transkript an Ort und Stelle springt.",
      "Laden Sie jede von älteren Builds geschriebene Transkriptzeile, anstatt eine vergangene Sitzung als leer anzuzeigen.",
      "Schneiden Sie das Transkript an der Nachricht aus, die Sie beim erneuten Generieren oder erneuten Senden einer Bearbeitung ausgewählt haben, und listen Sie eine gegabelte Sitzung immer in der Seitenleiste auf.",
      "Beurteilen Sie die Aktivität des Subagenten anhand jeder Antwort, begrenzen Sie die Runden jedes integrierten Subagenten und melden Sie eine abgelaufene Wartezeit als noch aktiv statt als fehlgeschlagen.",
      "Wiederholen Sie einen vorübergehenden Anbieterausfall bis zu viermal mit 1/2/4/8 Sekunden Wartezeit auf einem gemeinsamen Budget pro Runde und melden Sie den tatsächlichen Versuch mitten im Stream."
    ]
  },
  {
    "version": "0.10.8",
    "date": "2026-08-26",
    "highlights": [
      "Halten Sie die nativen Windows-Fenstersteuerelemente von Panel-Aktionen in der rahmenlosen Shell isoliert.",
      "Geben Sie temporären Chats isolierte Scratch-Arbeitsbereiche, damit ihre Dateien von der Projektarbeit getrennt bleiben.",
      "Verbesserung der Wiederherstellungsaufforderung im Befehlsstarter mit einem klareren Bot-Modellsymbol.",
      "Blenden Sie die Bildlaufleisten der Seitenleiste beim Schweben ein, während sie im Ruhezustand still bleiben."
    ]
  },
  {
    "version": "0.10.7",
    "date": "2026-08-25",
    "highlights": [
      "Behalten Sie die Composer-Sende- und Stoppsteuerung in einem stabilen Steckplatz, damit Zugluft und Laufdrehungen aufeinander abgestimmt bleiben.",
      "Die Eingabeaufforderungserweiterung bleibt über den Befehlsstarter verfügbar, ohne dass ein eigenständiges Symbolleistensymbol erforderlich ist.",
      "Machen Sie die Bildlaufleisten der Seitenleiste im Ruhezustand leiser und sorgen Sie dafür, dass sie während der Navigation erkennbar bleiben."
    ]
  },
  {
    "version": "0.10.6",
    "date": "2026-08-25",
    "highlights": [
      "Denkfähigkeiten für genau das im Composer ausgewählte Modell anzeigen, auch bevor eine neue Sitzung erstellt wird.",
      "Starten Sie neue Sitzungen auf der stärksten veröffentlichten Ebene des ausgewählten Argumentationsmodells."
    ]
  },
  {
    "version": "0.10.5",
    "date": "2026-08-25",
    "highlights": [
      "Halten Sie Windows-Fenstersteuerelemente von Panel-Aktionen in der rahmenlosen Shell isoliert.",
      "Öffnen Sie Windows-Projektordner und -dateien zuverlässig, einschließlich Pfaden mit dem Präfix mit erweiterter Länge.",
      "Bearbeiten Sie CRLF-Dateien, ohne ihren ursprünglichen Zeilenendestil zu ändern."
    ]
  },
  {
    "version": "0.10.4",
    "date": "2026-08-25",
    "highlights": [
      "Zeigt nur konfigurierte Anbietermodelle in der Konversationsauswahl an, während gespeicherte Modelle verfügbar bleiben, wenn die Erkennung nicht verfügbar ist.",
      "Halten Sie das rahmenlose Fenstersteuerungsband undurchsichtig, damit der Seiteninhalt niemals durch native Steuerelemente angezeigt wird.",
      "Halten Sie die Chat-Breite stabil, während das Arbeitsfenster geöffnet ist, und stellen Sie die Grenzen des Nur-Chat-Fensters wieder her, nachdem es ausgeblendet wurde."
    ]
  },
  {
    "version": "0.10.3",
    "date": "2026-08-25",
    "highlights": [
      "Verbessern Sie die Verbesserung der einmaligen Eingabeaufforderung, sodass der aktuelle Entwurf und die Dateiverweise erhalten bleiben.",
      "Halten Sie die Sende- und Stoppaktionen des Composers auf den sichtbaren Entwurf und die laufende Sitzung ausgerichtet.",
      "Behalten Sie Hintergrunddelegierungsmetadaten über TaskWait-Runden und Renderer-Neuladungen hinweg bei.",
      "Halten Sie den Verlauf und das Transkript der gespaltenen Sitzungen sofort nach der Verzweigung verfügbar."
    ]
  },
  {
    "version": "0.10.2",
    "date": "2026-08-24",
    "highlights": [
      "Halten Sie Chat-Inhalte und den Composer bequem zentriert, wenn die Seitenleiste minimiert ist.",
      "Bereiten Sie große Bildanhänge vor, ohne die gesamte Datei in den Speicher zu laden, auch bei der Wiedergabe des Verlaufs."
    ]
  },
  {
    "version": "0.10.1",
    "date": "2026-08-24",
    "highlights": [
      "Stellen Sie Eingabeaufforderungen in die Warteschlange, die während einer aktiven Ausführung gesendet werden, und stellen Sie sie der Reihe nach bereit, ohne dass der aktuelle Entwurf verloren geht.",
      "Bindet Hintergrund-Subagenten mit Leerlauf- und Gesamtzeitüberschreitungen und zeigt an, wenn ein Delegat eine Zeitüberschreitung aufweist.",
      "Laden Sie lange Sitzungsverläufe auf begrenzten Seiten und rufen Sie frühere Nachrichten ab, während Sie nach oben scrollen."
    ]
  },
  {
    "version": "0.10.0",
    "date": "2026-08-21",
    "highlights": [
      "Konfigurieren Sie mehrere Modelle pro Anbieter und wechseln Sie direkt im Composer zwischen ihnen.",
      "Verwalten Sie Agentenfunktionen in einem neu gestalteten Einstellungsstudio mit klareren Bereichsblöcken und Menüs.",
      "Den Verlauf der Host-Zwischenablage für Plugins als neue Funktion verfügbar machen.",
      "Halten Sie leere Sitzungen dauerhaft, damit sie nach dem Neustart angezeigt und wiederverwendet werden können.",
      "Erleichtern Sie die Verwendung der Modellauswahl durch eine klarere Anbieterhierarchie und gleichmäßiges Scrollen.",
      "Geben Sie immer die Gesamtzeilenanzahl in den Leseergebnissen an, damit große Dateien zuverlässig ausgelagert werden können.",
      "Stellen Sie ratenbegrenzte Streams bei Wiederholungsversuchen zuverlässiger wieder her.",
      "Zeigen Sie ausgewählte Dateien im Dateimanager an, wenn Sie sie über das Bedienfeld „Dateien“ öffnen."
    ]
  },
  {
    "version": "0.9.1",
    "date": "2026-08-20",
    "highlights": [
      "Machen Sie angeheftete Projektsymbole deutlich, damit sie in der Seitenleiste leichter zu erkennen sind.",
      "Verhindern Sie, dass die Aktivität des Subagenten nach Abschluss des Vorgangs beim Ausführen hängenbleibt.",
      "Passen Sie Plugin-Seiten und -Bedienfelder besser an den Rest des App-Chroms an.",
      "Reduzieren Sie die Eingabe- und Sendelatenz im Composer.",
      "Sorgen Sie dafür, dass lange Transkripte reibungsloser scrollen, und vermeiden Sie Blitze beim Wechseln der Sitzungen.",
      "Stellen Sie die leere Hilfslinie und das unten ausgerichtete Composer-Layout wieder her."
    ]
  },
  {
    "version": "0.9.0",
    "date": "2026-08-20",
    "highlights": [
      "Durchsuchen Sie Projektdateien im gebündelten Dateifenster und öffnen Sie sie mit der Standard-App des Betriebssystems.",
      "Fügen Sie dem Arbeitsfenster isolierte, von Plugins beigesteuerte Ansichten hinzu und sorgen Sie dafür, dass die Herkunft des Marktplatzes und der Status der zurückgezogenen Version sichtbar bleiben.",
      "Entfernen Sie das integrierte interaktive Terminal, während Sie die Bash-Ausgabe in der Konversation und die interaktiven Shells im externen Terminal beibehalten.",
      "Ratenbegrenzungen des Wiederholungsanbieters ohne doppelte Assistentenmeldungen vorhanden, dann „Weiter“ anbieten, wenn das Wiederholungsbudget erschöpft ist.",
      "Verwenden Sie eine kompakte Kontextzusammenfassung, um die Modell-, Tool-, Cache- und Komprimierungsnutzung auf einen Blick zu sehen.",
      "Bringen Sie die fünf Kernsitzungsbefehle durch lokalisierte Slash-Befehlshinweise im Composer bei.",
      "Halten Sie die Home- und Konversationskomponisten auf dem Laufenden, während ihre Begrüßungs- und Befehlshinweise reibungslos rotieren."
    ]
  },
  {
    "version": "0.8.1",
    "date": "2026-08-19",
    "highlights": [
      "Melden Sie sich bei mehreren Anbieterkonten an und wählen Sie das für jeden Anbieter verwendete Konto aus.",
      "Nutzen Sie die Fähigkeiten jedes Modells, um zu entscheiden, wann Bildanhänge unterstützt werden.",
      "Wählen Sie den Argumentationsaufwand direkt vom Composer für Modelle aus, die ihn offenlegen.",
      "Behalten Sie eine PI-Desktop-Instanz pro Datenverzeichnis bei, um widersprüchliche Sitzungen zu vermeiden.",
      "Organisieren Sie Einstellungen in übersichtlicheren Gruppen und vereinfachen Sie die Verwaltung von Anbieterkonten.",
      "Halten Sie die integrierten Subagenten an den Berechtigungsmodus der übergeordneten Konversation angepasst."
    ]
  },
  {
    "version": "0.8.0",
    "date": "2026-08-17",
    "highlights": [
      "Delegieren Sie Hintergrund-Subagenten und warten Sie auf deren Ergebnisse, ohne die Konversation zu blockieren.",
      "Erhöhen Sie die Obergrenze des laufenden Subagenten auf 10 und wenden Sie den Berechtigungsbereich jedes Agenten auf delegierte Arbeit an.",
      "Fügen Sie integrierte Explorer- und Fixer-Subagenten für allgemeine Hintergrundaufgaben hinzu.",
      "Fragen Sie einmal, ob das Schließen des Fensters in die Taskleiste minimiert oder beendet werden soll, und merken Sie sich dann die Auswahl.",
      "Lassen Sie Plugin-Panels der App-Sprache und dem Farbmodus folgen.",
      "Wiederholen Sie Fehler bei der Ratenbegrenzung in der Mitte des Streams im selben Zug, anstatt die Antwort zu stoppen.",
      "Genehmigte Planläufe nach einer Sidecar-Unterbrechung wiederherstellen.",
      "Verhindern Sie, dass Seitenwagen-Unfallwarnungen ein Fenster zerbrechen, das bereits verschwunden ist."
    ]
  },
  {
    "version": "0.7.0",
    "date": "2026-08-15",
    "highlights": [
      "Beschränken Sie den Zugriff auf Plugin-Dateien auf den deklarierten Dateibereich jedes Plugins und senden Sie gelöschte Dateien zur einfachen Wiederherstellung in den Papierkorb.",
      "Zeigt den deklarierten Dateibereich jedes Plugins neben seinen Berechtigungen an.",
      "Beschränken Sie Plugin-Netzwerkanfragen auf die deklarierte Domänen-Zulassungsliste jedes Plugins.",
      "Leiten Sie unbekannte Plugin-Panel-Kanäle an das Plugin weiter, damit tiefere Integrationen weiterhin funktionieren.",
      "Verhindern Sie, dass die Seitenleiste beim Ein- und Ausblenden flackert.",
      "Machen Sie Agentenbearbeitungen zeilenverankert, sodass eine unterbrochene Bearbeitung ordnungsgemäß wiederhergestellt wird, anstatt die Runde stillschweigend zu beenden.",
      "Harmonisierung der Hierarchie der Kartentypografie für eine einheitlichere Benutzeroberfläche.",
      "Aktualisieren Sie die Desktop-Shell und die Agent-Laufzeit auf die neuesten Electron- und Pi-Versionen."
    ]
  },
  {
    "version": "0.6.0",
    "date": "2026-08-14",
    "highlights": [
      "Öffnen Sie den Kontextnutzungsinspektor per Klick, um Token- und Cache-Statistiken anzuzeigen.",
      "Schalten Sie die Sichtbarkeit des Arbeitsbereichs mit einer neuen Tastenkombination um.",
      "Halten Sie Entwürfe neuer Aufgaben aus dem Verlauf fern, bis die erste Nachricht gesendet wird.",
      "Fügen Sie eine benutzerdefinierte globale Schriftartenauswahl mit gebündelten OFL-Schriftarten für personalisierte Typografie hinzu.",
      "Merken Sie sich kürzlich verwendete Plugins im Launcher für einen schnelleren Zugriff.",
      "Kopiersitzungspfad zum Kontextmenü für den Entwicklermodus hinzufügen.",
      "Behebung von Problemen mit dem Abschneiden der Schriftartenauswahl und dem Zurücksetzen der Systemstandards.",
      "Lassen Sie macOS PI-Desktop nach dem Schließen des Fensters im Dock und drücken Sie Cmd+Tab.",
      "Chat-Transkript angeheftet halten, wenn Composer nach dem Senden ausgeblendet wird.",
      "Geben Sie dem Arbeitspanel einen echten leeren Zustand mit klarerer Führung."
    ]
  },
  {
    "version": "0.5.11",
    "date": "2026-08-13",
    "highlights": [
      "Fügen Sie Offline-Verfügbarkeit und Metadatenaktualisierung für den Plugin-Marktplatz hinzu.",
      "Zwischenspeichern von Composer-Entwürfen pro Konversation für eine schnellere Sitzungswiederherstellung.",
      "Plugin-Panel-Titel lokalisieren und Panel-Fenster-Chrom anpassen.",
      "Maskottchen-Schlüsselfarbe auf dunklen Oberflächen korrigieren.",
      "Reduzieren Sie die Latenz der macOS-Launcher-Verknüpfung für schnellere Interaktionen."
    ]
  },
  {
    "version": "0.5.10",
    "date": "2026-08-13",
    "highlights": [
      "Verfeinern Sie die Fensterchrome und sicheren Bereiche des Plug-in-Panels, damit der Plug-in-Inhalt von nativen Steuerelementen ferngehalten wird.",
      "Polieren Sie die Seitenhierarchie der Plugins und reduzieren Sie die Übersichtskopie für einen klareren Erweiterungsworkflow.",
      "Verwenden Sie das richtige macOS-Tray-Vorlagensymbol für ein klareres Erscheinungsbild der Menüleiste."
    ]
  },
  {
    "version": "0.5.9",
    "date": "2026-08-13",
    "highlights": [
      "Sorgen Sie dafür, dass der Zielmodus die automatische Berechtigungsbehandlung verwendet, um einen konsistenteren Arbeitsablauf zu gewährleisten.",
      "Wärmen Sie den globalen Plugin-Launcher vor, damit er schneller geöffnet wird, auch wenn eine andere App fokussiert ist.",
      "Geben Sie Plugin-Panels natives Fenster-Chrom mit zuverlässigen Steuerelementen zum Minimieren, Maximieren und Schließen.",
      "Aktualisieren Sie die zweisprachige Dokumentationsseite mit vollständigen Anleitungen und Spezifikationen in Englisch und vereinfachtem Chinesisch."
    ]
  },
  {
    "version": "0.5.8",
    "date": "2026-08-12",
    "highlights": [
      "Stellen Sie den globalen Plugin-Starter „Alt+Leertaste“ von Windows wieder her, auch wenn eine andere App fokussiert ist.",
      "Halten Sie PI-Desktop in der Taskleiste verfügbar, wenn es unter macOS, Windows und Linux minimiert ist.",
      "Verbessern Sie die Lesbarkeit des nativen Auswahlmenüs in hellen und dunklen Designs."
    ]
  },
  {
    "version": "0.5.7",
    "date": "2026-08-12",
    "highlights": [
      "Fügen Sie Asktool-Fragen mit Einzelauswahl-, Mehrfachauswahl-, benutzerdefinierten Antwort-, Überspringen- und Ablehnungsabläufen hinzu.",
      "Halten Sie den Fortschritt mehrerer Fragen mit den Indikatoren für beantwortete, unbeantwortete und übersprungene Fragen sichtbar.",
      "Platzieren Sie interaktive Fragen auf derselben Composer-Genehmigungsoberfläche wie Plan- und Zielgenehmigungen.",
      "Vereinfachen Sie Genehmigungskarten und merken Sie sich den ausgewählten Genehmigungsmodus für die nächste Anfrage."
    ]
  },
  {
    "version": "0.5.6",
    "date": "2026-08-11",
    "highlights": [
      "Öffnen Sie installierte Plugins über einen globalen Tastatur-Launcher, ohne den aktuellen Arbeitsbereich zu verlassen.",
      "Reduzieren Sie erweiterte Denk-, Tool- und Subagentendetails, um lange Gespräche lesbar zu halten.",
      "Halten Sie die Aufgabenkonfiguration während aktiver Runden verfügbar und zeigen Sie Durchsatzstatistiken nach dem Stoppen an.",
      "Verfeinern Sie die Eckhierarchie auf der gesamten Benutzeroberfläche für eine klarere visuelle Gruppierung."
    ]
  },
  {
    "version": "0.5.5",
    "date": "2026-08-11",
    "highlights": [
      "Visualisieren Sie parallele Subagenten und ihre Aufgabenbeziehungen direkt im Gespräch.",
      "Halten Sie eingefügte Dateiverweise kompakt und stellen Sie ihre Chips wieder her, nachdem Sie eine Runde angehalten haben.",
      "Halten Sie die Modussteuerung während der Sitzungserstellung verfügbar und das Transkript nach dem Senden angeheftet.",
      "Führen Sie eine reibungslosere Wiederherstellung durch, wenn native Tools einen falschen Dateipfad erhalten.",
      "Polnische Seitenleisten-Fußzeilenaktionen und umschlossene Links in Benutzernachrichten."
    ]
  },
  {
    "version": "0.5.4",
    "date": "2026-08-08",
    "highlights": [
      "Verfeinern Sie das leere Maskottchen mit langsameren Posenänderungen im Leerlauf und kontinuierlicher Wiedergabe beim Schweben."
    ]
  },
  {
    "version": "0.5.0",
    "date": "2026-08-07",
    "highlights": [
      "Führen Sie begrenzte Subagenten hinter einem Aufgabentool aus, mit benutzerdefinierten Agenten, angehefteten Modellen, Attribution und Sitzungspersistenz.",
      "Verwalten Sie Subagenten aus Erweiterungen mit Neuladen der Registrierung und einem klareren schreibgeschützten Status.",
      "Bereiten Sie Kontextprüfpunkte während der Leerlaufzeit vor und installieren Sie sie, während der Transkriptverlauf erhalten bleibt und Komprimierungszeilen und Warnungen angezeigt werden.",
      "Fügen Sie den Zielmodus als zweiten Vertragsmodus hinzu und behalten Sie eingefügte Dateiverweise über Modusbefehle bei.",
      "Stellen Sie Subagent- und Host-gestützte Panels wieder her, wenn der Host die Verbindung wiederherstellt, mit leiserer routinemäßiger Teardown-Diagnose.",
      "Polnische Arbeitspanel- und Erweiterungsoberflächen mit klareren Metadaten, Steuerelementen und Kontrast zu dunklen Themen."
    ]
  },
  {
    "version": "0.4.3",
    "date": "2026-08-05",
    "highlights": [
      "Vervollständigen Sie den Agent-Only-Plan-Workflow mit dauerhaften Markdown-Prüfpunkten, Genehmigung und Ausführung in der Warteschlange.",
      "Fügen Sie projektbezogene MCP-Server und Skills mit einer Erweiterungsbereichssteuerung hinzu.",
      "Verschärfen Sie externe Pfadberechtigungen und native Suchbereiche über Arbeitsbereiche hinweg.",
      "Plangenehmigungsoberflächen schließen, nachdem Auflösungs- und Modusbefehle die aktive Sitzung wechseln.",
      "Lange Konversationen werden automatisch komprimiert: Das Transkript speichert jede Nachricht, markiert, wo jede Komprimierung stattgefunden hat, und warnt Sie, damit Sie entscheiden können, ob Sie eine neue Sitzung starten möchten."
    ]
  },
  {
    "version": "0.4.2",
    "date": "2026-08-03",
    "highlights": [
      "Zeigt die Kontext-Cache-Trefferrate im Chat-Transkript-Header für bessere Transparenz an."
    ]
  },
  {
    "version": "0.4.1",
    "date": "2026-08-02",
    "highlights": [
      "GitHub-Versionen aktualisieren und Links zum kanonischen PI-Desktop-Repository automatisch aktualisieren.",
      "Aktualisieren Sie die Projekt-, Plugin- und Release-Dokumentation, um den PI-Desktop-Repository-Namen zu verwenden."
    ]
  },
  {
    "version": "0.4.0",
    "date": "2026-08-01",
    "highlights": [
      "Plugins können jetzt Fähigkeiten, Themen, MCP-Server, residente Dienste und einen Inter-Plugin-Nachrichtenbus beitragen.",
      "Das Plugin-SDK deklariert alle neuen Funktionstypen, damit Autoren sie über das Manifest aktivieren können.",
      "Der Host-Kern validiert Funktionsbeiträge und leitet automatisch Berechtigungen pro Plugin ab.",
      "Die Eingabeaufforderung des Agentensystems umfasst jetzt vom Plugin deklarierte Fähigkeiten für Tool-bezogene Konversationen.",
      "Plugins-Seite neu gestaltet mit Vorlagenauswahl, Hot-Reload beim Speichern und Autorentools.",
      "Beim Erstellen eines Plugins aus einer Vorlage wird jetzt der Scaffolded-Ordner als Projekt geöffnet.",
      "Einheitliches Kopfzeilenmenü des Arbeitspanels mit übersichtlicheren Steuerelementen und Kontextaktionen.",
      "Stile, aufgeteilt in Partialtypen pro Oberfläche; Duplikat und totes CSS entfernt."
    ]
  },
  {
    "version": "0.3.0",
    "date": "2026-07-31",
    "highlights": [
      "Das Projektarchiv „Einstellungen“ zeigt jetzt gruppierte Abschnitte (Angeheftet/Alle/Archiviert) mit Anzahl pro Abschnitt, Live-Suche und Sortierkontrollen an.",
      "Die Breite des Arbeitspanel-Docks ist schmaler für bessere Layout-Proportionen.",
      "Das Design des Schalters auf der Schiene im Lichtdesign wurde korrigiert."
    ]
  },
  {
    "version": "0.2.11",
    "date": "2026-07-31",
    "highlights": [
      "Die globale Suche findet jetzt Chats, Seiten, Einstellungen und integrierte oder Plugin-Befehle an einem Ort.",
      "Darstellungssteuerelemente verwenden jetzt Design- und Sprachvorschaukarten, wobei die automatische Sprache korrekt dem Gebietsschema des Betriebssystems folgt.",
      "Die Einstellungen verfügen jetzt über spezielle KI- und Verknüpfungsabschnitte für eine klarere Navigation.",
      "Der Agent lädt jetzt mehrschichtige Projektanweisungen für AGENTS.md/CLAUDE.md mit Editoren für globale und projektbezogene AGENTS.md.",
      "Das Projektarchiv durchsucht jetzt Sitzungstitel und zeigt die neueste Aktivität, die Anzahl der Sitzungen, Zeitstempel und den erweiterbaren Verlauf an.",
      "Behebung eines Desktop-Startfehlers, der durch die Sandbox-Preload-Regression verursacht wurde.",
      "Reduzieren Sie den überwachten Footprint der entpackten macOS-App um etwa 55 % und behalten Sie dabei die Offline-Syntaxhervorhebung und die native Terminalunterstützung bei."
    ]
  },
  {
    "version": "0.2.10",
    "date": "2026-07-30",
    "highlights": [
      "Fügen Sie eine obere Konversationsleiste im Codex/WorkBuddy-Stil mit verbesserten Steuerelementen hinzu.",
      "Aktualisieren Sie das Chat-Transkript und den Markdown-Prosa-Stil für eine bessere Lesbarkeit.",
      "Vereinheitlichen Sie die Kopfzeile des Arbeitspanels mit dem Kontextmenü und animieren Sie das Zusammenklappen der Seitenleiste.",
      "Kombinieren Sie Tool-Launcher in einem Erstellungs-Dropdown für eine übersichtlichere Benutzeroberfläche.",
      "Docken Sie das Arbeitsfeld im festen Fenster an, anstatt es zu erweitern.",
      "Polnische Steuerelemente in der oberen Leiste: Deduplizierung umschalten, Steuerelemente schützen, macOS-Ausrichtung."
    ]
  },
  {
    "version": "0.2.8",
    "date": "2026-07-29",
    "highlights": [
      "Update-Eingabeaufforderungen und -Einstellungen öffnen jetzt vollständige lokalisierte Versionshinweise.",
      "Animationen zum Erweitern und Reduzieren des Arbeitspanels wirken flüssiger.",
      "Lange Gespräche verdichten übergroße Werkzeug-Ergebnisstapel zuverlässiger."
    ]
  },
  {
    "version": "0.2.7",
    "date": "2026-07-28",
    "highlights": [
      "Markdown-Antworten können Bilder, Audio und Video inline rendern.",
      "Remote-Bilder werden mit aktualisierter Inhaltssicherheitsrichtlinie angezeigt.",
      "Medien-Markup wird bereinigt, sodass nur sichere Tags zulässig sind."
    ]
  },
  {
    "version": "0.2.6",
    "date": "2026-07-28",
    "highlights": [
      "Turn-Boundary-Kontextkontrollpunkte verdichten lange Chats, ohne den Verlauf zu verbergen.",
      "Reibungsloser Gesprächswechsel mit zwischengespeicherten Transkripten und einem stabilen Rahmen.",
      "Angedockte Werkzeuge behalten eine feste Breite, sodass der Chat neben dem Arbeitsfenster lesbar bleibt.",
      "Das Projektmenü kann den Ordner in Ihrem Systemdateimanager öffnen.",
      "Composer-Eingabeaufforderungszeilen zeigen kein führendes Markensymbol mehr an."
    ]
  },
  {
    "version": "0.2.5",
    "date": "2026-07-28",
    "highlights": [
      "Die Navigation im Arbeitspanel wurde mit einer übersichtlicheren Werkzeugleiste neu gestaltet.",
      "Die Größenänderung des Fensters erfolgt bereichsabhängig, sodass das Layout vorhersehbar bleibt.",
      "Streaming-Renderings sind für eine schnellere Interaktion isoliert.",
      "Bei neuen Argumentationssitzungen wird standardmäßig auf maximales Denken zurückgegriffen, sofern verfügbar.",
      "Das Transkript bleibt nach dem Senden an die letzte Nachricht angeheftet."
    ]
  },
  {
    "version": "0.2.4",
    "date": "2026-07-28",
    "highlights": [
      "Composer-Chips sorgen dafür, dass Unterlängen vollständig sichtbar sind.",
      "Aktualisiertes Pi-AI für neuere Claude-Modelle einschließlich Opus 5-Unterstützung."
    ]
  },
  {
    "version": "0.2.3",
    "date": "2026-07-28",
    "highlights": [
      "Shell-Kopie länderübergreifend in einfacher Benutzersprache neu geschrieben.",
      "Auswahl, CJK-Beschriftungen und Politur der Hover-Bewegung.",
      "Arbeitsplatte und Einstellungen Lichtoberflächen verfeinert.",
      "Vorabversionsinstallationen entdecken jetzt neuere stabile GitHub-Versionen."
    ]
  },
  {
    "version": "0.2.2",
    "date": "2026-07-27",
    "highlights": [
      "Plugin-Marktplatz mit offiziellem Remote-Katalog und Detailfenstern.",
      "Isolierte Plugin-Panels und geschlossene Hochrisiko-APIs.",
      "Klicken Sie mit der rechten Maustaste auf Abschnittssymbolleisten, um Projekte oder Sitzungen zu erstellen.",
      "Startup-Splash, sanftere Bewegung und i18n-Politur.",
      "Die obere Navigation des Arbeitspanels unterstützt Rechtsklick zum Öffnen von Werkzeugen."
    ]
  },
  {
    "version": "0.2.1",
    "date": "2026-07-27",
    "highlights": [
      "Arbeitspanel-Tools bleiben pro Konversation erhalten.",
      "Der Überprüfungseintrag ist auf die Sitzung beschränkt, in der die Änderungen vorgenommen wurden."
    ]
  },
  {
    "version": "0.2.0",
    "date": "2026-07-27",
    "highlights": [
      "Seitenleiste trennt Projekte und Sitzungen mit klarerem Aufgabenstatus.",
      "Forken oder Antworten des Assistenten bearbeiten; Symbolleisten für Nachrichten, die nur aus Symbolen bestehen.",
      "Eintrag zur Arbeitsbereichsüberprüfung nach erfolgreichen Dateibearbeitungen.",
      "Tastaturkürzelzuordnungen und Entwicklermodus für DevTools.",
      "Der Pi-Modellkatalog ist die Autorität für Anbietermodelle.",
      "Die Denkkontrolle steht im Composer neben dem Modus."
    ]
  },
  {
    "version": "0.1.1",
    "date": "2026-07-26",
    "highlights": [
      "Erste öffentliche Veröffentlichung: Local-First-KI-Coding-Agent-Desktop-Client.",
      "Chat- und Agent-Modi mit Streaming, Denkebenen und Modellverwaltung.",
      "Workspace-Tools mit Permission Gating, Terminal, Browser und Git-Review.",
      "Rust-Hostkern für Speicher, Geheimnisse, Sitzungen und Benachrichtigungen.",
      "Plugin-Grundlage plus duale Englisch-/简体中文-Benutzeroberfläche.",
      "Update prüft anhand von GitHub-Releases (in der App, sofern unterstützt)."
    ]
  }
];
