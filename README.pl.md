<div align="center">

<img src="resources/logo.svg" width="96" alt="logo ajzakomator" />

# ajzakomator

**Siatka terminali do pracy z wieloma agentami Claude Code i Codex naraz, na Windowsie.**

[**Pobierz**](https://github.com/adamejzak/ajzakomator/releases/latest) · [English](README.md)

<img src="docs/screenshots/main.png" alt="ajzakomator: pięciu agentów w układzie 3+2" width="100%" />

</div>

## Co potrafi

- **Projekty po lewej**, a w każdym kilka gridów jako zakładki: od jednego terminala po 5×4, układy rzędami (`3+2`, `2+2+1`) i scalanie komórek
- **Każda komórka** może mieć nazwę, kolor, prompt startowy i osobny `git worktree`
- **Statusy na żywo**: ◐ pracuje, ● czeka na Ciebie, plus powiadomienie Windows, gdy agent w tle skończy
- **Nic nie ginie**: po restarcie aplikacji rozmowy same się wznawiają, zamknięte gridy trafiają do Historii, a lista starych czatów Claude i Codex jest pod ręką
- **Snippety** z ikonami i kolorami: klik wkleja do aktywnej komórki, Shift+klik do całej siatki, można też przeciągnąć na komórkę
- **Układ paneli**: przeciągnij krawędź projektów lub snippetów, aby zmienić szerokość; podwójny klik przywraca domyślną. Szerokości i kolejność projektów oraz snippetów są zapamiętywane
- **Przeglądarka plików**: zakładka „Pliki” w lewym panelu pokazuje drzewo projektu, podgląd tekstu i skróty do edytora lub Eksploratora Windows
- **Menu pod prawym przyciskiem**: na projekcie, gridzie, snippecie, pliku i pustej przestrzeni paneli. W edytorze projektu kliknięcie avatara wybiera własną ikonę, a „Anuluj” odrzuca zmiany
- **Paleta `Ctrl+K`** przeszukuje projekty, gridy, snippety, presety, historię i akcje
- **Terminal jak w Windows Terminal**: kolory agentów, klikanie myszą, AltGr, wklejanie obrazków i **przytrzymanie spacji do dyktowania**
- **Automatyczne aktualizacje** w tle

## Instalacja

1. Pobierz **`ajzakomator-Setup-x.y.z.exe`** z [najnowszego wydania](https://github.com/adamejzak/ajzakomator/releases/latest)
2. Uruchom. Jeśli Windows SmartScreen ostrzeże przed niepodpisaną aplikacją, wybierz *Więcej informacji* i *Uruchom mimo to*
3. Dodaj projekt (dowolny folder) i otwórz grid

Wymagania: Windows 10 1809+ lub 11, zalecany PowerShell 7, `claude` i/lub `codex` w `PATH`, `git` tylko do worktree.

## Skróty

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

## Licencja

[MIT](LICENSE)
