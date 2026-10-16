// The SSH editor view in the main area (spec 10.2): one tab per host or key, plus "new key" tabs.
// The tab title text lives in ../../ssh.ts (sshEditorTitleText), so the tab strip does not load this lazy screen (L11).
import { useI18n } from '../../i18n';
import { useStore } from '../../store';
import { useSshStore } from '../../sshStore';
import { HostEditor } from './HostEditor';
import { KeyEditor } from './KeyEditor';
import { NewKeyEditor } from './NewKeyEditor';
import './ssh.css';

export function SshEditorScreen() {
  const { tr } = useI18n();
  const editor = useSshStore((st) => st.editors.find((e) => e.id === st.activeEditorId));
  const hostExists = useStore((st) => !editor?.targetId || editor.kind !== 'host' || st.s.sshHosts.some((h) => h.id === editor.targetId));
  if (!editor) return null;
  return (
    <div className="ssh-editor-screen">
      {editor.kind === 'host' && (hostExists
        ? <HostEditor key={editor.id + (editor.targetId ?? '')} editorId={editor.id} hostId={editor.targetId} />
        : <div className="ssh-editor"><p className="ssh-card-hint">{tr('Ten host został usunięty')}</p></div>)}
      {editor.kind === 'key' && editor.targetId && <KeyEditor key={editor.id + editor.targetId} editorId={editor.id} keyId={editor.targetId} />}
      {editor.kind === 'newKey' && <NewKeyEditor key={editor.id} editorId={editor.id} />}
    </div>
  );
}
