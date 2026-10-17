// Texts of SSH mode (0.9.2): the SSH navigation in the side panel, group tiles, empty states, known hosts in the SSH view.
// Each row: English, German, Spanish, French, Portuguese. Polish is the key.
export const sshModeMessages = {
  'SFTP': ['SFTP', 'SFTP', 'SFTP', 'SFTP', 'SFTP'],
  'Grupy': ['Groups', 'Gruppen', 'Grupos', 'Groupes', 'Grupos'],
  'Wszystkie': ['All', 'Alle', 'Todos', 'Tous', 'Todos'],
  'Pokaż tylko grupę {name}': ['Show only the group {name}', 'Nur die Gruppe {name} anzeigen', 'Mostrar solo el grupo {name}', 'Afficher uniquement le groupe {name}', 'Mostrar apenas o grupo {name}'],
  'Nie masz jeszcze hostów': ['No hosts yet', 'Noch keine Hosts', 'Todavía no hay hosts', 'Aucun hôte pour l’instant', 'Ainda não há anfitriões'],
  'Zapisz adres, użytkownika i sposób logowania, a potem łącz się jednym kliknięciem w dowolnej siatce.': [
    'Save the address, user and sign-in method, then connect with one click in any grid.',
    'Speichere Adresse, Benutzer und Anmeldeart und verbinde dich dann mit einem Klick in jedem Grid.',
    'Guarda la dirección, el usuario y el método de inicio de sesión y conéctate con un clic en cualquier cuadrícula.',
    'Enregistrez l’adresse, l’utilisateur et la méthode de connexion, puis connectez-vous en un clic dans n’importe quelle grille.',
    'Guarde o endereço, o utilizador e o método de início de sessão e ligue-se com um clique em qualquer grelha.',
  ],
  'Nie masz jeszcze kluczy': ['No keys yet', 'Noch keine Schlüssel', 'Todavía no hay claves', 'Aucune clé pour l’instant', 'Ainda não há chaves'],
  'Wygeneruj nowy klucz albo dodaj istniejący z pliku lub jako wklejony tekst. Klucz publiczny skopiujesz potem do authorized_keys na serwerze.': [
    'Generate a new key or add an existing one from a file or as pasted text. Then copy the public key to authorized_keys on the server.',
    'Erzeuge einen neuen Schlüssel oder füge einen vorhandenen aus einer Datei oder als eingefügten Text hinzu. Kopiere dann den öffentlichen Schlüssel in authorized_keys auf dem Server.',
    'Genera una clave nueva o añade una existente desde un archivo o como texto pegado. Después copia la clave pública en authorized_keys del servidor.',
    'Générez une nouvelle clé ou ajoutez-en une existante depuis un fichier ou en collant son texte. Copiez ensuite la clé publique dans authorized_keys sur le serveur.',
    'Gere uma chave nova ou adicione uma existente a partir de um ficheiro ou como texto colado. Depois copie a chave pública para authorized_keys no servidor.',
  ],
  'Klucz serwera trafia tutaj, gdy przy pierwszym połączeniu wybierzesz „Zaufaj i zapisz”.': [
    'A server key is listed here once you choose “Trust and save” on the first connection.',
    'Ein Serverschlüssel erscheint hier, sobald du bei der ersten Verbindung „Vertrauen und speichern“ wählst.',
    'La clave de un servidor aparece aquí cuando eliges «Confiar y guardar» en la primera conexión.',
    'La clé d’un serveur apparaît ici lorsque vous choisissez « Faire confiance et enregistrer » à la première connexion.',
    'A chave de um servidor aparece aqui quando escolhe «Confiar e guardar» na primeira ligação.',
  ],
  'Wybierz host, aby zobaczyć szczegóły.': ['Select a host to see its details.', 'Wähle einen Host, um die Details zu sehen.', 'Selecciona un host para ver sus detalles.', 'Sélectionnez un hôte pour voir ses détails.', 'Selecione um anfitrião para ver os detalhes.'],
  'Wybierz klucz, aby zobaczyć szczegóły.': ['Select a key to see its details.', 'Wähle einen Schlüssel, um die Details zu sehen.', 'Selecciona una clave para ver sus detalles.', 'Sélectionnez une clé pour voir ses détails.', 'Selecione uma chave para ver os detalhes.'],
  'Usuń {host}': ['Remove {host}', '{host} entfernen', 'Eliminar {host}', 'Supprimer {host}', 'Remover {host}'],
  '{name}, hosty: {count}': ['{name}, hosts: {count}', '{name}, Hosts: {count}', '{name}, hosts: {count}', '{name}, hôtes : {count}', '{name}, anfitriões: {count}'],
  'Dodano {date}': ['Added {date}', 'Hinzugefügt am {date}', 'Añadido el {date}', 'Ajouté le {date}', 'Adicionado em {date}'],
  'Przesyłanie plików przez SFTP pojawi się w jednej z kolejnych wersji.': [
    'File transfer over SFTP is coming in a later version.',
    'Dateiübertragung per SFTP kommt in einer späteren Version.',
    'La transferencia de archivos por SFTP llegará en una versión posterior.',
    'Le transfert de fichiers par SFTP arrivera dans une version ultérieure.',
    'A transferência de ficheiros por SFTP chega numa versão posterior.',
  ],
} as const;
