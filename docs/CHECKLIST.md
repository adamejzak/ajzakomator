# Ręczna lista kontrolna przed wydaniem

Uruchom zbudowaną aplikację (`release\win-unpacked\MultiCoding.exe`) na prawdziwym projekcie.

- [ ] Kolory Claude i Codex wyglądają jak w PowerShellu / Windows Terminal
- [ ] Klikanie myszą w TUI (menu, opcje, przewijanie) działa w Claude i w Codex
- [ ] Przytrzymanie spacji uruchamia dyktowanie (Codex, Claude)
- [ ] AltGr: ą ę ś ć ż ź ł ó ń wpisują się poprawnie
- [ ] Ctrl+V tekst; Ctrl+V obraz trafia do Claude; Ctrl+C z zaznaczeniem kopiuje; Ctrl+C bez zaznaczenia przerywa
- [ ] Grid 4×3 z kilkoma aktywnymi agentami — płynnie, bez przycinania okna
- [ ] Przełączanie projektów/zakładek nie przerywa agentów; statusy ◐/● aktualizują się w tle
- [ ] Powiadomienie Windows, gdy agent w ukrytej komórce skończy; klik przenosi do komórki
- [ ] Zamknięcie zakładki → Historia → Przywróć wznawia rozmowy
- [ ] Restart aplikacji przywraca projekty, zakładki i wznawia rozmowy
- [ ] Historia: lista starych rozmów, wznowienie w nowej zakładce / komórce
- [ ] Worktree: komórka na własnym branchu; zamknięcie pyta o usunięcie
- [ ] Zamknięcie aplikacji z działającymi agentami — bez błędu, bez osieroconych procesów
