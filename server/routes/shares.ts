// Review links. Owner side: create, change, revoke links for a video or a folder (behind the guard / sign-in).
// Guest side (/g/<token>, /api/g/…, /media/g/…, /data/g/…): the token is the only credential, so every rule is
// enforced on the server: expiry, password, what the link covers (a folder link can't reach other videos, and videos
// are named by ids the link gave them), which versions, whether visitors may comment, approve or download.
//   shares/access.ts  what a request may reach through a link (shared by every guest route)
//   shares/owner.ts   the owner's link management
//   shares/guest.ts   the link, its videos, visits and views, and everything a visitor writes
//   shares/media.ts   playback, waveforms, posters, sprites, screenshots and downloads through a link
import type { Router } from 'express';
import type { ServerContext } from '../context.ts';
import { router } from '../http.ts';
import { guestRoutes } from './shares/guest.ts';
import { guestMediaRoutes } from './shares/media.ts';
import { ownerShareRoutes } from './shares/owner.ts';

export function shareRoutes(ctx: ServerContext): Router {
  return router().use(ownerShareRoutes(ctx), guestRoutes(ctx), guestMediaRoutes(ctx));
}
