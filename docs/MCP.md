# Agenci i lokalny MCP

Integracja jest opcjonalna. Nowy grid domyślnie ma **Bez MCP**: uruchamia zwykłe terminale i agentów, zachowując oryginalne prompty startowe. Istniejące gridy nie dostają automatycznie ról ani integracji.

## Włączenie

W oknie „Nowy grid” wybierz rolę dla wybranych komórek:

- **Bez MCP** — zwykły agent, bez połączenia z serwerem Ajzakomatora.
- **Wykonawca** — własne zadania, raportowanie wyników, wiadomości do agentów projektu i snippety.
- **Koordynator** — dodatkowo tworzenie gridów, presetów i przydzielanie zadań innym agentom.

Można mieszać wszystkie warianty w jednym gridzie. Role zapisują się w presetach. PowerShell i inne zwykłe powłoki nie korzystają z MCP.

Claude Code i Codex otrzymują konfigurację lokalnego serwera przy uruchamianiu komórki z rolą. Rolę można później zmienić w panelu **AI → Agenci** albo menu komórki. Po włączeniu roli w już działającym terminalu uruchom agenta ponownie. Wybranie „Bez MCP” natychmiast odbiera dostęp do narzędzi; restart usuwa konfigurację z uruchomionego klienta.

## Praca z zespołem

Przycisk **AI** otwiera panel agentów, zadań, wiadomości i aktywności. Zadania mają statusy kolejki, pracy, blokady, ukończenia i anulowania. Wynik może zawierać podsumowanie, pliki, gałąź, commit i informacje o testach. Wiadomości mają potwierdzenie przeczytania. Dane zapisują się razem ze stanem aplikacji.

Zadania i wiadomości trafiają do trwałej skrzynki MCP. Agent odczytuje ją narzędziami `get_tasks` i `get_messages`; sam serwer nie gwarantuje obudzenia pracującego modelu. Potwierdzona, uruchomiona sesja Codexa może dodatkowo otrzymać treść przez `codex queue`. Potwierdzenie wymaga wybrania sesji z historii — dopasowanie pliku rozmowy na podstawie czasu nie wystarcza. Wersja Codexa musi obsługiwać tę komendę.

Dla Claude oraz niepotwierdzonych sesji Codexa dostępne jest **Kopiuj prompt** i ręczne wklejenie do terminala. Błąd dostarczenia nie usuwa zadania. Można ponowić dostarczenie. Anulowanie zadania zmienia jego stan, ale nie przerywa pracy modelu.

Prompt startowy komórki z rolą tworzy śledzone zadanie i zawiera instrukcję raportowania wyniku. Bez roli prompt pozostaje zwykłym tekstem. Grid utworzony przez agenta działa w tle, bez zmiany aktywnej zakładki. Tworzenie agentów może zużywać limity modeli; instrukcje MCP wymagają wyraźnego polecenia użytkownika dotyczącego delegowania.

**Wstrzymaj automatyzację** blokuje nowe operacje agentów oraz automatyczne dostarczanie. Nadal można odczytywać skrzynki i raportować wyniki trwających zadań. Bezpośrednie utworzenie gridu przez użytkownika pozostaje dostępne.

## Narzędzia

| Narzędzia | Zastosowanie |
| --- | --- |
| `get_context`, `list_agents` | Tożsamość komórki, projekt, role i statusy |
| `list_library`, `get_snippet` | Biblioteka presetów i snippetów |
| `save_snippet`, `apply_snippet` | Zapis promptu i przydzielenie go jako zadania |
| `create_grid`, `save_preset` | Tworzenie gridów i presetów przez koordynatora |
| `create_task`, `get_tasks`, `update_task` | Przydział, odbiór i wynik zadania |
| `send_message`, `get_messages`, `acknowledge_message` | Skrzynka wiadomości |
| `deliver_task`, `deliver_message` | Ponowienie dostarczenia do sesji |

Agent ma dostęp wyłącznie do swojego projektu. Wykonawca widzi własne zadania i wiadomości; koordynator widzi zadania projektu. Snippety globalne są do odczytu, a zapis przez agenta dotyczy projektu. Zmiany ról i pauza są dostępne wyłącznie użytkownikowi.

Serwer Streamable HTTP nasłuchuje tylko na `127.0.0.1`, na losowym porcie. Każda komórka ma osobny token przekazywany przez środowisko, unieważniany po zakończeniu lub restarcie. Token nie trafia do argumentów procesu ani zapisanego stanu aplikacji. Żądania mają limit 256 KiB, a grid do 20 komórek. Gridy tworzone przez agentów ograniczono do 100 komórek w projekcie; skrzynki do 500 zadań i 500 wiadomości, dziennik do 200 zdarzeń.

## Sprawdzenie zmian

```sh
npm run typecheck
npm test
npm run test:automation
```

Test aplikacji używa osobnego katalogu tymczasowego i atrap Claude/Codexa, bez wywoływania modeli. Sprawdza prawdziwe połączenie MCP, formularze, zadania, wyniki, wiadomości, pauzę, tworzenie zwykłego gridu bez MCP i zapis danych. Zrzuty ekranu pozostawia w katalogu wskazanym w wyniku testu. Wymaga Node.js 22 lub nowszego oraz środowiska graficznego Electron.
