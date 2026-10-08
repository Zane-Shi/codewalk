import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { SourceLocation, SourceSelection } from './types';

type NavigationState = {
  current?: SourceLocation;
  back: SourceLocation[];
  forward: SourceLocation[];
};

type WorkspaceState = {
  projectId?: string;
  snapshotId?: string;
  filePath?: string;
  modelId?: string;
  activeAnnotationId?: string;
  minimized: boolean;
  filter: string;
  expanded: Record<string, string[]>;
  selection?: SourceSelection;
  initialQuestionOpen: boolean;
  sidebarTab: 'routes' | 'files';
  rightTab: 'teaching' | 'annotations';
  annotationScope: 'file' | 'all';
  activeRouteId?: string;
  activeModuleId?: string;
  activeBlockId?: string;
  leftCollapsed: boolean;
  rightCollapsed: boolean;
  leftPanelWidth: number;
  rightPanelWidth: number;
  navigation: Record<string, NavigationState>;
  set: (value: Partial<WorkspaceState>) => void;
  toggleFolder: (snapshotId: string, path: string) => void;
  expandParents: (snapshotId: string, file: string) => void;
  collapseFolders: (snapshotId: string) => void;
  navigateSource: (snapshotId: string, location: SourceLocation) => void;
  backSource: (snapshotId: string) => SourceLocation | undefined;
  forwardSource: (snapshotId: string) => SourceLocation | undefined;
};

export const useWorkspace = create<WorkspaceState>()(
  persist(
    (set) => ({
      minimized: false,
      filter: '',
      expanded: {},
      initialQuestionOpen: false,
      sidebarTab: 'routes',
      rightTab: 'teaching',
      annotationScope: 'file',
      leftCollapsed: false,
      rightCollapsed: false,
      leftPanelWidth: 260,
      rightPanelWidth: 400,
      navigation: {},
      set: (value) => set(value),
      toggleFolder: (snapshotId, path) =>
        set((state) => {
          const values = new Set(state.expanded[snapshotId] ?? []);
          if (values.has(path)) values.delete(path);
          else values.add(path);
          return { expanded: { ...state.expanded, [snapshotId]: [...values] } };
        }),
      expandParents: (snapshotId, file) =>
        set((state) => {
          const values = new Set(state.expanded[snapshotId] ?? []),
            parts = file.split('/');
          for (let index = 1; index < parts.length; index++)
            values.add(parts.slice(0, index).join('/'));
          return { expanded: { ...state.expanded, [snapshotId]: [...values] } };
        }),
      collapseFolders: (snapshotId) =>
        set((state) => ({ filter: '', expanded: { ...state.expanded, [snapshotId]: [] } })),
      navigateSource: (snapshotId, location) =>
        set((state) => {
          const history = state.navigation[snapshotId] ?? { back: [], forward: [] };
          const same =
            history.current && JSON.stringify(history.current) === JSON.stringify(location);
          return {
            navigation: {
              ...state.navigation,
              [snapshotId]: same
                ? { ...history, current: location }
                : {
                    current: location,
                    back: history.current
                      ? [...history.back, history.current].slice(-100)
                      : history.back,
                    forward: [],
                  },
            },
          };
        }),
      backSource: (snapshotId) => {
        let target: SourceLocation | undefined;
        set((state) => {
          const history = state.navigation[snapshotId];
          target = history?.back.at(-1);
          if (!history || !target) return state;
          return {
            navigation: {
              ...state.navigation,
              [snapshotId]: {
                current: target,
                back: history.back.slice(0, -1),
                forward: history.current
                  ? [history.current, ...history.forward].slice(0, 100)
                  : history.forward,
              },
            },
          };
        });
        return target;
      },
      forwardSource: (snapshotId) => {
        let target: SourceLocation | undefined;
        set((state) => {
          const history = state.navigation[snapshotId];
          target = history?.forward[0];
          if (!history || !target) return state;
          return {
            navigation: {
              ...state.navigation,
              [snapshotId]: {
                current: target,
                back: history.current
                  ? [...history.back, history.current].slice(-100)
                  : history.back,
                forward: history.forward.slice(1),
              },
            },
          };
        });
        return target;
      },
    }),
    {
      name: 'codewalk:workspace',
      partialize: (state) => ({
        projectId: state.projectId,
        snapshotId: state.snapshotId,
        filePath: state.filePath,
        modelId: state.modelId,
        activeAnnotationId: state.activeAnnotationId,
        minimized: state.minimized,
        expanded: state.expanded,
        sidebarTab: state.sidebarTab,
        rightTab: state.rightTab,
        annotationScope: state.annotationScope,
        activeRouteId: state.activeRouteId,
        activeModuleId: state.activeModuleId,
        activeBlockId: state.activeBlockId,
        leftCollapsed: state.leftCollapsed,
        rightCollapsed: state.rightCollapsed,
        leftPanelWidth: state.leftPanelWidth,
        rightPanelWidth: state.rightPanelWidth,
        navigation: state.navigation,
      }),
      merge: (persisted, current) => {
        const saved = persisted as Partial<WorkspaceState>;
        return {
          ...current,
          ...saved,
          sidebarTab: saved.sidebarTab === 'files' ? 'files' : 'routes',
        };
      },
    },
  ),
);
