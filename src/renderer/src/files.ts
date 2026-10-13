import { create } from 'zustand';
import { detectLanguage, type Language } from '../../shared/languages';
import { askChoice, getS, getUi, setUi } from './store';
import { tr } from './i18n';
import { documentId, documentsUnder, removeDocuments, retargetDocuments, type FileMoveRecord } from '../../shared/fileOps';

export interface FileDocument {
  id: string;
  projectId: string;
  relativePath: string;
  name: string;
  text: string;
  savedText: string;
  diskText: string;
  status: 'loading' | 'ready' | 'error' | 'binary' | 'truncated';
  saving: boolean;
  error: string | null;
  wrap: boolean;
  markdownView?: 'preview' | 'source';
}
const labels = {
  dirty: ['Unsaved changes', 'Niezapisane zmiany', 'Ungespeicherte Änderungen', 'Cambios sin guardar', 'Modifications non enregistrées', 'Alterações não guardadas'],
  discard: ['Discard', 'Odrzuć', 'Verwerfen', 'Descartar', 'Ignorer', 'Descartar'],
  close: ['Save changes before closing?', 'Zapisać zmiany przed zamknięciem?', 'Änderungen vor dem Schließen speichern?', '¿Guardar antes de cerrar?', 'Enregistrer avant de fermer ?', 'Guardar antes de fechar?'],
  saving: ['Saving…', 'Zapisywanie…', 'Speichern…', 'Guardando…', 'Enregistrement…', 'A guardar…'],
  saved: ['Saved', 'Zapisano', 'Gespeichert', 'Guardado', 'Enregistré', 'Guardado'],
  tooLarge: ['This file exceeds 256 KB and cannot be edited safely here.', 'Ten plik przekracza 256 KB i nie może być tu bezpiecznie edytowany.', 'Diese Datei ist größer als 256 KB und kann hier nicht sicher bearbeitet werden.', 'Este archivo supera 256 KB y no se puede editar aquí con seguridad.', 'Ce fichier dépasse 256 Ko et ne peut pas être modifié ici en sécurité.', 'Este ficheiro excede 256 KB e não pode ser editado aqui em segurança.'],
  failed: ['Could not save. Your draft is preserved.', 'Nie udało się zapisać. Szkic został zachowany.', 'Speichern fehlgeschlagen. Der Entwurf bleibt erhalten.', 'No se pudo guardar. El borrador se conserva.', 'Échec de l’enregistrement. Le brouillon est conservé.', 'Não foi possível guardar. O rascunho foi preservado.'],
  conflict: ['The file changed outside the editor. Your draft is preserved.', 'Plik zmienił się poza edytorem. Twój szkic został zachowany.', 'Die Datei wurde außerhalb des Editors geändert. Der Entwurf bleibt erhalten.', 'El archivo cambió fuera del editor. El borrador se conserva.', 'Le fichier a été modifié en dehors de l’éditeur. Le brouillon est conservé.', 'O ficheiro foi alterado fora do editor. O rascunho foi preservado.'],
  invalid: ['Invalid file content.', 'Nieprawidłowa treść pliku.', 'Ungültiger Dateiinhalt.', 'Contenido de archivo no válido.', 'Contenu du fichier non valide.', 'Conteúdo de ficheiro inválido.'],
  binary: ['Binary files or unsupported encodings cannot be edited.', 'Nie można edytować pliku binarnego lub nieobsługiwanego kodowania.', 'Binärdateien oder nicht unterstützte Kodierungen können nicht bearbeitet werden.', 'No se pueden editar archivos binarios o codificaciones no admitidas.', 'Les fichiers binaires ou les encodages non pris en charge ne peuvent pas être modifiés.', 'Não é possível editar ficheiros binários ou codificações não suportadas.'],
} as const;
export function fileLabel(key: keyof typeof labels, language: Language = getS().settings.language ?? detectLanguage(navigator.languages)): string {
  return labels[key][['en', 'pl', 'de', 'es', 'fr', 'pt'].indexOf(language)];
}
export function fileErrorLabel(message: string, language: Language): string {
  const key = message === 'Plik zmienił się poza edytorem. Twój szkic został zachowany.' ? 'conflict'
    : message === 'Nieprawidłowa treść pliku.' ? 'invalid'
    : message === 'Plik jest zbyt duży do bezpiecznej edycji.' ? 'tooLarge'
    : message.startsWith('Nie można edytować pliku binarnego') ? 'binary' : null;
  return key ? fileLabel(key, language) : message;
}
const normalize = (text: string) => text.replace(/\r\n|\r/g, '\n');
const storageKey = 'mc-file-drafts-v1';
function restoreDrafts(): FileDocument[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(storageKey) ?? '[]');
    if (!Array.isArray(value)) return [];
    return value.filter((d): d is FileDocument => d && typeof d.id === 'string' && typeof d.projectId === 'string' && typeof d.relativePath === 'string' && typeof d.name === 'string' && typeof d.text === 'string' && typeof d.savedText === 'string' && typeof d.diskText === 'string')
      .map((d) => ({ ...d, status: 'ready', saving: false, error: null, wrap: Boolean(d.wrap) }));
  } catch { return []; }
}
export const useFileStore = create<{ documents: FileDocument[]; activeFileId: string | null }>(() => ({ documents: restoreDrafts(), activeFileId: null }));
function patch(id: string, changes: Partial<FileDocument>): void {
  useFileStore.setState((s) => ({ documents: s.documents.map((d) => d.id === id ? { ...d, ...changes } : d) }));
}
/** Set by the Files panel when a file is opened with the keyboard (Enter): the editor then takes focus. */
export const treeOpen = { keyboard: false, hold: false };
/** A rename or move from the tree re-creates editors: they must not steal the keyboard from the tree for a moment. */
export function holdTreeFocus(): void { treeOpen.hold = true; setTimeout(() => { treeOpen.hold = false; }, 600); }
export const isFileDirty = (d: FileDocument): boolean => d.text !== d.savedText;
export function activateFile(id: string): void {
  setUi({ settingsActive: false });
  if (useFileStore.getState().documents.some((d) => d.id === id)) useFileStore.setState({ activeFileId: id });
}
export function showTerminalTabs(): void { setUi({ settingsActive: false }); useFileStore.setState({ activeFileId: null }); }
export async function openFile(projectId: string, relativePath: string): Promise<void> {
  setUi({ settingsActive: false });
  const path = relativePath.replace(/\\/g, '/');
  const id = documentId(projectId, path);
  const existing = useFileStore.getState().documents.find((d) => d.id === id);
  if (existing) { activateFile(id); return; }
  const document: FileDocument = { id, projectId, relativePath: path, name: path.split('/').pop() ?? path, text: '', savedText: '', diskText: '', status: 'loading', saving: false, error: null, wrap: false };
  useFileStore.setState((s) => ({ documents: [...s.documents, document], activeFileId: id }));
  await retryFile(id);
}
const loads = new Map<string, symbol>();
export async function retryFile(id: string): Promise<void> {
  const doc = useFileStore.getState().documents.find((d) => d.id === id);
  if (!doc || isFileDirty(doc) || doc.saving) return;
  const token = Symbol(); loads.set(id, token);
  patch(id, { status: 'loading', error: null });
  try {
    const result = await window.mc.readProjectFile(doc.projectId, doc.relativePath);
    if (loads.get(id) !== token) return;
    if (result.kind === 'text') patch(id, { status: result.truncated ? 'truncated' : 'ready', text: normalize(result.text), savedText: normalize(result.text), diskText: result.text });
    else patch(id, { status: result.kind, error: result.kind === 'error' ? result.message : null });
  } catch (error) { if (loads.get(id) === token) patch(id, { status: 'error', error: String(error) }); }
  finally { if (loads.get(id) === token) loads.delete(id); }
}
export function editFile(id: string, text: string): void {
  const doc = useFileStore.getState().documents.find((d) => d.id === id);
  if (doc?.status === 'ready') patch(id, { text: normalize(text) });
}
export function toggleFileWrap(id: string): void {
  const doc = useFileStore.getState().documents.find((d) => d.id === id);
  if (doc) patch(id, { wrap: !doc.wrap });
}
export function setFileMarkdownView(id: string, markdownView: 'preview' | 'source'): void {
  patch(id, { markdownView });
}
export async function saveFile(id: string): Promise<boolean> {
  const doc = useFileStore.getState().documents.find((d) => d.id === id);
  if (!doc || doc.status !== 'ready' || doc.saving) return false;
  if (!isFileDirty(doc)) return true;
  patch(id, { saving: true, error: null });
  try {
    const result = await window.mc.writeProjectFile(doc.projectId, doc.relativePath, doc.text, doc.diskText);
    if (!result.ok) { patch(id, { error: result.error }); return false; }
    const endings = doc.diskText.match(/\r\n|\r|\n/g) ?? [];
    let index = 0;
    const diskText = doc.text.replace(/\n/g, () => endings[index++] ?? endings[0] ?? '\n');
    // Edits made while saving stay dirty against the snapshot that was written.
    patch(id, { savedText: doc.text, diskText });
    return true;
  } catch { patch(id, { error: fileLabel('failed') }); return false; }
  finally { patch(id, { saving: false }); }
}
const closing = new Set<string>();
export async function closeFile(id: string): Promise<boolean> {
  const doc = useFileStore.getState().documents.find((d) => d.id === id);
  if (!doc) return true;
  if (doc.saving || closing.has(id) || getUi().dialog) return false;
  closing.add(id);
  try {
    if (isFileDirty(doc)) {
      const choice = await askChoice(fileLabel('close'), doc.relativePath, [
        { label: tr('Zapisz'), value: 'save', primary: true },
        { label: fileLabel('discard'), value: 'discard', danger: true },
        { label: tr('Anuluj'), value: 'cancel' },
      ]);
      if (choice !== 'save' && choice !== 'discard') return false;
      if (choice === 'save' && (!await saveFile(id) || useFileStore.getState().documents.some((d) => d.id === id && isFileDirty(d)))) return false;
    }
    loads.delete(id);
    useFileStore.setState((s) => {
      const documents = s.documents.filter((d) => d.id !== id);
      const next = documents.filter((d) => d.projectId === doc.projectId).at(-1);
      return { documents, activeFileId: s.activeFileId === id ? next?.id ?? null : s.activeFileId };
    });
    return true;
  } finally { closing.delete(id); }
}
export function hasDirtyFiles(): boolean { return useFileStore.getState().documents.some(isFileDirty); }
useFileStore.subscribe((s) => {
  try { localStorage.setItem(storageKey, JSON.stringify(s.documents.filter(isFileDirty))); } catch { /* In-memory drafts still remain protected by close confirmation. */ }
});

/** Open tabs follow renamed or moved files and folders (their text and unsaved changes stay untouched). */
export function retargetOpenFiles(projectId: string, moves: FileMoveRecord[]): void {
  const before = useFileStore.getState();
  const result = retargetDocuments(before.documents, before.activeFileId, projectId, moves);
  if (!result.changed) return;
  const oldIds = new Set(before.documents.map((d) => d.id));
  const reload = result.documents.filter((d) => d.status === 'loading' && !oldIds.has(d.id)).map((d) => d.id);
  for (const doc of before.documents) loads.delete(doc.id);
  useFileStore.setState({ documents: result.documents, activeFileId: result.activeId });
  for (const id of reload) void retryFile(id);
}

/** Tabs of trashed files: clean ones close, tabs with unsaved changes stay (marked) so the draft is not lost. */
export function forgetDeletedFiles(projectId: string, paths: string[]): void {
  const state = useFileStore.getState();
  const ids = documentsUnder(state.documents, projectId, paths);
  if (!ids.length) return;
  const keep = new Set(ids.filter((id) => state.documents.some((d) => d.id === id && isFileDirty(d))));
  const gone = ids.filter((id) => !keep.has(id));
  for (const id of ids) loads.delete(id);
  const removed = removeDocuments(state.documents, state.activeFileId, gone);
  useFileStore.setState({
    documents: removed.documents.map((d) => keep.has(d.id) ? { ...d, error: 'Ten plik został usunięty z dysku. Niezapisany szkic został zachowany.' } : d),
    activeFileId: removed.activeId,
  });
}

/** Closes several tabs one by one (each unsaved one asks first); stops when the user cancels. */
export async function closeFiles(ids: string[]): Promise<void> {
  for (const id of ids) if (!await closeFile(id)) return;
}
