import type { SwapError } from './accounts';

// Texts for "Make main account" (swapping a saved Claude account into the machine's own login).
// Each row: English, German, Spanish, French, Portuguese. Polish is the key.
export const swapMessages = {
  'Ustaw jako główne': ['Make main account', 'Als Hauptkonto festlegen', 'Establecer como cuenta principal', 'Définir comme compte principal', 'Definir como conta principal'],
  'Ustawić {name} jako konto główne?': ['Make {name} the main account?', '{name} als Hauptkonto festlegen?', '¿Establecer {name} como cuenta principal?', 'Définir {name} comme compte principal ?', 'Definir {name} como conta principal?'],
  'Obecne konto główne ({current}) zostanie zachowane jako zapisane konto, a wybrane stanie się głównym logowaniem Claude Code. Otwarte sesje Claude przełączą się na nie przy następnej wiadomości, bez zamykania. Na macOS ta funkcja nie jest dostępna. Tokeny są wymieniane tylko na tym komputerze.': [
    'The current main account ({current}) is kept as a saved account and the selected one becomes the main Claude Code login. Open Claude sessions switch to it on their next message without being closed. Not available on macOS. Tokens are only exchanged on this computer.',
    'Das aktuelle Hauptkonto ({current}) bleibt als gespeichertes Konto erhalten, das gewählte wird zur Haupt-Anmeldung von Claude Code. Offene Claude-Sitzungen wechseln bei ihrer nächsten Nachricht dorthin, ohne geschlossen zu werden. Unter macOS nicht verfügbar. Tokens werden nur auf diesem Computer ausgetauscht.',
    'La cuenta principal actual ({current}) se conserva como cuenta guardada y la elegida pasa a ser el inicio de sesión principal de Claude Code. Las sesiones de Claude abiertas cambian a ella con su siguiente mensaje, sin cerrarse. No disponible en macOS. Los tokens solo se intercambian en este equipo.',
    'Le compte principal actuel ({current}) est conservé comme compte enregistré et celui choisi devient la connexion principale de Claude Code. Les sessions Claude ouvertes basculent dessus à leur prochain message, sans être fermées. Indisponible sous macOS. Les jetons ne sont échangés que sur cet ordinateur.',
    'A conta principal atual ({current}) é mantida como conta guardada e a escolhida passa a ser o início de sessão principal do Claude Code. As sessões do Claude abertas mudam para ela na mensagem seguinte, sem serem fechadas. Não disponível no macOS. Os tokens são trocados apenas neste computador.',
  ],
  'obecne konto główne': ['the current main account', 'das aktuelle Hauptkonto', 'la cuenta principal actual', 'le compte principal actuel', 'a conta principal atual'],
  'Limity tego konta są wyczerpane (100%), więc sesje mogą nie działać do czasu resetu.': ['This account has reached its limit (100%), so sessions may not work until it resets.', 'Dieses Konto hat sein Limit erreicht (100%), Sitzungen funktionieren evtl. erst nach dem Reset wieder.', 'Esta cuenta ha alcanzado su límite (100%), por lo que las sesiones pueden no funcionar hasta que se reinicie.', 'Ce compte a atteint sa limite (100%), les sessions peuvent ne pas fonctionner avant la réinitialisation.', 'Esta conta atingiu o limite (100%), por isso as sessões podem não funcionar até ser reposto.'],
  'Konto główne: {email}': ['Main account: {email}', 'Hauptkonto: {email}', 'Cuenta principal: {email}', 'Compte principal : {email}', 'Conta principal: {email}'],
  'Zmieniono konto główne.': ['The main account was changed.', 'Das Hauptkonto wurde geändert.', 'Se cambió la cuenta principal.', 'Le compte principal a été changé.', 'A conta principal foi alterada.'],
  'Nie udało się zmienić konta głównego.': ['Could not change the main account.', 'Das Hauptkonto konnte nicht geändert werden.', 'No se pudo cambiar la cuenta principal.', 'Impossible de changer le compte principal.', 'Não foi possível alterar a conta principal.'],
  'Zmiana konta głównego nie jest dostępna na macOS.': ['Changing the main account is not available on macOS.', 'Das Ändern des Hauptkontos ist unter macOS nicht verfügbar.', 'Cambiar la cuenta principal no está disponible en macOS.', 'Changer le compte principal n’est pas disponible sous macOS.', 'Alterar a conta principal não está disponível no macOS.'],
  'Trwa logowanie lub zmiana konta. Spróbuj za chwilę.': ['A sign-in or account change is in progress. Try again in a moment.', 'Eine Anmeldung oder Kontoänderung läuft gerade. Versuche es gleich noch einmal.', 'Hay un inicio de sesión o un cambio de cuenta en curso. Inténtalo de nuevo en un momento.', 'Une connexion ou un changement de compte est en cours. Réessayez dans un instant.', 'Está em curso um início de sessão ou uma mudança de conta. Tente novamente daqui a pouco.'],
  'Zmienna CLAUDE_CODE_OAUTH_TOKEN nadpisuje logowanie - usuń ją, aby przełączać konta': ['The CLAUDE_CODE_OAUTH_TOKEN variable overrides the sign-in - remove it to switch accounts', 'Die Variable CLAUDE_CODE_OAUTH_TOKEN überschreibt die Anmeldung - entferne sie, um Konten zu wechseln', 'La variable CLAUDE_CODE_OAUTH_TOKEN anula el inicio de sesión - elimínala para cambiar de cuenta', 'La variable CLAUDE_CODE_OAUTH_TOKEN remplace la connexion - supprimez-la pour changer de compte', 'A variável CLAUDE_CODE_OAUTH_TOKEN substitui o início de sessão - remova-a para trocar de conta'],
  'Brak głównego logowania Claude Code. Najpierw zaloguj się w Claude Code.': ['There is no main Claude Code sign-in. Sign in to Claude Code first.', 'Es gibt keine Haupt-Anmeldung bei Claude Code. Melde dich zuerst in Claude Code an.', 'No hay un inicio de sesión principal de Claude Code. Inicia sesión primero en Claude Code.', 'Aucune connexion principale à Claude Code. Connectez-vous d’abord à Claude Code.', 'Não existe início de sessão principal do Claude Code. Inicie sessão primeiro no Claude Code.'],
  'Nie znaleziono zapisanego logowania tego konta. Zaloguj się do niego ponownie.': ['The saved sign-in of this account was not found. Sign in to it again.', 'Die gespeicherte Anmeldung dieses Kontos wurde nicht gefunden. Melde dich erneut an.', 'No se encontró el inicio de sesión guardado de esta cuenta. Vuelve a iniciar sesión.', 'La connexion enregistrée de ce compte est introuvable. Reconnectez-vous.', 'O início de sessão guardado desta conta não foi encontrado. Inicie sessão novamente.'],
  'To konto jest już kontem głównym.': ['This account is already the main one.', 'Dieses Konto ist bereits das Hauptkonto.', 'Esta cuenta ya es la principal.', 'Ce compte est déjà le compte principal.', 'Esta conta já é a principal.'],
  'To samo konto jest już zapisane w aplikacji. Najpierw usuń zduplikowane zapisane konto.': ['The main account is already saved in the app. Remove the duplicate saved account first.', 'Das Hauptkonto ist bereits in der App gespeichert. Entferne zuerst das doppelte gespeicherte Konto.', 'La cuenta principal ya está guardada en la aplicación. Quita primero la cuenta guardada duplicada.', 'Le compte principal est déjà enregistré dans l’application. Supprimez d’abord le compte enregistré en double.', 'A conta principal já está guardada na aplicação. Remova primeiro a conta guardada duplicada.'],
  'Logowanie tego konta wygasło. Zaloguj się ponownie przez kartę konta.': ['The sign-in of this account expired. Sign in again via the account card.', 'Die Anmeldung dieses Kontos ist abgelaufen. Melde dich über die Kontokarte erneut an.', 'El inicio de sesión de esta cuenta caducó. Vuelve a iniciar sesión desde la tarjeta de la cuenta.', 'La connexion de ce compte a expiré. Reconnectez-vous depuis la carte du compte.', 'O início de sessão desta conta expirou. Inicie sessão novamente através do cartão da conta.'],
  'Nie udało się odświeżyć tokenu konta. Spróbuj ponownie.': ['Could not refresh the account token. Try again.', 'Das Token des Kontos konnte nicht erneuert werden. Versuche es erneut.', 'No se pudo renovar el token de la cuenta. Inténtalo de nuevo.', 'Impossible de renouveler le jeton du compte. Réessayez.', 'Não foi possível renovar o token da conta. Tente novamente.'],
  'Nic nie zostało zmienione - zamiana została wycofana, a dane są bezpieczne.': ['Nothing was changed - the swap was rolled back and your data is safe.', 'Es wurde nichts geändert - der Tausch wurde zurückgesetzt, deine Daten sind sicher.', 'No se cambió nada - el intercambio se revirtió y tus datos están a salvo.', 'Rien n’a été modifié - l’échange a été annulé et vos données sont en sécurité.', 'Nada foi alterado - a troca foi revertida e os seus dados estão seguros.'],
} as const;

type SwapKey = keyof typeof swapMessages;

const ERROR_KEYS: Record<SwapError, SwapKey> = {
  unsupported: 'Zmiana konta głównego nie jest dostępna na macOS.',
  invalid: 'Nie udało się zmienić konta głównego.',
  busy: 'Trwa logowanie lub zmiana konta. Spróbuj za chwilę.',
  envToken: 'Zmienna CLAUDE_CODE_OAUTH_TOKEN nadpisuje logowanie - usuń ją, aby przełączać konta',
  noMain: 'Brak głównego logowania Claude Code. Najpierw zaloguj się w Claude Code.',
  noTarget: 'Nie znaleziono zapisanego logowania tego konta. Zaloguj się do niego ponownie.',
  sameAccount: 'To konto jest już kontem głównym.',
  duplicate: 'To samo konto jest już zapisane w aplikacji. Najpierw usuń zduplikowane zapisane konto.',
  dead: 'Logowanie tego konta wygasło. Zaloguj się ponownie przez kartę konta.',
  transient: 'Nie udało się odświeżyć tokenu konta. Spróbuj ponownie.',
  write: 'Nic nie zostało zmienione - zamiana została wycofana, a dane są bezpieczne.',
};

/** Translation key (the Polish source text) of the message shown for a failed swap; unknown values get the generic one. */
export function swapErrorKey(error: unknown): SwapKey {
  return typeof error === 'string' && Object.prototype.hasOwnProperty.call(ERROR_KEYS, error)
    ? ERROR_KEYS[error as SwapError]
    : 'Nie udało się zmienić konta głównego.';
}
