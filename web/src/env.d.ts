// Build-time flags (web/vite.config.ts `define`).

/** #/styleguide is part of this build (dev and test builds; LAMPO_STYLEGUIDE=0 leaves it out). */
declare const __STYLEGUIDE__: boolean;

/** A picture the build emits as a file of its own (hashed, cached for good): its URL. */
declare module '*.webp' {
  const url: string;
  export default url;
}
