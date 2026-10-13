// Texts for resetting a terminal's input modes. Each row: English, German, Spanish, French, Portuguese. Polish is the key.
export const termMessages = {
  'Zresetuj terminal': ['Reset terminal', 'Terminal zurücksetzen', 'Restablecer terminal', 'Réinitialiser le terminal', 'Repor terminal'],
  'Komórka: zresetuj terminal (tryby myszy i klawiatury)': [
    'Cell: reset terminal (mouse and keyboard modes)',
    'Zelle: Terminal zurücksetzen (Maus- und Tastaturmodi)',
    'Celda: restablecer terminal (modos de ratón y teclado)',
    'Cellule : réinitialiser le terminal (modes souris et clavier)',
    'Célula: repor terminal (modos de rato e teclado)',
  ],
  'Terminal zresetowany - historia została zachowana.': [
    'Terminal reset - the history was kept.',
    'Terminal zurückgesetzt - der Verlauf bleibt erhalten.',
    'Terminal restablecido - se conservó el historial.',
    'Terminal réinitialisé - l’historique est conservé.',
    'Terminal reposto - o histórico foi mantido.',
  ],
  'Terminal wysyłał zdarzenia myszy do powłoki - zresetowano tryb': [
    'The terminal was sending mouse events to the shell - the mode was reset',
    'Das Terminal hat Mausereignisse an die Shell gesendet - der Modus wurde zurückgesetzt',
    'El terminal enviaba eventos de ratón a la shell - se restableció el modo',
    'Le terminal envoyait des événements souris au shell - le mode a été réinitialisé',
    'O terminal estava a enviar eventos do rato para a shell - o modo foi reposto',
  ],
} as const;
