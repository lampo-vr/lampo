// How far a visitor watches, told to the link's owner in coarse pieces (lib/watch.ts): which hundredths of the version
// played and for how long, every 15 s while it plays, when it stops and when the page goes away. What tells this
// browser apart is a random id kept here; the server stores only a key derived from it. Listening to `timeupdate` never touches playback.
import { type RefObject, useRef, useState } from 'react';
import { beacon, useWatchReport as useReport } from '../lib/watchReport.ts';

const ID = 'vr.g.visitor';

/** This browser's random visitor id (made once, kept in localStorage), or null where storage is refused. */
export function visitorId(): string | null {
  try {
    let id = localStorage.getItem(ID);
    if (!id || !/^[A-Za-z0-9_-]{12,40}$/.test(id)) {
      const bytes = crypto.getRandomValues(new Uint8Array(12));
      id = btoa(String.fromCharCode(...bytes))
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '');
      localStorage.setItem(ID, id);
    }
    return id;
  } catch {
    return null;
  }
}

interface Options {
  token: string;
  /** The video's id within the link. */
  slug: string;
  v: number;
  video: RefObject<HTMLVideoElement | null>;
  playing: boolean;
  /** The name the visitor gave, if any. */
  name: string;
}

export function useWatchReport({ token, slug, v, video, playing, name }: Options): void {
  const nameRef = useRef(name);
  nameRef.current = name;
  const [id] = useState(visitorId);
  useReport({
    video,
    playing,
    about: JSON.stringify([token, slug, v]),
    on: !!id,
    send: (r, about) => {
      const [t, s, ver] = JSON.parse(about) as [string, string, number];
      beacon(`/api/g/${t}/progress`, {
        visitor: id,
        slug: s,
        v: ver,
        ...r,
        ...(nameRef.current.trim() ? { name: nameRef.current.trim() } : {}),
      });
    },
  });
}
