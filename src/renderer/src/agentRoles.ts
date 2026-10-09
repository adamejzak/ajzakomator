import type { AgentRole } from '../../shared/automation';
import { findCell } from '../../shared/state';
import { askChoice, getS, setUi, toast } from './store';
import { spawnCell } from './actions';
import { tr } from './i18n';

const changing = new Set<string>();
export async function changeAgentRole(cellId: string, role: AgentRole | null): Promise<void> {
  if (changing.has(cellId)) return;
  changing.add(cellId);
  try {
    const found = findCell(getS(), cellId);
    if (!found) return;
    const resume = !!found.cell.session;
    const choice = await askChoice(tr('Zastosuj rolę i uruchom agenta ponownie'),
      `${tr(role === 'coordinator' ? 'Koordynator' : role === 'worker' ? 'Wykonawca' : 'Bez MCP')}\n\n${tr(resume ? 'Rozmowa zostanie wznowiona. Nowa rola MCP zacznie działać po restarcie.' : 'Agent uruchomi nową rozmowę, ponieważ nie ma jeszcze zapisanej sesji.')}`,
      [{ label: tr('Zastosuj później'), value: 'later' }, { label: tr(resume ? 'Zastosuj i wznów' : 'Zastosuj i uruchom'), value: 'restart', primary: true }]);
    if (!choice) return;
    await window.mc.automation('set_role', { cellId, role });
    if (choice === 'restart') {
      await window.mc.killCellAndWait(cellId);
      await spawnCell(cellId, resume ? 'resume' : 'new');
    }
    setUi({ mcpInfo: await window.mc.getMcpInfo() });
  } catch (error) { toast(String(error), 'error'); }
  finally { changing.delete(cellId); }
}
