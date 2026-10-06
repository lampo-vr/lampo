// The owner's player reports what the person watching plays, the way a review link's guest player does
// (web/src/lib/watchReport.ts → POST /api/review/:slug/watch, kept in data/<slug>/views.json): Insights and the
// viewers chip show who on the team watched a video, how often and how long.
import type { RefObject } from 'react';
import { enc } from '../api/client.ts';
import { beacon, useWatchReport } from '../lib/watchReport.ts';

export function useTeamWatch(slug: string, v: number, video: RefObject<HTMLVideoElement | null>, playing: boolean): void {
  useWatchReport({
    video,
    playing,
    about: JSON.stringify([slug, v]),
    on: true,
    send: (r, about) => {
      const [s, ver] = JSON.parse(about) as [string, number];
      beacon(`/api/review/${enc(s)}/watch`, { v: ver, ...r });
    },
  });
}
