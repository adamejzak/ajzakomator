# ajzakomator

Siatka terminali na Windowsa do pracy z wieloma agentami naraz (Claude Code, Codex). Projekty po lewej,
w każdym projekcie dowolnie wiele zakładek-gridów (1, 2, 2×2 … 5×4, ze scalaniem komórek), snippety
promptów, paleta Ctrl+K, statusy agentów z powiadomieniami oraz powrót do zamkniętych gridów i starych rozmów.

## Uruchomienie

```powershell
npm install          # .npmrc ustawia legacy-peer-deps (obejście błędu npm 10)
npm run dev          # tryb deweloperski
npm run dist         # instalator + wersja portable w release\
npm test             # testy jednostkowe + integracyjne (prawdziwy ConPTY)
```

Wymagania: Windows 10 1809+ / 11, `pwsh` (zalecany) lub Windows PowerShell, `claude` i/lub `codex` w PATH,
`git` (dla worktree), `curl` (systemowy, do hooków statusu Claude).

## Jak to działa

- **Projekt** = folder. **Zakładka** = grid terminali. **Komórka** = terminal z profilem (Claude / Codex / PowerShell…).
- Terminale wszystkich projektów i zakładek działają w tle; przełączanie niczego nie przerywa.
- Komórka startuje przy pierwszym wyświetleniu. Po restarcie aplikacji rozmowy są wznawiane
  (`claude --resume <id>`, `codex resume <id>`).
- Zamknięta zakładka trafia do **Historii** projektu (z ID rozmów) — jednym klikiem wraca.
  W Historii jest też lista **starych rozmów** Claude/Codex z tego folderu (również odpalonych poza aplikacją).
- **Statusy**: ◐ pracuje · ● czeka na Ciebie · ✕ zakończony. Claude raportuje przez hooki (plik ustawień
  przekazany `--settings`, Twój `settings.json` nie jest ruszany), Codex przez powiadomienia terminala,
  reszta heurystycznie. Gdy agent w niewidocznej komórce skończy — powiadomienie Windows (klik = skok do komórki).
- **Worktree**: w oknie gridu lub w menu „+ agent” komórka może dostać własny `git worktree`
  (`..\<projekt>-wt-<nazwa>`, branch `mc/<nazwa>`).
- **Klawiatura**: obsługiwany tryb `win32-input-mode` (jak Windows Terminal) — działa przytrzymanie spacji
  do dyktowania, AltGr, mysz w TUI.

## Skróty

| Skrót | Akcja |
|---|---|
| Ctrl+K / Ctrl+Shift+P | paleta: projekty, zakładki, snippety, presety, historia, rozmowy, akcje |
| Ctrl+Shift+T | nowa zakładka z jednym terminalem (ostatni profil) |
| Ctrl+Shift+G | nowy grid / preset |
| Ctrl+Shift+N | dodaj agenta do bieżącej siatki |
| Ctrl+Shift+W | zamknij zakładkę (→ Historia) |
| Ctrl+Shift+H | Historia projektu |
| Ctrl+Shift+M | maksymalizuj / przywróć komórkę (też dwuklik nagłówka) |
| Ctrl+Alt+strzałki | przejście między komórkami |
| Ctrl+Tab / Ctrl+Shift+Tab | następna / poprzednia zakładka |
| Ctrl+Shift+B | panel snippetów |
| Ctrl+Shift+E | panel projektów |
| Ctrl+kółko | zoom czcionki w komórce |
| Ctrl+C (z zaznaczeniem) / Ctrl+Shift+C | kopiuj |
| Ctrl+V / prawy klik | wklej (gdy w schowku jest obraz, Ctrl+V trafia do agenta) |

Snippety: klik → aktywna komórka, **Shift**+klik → wszystkie komórki siatki, przeciągnięcie → wskazana komórka.

## Dane

`%APPDATA%\ajzakomator\state.json` (+ `.bak`), pliki hooków w `%APPDATA%\ajzakomator\hooks`.
Zmienna `MC_DATA_DIR` pozwala użyć innego folderu (testy).
