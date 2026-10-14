import { useEffect } from 'react';
import { CodeEditor } from './CodeEditor';
import { closeFile, editFile, fileErrorLabel, fileLabel, isFileDirty, retryFile, saveFile, setFileMarkdownView, toggleFileWrap, useFileStore } from '../files';
import { isMarkdownPath, MarkdownPreview } from './MarkdownPreview';
import { useI18n } from '../i18n';
import { getUi, useStore } from '../store';
import { matchesShortcut } from '../shortcuts';
import { fullProjectPath } from '../../../shared/platform';
import { FileActionIcon, FileBreadcrumb } from './FileIcon';
import { IX } from './icons';

export function FileEditor() {
  const { tr, language, errorText } = useI18n();
  const doc = useFileStore((s) => s.documents.find((d) => d.id === s.activeFileId));
  const project = useStore((s) => s.s.projects.find((p) => p.id === doc?.projectId));
  useEffect(() => {
    if (!doc) return;
    const onKey = (event: KeyboardEvent) => {
      if (getUi().dialog || getUi().modal || getUi().palette) return;
      if (matchesShortcut('editor.save', event)) {
        event.preventDefault(); event.stopPropagation(); void saveFile(doc.id);
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [doc?.id]);
  if (!doc) return null;
  const dirty = isFileDirty(doc);
  const markdown = isMarkdownPath(doc.relativePath);
  const preview = markdown && doc.markdownView !== 'source';
  const viewLabels = {
    en: ['Preview', 'Edit source'], pl: ['Podgląd', 'Edytuj źródło'], de: ['Vorschau', 'Quelltext bearbeiten'],
    es: ['Vista previa', 'Editar código'], fr: ['Aperçu', 'Modifier la source'], pt: ['Pré-visualização', 'Editar fonte'],
  }[language];
  const path = project ? fullProjectPath(project.path, doc.relativePath, window.mc.platform) : doc.relativePath;
  return (
    <section className="file-editor file-workspace-editor" aria-label={doc.relativePath}>
      <div className="file-editor-toolbar">
        <FileBreadcrumb projectName={project?.name} relativePath={doc.relativePath} fullPath={path} />
        <span role="status" className={`editor-save-status ${dirty ? 'dirty' : ''}`}>{doc.saving ? fileLabel('saving', language) : dirty ? `● ${fileLabel('dirty', language)}` : doc.status === 'ready' ? fileLabel('saved', language) : ''}</span>
        <div className="file-editor-actions">
          {markdown && <div className="markdown-view-toggle" role="group" aria-label="Markdown">
            <button className={`btn ghost small ${preview ? 'active' : ''}`} aria-pressed={preview} onClick={() => setFileMarkdownView(doc.id, 'preview')}>{viewLabels[0]}</button>
            <button className={`btn ghost small ${!preview ? 'active' : ''}`} aria-pressed={!preview} onClick={() => setFileMarkdownView(doc.id, 'source')}>{viewLabels[1]}</button>
          </div>}
          {!preview && <button className={`btn ghost icon ${doc.wrap ? 'active' : ''}`} title={tr('Zawijaj wiersze')} aria-label={tr('Zawijaj wiersze')} aria-pressed={doc.wrap} onClick={() => toggleFileWrap(doc.id)}><FileActionIcon kind="wrap" /></button>}
          <button className={`btn ghost icon ${dirty ? 'save-dirty' : ''}`} title={tr('Zapisz')} aria-label={tr('Zapisz')} disabled={!dirty || doc.saving || doc.status !== 'ready'} onClick={() => void saveFile(doc.id)}><FileActionIcon kind="save" /></button>
          <button className="btn ghost icon" title={tr('Zamknij podgląd pliku')} aria-label={tr('Zamknij podgląd pliku')} onClick={() => void closeFile(doc.id)}><IX /></button>
        </div>
      </div>
      {doc.error && <div className="preview-notice error" role="alert" style={{ whiteSpace: 'pre-wrap' }}>{errorText(fileErrorLabel(doc.error, language))}</div>}
      {doc.status === 'loading' && <div className="file-preview-message muted">{tr('Wczytywanie pliku…')}</div>}
      {doc.status === 'ready' && (preview
        ? <MarkdownPreview key={doc.id} text={doc.text} projectId={doc.projectId} path={doc.relativePath} />
        : <CodeEditor key={doc.id} path={doc.relativePath} text={doc.text} wrap={doc.wrap} onChange={text => editFile(doc.id, text)} />)}
      {doc.status === 'binary' && <div className="file-preview-message muted">{tr('Ten plik jest binarny lub ma nieobsługiwane kodowanie. Otwórz go w edytorze albo menedżerze plików.')}</div>}
      {doc.status === 'truncated' && <div className="file-preview-message muted">{fileLabel('tooLarge', language)}</div>}
      {doc.status !== 'loading' && doc.status !== 'ready' && <div style={{ padding: 16, display: 'flex', gap: 8 }}>
        <button className="btn" onClick={() => void retryFile(doc.id)}>{tr('Spróbuj ponownie')}</button>
        {project && <button className="btn" onClick={() => window.mc.openInEditor(path)}>{tr('Otwórz w edytorze')}</button>}
      </div>}
    </section>
  );
}
