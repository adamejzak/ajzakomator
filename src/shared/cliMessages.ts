// Texts for the "agent CLI is not installed" placeholder. English, German, Spanish, French and Portuguese;
// Polish uses the source message (the key). Placeholders must match across a row.
export const cliMessages = {
  '{name} nie jest zainstalowany': ['{name} is not installed', '{name} ist nicht installiert', '{name} no está instalado', '{name} n’est pas installé', '{name} não está instalado'],
  'Nie znaleziono polecenia „{command}”. Zainstaluj {name} albo użyj innego profilu.': ['The “{command}” command was not found. Install {name} or use another profile.', 'Der Befehl „{command}“ wurde nicht gefunden. Installiere {name} oder verwende ein anderes Profil.', 'No se encontró el comando «{command}». Instala {name} o usa otro perfil.', 'La commande « {command} » est introuvable. Installez {name} ou utilisez un autre profil.', 'O comando «{command}» não foi encontrado. Instale {name} ou use outro perfil.'],
  'Zainstaluj': ['Install', 'Installieren', 'Instalar', 'Installer', 'Instalar'],
  'Pokaż instrukcję': ['Show instructions', 'Anleitung anzeigen', 'Mostrar instrucciones', 'Afficher les instructions', 'Mostrar instruções'],
  'Sprawdź ponownie': ['Check again', 'Erneut prüfen', 'Comprobar de nuevo', 'Vérifier à nouveau', 'Verificar novamente'],
  'Sprawdzam…': ['Checking…', 'Prüfe…', 'Comprobando…', 'Vérification…', 'A verificar…'],
  '(niezainstalowany)': ['(not installed)', '(nicht installiert)', '(no instalado)', '(non installé)', '(não instalado)'],
  'Brak w systemie: {names}. Komórki ({count}) pokażą ekran instalacji zamiast terminala.': ['Not found on this computer: {names}. Cells ({count}) will show an install screen instead of a terminal.', 'Auf diesem Computer nicht gefunden: {names}. Zellen ({count}) zeigen statt eines Terminals einen Installationsbildschirm.', 'No se encontró en este equipo: {names}. Las celdas ({count}) mostrarán una pantalla de instalación en lugar de un terminal.', 'Introuvable sur cet ordinateur : {names}. Les cellules ({count}) afficheront un écran d’installation au lieu d’un terminal.', 'Não encontrado neste computador: {names}. As células ({count}) mostrarão um ecrã de instalação em vez de um terminal.'],
  'Zainstaluj albo kliknij ponownie, aby mimo to utworzyć grid.': ['Install it, or click again to create the grid anyway.', 'Installiere es oder klicke erneut, um das Raster trotzdem zu erstellen.', 'Instálalo o haz clic de nuevo para crear la cuadrícula de todos modos.', 'Installez-le, ou cliquez à nouveau pour créer quand même la grille.', 'Instale-o ou clique novamente para criar a grelha mesmo assim.'],
  'Utwórz mimo to ({count})': ['Create anyway ({count})', 'Trotzdem erstellen ({count})', 'Crear de todos modos ({count})', 'Créer quand même ({count})', 'Criar mesmo assim ({count})'],
  'Wykryto: {name}': ['Detected: {name}', 'Erkannt: {name}', 'Detectado: {name}', 'Détecté : {name}', 'Detetado: {name}'],
  'Nadal nie znaleziono: {name}': ['Still not found: {name}', 'Weiterhin nicht gefunden: {name}', 'Todavía no se encuentra: {name}', 'Toujours introuvable : {name}', 'Continua por encontrar: {name}'],
} as const;
