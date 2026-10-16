// The SSH editor view in the main area (spec 10.2): one tab per host or key, plus "new key" tabs.
// Every open editor tab stays mounted (hidden when not active, like the Settings page), so unsaved input and a new-key
// draft survive switching to a grid, a file or another tab; an editor unmounts only when its tab closes or is retargeted.
// Typed secrets do not survive: a hidden pane clears its password, passphrase and pasted private key fields (D4).
// The tab title text lives in ../../ssh.ts (sshEditorTitleText), so the tab strip does not load this lazy screen (L11).
import { useI18n } from '../../i18n';
import { useStore } from '../../store';
import { useSshStore } from '../../sshStore';
import type { SshEditorRef } from '../../../../shared/ssh';
import { HostEditor } from './HostEditor';
import { KeyEditor } from './KeyEditor';
import { NewKeyEditor } from './NewKeyEditor';
import { PaneActive } from './paneVisibility';
import './ssh.css';

export function SshEditorScreen() {
  const visible = useStore((st) => !st.ui.settingsActive);
  const editors = useSshStore((st) => st.editors);
  const activeEditorId = useSshStore((st) => st.activeEditorId);
  return (
    <>
      {editors.map((editor) => (
        <div key={editor.id} className={`ssh-editor-screen ${visible && editor.id === activeEditorId ? 'active' : ''}`} data-editor-id={editor.id}>
          <PaneActive.Provider value={visible && editor.id === activeEditorId}><EditorPane editor={editor} /></PaneActive.Provider>
        </div>
      ))}
    </>
  );
}

function EditorPane({ editor }: { editor: SshEditorRef }) {
  const { tr } = useI18n();
  const hostExists = useStore((st) => !editor.targetId || editor.kind !== 'host' || st.s.sshHosts.some((h) => h.id === editor.targetId));
  if (editor.kind === 'host') {
    return hostExists
      ? <HostEditor key={editor.targetId ?? 'new'} editorId={editor.id} hostId={editor.targetId} />
      : <div className="ssh-editor"><p className="ssh-card-hint">{tr('Ten host został usunięty')}</p></div>;
  }
  if (editor.kind === 'key') return editor.targetId ? <KeyEditor key={editor.targetId} editorId={editor.id} keyId={editor.targetId} /> : null;
  return <NewKeyEditor key={editor.id} editorId={editor.id} initialMode={editor.targetId as 'generate' | 'file' | 'paste' | undefined} />;
}
