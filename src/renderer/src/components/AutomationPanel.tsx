import { RoleSelect } from './RoleSelect';
import { changeAgentRole } from '../agentRoles';
import { useEffect, useState } from 'react';
import { activeProject, getProfile } from '../../../shared/state';
import { taskPrompt, type AgentRuntimeStatus, type AutomationInput, type AutomationOperation, type TaskStatus } from '../../../shared/automation';
import { focusCell } from '../actions';
import { useI18n } from '../i18n';
import { setUi, toast, useStore } from '../store';
import { IX } from './icons';

const taskLabels = { queued: 'W kolejce', in_progress: 'W trakcie', blocked: 'Zablokowane', completed: 'Ukończone', cancelled: 'Anulowane' } as const;
const runtimeLabels = { starting: 'Uruchamianie', working: 'pracuje', ready: 'Gotowy', needs_attention: 'Wymaga uwagi', unknown: 'Brak potwierdzenia', exited: 'zakończony' } as const;

export function AutomationPanel() {
  const { tr, errorText } = useI18n();
  const state = useStore((s) => s.s);
  const info = useStore((s) => s.ui.mcpInfo);
  const project = activeProject(state);
  const [tab, setTab] = useState<'agents' | 'tasks' | 'messages' | 'activity'>('tasks');
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [composing, setComposing] = useState(false);
  const [target, setTarget] = useState('');
  const [title, setTitle] = useState('');
  const [prompt, setPrompt] = useState('');
  const [busy, setBusy] = useState(false);
  const [runtime, setRuntime] = useState<Record<string, AgentRuntimeStatus>>({});
  const agents = project?.tabs.flatMap((grid) => grid.cells.filter((cell) => getProfile(state, cell.profileId).cli !== 'shell').map((cell) => ({ cell, grid }))) ?? [];
  const recipients = agents.filter(({ cell }) => cell.role);
  const targetId = recipients.some(({ cell }) => cell.id === target) ? target : recipients[0]?.cell.id ?? '';
  const tasks = state.automation.tasks.filter((task) => task.projectId === project?.id);
  const messages = state.automation.messages.filter((message) => message.projectId === project?.id);
  const label = (cellId?: string) => cellId ? agents.find(({ cell }) => cell.id === cellId)?.cell.name ?? agents.find(({ cell }) => cell.id === cellId)?.grid.name ?? tr('Agent niedostępny') : tr('Ty');

  useEffect(() => { setTarget(''); setTitle(''); setPrompt(''); setSelectedTaskId(null); setComposing(false); }, [project?.id]);

  useEffect(() => {
    if (!project) return;
    let disposed = false;
    const refresh = async () => {
      try {
        const list = await window.mc.automation('list_agents', { projectId: project.id }) as Array<{ cellId: string; status: AgentRuntimeStatus }>;
        if (!disposed) setRuntime(Object.fromEntries(list.map((a) => [a.cellId, a.status])));
      } catch { /* The project may have been removed while the request was pending. */ }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 2000);
    return () => { disposed = true; clearInterval(timer); };
  }, [project?.id]);

  const run = async <K extends AutomationOperation,>(operation: K, args: AutomationInput<K>): Promise<boolean> => {
    setBusy(true);
    try { await window.mc.automation(operation, args); return true; }
    catch (error) { toast(errorText(String(error).replace(/^Error: /, '')), 'error'); return false; }
    finally { setBusy(false); }
  };
  const copy = (text: string) => { window.mc.clipboardWrite(text); toast(tr('Skopiowano. Wklej do wybranego agenta.')); };
  const delivery = (value: string) => tr(value === 'native' ? 'Przekazano do sesji' : value === 'startup' ? 'Prompt startowy' : 'W skrzynce agenta');

  return <section className="automation-panel" aria-label={tr('Zadania i wiadomości agentów')}>
    <div className="automation-head">
      <strong>{tr('Zespół AI')}</strong>
      <span className={`mcp-state ${info.running ? 'connected' : ''}`} title={info.error ?? info.url}>{info.running ? tr('Serwer MCP działa') : tr('MCP niedostępne')}</span>
      <span className="grow" />
      {tab === 'tasks' && <button className="btn small" onClick={() => { setComposing((v) => !v); setSelectedTaskId(null); }}>{composing ? tr('Zamknij') : '+ ' + tr('Nowe zadanie')}</button>}
      <button className={`btn small ${state.automation.paused ? 'paused' : ''}`} disabled={busy} onClick={() => void run('set_paused', { paused: !state.automation.paused })}>
        {tr(state.automation.paused ? 'Wznów automatyzację' : 'Wstrzymaj automatyzację')}
      </button>
      <button className="btn small" aria-label={tr('Zamknij')} onClick={() => setUi({ automationOpen: false })}><IX /></button>
    </div>
    <div className="automation-tabs" role="tablist" aria-label={tr('Zespół AI')}>
      {(['agents', 'tasks', 'messages', 'activity'] as const).map((item) => <button key={item} role="tab" aria-selected={tab === item} className={tab === item ? 'active' : ''} onClick={() => { setTab(item); setSelectedTaskId(null); setComposing(false); }}>
        {tr({ agents: 'Agenci', tasks: 'Zadania', messages: 'Wiadomości', activity: 'Aktywność' }[item] as 'Agenci' | 'Zadania' | 'Wiadomości' | 'Aktywność')}
        {item === 'tasks' ? ` (${tasks.filter((t) => !['completed', 'cancelled'].includes(t.status)).length})` : item === 'messages' ? ` (${messages.filter((m) => !m.readAt).length})` : ''}
      </button>)}
    </div>
    {state.automation.paused && <div className="automation-note">{tr('Automatyzacja wstrzymana. Wyniki trwających zadań nadal można odebrać.')}</div>}
    {!project ? <div className="automation-empty">{tr('Najpierw dodaj projekt')}</div> : <div className="automation-content">
      {((tab === 'tasks' && composing) || tab === 'messages') && <form className="automation-compose" onSubmit={(event) => {
        event.preventDefault();
        if (!targetId || !prompt.trim()) return;
        void run(tab === 'tasks' ? 'create_task' : 'send_message', tab === 'tasks'
          ? { cellId: targetId, title: title.trim(), prompt: prompt.trim() }
          : { toCellId: targetId, text: prompt.trim() }).then((ok) => { if (ok) { setTitle(''); setPrompt(''); setComposing(false); } });
      }}>
        <label>{tr('Odbiorca')}<select className="select" value={targetId} disabled={busy || !recipients.length} onChange={(e) => setTarget(e.target.value)}>
          {!recipients.length && <option value="">{tr('Brak agentów')}</option>}
          {recipients.map(({ cell, grid }) => <option key={cell.id} value={cell.id}>{grid.name} · {cell.name ?? getProfile(state, cell.profileId).name}</option>)}
        </select></label>
        {tab === 'tasks' && <label>{tr('Tytuł zadania')}<input className="input" disabled={busy} required maxLength={140} value={title} onChange={(e) => setTitle(e.target.value)} /></label>}
        <label>{tr(tab === 'tasks' ? 'Treść zadania' : 'Wiadomość')}<textarea className="textarea" disabled={busy} required maxLength={32000} value={prompt} onChange={(e) => setPrompt(e.target.value)} /></label>
        <button className="btn white" disabled={busy || !targetId || state.automation.paused}>{tr(tab === 'tasks' ? 'Przydziel zadanie' : 'Wyślij wiadomość')}</button>
        <p className="muted">{tr('Zadania i wiadomości trafiają do skrzynki MCP. Potwierdzone sesje Codexa otrzymują je także przez kolejkę.')}</p>
      </form>}
      <div className="automation-list" role="tabpanel">
        {tab === 'agents' && <>
          <p className="muted">{tr('Koordynator może tworzyć zespoły i przydzielać zadania innym agentom.')}</p>
          {!agents.length && <p className="automation-empty">{tr('Brak agentów')}</p>}
          {agents.map(({ cell, grid }) => <article className="automation-card" key={cell.id}>
            <div className="row"><strong>{cell.name ?? getProfile(state, cell.profileId).name}</strong><span className="grow" /><span className="muted">{tr(runtimeLabels[runtime[cell.id] ?? 'unknown'])}</span></div>
            {cell.role && <span className={`agent-mcp-status ${info.connectedCellIds?.includes(cell.id) ? 'connected' : ''}`}>{tr(info.connectedCellIds?.includes(cell.id) ? 'MCP działa' : info.configuredCellIds?.includes(cell.id) ? 'MCP skonfigurowane · oczekiwanie na agenta' : 'Wymaga restartu')}
              {!info.configuredCellIds?.includes(cell.id) && <button className="btn small" onClick={() => void changeAgentRole(cell.id, cell.role!)}>{tr('Uruchom ponownie')}</button>}</span>}
            <span className="muted">{grid.name}{cell.worktree ? ` · ${cell.worktree.branch}` : ''}</span>
            <div className="row">
              <RoleSelect value={cell.role} disabled={busy} onChange={(role) => void changeAgentRole(cell.id, role ?? null)} />
              <button className="btn small" onClick={() => focusCell(cell.id)}>{tr('Otwórz agenta')}</button>
              {getProfile(state, cell.profileId).cli === 'codex' && !cell.session?.confirmed && <button className="btn small" onClick={() => { focusCell(cell.id); setUi({ modal: { kind: 'history', projectId: project.id } }); }}>{tr('Wybierz sesję z historii')}</button>}
            </div>
          </article>)}
          <p className="muted">{tr('Po zmianie roli uruchom agenta ponownie, aby włączyć MCP.')}</p>
        </>}
        {tab === 'tasks' && <>
          {selectedTaskId && <button className="btn small task-back" onClick={() => setSelectedTaskId(null)}>← {tr('Wróć do zadań')}</button>}
          {!tasks.length && <p className="automation-empty">{tr('Brak zadań. Przydziel pierwsze zadanie agentowi.')}</p>}
          <div className={selectedTaskId ? 'task-detail-list' : 'task-card-grid'}>
          {[...tasks].reverse().filter((task) => !selectedTaskId || task.id === selectedTaskId).map((task) => <article className={`automation-card task-${task.status} ${selectedTaskId ? 'task-detail' : 'task-summary'}`} key={task.id}>
            {!selectedTaskId ? <button className="task-open" onClick={() => { setSelectedTaskId(task.id); setComposing(false); }}>
              <div className="task-summary-head"><strong title={task.title}>{task.title}</strong><span className="task-state">{tr(taskLabels[task.status])}</span></div>
              <span className="muted">{label(task.cellId)}</span>
              <span className="task-summary-foot">{delivery(task.delivery)} <span>↗</span></span>
            </button> : <>
            <div className="row"><strong>{task.title}</strong><span className="grow" /><span className="task-state">{tr(taskLabels[task.status as TaskStatus])}</span></div>
            <span className="muted">{label(task.cellId)} · {delivery(task.delivery)}</span>
            <details><summary>{tr('Treść zadania')}</summary><p className="automation-text">{task.prompt}</p></details>
            {task.blockedReason && <p className="automation-text blocked-reason">{task.blockedReason}</p>}
            {task.result && <details open><summary>{tr('Wynik zadania')}</summary>
              <p className="automation-text">{task.result.summary}</p>
              {(task.result.branch || task.result.commit) && <p className="muted">{[task.result.branch, task.result.commit].filter(Boolean).join(' · ')}</p>}
              {task.result.files.length > 0 && <p className="automation-text"><strong>{tr('Pliki')}: </strong>{task.result.files.join(', ')}</p>}
              {task.result.tests.length > 0 && <p className="automation-text"><strong>{tr('Testy')}: </strong>{task.result.tests.join('\n')}</p>}
            </details>}
            {task.deliveryError && task.status === 'queued' && <p className="muted">{tr('Oczekuje w skrzynce. Możesz skopiować prompt do terminala.')}</p>}
            <div className="row wrap">
              <button className="btn small" disabled={!agents.some(({ cell }) => cell.id === task.cellId)} onClick={() => focusCell(task.cellId)}>{tr('Otwórz agenta')}</button>
              {!['completed', 'cancelled'].includes(task.status) && <>
                <button className="btn small" onClick={() => copy(taskPrompt(task))}>{tr('Kopiuj prompt')}</button>
                {task.delivery === 'pending' && <button className="btn small" disabled={busy || state.automation.paused} onClick={() => void run('deliver_task', { taskId: task.id })}>{tr('Ponów dostarczenie')}</button>}
                <button className="btn small" disabled={busy} onClick={() => void run('update_task', { taskId: task.id, status: 'cancelled' })}>{tr('Anuluj zadanie')}</button>
              </>}
            </div>
          </>}
          </article>)}
          </div>
        </>}
        {tab === 'messages' && <>
          {!messages.length && <p className="automation-empty">{tr('Brak wiadomości')}</p>}
          {[...messages].reverse().map((message) => <article className="automation-card" key={message.id}>
            <div className="row"><strong>{label(message.fromCellId)} → {label(message.toCellId)}</strong><span className="grow" /><span className="muted">{message.readAt ? tr('Przeczytane') : delivery(message.delivery)}</span></div>
            <p className="automation-text">{message.text}</p>
            <div className="row wrap">
              <button className="btn small" disabled={!agents.some(({ cell }) => cell.id === message.toCellId)} onClick={() => focusCell(message.toCellId)}>{tr('Otwórz agenta')}</button>
              <button className="btn small" onClick={() => copy(`[Ajzakomator message ${message.id}]\n${message.text}\nUse acknowledge_message to mark this message as read.`)}>{tr('Kopiuj prompt')}</button>
              {message.delivery === 'pending' && !message.readAt && <button className="btn small" disabled={busy || state.automation.paused} onClick={() => void run('deliver_message', { messageId: message.id })}>{tr('Ponów dostarczenie')}</button>}
              {!message.readAt && <button className="btn small" disabled={busy} onClick={() => void run('acknowledge_message', { messageId: message.id })}>{tr('Oznacz jako przeczytane')}</button>}
            </div>
          </article>)}
        </>}
        {tab === 'activity' && <>
          {!state.automation.events.some((e) => e.projectId === project.id) && <p className="automation-empty">{tr('Brak aktywności')}</p>}
          {state.automation.events.filter((e) => e.projectId === project.id).slice(-50).reverse().map((event) => <article className="automation-card" key={event.id}>
            <div className="row"><strong>{event.detail}</strong><span className="grow" /><time className="muted">{new Date(event.createdAt).toLocaleTimeString()}</time></div>
            <span className="muted">{label(event.cellId)}</span>
          </article>)}
        </>}
      </div>
    </div>}
  </section>;
}
