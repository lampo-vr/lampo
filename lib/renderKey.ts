// Which render a derived file belongs to (posters, sprites, waveforms, analysis, Auto-check, diffs, transcripts,
// playback copies, frame grabs, and the URLs that serve them): its sample, which two different renders never share,
// or, for a version registered before samples existed, its hash, so the files cached for it stay valid. Two renders
// can share a hash (Version.sample). Browser-safe.
import type { Version } from './types.ts';

export const renderKey = (ver: Pick<Version, 'hash' | 'sample'>): string => ver.sample || ver.hash;
