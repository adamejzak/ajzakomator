import { useEffect } from 'react';
import { CodeEditor } from './CodeEditor';
import { closeFile, editFile, fileErrorLabel, fileLabel, isFileDirty, retryFile, saveFile, toggleFileWrap, useFileStore } from '../files';
import { useI18n } from '../i18n';
import { getUi, useStore } from '../store';
import { fullProjectPath } from '../../../shared/platform';

export function FileEditor() {
  const { tr, language, errorText } = useI18n();
  const doc = useFileStore((s) => s.documents.find((d) => d.id === s.activeFileId));
  const project = useStore((s) => s.s.projects.find((p) => p.id === doc?.projectId));
  useEffect(() => {
    if (!doc) return;
    const onKey = (event: KeyboardEvent) => {
      if (getUi().dialog || getUi().modal || getUi().palette) return;
      if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && event.code === 'KeyS') {
        event.preventDefault(); event.stopPropagation(); void saveFile(doc.id);
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [doc?.id]);
  if (!doc) return null;
  const dirty = isFileDirty(doc);
  const path = project ? fullProjectPath(project.path, doc.relativePath, window.mc.platform) : doc.relativePath;
  return (
    <section className="file-editor" aria-label={doc.relativePath} style={{ display: 'flex', flexDirection: 'column', flex: 1, minWidth: 0, minHeight: 0, height: '100%', overflow: 'hidden' }}>
      <div className="file-preview-toolbar" style={{ flexShrink: 0 }}>
        <span className="file-preview-path muted" title={path}>{project?.name} / {doc.relativePath}</span>
        <span role="status" className="muted">{doc.saving ? fileLabel('saving', language) : dirty ? `● ${fileLabel('dirty', language)}` : doc.status === 'ready' ? fileLabel('saved', language) : ''}</span>
        <button className={`btn small ${doc.wrap ? 'primary' : ''}`} aria-pressed={doc.wrap} onClick={() => toggleFileWrap(doc.id)}>{tr('Zawijaj wiersze')}</button>
        <button className="btn small primary" disabled={!dirty || doc.saving || doc.status !== 'ready'} onClick={() => void saveFile(doc.id)}>{tr('Zapisz')}</button>
        <button className="btn small" aria-label={tr('Zamknij podgląd pliku')} onClick={() => void closeFile(doc.id)}>×</button>
      </div>
      {doc.error && <div className="preview-notice error" role="alert" style={{ whiteSpace: 'pre-wrap' }}>{errorText(fileErrorLabel(doc.error, language))}</div>}
      {doc.status === 'loading' && <div className="file-preview-message muted">{tr('Wczytywanie pliku…')}</div>}
      {doc.status === 'ready' && <CodeEditor key={doc.id} path={doc.relativePath} text={doc.text} wrap={doc.wrap} onChange={text => editFile(doc.id, text)} />}
      {doc.status === 'binary' && <div className="file-preview-message muted">{tr('Ten plik jest binarny lub ma nieobsługiwane kodowanie. Otwórz go w edytorze albo menedżerze plików.')}</div>}
      {doc.status === 'truncated' && <div className="file-preview-message muted">{fileLabel('tooLarge', language)}</div>}
      {doc.status !== 'loading' && doc.status !== 'ready' && <div style={{ padding: 16, display: 'flex', gap: 8 }}>
        <button className="btn" onClick={() => void retryFile(doc.id)}>{tr('Spróbuj ponownie')}</button>
        {project && <button className="btn" onClick={() => window.mc.openInEditor(path)}>{tr('Otwórz w edytorze')}</button>}
      </div>}
    </section>
  );
}
