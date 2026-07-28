# AETHER-OS: Architektur- und Projektplan

Dieser Plan definiert eine risikoarme, local-first Architektur und eine prüfbare Lieferreihenfolge für AETHER-OS, bevor Code oder Abhängigkeiten festgelegt werden.

## Ausgangslage und Zielbild

Das Workspace-Verzeichnis ist derzeit leer; AETHER-OS wird deshalb als Greenfield-Desktop-Anwendung entworfen. Das Produkt ist ein lokaler Wissens- und Agenten-Workspace: Inhalte werden auf dem Gerät gespeichert, lokal durchsucht und von lokal betriebenen Modellen verarbeitet. Netzwerkzugriffe sind ausschließlich optional und explizit (z. B. auf einen lokalen Ollama-Prozess oder später auf vertrauenswürdige Peers).

## Architekturprinzipien

- **Local-first:** SQLite und der lokale Dateisystem-Speicher sind die Quelle der Wahrheit. Kein Cloud-Konto, keine Telemetrie und keine verpflichtende externe API.
- **Offline-fähig:** Erstellen, Bearbeiten, Graph-Abfragen, Indexierung und lokale Suche funktionieren ohne Internet. Die Ollama-Anbindung degradiert transparent, falls der lokale Dienst nicht läuft.
- **Sicherheitsgrenzen:** Die React-Webview ist nicht vertrauenswürdig; privilegierte Dateisystem-, Datenbank- und Prozesszugriffe bleiben im Rust-Core. Plugins erhalten keine Host-Rechte, sondern ausschließlich capability-beschränkte Wasm-Schnittstellen.
- **Explizite Konsistenz:** SQLite enthält strukturierte Entitäten und Transaktionen; CRDT-Dokumente werden als Versionen/Changes persistiert. Der Suchindex ist ein rekonstruierbarer abgeleiteter Zustand, nie die alleinige Datenquelle.
- **Messbare Qualität:** Jede Schicht besitzt deterministische Tests, Metriken und klar definierte Fehlermodi. Performance- und Sicherheitsversprechen werden erst nach Benchmarks behauptet.

## Zielarchitektur

### 1. Desktop-Shell und Prozessgrenzen

- **Tauri v2:** Verpackt die React/TypeScript-Benutzeroberfläche und stellt eine strikt typisierte IPC-Grenze zum Rust-Core bereit.
- **Rust Application State:** Hält Konfiguration, Datenbankpool, Index-Handle, Cancellation-Registry und Health-Status. Zustandsänderungen laufen über Commands/Events, nicht über direkten Frontend-Zugriff.
- **IPC-Vertrag:** Command-Request/Response für kurze Operationen; Tauri-Events für Streaming (LLM-Tokens, Indexfortschritt, Agent-Logs). Jede Antwort verwendet einen serialisierbaren Fehlercode plus sichere Benutzerbeschreibung.

### 2. Persistenz- und Wissensschicht

- **SQLite als System of Record:** Tabellen für `nodes`, `edges`, `documents`, `agent_logs`, `index_jobs` und Metadaten. Aktivierte Foreign Keys, WAL-Modus, Migrationen und kurze Transaktionen sind obligatorisch.
- **Graphmodell:** `nodes` repräsentieren Wissenseinheiten; `edges` tragen Relation, Gewicht, Erzeuger und Zeitstempel. Graphabfragen beginnen mit indizierten Nachbarschaftsabfragen; eine dedizierte Graphdatenbank ist nicht Teil von Phase 1.
- **Dokumente:** Originalinhalt plus normalisierte Chunks. Ein Chunk verweist eindeutig auf Dokument und Versionsstand, damit stale Vektoren erkannt und neu aufgebaut werden können.
- **CRDTs:** Automerge wird erst eingeführt, wenn ein konkret reproduzierbarer Offline-Konfliktfall und ein Sync-Protokoll definiert sind. Bis dahin ist die lokale SQLite-Transaktion maßgeblich.

### 3. Lokale Such- und KI-Schicht

- **Embedding-Provider-Abstraktion:** Einheitlicher Vertrag für `embed(text) -> [f32; dimensions]`. Implementierungen: lokaler Ollama-Embedding-Endpunkt und ein eingebetteter ONNX/fastembed-Fallback. Die Dimension ist providergebunden und wird pro Index gespeichert, nicht global als harte 384-Annahme.
- **Index-Lifecycle:** Inhalt ändern -> Chunking -> Embedding -> atomar als neue Indexversion schreiben -> alte Version entfernen. Fehler hinterlassen einen wiederholbaren Jobstatus, niemals halb interpretierte Suchergebnisse.
- **Hybrid Retrieval:** Phase 1 startet mit SQLite FTS5/BM25 plus Dense Retrieval und nachvollziehbarer Score-Normalisierung. Erst wenn Recall/Latenz-Messungen es rechtfertigen, wird LanceDB/HNSW als austauschbarer Vector-Store aktiviert.
- **LLM-Orchestrierung:** Ollama wird über `localhost` mit Timeouts, Health Check und Abbruchsignal angesprochen. Token-Streams werden unverändert als Events an die UI weitergegeben; Prompts und Antworten werden nur nach ausdrücklicher Produktentscheidung geloggt.

### 4. Plugin- und Agentensicherheit

- **Wasm-Sandbox:** Wasmtime ohne WASI per Default; keine Netzwerk-, Datei-, Uhr- oder Prozess-Imports. Speicherlimit, Fuel/Timeout und begrenzte Host-Funktionen sind Pflicht.
- **Capability-Modell:** Ein Tool erhält deklarierte, schmale Operationen (z. B. `read_note(id)`, `create_note(...)`) und niemals einen allgemeinen Dateisystempfad oder SQL-Zugriff.
- **Agentenmodell:** Ein Agent ist ein orchestrierter Ablauf aus Kontextgewinnung, lokaler Modellanfrage und auditierten Tool-Aufrufen. Jeder Tool-Call erhält eine Ausführungs-ID, Eingabe-/Ausgabegrenzen und einen Logeintrag.

### 5. UI-Architektur und Performance

- **React + TypeScript strict:** Domänen-Typen werden vom IPC-Vertrag abgeleitet; Zustand trennt persistierte Daten, flüchtige UI-Interaktion und Streamingzustand.
- **Canvas-Graph:** Nicht DOM-pro-Knoten. Phase 1 nutzt Canvas/WebGL-Rendering mit Viewport-Culling, Level-of-Detail, Node-Batching und inkrementellen Layout-Updates. React Flow ist für kleinere interaktive Editierflächen geeignet, nicht als unvalidierte Zusage für 100.000 Knoten.
- **Editor:** Ein textbasierter Block-Editor mit autosave, Debounce und Versionskennung. Indexierung wird nach erfolgreichem Persistieren asynchron ausgelöst.
- **Health-Bar:** Zeigt tatsächliche Core-Metriken: Datenbankstatus, Indexgröße/Jobstatus, Ollama-Erreichbarkeit sowie Sandbox-Limits. Keine erfundenen Ressourcenwerte.

## Datenfluss

1. Der Editor sendet eine validierte Mutation über IPC.
2. Der Rust-Core schreibt Inhalt und Version transaktional in SQLite.
3. Ein persistierter Indexjob chunkt die aktuelle Version und ruft den lokalen Embedding-Provider auf.
4. Der Vector-Store speichert Vektoren mit Dokument-, Chunk- und Versionsreferenz; der Job wird als erfolgreich oder wiederholbar fehlerhaft markiert.
5. Eine Suche kombiniert FTS-Kandidaten und Dense Retrieval, lädt autoritative Metadaten aus SQLite und liefert rangierte Treffer an die UI.
6. Eine Agentenfrage nutzt genau diesen Retrieval-Kontext, streamt die lokale Modellantwort und protokolliert nur die festgelegten Auditdaten.

## Phasen und Lieferobjekte

### Phase 0: Architecture Baseline

- Entscheidungen zu Tauri, Datenmodell, Index-Provider, IPC-Fehlerformat und Sandboxing als kurze ADRs festhalten.
- Threat Model für lokale Daten, Plugins und P2P erstellen.
- Akzeptanzkriterien, Offline-Testmatrix und Performance-Budgets definieren.

### Phase 1A: Vertrauenswürdiger lokaler Kern

- Tauri-Shell, Rust-State, SQLite-Migrationen, Node-/Edge-/Document-CRUD und Testdaten.
- Editor mit langlebigem Speichern und einfaches Graph-Canvas.
- Rust Unit- und Integrations-Tests für Transaktionen, Migrationen und Graphabfragen.
- Erfolgskriterium: Offline erstellte Inhalte überstehen Neustarts; parallele Schreibversuche bleiben konsistent.

### Phase 1B: Indexierung und Retrieval

- Chunking, persistierte Indexjobs, lokaler Embedding-Provider und FTS5-Suche.
- Dense Vector-Store hinter Trait einführen; LanceDB nur nach einer kompatibilitätsgeprüften, reproduzierbaren Implementierung.
- Hybrid Search mit Testkorpus und Recall/Latenz-Messung.
- Erfolgskriterium: Dokument -> Indexjob -> semantische Suche funktioniert ohne Internet und macht Fehlerzustände sichtbar.

### Phase 1C: Lokale KI und sichere Tool-Ausführung

- Ollama Health Check, Cancellation und tokenweises Streaming.
- Wasmtime-Sandbox mit Ressourcenlimits und Testmodulen für erlaubte/abgewiesene Imports.
- Auditierbare Agenten-Tool-Calls.
- Erfolgskriterium: Nicht erreichbares Ollama blockiert die App nicht; fehlerhaftes Wasm kann weder Host-Dateien noch den Prozess kompromittieren.

### Phase 1D: Produktionsreife UX und Verifikation

- Fehlerzustände, Recovery von Indexjobs, Datenexport/-import und Backup-Konzept.
- Accessibility-Grundlagen, virtuelle Darstellung großer Listen und Canvas-Benchmarks.
- E2E-Ablauf: Erstellen -> Speichern -> Indexieren -> Suchen -> lokale Agentenantwort.
- Erfolgskriterium: reproduzierbarer Offline-Releasekandidat mit dokumentierten Hardware- und Modellspezifikationen.

### Phase 2: Synchronisation und Kooperation

- Automerge-Change-Log, Geräteidentitäten, End-to-End-Verschlüsselung und konfliktorientierte UX.
- libp2p erst nach NAT-, Discovery-, Pairing- und Schlüsselrotation-Design. Ein serverloses P2P-System darf keine impliziten Discovery- oder Relay-Annahmen verbergen.

### Phase 3: Compute Mesh und Plugin-Ökosystem

- Vertrauensmodell, Workload-Scheduler, überprüfbare Artefakte und Ressourcenquoten.
- Signierte Plugin-Pakete, Capability-Manifest und sichere Updates vor frei verteilten Agenten-Tools.

## Technische Risiken und Entscheidungen

- **LanceDB-Rust-Integration:** API-Reife und Kompatibilität müssen zum Implementierungszeitpunkt validiert werden. Der `VectorStore`-Trait verhindert eine Bindung des restlichen Systems an eine einzelne Datenbank.
- **Embeddings:** ONNX-Modelle sind groß und plattformabhängig. Modell-Download, Hash-Prüfung, Speicherverbrauch und Lizenz werden als Produktfunktion behandelt; keine stillschweigende Netzwerkanfrage im Offline-Modus.
- **100.000 Knoten bei 60 FPS:** Dies ist ein Benchmarkziel, keine Architekturannahme. Es erfordert GPU-Rendering, Culling und progressive Layouts; DOM-basierte Flows allein sind unzureichend.
- **Wasm-Sicherheit:** Wasmtime isoliert nicht automatisch alle Risiken. Ohne WASI, mit Fuel, Speicherlimits und minimalen Host-Imports wird die Angriffsfläche kontrolliert.
- **CRDT plus Datenbank:** Doppelte Wahrheit vermeiden: CRDT-Changes und relationale Projektionen müssen eine definierte Reihenfolge, Versionierung und Rebuild-Strategie haben.
- **P2P ohne Cloud:** Lokales LAN ist machbar; Internet-übergreifende Verbindungen benötigen bewusst gewählte NAT-/Relay-Mechanismen. Das widerspricht nicht Local-first, darf aber nicht als kostenlos garantiert werden.

## Qualitätssicherung

- **Rust:** `cargo fmt --check`, `cargo clippy -- -D warnings`, Unit Tests für jede Domänenschicht und Integrations-Tests mit temporären Datenverzeichnissen.
- **Frontend:** TypeScript strict, Vitest/Testing Library für Zustand, UI-Fehler- und Streamingzustände.
- **E2E:** Playwright gegen die Desktop-App für Offline-CRUD, Indexierung, Suche und Modell-nicht-verfügbar-Verhalten.
- **Benchmarks:** Separate, versionierte Benchmarks für SQLite-Schreiblast, Retrieval-Latenz, Speicherverbrauch sowie Canvas-Rendering; CI-Grenzen erst nach einer Baseline festsetzen.
- **Sicherheitsprüfungen:** Negativtests für unsichere IPC-Eingaben, SQL-Injection-Abwehr durch parametrisierte Queries, Wasm-Importverbote und Ressourcenerschöpfung.

## Vor dem ersten Implementierungsprompt festzuzurren

1. Zielplattformen der ersten Version (nur macOS oder macOS/Linux/Windows).
2. Datenspeicherort, Verschlüsselungs-/Backup-Anforderungen und ob Inhalte auf Dateisystemebene verschlüsselt werden müssen.
3. Primäres lokales Modell sowie minimale Hardware- und Speicherbudgets.
4. Erwartetes Dokumentformat und maximale anfängliche Korpusgröße.
5. Produktgrenze für Phase 1: Einzelgerät oder bereits lokale Mehrgeräte-Synchronisation.
6. Lizenzstrategie für Anwendung, Modelle und eingebundene Komponenten.
