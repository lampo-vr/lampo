# The brand film

The pictures the entrance plays on its left (`web/src/ui/Entrance.tsx`): 60 consecutive frames, film frames 266–325
at 24 fps around F 0295 (00:12:07), of Lampo's own demo footage, the brand film of the project's website (an
AI-generated clip made with Higgsfield, Seedance 2.0). Never a client's video. The film's sources (the full film and
its prompt) aren't in this repository; [NOTICE.md](../../../../NOTICE.md) lists the footage.
Made by `node scripts/brand-film.ts <film.mp4>`: `poster.webp` (F 0295), `strip.webp` (the thumbnails),
`frames-0…3.webp` (fifteen frames to a sheet) and `poster-lq.webp`, `strip-lq.webp` (the still and the strip a few
pixels across: the entrance's stylesheet inlines them, so the film's tones are there before the still is decoded).
