# Agenci i lokalny MCP

Integracja jest opcjonalna. Nowy grid domyślnie ma **Bez MCP**: uruchamia zwykłe terminale i agentów, zachowując oryginalne prompty startowe. Istniejące gridy nie dostają automatycznie ról ani integracji.

## Włączenie

W oknie „Nowy grid” wybierz rolę dla wybranych komórek:

- **Bez MCP** - zwykły agent, bez połączenia z serwerem Ajzakomatora.
- **Wykonawca** - własne zadania, raportowanie wyników, wiadomości do agentów projektu i snippety.
- **Koordynator** - dodatkowo tworzenie gridów, presetów i przydzielanie zadań innym agentom.

Można mieszać wszystkie warianty w jednym gridzie. Role zapisują się w presetach. PowerShell i inne zwykłe powłoki nie korzystają z MCP.

Claude Code i Codex otrzymują konfigurację lokalnego serwera przy uruchamianiu komórki z rolą. Rolę można później zmienić w panelu **AI → Agenci** albo menu komórki. Aplikacja proponuje zastosowanie roli i restart w jednym kroku, ze wznowieniem zapisanej sesji. Jeśli sesja nie jest jeszcze znana, informuje o rozpoczęciu nowej rozmowy. Można też odłożyć restart. Wybranie „Bez MCP” odbiera dostęp do narzędzi; restart usuwa konfigurację z klienta.

Panel rozróżnia wymagany restart, skonfigurowane MCP oczekujące na agenta i faktyczne połączenie. Sam działający serwer nie oznacza, że agent już załadował narzędzia.

## Praca z zespołem

Przycisk **AI** otwiera panel agentów, zadań, wiadomości i aktywności. Zadania mają statusy kolejki, pracy, blokady, ukończenia i anulowania. Wynik może zawierać podsumowanie, pliki, gałąź, commit i informacje o testach. Wiadomości mają potwierdzenie przeczytania. Dane zapisują się razem ze stanem aplikacji.

Zadania i wiadomości trafiają do trwałej skrzynki MCP. `read_inbox` odczytuje własne zadania i nieprzeczytane wiadomości razem; `acknowledge: true` zbiorczo potwierdza zwrócone wiadomości. Domyślnie zwraca tylko otwarte zadania (`closed: true` dodaje zamknięte). Agent sprawdza skrzynkę przy rozpoczęciu i zakończeniu zadania, a gdy nie ma pracy, używa `wait_for` zamiast odpytywać serwer: wywołanie czeka do `timeoutSec` (maks. 45 s) i wraca od razu, gdy pojawi się nieprzeczytana wiadomość albo zadanie gotowe do startu. Z `taskIds` koordynator czeka na ukończenie, zablokowanie lub anulowanie któregokolwiek (`all: true` - wszystkich) z podanych zadań, więc nie musi w pętli wywoływać `get_tasks`. Sam serwer nie gwarantuje obudzenia modelu. Potwierdzona, uruchomiona sesja Codexa może dodatkowo otrzymać treść przez `codex queue`. Potwierdzenie wymaga wybrania sesji z historii - dopasowanie pliku rozmowy na podstawie czasu nie wystarcza. Wersja Codexa musi obsługiwać tę komendę.

Dla Claude oraz niepotwierdzonych sesji Codexa dostępne jest **Kopiuj prompt** i ręczne wklejenie do terminala. Błąd dostarczenia nie usuwa zadania. Można ponowić dostarczenie. Anulowanie zadania zmienia jego stan, ale nie przerywa pracy modelu.

Prompt startowy komórki z rolą tworzy śledzone zadanie i zawiera instrukcję raportowania wyniku. Bez roli prompt pozostaje zwykłym tekstem. Grid utworzony przez agenta działa w tle, bez zmiany aktywnej zakładki. Tworzenie agentów może zużywać limity modeli; instrukcje MCP wymagają wyraźnego polecenia użytkownika dotyczącego delegowania.

**Wstrzymaj automatyzację** blokuje nowe operacje agentów oraz automatyczne dostarczanie. Nadal można odczytywać skrzynki i raportować wyniki trwających zadań. Bezpośrednie utworzenie gridu przez użytkownika pozostaje dostępne.

## Narzędzia

Koordynator może rozbudować bieżący grid przez `create_grid` z `gridId` albo utworzyć nowy zespół w tle przez `create_grid` z `name`. Narzędzie przyjmuje nazwy, kolory, profile, modele i prompty komórek. `update_grid` zmienia nazwę i kolor zakładki, a `update_agent` nazwę, kolor, profil i model agenta. Modele muszą być obsługiwane przez zainstalowane CLI; zmiana profilu lub modelu obowiązuje przy następnym uruchomieniu. Wynik zawiera `needsRestart` i przyczynę. Opcja `restart` próbuje wznowienia tylko wtedy, gdy środowisko ma potwierdzoną sesję.

Zadania mogą mieć `dependsOn` z identyfikatorami wcześniejszych zadań. `get_tasks` zwraca `ready` i `blockedBy`, a `readyOnly: true` filtruje kolejkę do pracy gotowej do rozpoczęcia. Zadania nie można rozpocząć ani dostarczyć przed ukończeniem zależności. Wyniki z listą plików, kontraktem API i testami stanowią trwałe przekazanie pracy kolejnemu agentowi.

`close_grid` zatrzymuje agentów innego gridu i przenosi go do Historii, zachowując rozmowy i worktree. Niezakończone zadania wymagają `cancelTasks: true` i zostaną anulowane. Koordynator nie może zamknąć własnego gridu przez MCP.

Przykład polecenia: „Dodaj Backend i Reviewer do tego gridu, nadaj im różne kolory. Przydziel zmianę walidacji Backendowi, a zadanie przeglądu uzależnij od jego ukończenia. Wymagaj listy plików i wyników testów. Nie twórz kolejnego gridu”. Przy wspólnym checkoutcie uzgodnij odpowiedzialność za pliki; przy niezależnych gałęziach wybierz worktree.

| Narzędzia | Zastosowanie | Kto |
| --- | --- | --- |
| `get_context`, `list_agents` | Tożsamość komórki i liczniki skrzynki; zwięzła lista agentów (`verbose` dodaje szczegóły) | wszyscy |
| `read_inbox`, `wait_for` | Otwarte zadania i wiadomości razem; ograniczone w czasie oczekiwanie zamiast odpytywania | wszyscy |
| `update_task`, `send_message` | Wynik zadania; wiadomość do agenta | wszyscy |
| `snippets` | `action`: `list`, `get`, `save`, `apply` - biblioteka promptów i presetów | wszyscy |
| `update_agent`, `help` | Nazwa, kolor, profil, model (własne; cudze tylko koordynator); dłuższe wyjaśnienia na żądanie | wszyscy |
| `create_task`, `get_tasks`, `deliver` | Przydział zadań, widok zadań projektu (strony, `next`), ponowienie dostarczenia | koordynator |
| `create_grid`, `update_grid`, `close_grid`, `save_preset` | Zespoły w tle (z `gridId` dopisuje komórki), nazwa i kolor gridu, archiwizacja, presety | koordynator |

Lista narzędzi zależy od roli: wykonawca nie dostaje narzędzi ani schematów koordynatora. Dawne nazwy (`list_library`, `get_snippet`, `save_snippet`, `apply_snippet`, `add_agents`, `get_messages`, `acknowledge_message`, `deliver_task`, `deliver_message`, `get_tasks`, `create_task`) pozostają wywoływalne, ale nie są wypisywane, więc nie kosztują tokenów. Uprawnienia sprawdza usługa, a nie lista narzędzi.

Wyniki są zwięzłe: tworzenie zadania i wiadomości zwraca tylko `id` i stan dostarczenia, `update_task` - `id` i status, długie teksty kończą się znacznikiem `...[truncated N chars; full:true for all]`, a listy mają `next`. Odpowiedź to jeden blok tekstu JSON bez `structuredContent`, żeby klient nie liczył jej dwa razy.

## Koszt w tokenach

Każdy agent z włączonym MCP płaci za definicje narzędzi i instrukcje w każdej rozmowie. Szacunek (znaki / 3,6): koordynator ok. 2200 tokenów (było 4425), wykonawca ok. 1260 (było 4425). Pomiar i opóźnienia: `node scripts/mcp-bench.mjs`.

Agent ma dostęp wyłącznie do swojego projektu. Wykonawca widzi własne zadania i wiadomości; koordynator widzi zadania projektu. Snippety globalne są do odczytu, a zapis przez agenta dotyczy projektu. Zmiany ról i pauza są dostępne wyłącznie użytkownikowi.

Serwer Streamable HTTP nasłuchuje tylko na `127.0.0.1`, na losowym porcie. Każda komórka ma osobny token przekazywany przez środowisko, unieważniany po zakończeniu lub restarcie. Token nie trafia do argumentów procesu ani zapisanego stanu aplikacji. Żądania mają limit 256 KiB, a grid do 20 komórek. Serwer odrzuca obce nagłówki Host i Origin (ochrona przed DNS rebinding), ogranicza liczbę żądań na token (429) i liczbę jednoczesnych żądań na token, a token unieważnia przy zakończeniu, restarcie lub usunięciu roli komórki. Gridy tworzone przez agentów ograniczono do 100 komórek w projekcie; skrzynki do 500 zadań i 500 wiadomości, dziennik do 200 zdarzeń.

## Claude Code i Codex

Claude dostaje `--mcp-config` z plikiem komórki (`type: http`, nagłówek `Authorization: Bearer ${AJZ_MCP_TOKEN}`), Codex - `-c mcp_servers.ajzakomator.url=...` i `bearer_token_env_var="AJZ_MCP_TOKEN"`. Oba klienty łączą się z lokalnym serwerem i widzą te same narzędzia; schematy są płaskie (bez `$ref`, `anyOf` i typów `null`), bo Codex przekazuje je modelowi bez zmian. Narzędzia zmieniające tylko stan aplikacji mają `openWorldHint: false`, więc Codex nie pyta o zgodę przy każdym `update_task`; `create_grid` (uruchamia agentów) i `close_grid` (zatrzymuje je) zachowują pytanie o zgodę.

Połączenie można sprawdzić bez modelu: `node scripts/mcp-serve.mjs` uruchamia serwer z atrapami, a `claude mcp add --transport http ...` / `codex mcp add --url ... --bearer-token-env-var ...` z tymczasowym `CLAUDE_CONFIG_DIR` / `CODEX_HOME` oraz `claude mcp list` pokazują stan połączenia.

## Sprawdzenie zmian

```sh
npm run typecheck
npm test
npm run test:automation
```

Test aplikacji używa osobnego katalogu tymczasowego i atrap Claude/Codexa, bez wywoływania modeli. Sprawdza prawdziwe połączenie MCP, formularze, zadania, wyniki, wiadomości, pauzę, tworzenie zwykłego gridu bez MCP i zapis danych. Zrzuty ekranu pozostawia w katalogu wskazanym w wyniku testu. Wymaga Node.js 22 lub nowszego oraz środowiska graficznego Electron.
