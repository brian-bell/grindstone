import type { FlowPaneState } from './workspace'

export type MiddlePaneSurface = {
  id: 'flow-workspace'
  label: 'Flow Workspace'
  route: '/'
  scope: 'flow'
}

export const middlePaneManifest = [
  {
    id: 'flow-workspace',
    label: 'Flow Workspace',
    route: '/',
    scope: 'flow'
  }
] as const satisfies readonly MiddlePaneSurface[]

export type MiddlePaneRouteResolution =
  | { surface: (typeof middlePaneManifest)[number] }
  | { surface: (typeof middlePaneManifest)[number]; flowState: FlowPaneState }

export function resolveMiddlePaneRoute(path: string): MiddlePaneRouteResolution {
  if (path === '/' || path === '/flow') {
    return { surface: middlePaneManifest[0] }
  }

  return {
    surface: middlePaneManifest[0],
    flowState: {
      status: 'error',
      message: 'Only Flow workspace routes are available in this shell.'
    }
  }
}
