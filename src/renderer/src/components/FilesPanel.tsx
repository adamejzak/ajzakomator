import { activeProject } from '../../../shared/state';
import { useStore } from '../store';
import { ProjectExplorer } from './ProjectExplorer';
import './file-workspace.css';

/** The Files panel contains the active project's explorer. */
export function FilesPanel() {
  const project = useStore((st) => activeProject(st.s));
  if (!project) return null;
  return (
    <div className="sidebar-content files-panel">
      <ProjectExplorer key={`${project.id}:${project.path}`} project={project} />
    </div>
  );
}
