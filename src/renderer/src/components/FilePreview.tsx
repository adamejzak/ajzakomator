import { useI18n } from '../i18n';
import { useEffect, useState } from 'react';
import type { ProjectFilePreview } from '../../../shared/types';
import { closeModal, useStore } from '../store';
import { fullProjectPath } from './ProjectExplorer';
import { IFile, IX } from './icons';

export function FilePreview({ projectId, relativePath }: { projectId: string; relativePath: string }) {
  const { tr, language, errorText } = useI18n();
  const project = useStore((st) => st.s.projects.find((p) => p.id === projectId));
  const [preview, setPreview] = useState<ProjectFilePreview | null>(null);
  const [wrap, setWrap] = useState(false);
  useEffect(() => {
    let cancelled = false;
    setPreview(null);
    window.mc.readProjectFile(projectId, relativePath)
      .then((value) => { if (!cancelled) setPreview(value); })
      .catch(() => { if (!cancelled) setPreview({ kind: 'error', message: tr("Nie udało się wczytać pliku.") }); });
    return () => { cancelled = true; };
  }, [projectId, project?.path, relativePath]);
  if (!project) return null;
  const path = fullProjectPath(project.path, relativePath);
  return (
    <div className="modal wide file-preview">
      <div className="modal-head">
        <IFile />
        <h3 title={relativePath}>{relativePath.split('/').pop()}</h3>
        <button className="btn ghost icon" aria-label={tr("Zamknij podgląd pliku")} onClick={closeModal}><IX /></button>
      </div>
      <div className="file-preview-toolbar">
        <span className="file-preview-path muted" title={path}>{project.name} / {relativePath}</span>
        {preview && preview.kind !== 'error' && <span className="muted">{new Intl.NumberFormat(language, { maximumFractionDigits: 1 }).format(preview.size / 1024)} KB</span>}
        {preview?.kind === 'text' && <button className={`btn small ${wrap ? 'primary' : ''}`} aria-pressed={wrap} onClick={() => setWrap((v) => !v)}>{tr("Zawijaj wiersze")}</button>}
      </div>
      {!preview && <div className="file-preview-message muted">{tr("Wczytywanie pliku…")}</div>}
      {preview?.kind === 'text' && (
        <>
          {preview.truncated && <div className="preview-notice">{tr("Podgląd pierwszych 256 KB. Cały plik możesz otworzyć w edytorze.")}</div>}
          <pre className={`file-content ${wrap ? 'wrap' : ''}`}>{preview.text || <span className="muted">{tr("Pusty plik")}</span>}</pre>
        </>
      )}
      {preview?.kind === 'binary' && <div className="file-preview-message muted">{tr("Ten plik jest binarny lub ma nieobsługiwane kodowanie. Otwórz go w edytorze albo menedżerze plików.")}</div>}
      {preview?.kind === 'error' && <div className="file-preview-message error">{errorText(preview.message)}</div>}
      <div className="modal-foot">
        <button className="btn ghost" onClick={() => window.mc.clipboardWrite(path)}>{tr("Kopiuj ścieżkę")}</button>
        <span style={{ flex: 1 }} />
        <button className="btn" onClick={() => window.mc.revealPath(path)}>{tr("Pokaż w menedżerze plików")}</button>
        <button className="btn white" onClick={() => window.mc.openInEditor(path)}>{tr("Otwórz w edytorze")}</button>
      </div>
    </div>
  );
}
