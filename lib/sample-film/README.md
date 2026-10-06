# The sample's film

`v1.mp4` and `v2.mp4` are the first run's sample ([lib/sample.ts](../sample.ts), [docs/onboarding.md](../../docs/onboarding.md#the-sample)):
two versions of the same five seconds of Lampo's own brand film, frame for frame, with the title "EVERY MILE, ON THE
RECORD." over the car in V1 and on the hill in V2.

**Origin**: Lampo's own demo footage, generated with Higgsfield (Seedance 2.0) for the project's website; the title
is burned in by [scripts/sample-film.ts](../../scripts/sample-film.ts). The film's sources (the full film and the
prompt it was made from) aren't in this repository; [NOTICE.md](../../NOTICE.md) lists the footage.

**Remake** (from the repository root, with the full film at hand): `node scripts/sample-film.ts <film.mp4>`. It
sets the title in headless Chrome (Instrument Sans, as the onboarding's pictures set it), lays it over the film with
ffmpeg (960 × 412, 24 fps, 121 frames, H.264 CRF 29, a soft chord as sound) and prints the title boxes that
`SAMPLE_TITLE` in lib/sample.ts keeps. The same film gives the same files, byte for byte.
