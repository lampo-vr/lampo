// The workspaces' code (auth/Workspaces.tsx): loaded for someone with more than one (the account menu's switcher), or
// for a link that names another workspace (App). One loader, so the chunk has one way in.
import { loader } from '../lib/lazy.ts';

export const workspacesCode = loader(() => import('./Workspaces.tsx'));
