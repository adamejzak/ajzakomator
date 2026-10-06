# MultiCoding — design

Data: 2026-10-06 · Status: zaakceptowany (użytkownik zrezygnował z przeglądu spec/planu)

## Cel

Osobna aplikacja na Windows do pracy z wieloma agentami CLI (Claude Code, Codex) naraz:
projekty po lewej, w każdym projekcie wiele zakładek-gridów terminali (1, 2, 2×2 … 5×4, ze scalaniem
komórek), szybkie odpalanie agentów z profili/presetów, wklejanie promptów ze snippetów, szybkie
przełączanie projektów i — najważniejsze — łatwy powrót do starych gridów i rozmów.
Ciemny, minimalistyczny styl w duchu Cursora. Jeden użytkownik, lokalnie, tylko Windows.

## Twarde wymagania (zweryfikowane spike'iem)

Terminal musi zachowywać się jak Windows Terminal/PowerShell dla TUI Claude i Codex:
truecolor, klikanie myszą, przytrzymanie spacji (głos), AltGr (polskie znaki), schowek, płynność przy 4×3.

Silnik potwierdzony w `spike/` (do wyrzucenia):
- `node-pty` 1.1 z `useConptyDll: true` (dołączony nowszy ConPTY/OpenConsole).
- `@xterm/xterm` 6 + `addon-webgl` + `addon-fit` + `addon-unicode11`, `windowsPty: {backend:'conpty'}`.
- Własna obsługa **win32-input-mode** (DECSET `?9001`): ConPTY o nią prosi, my wysyłamy każde
  keydown/keyup jako `ESC [ Vk;Sc;Uc;Kd;Cs;Rc _` — prawdziwe zdarzenia puszczenia klawisza.
- Środowisko dzieci czyszczone ze zmiennych sesji rodzica (`CLAUDECODE`, `CLAUDE_PID`, `CLAUDE_EFFORT`,
  `AI_AGENT`, `CLAUDE_CODE_{CHILD_SESSION,ENTRYPOINT,EXECPATH,MESSAGING_*,SESSION_*}`), inaczej
  Claude w komórce uznaje się za pod-sesję i nie zapisuje transkryptu.
- `TERM=xterm-256color`, `COLORTERM=truecolor`.
- Ctrl+C z zaznaczeniem = kopiuj; Ctrl+V = wklej tekst (bracketed paste), a gdy w schowku nie ma
  tekstu (obraz) — przekaż Ctrl+V do aplikacji.
- Zamykanie: najpierw zabij wszystkie pty i poczekaj na ich wyjście, potem zakończ proces
  (spike crashował segfaultem przy zamykaniu z żywymi ConPTY).

## Stos

Electron + TypeScript + React (electron-vite), Zustand (stan UI), Vitest, electron-builder (NSIS + portable).

## Pojęcia (model danych)

- **Project**: `id, name, path, color, tabs: Tab[], archive: ArchivedTab[], activeTabId`.
- **Tab**: `id, name, layout: GridLayout, cells: Cell[]`.
- **GridLayout**: `cols, rows, areas: Area[]` — każda Area to prostokąt `{col,row,colSpan,rowSpan}`;
  komórki = obszary (scalone pola = jeden obszar). Maks. 5×4.
- **Cell**: `id, profileId, worktree?: {path, branch}, session?: {cli:'claude'|'codex', id}, fontSize?`.
- **Profile**: `id, name, cli: 'claude'|'codex'|'shell', args: string, color` — gotowe: Claude,
  Claude Opus, Codex, Codex high, PowerShell.
- **Preset**: `id, name, layout, cells: {profileId, worktree: boolean}[], projectId?`.
- **Snippet**: `id, name, text, autoSend: boolean, projectId?`.
- **ArchivedTab**: zakładka + `closedAt` (układ i ID rozmów zachowane).

Stan trwały: `%APPDATA%\MultiCoding\state.json`, zapis atomowy (tmp + rename), debounce 500 ms,
kopia `state.json.bak` przy każdym udanym starcie. Uszkodzony plik → wczytaj `.bak`.

## Architektura

```
Renderer (React, xterm.js WebGL)  ◄── MessagePort (dane pty) ──►  Pty Host (utilityProcess, node-pty)
        ▲  ipc (stan, akcje)                                              ▲ ipc (spawn/kill/resize/status)
        └──────────────────────────── Main (Electron) ────────────────────┘
                 okno · state.json · git worktree · powiadomienia · serwer hooków · indeks sesji
```

- **Pty Host** trzyma wszystkie terminale wszystkich projektów; dane płyną bezpośrednio do renderera
  (MessagePort), z koalescencją ~4 ms. Crash hosta → renderer pokazuje komunikat, Main restartuje
  host, komórki wznawiają rozmowy.
- **Renderer** trzyma instancje xterm dla wszystkich komórek (także w ukrytych zakładkach/projektach,
  wtedy element DOM jest odpięty, xterm dalej przyjmuje dane). WebGL tylko dla widocznych komórek
  (limit kontekstów GPU); ukryte → dispose addonu.
- **Uruchomienie komórki**: `pwsh.exe -NoLogo` (fallback `powershell.exe`) w folderze projektu lub
  worktree, czyste env, potem wpisane polecenie profilu. Po wyjściu z agenta zostaje shell.

## Agenci, sesje, powroty

- Claude nowa rozmowa: `claude --session-id <uuid> <args>`; wznowienie: `claude --resume <uuid> <args>`.
- Codex nowa: `codex <args>`; ID z hooka `notify` (pole thread/session id) lub z nowego pliku w
  `~/.codex/sessions` z pasującym `cwd`; wznowienie: `codex resume <id> <args>`.
- Restart aplikacji: odtworzenie wszystkich projektów/zakładek, komórki z `session` startują z wznowieniem.
- **Archiwum**: zamknięcie zakładki przenosi ją do `project.archive`; „Historia” w lewym pasku + Ctrl+K,
  klik = przywróć zakładkę z wznowieniem rozmów.
- **Stare rozmowy**: Main indeksuje `~/.claude/projects/<zakodowana-ścieżka>/*.jsonl` i
  `~/.codex/sessions/**/*.jsonl` (filtr po cwd projektu), pokazuje datę, pierwszy prompt i źródło;
  wznowienie w aktywnej komórce / nowej komórce / nowej zakładce.
  Format plików weryfikowany przy implementacji; parser odporny na nieznane linie.

## Statusy

Stany komórki: `working ◐`, `waiting ●` (skończył / prosi o zgodę), `idle ○`, `exited ✕`.
- Claude: hooki przez `--settings <plik-json>` generowany przez aplikację (bez zmian w settings.json
  użytkownika): `UserPromptSubmit`→working, `Stop`/`Notification`→waiting. Hook = mały skrypt node
  wysyłający `{cellId, event}` do named pipe Main; `MC_CELL_ID` i ścieżka pipe w env komórki.
- Codex: `-c notify=[...]` z tym samym skryptem; plus OSC 9 w strumieniu.
- Fallback heurystyczny: wyjście po wpisaniu → working; 1,5 s ciszy po fali wyjścia → waiting.
- Agregacja: komórki → zakładka → projekt (lewy pasek: `◐2 ●1`).
- Powiadomienie Windows przy przejściu w `waiting`, jeśli komórka nie jest aktywna/widoczna lub okno
  nie ma fokusu; klik → przełącz projekt/zakładkę i sfokusuj komórkę. Wyłączalne.

## UI

- Lewy pasek (zwijalny): projekty (kolor, status), pod aktywnym — zakładki + „Historia”; „+ projekt”
  (wybór folderu). Prawy klik: zmień nazwę, kolor, usuń z listy, otwórz w Eksploratorze/Cursorze.
- Górny pasek: zakładki projektu, `⊞` (dialog siatki: wybór przeciągnięciem do 5×4, scalanie,
  profil dla wszystkich/każdej komórki, worktree, zapis/wczytanie presetu), `＋agent`.
- `＋agent` dokłada komórkę; siatka rośnie 1→2→2×2→3×2→3×3→4×3→5×4.
- Nagłówek komórki: numer, profil, status, branch; restart, maksymalizuj, zamknij.
  Dwuklik nagłówka = maksymalizuj/przywróć. Ctrl+kółko = zoom czcionki komórki.
- Prawy panel snippetów (Ctrl+B): wyszukiwarka; klik → aktywna komórka (bez Enter), przeciągnięcie →
  wskazana komórka, Shift → wszystkie komórki zakładki, `autoSend` → z Enter. Bracketed paste.
- Ctrl+K: paleta fuzzy — projekty, zakładki, archiwum, stare rozmowy, snippety, presety, profile, akcje.
- Skróty: Ctrl+T nowa zakładka 1× (ostatni profil), Ctrl+W zamknij zakładkę (→ archiwum),
  Ctrl+Shift+N +agent, Alt+strzałki przejście między komórkami, Ctrl+K, Ctrl+B.
- Motyw: tło `#0d0d0d`, panele `#141414`, ramki `#262626`, akcent niebieski; paleta ANSI Campbell;
  czcionka Cascadia Mono 13. Ustawienia w osobnym oknie dialogowym (motyw, czcionka, powiadomienia, shell).

## Worktree

Przełącznik w komórce lub presecie: `git worktree add ..\<projekt>-wt-<nazwa> -b mc/<nazwa>` od HEAD.
Zamknięcie komórki z worktree → pytanie o usunięcie (domyślnie zostaw). Brak gita → opcja wyszarzona.

## Błędy

Crash Pty Host → restart + wznowienie; agent zakończony → `✕` + „uruchom ponownie / wznów”;
brak `claude`/`codex` w PATH → komunikat w komórce; nieistniejący folder projektu → szary projekt
z „wskaż nową ścieżkę”; uszkodzony state → `.bak`.

## Testy

Vitest dla czystej logiki: model stanu i reducer akcji, układ siatki/scalanie/auto-rozrost,
kodowanie win32 klawiszy, czyszczenie env, budowanie poleceń profili, detektor statusu, parsery sesji,
fuzzy search. Test integracyjny Pty Host (spawn pwsh, echo, resize, kill). Ręczna checklista:
kolory, mysz, głos/spacja, AltGr, schowek/obraz, 4×3 pod obciążeniem, restart z wznowieniem.

## Poza zakresem v1

Pasek kompozytora, prompty startowe w presetach, synchronizacja, macOS/Linux, auto-update,
podgląd plików/diffów.
