// What the server accepts as an upload (lib/store.ts UPLOAD_EXT); it also checks the contents with ffprobe.
export const VIDEO_EXT = ['.mp4', '.mov', '.m4v', '.webm', '.mkv'];
export const VIDEO_ACCEPT = [...VIDEO_EXT, 'video/*'].join(',');
export const isVideo = (f: File) => VIDEO_EXT.includes(f.name.slice(f.name.lastIndexOf('.')).toLowerCase());
