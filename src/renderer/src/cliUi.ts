// Small renderer helpers around the CLI status (kept out of actions.ts so components can import them cheaply).
import { profileAvailable, type CliStatusMap } from '../../shared/cliStatus';
import type { MessageKey, MessageParams } from '../../shared/i18n';
import type { Profile } from '../../shared/types';

/** Profile name for menus and selects; profiles whose CLI is not installed stay selectable but are annotated. */
export function profileOptionLabel(
  profile: Pick<Profile, 'name' | 'cli'>,
  cliStatus: CliStatusMap,
  tr: (key: MessageKey, params?: MessageParams) => string,
): string {
  return profileAvailable(profile, cliStatus) ? profile.name : `${profile.name} ${tr('(niezainstalowany)')}`;
}
