import { useI18n } from '../i18n';
import { activeProject } from '../../../shared/state';
import { createProject } from '../actions';
import { useStore } from '../store';
import { IPlus } from './icons';
import { ProjectExplorer } from './ProjectExplorer';

/** The Files panel: the tree of the active project and the "add project" shortcut under it. */
export function FilesPanel() {
  const { tr } = useI18n();
  const project = useStore((st) => activeProject(st.s));
  if (!project) return null;
  return (
    <div className="sidebar-content">
      <ProjectExplorer key={`${project.id}:${project.path}`} project={project} />
      <div className="side-footer"><button className="btn project-add-inline" onClick={() => void createProject()}><IPlus />{tr('Dodaj projekt')}</button></div>
    </div>
  );
}
