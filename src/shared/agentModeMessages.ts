// Inserting paths into a shell cell: the format follows the agent running in it, or the cell's own setting.
// Each row: English, German, Spanish, French, Portuguese. Polish is the key.
export const agentModeMessages = {
  'Upuść: @ścieżka (Claude)': ['Drop: @path (Claude)', 'Ablegen: @Pfad (Claude)', 'Suelta: @ruta (Claude)', 'Déposer : @chemin (Claude)', 'Largar: @caminho (Claude)'],
  'Upuść: ścieżka (Codex)': ['Drop: path (Codex)', 'Ablegen: Pfad (Codex)', 'Suelta: ruta (Codex)', 'Déposer : chemin (Codex)', 'Largar: caminho (Codex)'],
  'Upuść: ścieżka w cudzysłowie (powłoka)': ['Drop: quoted path (shell)', 'Ablegen: Pfad in Anführungszeichen (Shell)', 'Suelta: ruta entre comillas (shell)', 'Déposer : chemin entre guillemets (shell)', 'Largar: caminho entre aspas (shell)'],
  'Dodano pierwsze {count} ścieżek': ['Added the first {count} paths', 'Die ersten {count} Pfade wurden hinzugefügt', 'Se añadieron las primeras {count} rutas', 'Les {count} premiers chemins ont été ajoutés', 'Foram adicionados os primeiros {count} caminhos'],
  'Wstawianie ścieżek': ['Inserting paths', 'Pfade einfügen', 'Inserción de rutas', 'Insertion des chemins', 'Inserção de caminhos'],
  'Automatycznie (wykryj Claude lub Codex)': ['Automatic (detect Claude or Codex)', 'Automatisch (Claude oder Codex erkennen)', 'Automático (detectar Claude o Codex)', 'Automatique (détecter Claude ou Codex)', 'Automático (detetar Claude ou Codex)'],
  'Claude: @ścieżka': ['Claude: @path', 'Claude: @Pfad', 'Claude: @ruta', 'Claude : @chemin', 'Claude: @caminho'],
  'Codex: zwykła ścieżka': ['Codex: plain path', 'Codex: einfacher Pfad', 'Codex: ruta simple', 'Codex : chemin simple', 'Codex: caminho simples'],
  'Powłoka: ścieżka w cudzysłowie': ['Shell: quoted path', 'Shell: Pfad in Anführungszeichen', 'Shell: ruta entre comillas', 'Shell : chemin entre guillemets', 'Shell: caminho entre aspas'],
} as const;
