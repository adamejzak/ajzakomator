// Typical start options of the agent CLIs, offered as switches on the profile page. They only edit the profile's argument string.
import type { CliKind } from './types';
import type { MessageKey } from './i18n';

export interface AgentPreset {
  /** The exact text appended to the arguments. */
  flag: string;
  /** What it does, in plain words (shown before the option is switched on). */
  hint: MessageKey;
  /** Switching it on skips the safety questions: shown with a warning. */
  risky?: boolean;
  /** Options of one group exclude each other (two models). */
  group?: string;
}

export const AGENT_PRESETS: Record<CliKind, AgentPreset[]> = {
  claude: [
    { flag: '--dangerously-skip-permissions', risky: true, hint: 'Tryb YOLO: agent wykonuje polecenia i zmienia pliki bez pytania o zgodę. Używaj tylko w zaufanych projektach.' },
    { flag: '--permission-mode plan', hint: 'Agent najpierw układa plan i niczego nie zmienia, dopóki go nie zatwierdzisz.' },
    { flag: '--model opus', group: 'model', hint: 'Najmocniejszy model Claude: najlepszy do trudnych zadań, ale wolniejszy i droższy.' },
    { flag: '--model sonnet', group: 'model', hint: 'Szybszy i tańszy model do codziennej pracy.' },
  ],
  codex: [
    { flag: '--yolo', risky: true, hint: 'Tryb YOLO: bez zatwierdzeń i bez piaskownicy, Codex robi wszystko sam. Używaj tylko w zaufanych projektach.' },
    { flag: '--full-auto', group: 'autonomy', hint: 'Codex pracuje sam w piaskownicy z zapisem w folderze projektu, bez pytań. Bezpieczniejsze niż YOLO.' },
    { flag: '--search', hint: 'Pozwala agentowi szukać informacji w internecie.' },
    { flag: '-c model_reasoning_effort=high', hint: 'Wyższy wysiłek rozumowania: dokładniejsze, ale wolniejsze odpowiedzi.' },
  ],
  shell: [],
};

const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const pattern = (flag: string): RegExp => new RegExp(`(^|\\s)${escape(flag)}(?=\\s|$)`);

export const hasFlag = (args: string, flag: string): boolean => pattern(flag).test(args);

const without = (args: string, flag: string): string => args.replace(pattern(flag), ' ').replace(/\s{2,}/g, ' ').trim();

/** The arguments with the option switched on (its group mates are removed) or off; the rest of the text stays untouched. */
export function toggleFlag(args: string, kind: CliKind, flag: string, on: boolean): string {
  const preset = AGENT_PRESETS[kind].find((p) => p.flag === flag);
  let next = without(args, flag);
  if (!on) return next;
  if (preset?.group) for (const mate of AGENT_PRESETS[kind]) if (mate.group === preset.group) next = without(next, mate.flag);
  return next ? `${next} ${flag}` : flag;
}

/** The command line a cell of this profile starts with (for the preview). */
export const commandPreview = (kind: CliKind, args: string): string => (kind === 'shell' ? '' : `${kind}${args.trim() ? ` ${args.trim()}` : ''}`);
