<div align="center">

<img src="resources/branding/banner.png" width="100%" alt="unimux - terminalowy workspace dla agentów programistycznych" />

<br />

**Siatka terminali do pracy z wieloma agentami Claude Code i Codex naraz, na Windowsie i macOS (Apple Silicon oraz Intel).**

Projekty, rozmowy z agentami, pliki i gotowe prompty w jednym miejscu.
Przełączaj projekty, gdy terminale nadal pracują w tle.

[**Pobierz**](https://github.com/daven-team/unimux/releases/latest) · [Funkcje](#co-potrafi) · [Skróty](#skróty) · [MCP](docs/MCP.md) · [English](README.md)

<img src="docs/screenshots/main.png" alt="Angielski interfejs unimux: projekty, cztery terminale demonstracyjne i snippety" width="100%" />

</div>

## Co potrafi

- **Opcjonalny MCP dla agentów**: role, gridy w tle, zadania z wynikami i wiadomości w panelu AI. Zwykłe gridy domyślnie działają bez MCP - [instrukcja](docs/MCP.md).
- **Limity kont AI**: panel pokazuje limity 5-godzinne i tygodniowe głównego konta Claude, dodatkowych zapisanych kont Claude i Codex. W menu „⋮” zapisanego konta **Ustaw jako główne** zamienia je z głównym logowaniem Claude: dotychczasowe konto główne zostaje zapisane, a otwarte sesje Claude zwykle przejmują nowe logowanie przy następnej wiadomości, bez zamykania (zależy to od wersji Claude Code; sesję, która tego nie zrobi, wystarczy zrestartować lub wznowić). Token wybranego konta jest najpierw odświeżany w Anthropic, a pliki logowania są wymieniane na Twoim komputerze. Gdy zamiana zostanie przerwana, aplikacja zachowuje kopię awaryjną, blokuje kolejne zamiany i prosi o sprawdzenie obu kont: po wyczyszczeniu ostrzeżenia zaloguj się ponownie na każde konto, które przestało działać (logowanie Claude zawsze można wykonać od nowa). Znane ograniczenie: jeśli sesja Claude zapisze swoje logowanie w tej samej milisekundzie co zamiana, aplikacja wykryje większość takich przypadków i poprosi o sprawdzenie kont, ale nie wszystkie - zachowaj własną kopię zapasową logowania Claude. Niedostępne na macOS, gdzie Claude trzyma logowanie w Keychain (zapisanych kont też nie da się tam dodać).
- **Projekty po lewej**, a w każdym kilka gridów jako zakładki: od jednego terminala po 5×4, układy rzędami (`3+2`, `2+2+1`) i scalanie komórek
- **Każda komórka** może mieć nazwę, kolor, prompt startowy i osobny `git worktree`
- **Statusy na żywo**: ◐ pracuje, ● czeka na Ciebie
- **Alerty** dla komórek Claude i Codex: powiadomienie systemowe i dźwięk dla trzech zdarzeń - agent **skończył pracę**, **potrzebuje Ciebie** (pytanie o zgodę lub pytanie do Ciebie) i **błąd** (tura zakończyła się błędem API, np. limitem, z czytelnym powodem). Każde zdarzenie ma własny przełącznik powiadomienia i dźwięk: jeden z ośmiu wbudowanych dźwięków syntezowanych (domyślny to łagodne ding-dong), dźwięk systemowy, własny plik (wav, mp3, ogg, m4a, aac lub flac, do 5 MB) albo brak. W Ustawieniach > Powiadomienia i dźwięki jest też suwak głośności, godziny ciszy (mogą przechodzić przez północ) oraz przycisk testu, który odtwarza dokładnie to, co zagra naprawdę. Alerty milczą, gdy patrzysz na komórkę w aktywnym oknie (chyba że włączysz **Powiadamiaj i graj dźwięk także w aktywnym oknie**), i nie odzywają się po przywróceniu sesji ani gdy komórka tylko ucichła; kliknięcie powiadomienia przenosi do komórki
- Jeden alert na turę: minimalizowanie i przywracanie okna, zmiana zakładki ani wybudzenie komputera nie wywołują ponownego alertu agenta, który już się zgłosił. **Wycisz alerty tej komórki** w menu komórki wycisza jedną komórkę (jej status nadal jest widoczny)
- Tura zakończona limitem lub błędem jest pokazana na czerwono zamiast „czeka na Ciebie”: **limit osiągnięty** dla limitu (Claude: rate limit, Codex: „You've hit your usage limit”), **błąd** dla każdej innej awarii, i wywołuje alert **błąd**
- Komórki Codex startują z hakiem `notify` dla pojedynczego procesu (nigdy nie zapisywanym do Twojego `config.toml`): po zakończeniu tury Codex wywołuje `curl` na lokalny serwer haków aplikacji. To daje dokładny koniec tury i dokładny identyfikator rozmowy, więc kilka komórek Codex w jednym folderze po restarcie wznawia każda własną rozmowę. Dla tych komórek zastępuje to ewentualny własny program `notify` z konfiguracji. Jeśli hak nigdy się nie zgłosi (stary Codex), komórka wraca do heurystyki aktywności. Powiadomienie tylko rozpoczyna koniec tury: liczy się, gdy komórka milczy przez ok. 2,5 s, więc subagent kończący pracę w trakcie tury nie wywoła fałszywego alertu „skończył” ani nie przypnie złej rozmowy; rozmowa jest zapisywana po pierwszym zatwierdzonym końcu tury, a potwierdzana po drugim. Uwaga: adres haka (token na uruchomienie i nonce na start) jest częścią polecenia wpisywanego do powłoki komórki, więc może trafić do historii tej powłoki; pozwala jedynie lokalnemu procesowi podrabiać statusy komórki i traci ważność po zamknięciu aplikacji
- Powiadomienia systemowe są zawsze ciche: dźwięk gra aplikacja, więc nie usłyszysz podwójnego sygnału. Zapisane ustawienia alertów mają pierwszeństwo przed starymi ustawieniami powiadomień i dźwięku z wcześniejszych wersji, które są czytane tylko wtedy, gdy nie ma jeszcze ustawień alertów
- **Nic nie ginie**: po restarcie aplikacji rozmowy same się wznawiają, zamknięte gridy trafiają do Historii, a lista starych czatów Claude i Codex jest pod ręką
- **Snippety** z ikonami i kolorami: klik wkleja do aktywnej komórki, Shift+klik do całej siatki, można też przeciągnąć na komórkę
- **Układ paneli**: przeciągnij krawędź projektów lub snippetów, aby zmienić szerokość; podwójny klik przywraca domyślną. Szerokości i kolejność projektów oraz snippetów są zapamiętywane
- **Pliki i edytor kodu**: zakładka „Pliki” pokazuje drzewo projektu; edytor ma numery wierszy, kolorowanie składni, zwijanie kodu, wyszukiwanie i cofanie zmian. Kod możesz też otworzyć w edytorze zewnętrznym
- **Menu pod prawym przyciskiem**: na projekcie, gridzie, snippecie, pliku i pustej przestrzeni paneli. W edytorze projektu kliknięcie avatara wybiera własną ikonę, a „Anuluj” odrzuca zmiany
- **Paleta `Ctrl+K` (`Cmd+K` na Macu)** przeszukuje projekty, gridy, snippety, presety, historię i akcje
- **Terminale systemowe**: Windows korzysta z PowerShella i ConPTY, macOS z zsh/bash i PTY. Na Macu działają `Cmd+C` / `Cmd+V`, a powłoka logowania wczytuje `PATH` agentów
- **Na Windowsie terminal jak w Windows Terminal**: kolory agentów, klikanie myszą, AltGr, wklejanie obrazków i **przytrzymanie spacji do dyktowania**
- **Języki aplikacji**: polski, angielski, niemiecki, hiszpański, francuski i portugalski. Wybór po pierwszym uruchomieniu po instalacji, późniejsza zmiana od razu w ustawieniach
- **Aktualizacje** zainstalowanej wersji Windows i aplikacji na Macu (nigdy bez Twojego kliknięcia)

<img src="docs/screenshots/editor.png" alt="Zakładka edytora kodu z otwartym katalogiem produktów Atlas i drzewem plików" width="100%" />

| Układ zespołu | Szybkie wyszukiwanie |
| --- | --- |
| ![Nowy grid: profile, role MCP i prompty](docs/screenshots/grid-dialog.png) | ![Paleta poleceń](docs/screenshots/palette.png) |

Zrzuty przedstawiają rzeczywistą aplikację w języku angielskim, z jednorazowymi projektami demonstracyjnymi i wynikami prawdziwych poleceń powłoki. Nie zawierają rozmów z modelami. [Instrukcja odtworzenia zrzutów](docs/screenshots/README.md).

## Panel Git i zaufanie do repozytorium

Kafelek **Git** w lewym pasku (aktywny dla projektów będących repozytoriami git) pokazuje gałąź z liczbą commitów do wysłania i pobrania, zmiany (dodawanie, cofanie, commit), historię commitów z cienkim grafem, szczegóły commita i diffy tylko do odczytu oraz daje **Fetch**, **Pull** (tylko fast-forward), **Push** (po potwierdzeniu z nazwą zdalnego repozytorium, gałęzi i adresem, na który faktycznie pójdzie) i zmianę gałęzi (tylko przy czystym drzewie). Używa systemowego `git` bez powłoki, z limitami czasu i rozmiaru wyniku. Nie ma kasowania zmian, force push, amend ani pomijania hooków.

Repozytorium git może mieć własną konfigurację, przez którą git uruchamia programy: `filter.*.clean/smudge` (odpala je `status` i `add`), `core.fsmonitor`, hooki, `core.hooksPath`, `core.sshCommand`, `diff.*.textconv`, `remote.*.uploadpack/receivepack`, pomocnicy poświadczeń, pliki `include` i inne. Otwarcie świeżo pobranego repozytorium nie może nic z tego uruchomić, dlatego panel ma model zaufania:

- Po otwarciu projektu panel czyta **lokalną** konfigurację repozytorium, `.gitattributes` / `.git/info/attributes` i `.git/hooks` **niczego nie uruchamiając** i szuka takich kluczy.
- Repozytorium bez nich działa normalnie. Repozytorium z nimi startuje w **trybie tylko do odczytu**: działają historia, szczegóły commitów, diffy commitów i lista gałęzi (sprawdzone, że niczego nie uruchamiają), a status, zmiany, diffy plików roboczych, dodawanie, commit, fetch, pull, push i zmiana gałęzi są wyłączone; status nie jest nawet pobierany przy powrocie do okna. Baner wymienia klucze (nigdy ich wartości).
- **Zaufaj temu repozytorium** zapamiętuje ścieżkę repozytorium razem z hashem dokładnie tej konfiguracji (i plików hooków) w `git-trust.json` w folderze danych aplikacji. Każda zmiana konfiguracji lub hooków pyta ponownie. Zaufanie nadaje tylko ten jawny przycisk; nic, co strona aplikacji dołączy do zwykłego żądania, go nie nada.
- Zaufane repozytorium działa normalnie, a panel w potwierdzeniach i przy polu commita przypomina, że jego hooki i filtry mogą się uruchamiać.
- Zawsze, także w zaufanych: `core.fsmonitor=false`, `--no-textconv`, `--no-ext-diff`, `--no-pager`, `protocol.ext.allow=never` oraz usuwanie ze środowiska zmiennych `GIT_DIR`, `GIT_WORK_TREE`, `GIT_INDEX_FILE`, `GIT_CONFIG_*`.
- Projekt będący podfolderem większego repozytorium (np. repozytorium w folderze domowym) otwiera się jako **repozytorium nadrzędne**: można je czytać, ale panel niczego w nim nie doda, nie zatwierdzi ani nie wyśle.
- Diff pliku nieśledzonego pokazuje tylko pliki, które git wymienia jako nieśledzone, nigdy przez link, junction ani alias 8.3 (`GIT~1`), a poświadczenia w diffach, opisach commitów i komunikatach błędów są maskowane.

Panel wymaga gita 2.26 lub nowszego w `PATH`.

## Instalacja

Wydania sprzed zmiany nazwy na Unimux mają `ajzakomator` w nazwach paczek. W tych wydaniach wybierz odpowiadający instalator lub architekturę Maca.

**Windows**

1. Pobierz **`unimux-Setup-x.y.z.exe`** z [najnowszego wydania](https://github.com/daven-team/unimux/releases/latest)
2. Uruchom. Jeśli Windows SmartScreen ostrzeże przed niepodpisaną aplikacją, wybierz *Więcej informacji* i *Uruchom mimo to*
3. Wybierz język przy pierwszym uruchomieniu
4. Dodaj projekt (dowolny folder) i otwórz grid

**macOS**

1. Pobierz **`unimux-x.y.z-mac-arm64.dmg`** dla Apple Silicon albo **`unimux-x.y.z-mac-x64.dmg`** dla Intela z [najnowszego wydania](https://github.com/daven-team/unimux/releases/latest).
2. Otwórz DMG i przeciągnij **unimux** do **Aplikacji**. Dostępne są też archiwa ZIP.
3. Uruchom aplikację, wybierz język, dodaj projekt i otwórz grid.

Buildy Maca mają podpis ad hoc bez certyfikatu Apple Developer i nie są notaryzowane. macOS może wymagać opcji **Otwórz mimo to** w **Ustawienia systemowe → Prywatność i ochrona**. Aplikacja aktualizuje się sama bez certyfikatu (zobacz [Aktualizacje](#aktualizacje); pierwsza aktualizacja do wersji z tą funkcją jest nadal ręczna). Zobacz [wymagania podpisywania Electrona](https://www.electronjs.org/docs/latest/tutorial/code-signing#macos-apis-that-require-code-signing).

Wymagania: Windows 10 1809+ lub 11 (zalecany PowerShell 7) albo macOS z zsh/bash, `claude` i/lub `codex` w `PATH` powłoki, `git` tylko do worktree.

Język zmienisz w **Ustawienia → Język aplikacji**. Przy pierwszym uruchomieniu aplikacja proponuje język systemu i prosi o jego potwierdzenie. Dotychczasowe instalacje zachowują polski.

## Pierwszy projekt

1. Dodaj folder, w którym chcesz pracować. Polecenia agentów uruchamiają się w folderze projektu.
2. Otwórz terminal albo utwórz grid i wybierz profil dla każdej komórki. Opcjonalnie dodaj nazwy i prompty startowe.
3. Zostaw **Bez MCP** dla zwykłych sesji lub wybierz role wykonawcy i koordynatora dla zarządzanego zespołu.
4. Otwórz **Pliki**, aby przeglądać i edytować kod. Powtarzalne instrukcje zapisz jako snippety.

## Aktualizacje

Zainstalowana wersja Windows sprawdza GitHub Releases. **Ustawienia → Aktualizacje** mają dwa tryby, a aktualizacja nigdy nie instaluje się bez Twojego kliknięcia. **Automatycznie**: przy starcie aplikacja sprawdza aktualizacje (okno pojawia się tylko, gdy sprawdzanie trwa dłużej) i gdy jest nowa wersja, pyta „Zainstaluj teraz” albo „Później”; pobieranie rusza w tle już podczas pytania, więc „Zainstaluj teraz” przechodzi od razu do instalatora („Później”, przycisk zamknięcia i Escape uruchamiają obecną wersję, a przycisk w stopce zainstaluje aktualizację później). **Ręcznie** (domyślnie): przy starcie nic się nie dzieje; aplikacja pobiera aktualizacje w tle, a nagłówek pokazuje postęp, rozmiar i prędkość pobierania. Stopka pokazuje **Dostępna wersja … - Aktualizuj**, a po pobraniu **Wersja … gotowa - Zainstaluj**; kliknięcie któregokolwiek otwiera jedno okno aktualizacji, które w razie potrzeby dokończy pobieranie, zainstaluje i uruchomi nową wersję. Jeśli przed startem instalatora pojawi się nowsze wydanie, okno przechodzi na najnowsze; gdy instalator już ruszył, ta wersja się kończy, a nowsza zostanie zaproponowana po ponownym uruchomieniu. Przed aktualizacją zapisz zmiany w edytorze. Rozmowy agentów są przywracane przez mechanizm wznowienia ich CLI.

Ręczne sprawdzenie: kliknij prawym przyciskiem nazwę i wersję **unimux**, a następnie wybierz **Sprawdź aktualizacje**. Po błędzie nagłówek pokazuje jego treść i pozwala ponowić próbę.

Wersja deweloperska nie instaluje aktualizacji.

**macOS.** Squirrel.Mac (electron-updater) odrzuca aktualizacje podpisane tylko ad hoc, dlatego aplikacja na Macu ma własny mechanizm z tymi samymi dwoma trybami i tą samą zasadą: nic nie instaluje się bez Twojego kliknięcia. Czyta `latest-mac.yml` z najnowszego wydania na GitHubie, pobiera `.zip` dla Twojego procesora (Apple Silicon lub Intel) do `~/Library/Application Support/unimux/updates/mac`, sprawdza rozmiar i SHA-512, rozpakowuje przez `ditto` i weryfikuje pakiet (wersja, identyfikator, plik wykonywalny i `codesign --verify`). Po kliknięciu instalacji mały skrypt czeka, aż aplikacja się zamknie, odkłada starą aplikację, wstawia nową (przy jakimkolwiek błędzie przywraca starą), usuwa znacznik kwarantanny i uruchamia nową wersję. Dziennik to `updates/mac/update.log`. W trybie **Automatycznie** pytanie przy starcie działa jak w Windows, a pobieranie rusza w trakcie namysłu. Aplikacja podmienia się sama tylko wtedy, gdy działa ze zwykłego, zapisywalnego pakietu `.app` należącego do Ciebie (np. w **Programach**). Z zamontowanego obrazu DMG, z kopii uruchomionej z tymczasowej lokalizacji (kwarantanna), z miejsca tylko do odczytu lub należącego do administratora, a także gdy macOS odmówi uprawnienia **Zarządzanie aplikacjami**, stopka pokazuje stronę pobierania, a podpowiedź mówi dlaczego.

Pierwsza aktualizacja do wersji macOS zawierającej ten mechanizm jest nadal ręczna (starsze wersje tego nie potrafią), a sam mechanizm nie został jeszcze sprawdzony na prawdziwym Macu; lista kontrolna jest w `docs/RELEASING.md`.

## Po co włączać MCP?

Zwykły grid wystarczy do niezależnych rozmów. MCP przydaje się, gdy agenci mają dzielić zadania i przekazywać sobie wyniki: w panelu **AI** widać, kto odpowiada za pracę, jakie pliki zmienił i co jest gotowe do review.

Dla funkcji obejmującej API i interfejs nazwij i pokoloruj komórki **Koordynator**, **Backend**, **Frontend** i **Review**. Wybierz Claude Code lub Codex osobno dla każdej komórki. Model i opcje CLI skonfigurujesz flagami profilu; koordynator może też wybrać model komórki przez MCP. Możesz włączyć role w istniejącym gridzie przez **AI → Agenci** albo utworzyć nowy z rolami i promptami startowymi. Przy zmianie roli aplikacja proponuje zastosowanie jej i restart ze wznowieniem zapisanej sesji albo odłożenie restartu.

Panel agentów odróżnia wymagany restart, konfigurację oczekującą na agenta i działające połączenie MCP. Samo uruchomienie lokalnego serwera nie oznacza, że agent już się z nim połączył.

1. Poproś koordynatora o podział funkcji i delegowanie zadań wybranym wykonawcom. Przy wspólnym katalogu ustalcie własność plików; worktree ułatwiają pracę na osobnych gałęziach.
2. Poproś koordynatora o zadanie frontendu z `dependsOn` wskazującym zadanie backendu. Backend raportuje kontrakt API, zmienione pliki i testy, a wiadomością przekazuje pracę frontendowi.
3. Frontend raportuje implementację. Agent review otrzymuje zadanie z wynikami obu części i sprawdza diff oraz testy.
4. Przejrzyj wyniki w **AI → Zadania**, zleć poprawki i zdecyduj o integracji. Zespół możesz zapisać jako preset.

Zadania i wiadomości są trwałym zapisem przekazania pracy. Nie gwarantują automatycznego uruchomienia modelu. Jeśli sesja nie ma potwierdzonego dostarczania natywnego, skopiuj prompt do właściwego terminala. [Instrukcja MCP](docs/MCP.md) opisuje role, dostarczanie i pauzę.

## Skróty

Na macOS w skrótach aplikacji używaj **Cmd** zamiast **Ctrl** oraz **Option** zamiast **Alt**.

Poniższe skróty są domyślne. Każdy z nich można zmienić, wyłączyć lub przywrócić w **Ustawienia > Skróty klawiszowe**: kliknij **Zmień**, naciśnij nową kombinację, a aplikacja ostrzeże, gdy używa jej już inna akcja (można je zamienić) albo gdy klawisze są zarezerwowane przez system lub terminal.

| Skrót | Akcja |
|---|---|
| `Ctrl+K` / `Ctrl+Shift+P` | paleta poleceń |
| `Ctrl+Shift+T` | nowa zakładka z jednym terminalem |
| `Ctrl+Shift+G` | nowy grid lub preset |
| `Ctrl+Shift+N` | dodaj agenta do bieżącej siatki |
| `Ctrl+Shift+W` | zamknij grid (trafia do Historii) |
| `Ctrl+Shift+H` | historia czatów i gridów |
| `Ctrl+Shift+M` | maksymalizuj komórkę |
| `Ctrl+Alt+strzałki` | przejście między komórkami |
| `Ctrl+Alt+Shift+strzałki` | zamiana aktywnej komórki z sąsiednią (albo przeciągnij komórkę za pasek na inną) |
| `Ctrl+Tab` | następny grid |
| `Ctrl+Shift+B` / `Ctrl+Shift+E` | pokaż lub ukryj snippety / projekty |
| `Ctrl+kółko myszy` | powiększenie w jednej komórce |

Zwykłe `Ctrl+T`, `Ctrl+B` i `Ctrl+W` w terminalach są pozostawione agentom Claude Code i Codex.

W drzewie Plików `F2` zmienia nazwę, `Delete` przenosi do kosza, a `Ctrl+C` / `Ctrl+X` / `Ctrl+V` / `Ctrl+Z` / `Ctrl+A` kopiują, wycinają, wklejają, cofają i zaznaczają wszystko. W zakładce edytora **Ctrl+S** / **Cmd+S** zapisuje plik, a **Tab** wstawia wcięcie. Pasek edytora pozwala zawijać wiersze i zamknąć plik. Niezapisane zmiany są oznaczone; zamknięcie proponuje zapis, odrzucenie albo anulowanie. Szkice przetrwają przeładowanie interfejsu, a zapis sprawdza, czy plik na dysku nie został zmieniony.

Więcej szczegółów, w tym architektura i instrukcja dla deweloperów, jest w [README po angielsku](README.md).

## Budowanie

`npm run dist:win` tworzy instalator Windows. `npm run dist:mac` tworzy DMG i ZIP na Macu. `npm run test:packaged` sprawdza terminal w zbudowanej aplikacji.

Workflow [CI](.github/workflows/ci.yml) testuje i buduje Windows x64 oraz macOS ARM64 i x64 na natywnych runnerach. Po wypchnięciu zmian możesz uruchomić build Maca z Windowsa przez **Actions → CI → Run workflow**. Pliki znajdziesz w artefaktach zakończonego uruchomienia; workflow nie publikuje automatycznie wydań.

Wydanie wszystkich platform opublikujesz przez **Actions → Publish release**, podając istniejący tag wersji i ID udanego CI dla tego samego commita. Wcześniej dodaj opis w `docs/releases/x.y.z.md`. Workflow sprawdza sumy paczek i dodaje instalatory Windows oraz DMG/ZIP obu architektur Maca do jednego wydania.

Dane aplikacji są lokalne: `%APPDATA%\unimux\state.json` na Windowsie i `~/Library/Application Support/unimux/state.json` na Macu. Pierwsze uruchomienie po aktualizacji z wydania sprzed zmiany nazwy przenosi tam dotychczasowy katalog danych i zostawia w starym miejscu dowiązanie, dzięki czemu nadal masz swoje projekty, rozmowy i zapisane konta.

Sprawdzanie aktualizacji łączy się z GitHub Releases. Agenci używają usług skonfigurowanych w ich własnych CLI. Lokalny MCP służy do zarządzania zespołem w aplikacji - [instrukcja po polsku](docs/MCP.md), [English guide](docs/MCP.en.md).

Zrzuty README odtworzysz po zbudowaniu aplikacji poleceniem `node scripts/capture-readme.mjs`. Skrypt korzysta z osobnych danych tymczasowych i rzeczywistego renderera Electron.

## Licencja

[MIT](LICENSE)
