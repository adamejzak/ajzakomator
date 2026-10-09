<div align="center">

<img src="resources/logo.svg" width="96" alt="logo ajzakomator" />

# ajzakomator

**Siatka terminali do pracy z wieloma agentami Claude Code i Codex naraz, na Windowsie i macOS (Apple Silicon oraz Intel).**

[**Pobierz**](https://github.com/adamejzak/ajzakomator/releases/latest) · [English](README.md)

<img src="docs/screenshots/main.png" alt="ajzakomator: pięciu agentów w układzie 3+2" width="100%" />

</div>

## Co potrafi

- **Opcjonalny MCP dla agentów**: role, gridy w tle, zadania z wynikami i wiadomości w panelu AI. Zwykłe gridy domyślnie działają bez MCP — [instrukcja](docs/MCP.md).
- **Projekty po lewej**, a w każdym kilka gridów jako zakładki: od jednego terminala po 5×4, układy rzędami (`3+2`, `2+2+1`) i scalanie komórek
- **Każda komórka** może mieć nazwę, kolor, prompt startowy i osobny `git worktree`
- **Statusy na żywo**: ◐ pracuje, ● czeka na Ciebie, plus powiadomienie systemowe, gdy agent w tle skończy
- **Nic nie ginie**: po restarcie aplikacji rozmowy same się wznawiają, zamknięte gridy trafiają do Historii, a lista starych czatów Claude i Codex jest pod ręką
- **Snippety** z ikonami i kolorami: klik wkleja do aktywnej komórki, Shift+klik do całej siatki, można też przeciągnąć na komórkę
- **Układ paneli**: przeciągnij krawędź projektów lub snippetów, aby zmienić szerokość; podwójny klik przywraca domyślną. Szerokości i kolejność projektów oraz snippetów są zapamiętywane
- **Przeglądarka plików**: zakładka „Pliki” w lewym panelu pokazuje drzewo projektu, podgląd tekstu i skróty do edytora, Eksploratora Windows lub Findera
- **Menu pod prawym przyciskiem**: na projekcie, gridzie, snippecie, pliku i pustej przestrzeni paneli. W edytorze projektu kliknięcie avatara wybiera własną ikonę, a „Anuluj” odrzuca zmiany
- **Paleta `Ctrl+K` (`Cmd+K` na Macu)** przeszukuje projekty, gridy, snippety, presety, historię i akcje
- **Terminale systemowe**: Windows korzysta z PowerShella i ConPTY, macOS z zsh/bash i PTY. Na Macu działają `Cmd+C` / `Cmd+V`, a powłoka logowania wczytuje `PATH` agentów
- **Na Windowsie terminal jak w Windows Terminal**: kolory agentów, klikanie myszą, AltGr, wklejanie obrazków i **przytrzymanie spacji do dyktowania**
- **Języki aplikacji**: polski, angielski, niemiecki, hiszpański, francuski i portugalski. Wybór po pierwszym uruchomieniu po instalacji, późniejsza zmiana od razu w ustawieniach
- **Automatyczne aktualizacje** zainstalowanej wersji Windows; Mac i wersja portable wskazują stronę pobierania

## Instalacja

**Windows**

1. Pobierz **`ajzakomator-Setup-x.y.z.exe`** z [najnowszego wydania](https://github.com/adamejzak/ajzakomator/releases/latest)
2. Uruchom. Jeśli Windows SmartScreen ostrzeże przed niepodpisaną aplikacją, wybierz *Więcej informacji* i *Uruchom mimo to*
3. Wybierz język przy pierwszym uruchomieniu
4. Dodaj projekt (dowolny folder) i otwórz grid

**macOS**

1. Pobierz **`ajzakomator-x.y.z-mac-arm64.dmg`** dla Apple Silicon albo **`ajzakomator-x.y.z-mac-x64.dmg`** dla Intela z [najnowszego wydania](https://github.com/adamejzak/ajzakomator/releases/latest).
2. Otwórz DMG i przeciągnij **ajzakomator** do **Aplikacji**. Dostępne są też archiwa ZIP.
3. Uruchom aplikację, wybierz język, dodaj projekt i otwórz grid.

Buildy Maca mają podpis ad hoc bez certyfikatu Apple Developer i nie są notaryzowane. macOS może wymagać opcji **Otwórz mimo to** w **Ustawienia systemowe → Prywatność i ochrona**. Aktualizacje instaluje się ręcznie; automatyczne aktualizacje potrzebują podpisu wydawcy. Zobacz [wymagania podpisywania Electrona](https://www.electronjs.org/docs/latest/tutorial/code-signing#macos-apis-that-require-code-signing).

Wymagania: Windows 10 1809+ lub 11 (zalecany PowerShell 7) albo macOS z zsh/bash, `claude` i/lub `codex` w `PATH` powłoki, `git` tylko do worktree.

Język zmienisz w **Ustawienia → Język aplikacji**. Przy pierwszym uruchomieniu aplikacja proponuje język systemu i prosi o jego potwierdzenie. Dotychczasowe instalacje zachowują polski.

## Skróty

Na macOS w skrótach aplikacji używaj **Cmd** zamiast **Ctrl** oraz **Option** zamiast **Alt**.

| Skrót | Akcja |
|---|---|
| `Ctrl+K` | paleta poleceń |
| `Ctrl+Shift+T` | nowa zakładka z jednym terminalem |
| `Ctrl+Shift+G` | nowy grid lub preset |
| `Ctrl+Shift+N` | dodaj agenta do bieżącej siatki |
| `Ctrl+Shift+W` | zamknij grid (trafia do Historii) |
| `Ctrl+Shift+H` | historia czatów i gridów |
| `Ctrl+Shift+M` | maksymalizuj komórkę |
| `Ctrl+Alt+strzałki` | przejście między komórkami |

Więcej szczegółów, w tym architektura i instrukcja dla deweloperów, jest w [README po angielsku](README.md).

## Budowanie

`npm run dist:win` tworzy instalator i wersję portable Windows. `npm run dist:mac` tworzy DMG i ZIP na Macu. `npm run test:packaged` sprawdza terminal w zbudowanej aplikacji.

Workflow [CI](.github/workflows/ci.yml) testuje i buduje Windows x64 oraz macOS ARM64 i x64 na natywnych runnerach. Po wypchnięciu zmian możesz uruchomić build Maca z Windowsa przez **Actions → CI → Run workflow**. Pliki znajdziesz w artefaktach zakończonego uruchomienia; workflow nie publikuje automatycznie wydań.

Wydanie wszystkich platform opublikujesz przez **Actions → Publish release**, podając istniejący tag wersji i ID udanego CI dla tego samego commita. Wcześniej dodaj opis w `docs/releases/x.y.z.md`. Workflow sprawdza sumy paczek i dodaje instalatory Windows oraz DMG/ZIP obu architektur Maca do jednego wydania.

Dane aplikacji są lokalne: `%APPDATA%\ajzakomator\state.json` na Windowsie i `~/Library/Application Support/ajzakomator/state.json` na Macu.

## Licencja

[MIT](LICENSE)
