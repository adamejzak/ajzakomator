// The panels the left rail can switch between. To add one (SSH terminal, Git ...): write its component and add one entry here;
// the rail, the keyboard handling and the resolving of a stored or unknown id come from shared/sidebarPanels.ts.
//   id               stable identifier (also what `ui.sidebarView` holds)
//   label            Polish translation key, shown as tile tooltip, accessible name and panel title
//   icon             tile icon (18px, 24px grid, see icons.tsx)
//   component        the panel content; it fills the column to the right of the rail
//   available        optional: false hides the tile altogether (platform, feature switch)
//   unavailableReason optional: the tile is shown but disabled, with this reason as its tooltip
import type { ComponentType, ReactNode } from 'react';
import type { MessageKey } from '../../shared/i18n';
import { gitPanelReason, type PanelContext, type PanelDef } from '../../shared/sidebarPanels';
import { FilesPanel } from './components/FilesPanel';
import { GitPanel } from './components/GitPanel';
import { TFiles, TGit, TProjects, TTerminal } from './components/icons';
import type { PanelResizeProps } from './components/PanelResizeHandle';
import { ProjectsPanel } from './components/ProjectsPanel';
import { TerminalPanel } from './components/TerminalPanel';

export interface PanelProps { resize: PanelResizeProps }

export interface SidebarPanel extends Omit<PanelDef, 'unavailableReason'> {
  label: MessageKey;
  icon: () => ReactNode;
  component: ComponentType<PanelProps>;
  unavailableReason?: (ctx: PanelContext) => MessageKey | null;
}

export const SIDEBAR_PANELS: readonly SidebarPanel[] = [
  { id: 'projects', label: 'Projekty', icon: TProjects, component: ProjectsPanel },
  { id: 'files', label: 'Pliki', icon: TFiles, component: FilesPanel, unavailableReason: (ctx) => (ctx.hasProject ? null : 'Najpierw dodaj projekt') },
  // Git needs a project that is a repository (the tile is disabled, with the reason as its tooltip, otherwise); Terminal is always there.
  { id: 'git', label: 'Git', icon: TGit, component: GitPanel, unavailableReason: gitPanelReason },
  { id: 'terminal', label: 'Terminal', icon: TTerminal, component: TerminalPanel },
];
