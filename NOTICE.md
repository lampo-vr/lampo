# Third-party notices

Lampo (the repository `lampo`, the npm package `@lampo-vr/lampo`) is licensed under the GNU Affero General Public License
v3.0 (see LICENSE). It uses the following third-party software, models and artwork, each under its own license.

## Speech-to-text

- **transcribe.cpp** and its Node binding `transcribe-cpp` (MIT), with **ggml** (MIT) —
  https://github.com/handy-computer/transcribe.cpp
- Models, downloaded on first use (not shipped with this project):
  - **Whisper large-v3-turbo** by OpenAI (MIT), GGUF conversion by handy-computer —
    https://huggingface.co/handy-computer/whisper-large-v3-turbo-gguf
  - **Parakeet TDT 0.6B v3** by NVIDIA, licensed under CC-BY-4.0 (https://creativecommons.org/licenses/by/4.0/) —
    https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3, GGUF conversion by handy-computer —
    https://huggingface.co/handy-computer/parakeet-tdt-0.6b-v3-gguf
  - **Qwen3-ASR 1.7B** by the Qwen team, Alibaba Cloud (Apache-2.0), optional —
    https://huggingface.co/handy-computer/Qwen3-ASR-1.7B-gguf

## Footage search

- **ONNX Runtime**, through its Node binding `onnxruntime-node` (MIT) — https://github.com/microsoft/onnxruntime
- **Tokenizers.js**, `@huggingface/tokenizers` (Apache-2.0) — https://github.com/huggingface/tokenizers.js
- The model, downloaded at runtime when footage search first indexes a video (not shipped with this project):
  - **SigLIP B/16-224** by Google (Apache-2.0) — https://huggingface.co/google/siglip-base-patch16-224, as converted
    to ONNX by Xenova — https://huggingface.co/Xenova/siglip-base-patch16-224

## Pre-review text checks (Docker image / Linux)

Installed from Debian packages in the Docker image, not bundled in the source:

- **Tesseract OCR** (Apache-2.0) with the `deu` and `eng` language data (Apache-2.0) — https://github.com/tesseract-ocr
- **Hunspell** (MPL-1.1 / GPL-2.0+ / LGPL-2.1+) — https://hunspell.github.io
- German dictionary **igerman98** (GPL-2.0 or GPL-3.0; used under GPL-3.0, compatible with AGPL-3.0) and the
  English (US) dictionary from **SCOWL** (permissive, BSD/MIT-style)
- **FFmpeg** (LGPL-2.1+ / GPL-2.0+ for the Debian build) — https://ffmpeg.org

On macOS the text checks use the system's Vision framework and NSSpellChecker instead.

## Server runtime

Installed with `npm install` (and kept in the Docker image), each with its license file in `node_modules`:

- **Express** (MIT), **zod** (MIT), **tus-node-server** and **tus-js-client** (MIT), **qrcode** (MIT), the
  **Model Context Protocol SDK** packages (Apache-2.0, MIT for earlier contributions) and **MCP Apps** (MIT)
- **resvg-js** (MPL-2.0) — https://github.com/yisibl/resvg-js. Used unmodified as a library; MPL-2.0 §3.3 allows
  distributing it as part of a larger work under the AGPL. Its source is available from the link above.

## Web UI

Bundled into the built UI (`web/dist`): React (MIT), TanStack Query (MIT), Radix Primitives and Floating UI (MIT),
Lucide icons (ISC), react-day-picker and date-fns (MIT), and the fonts Instrument Sans and Martian
Mono (SIL Open Font License 1.1).

- **CookieConsent** 3.1.0 by Orest Bida (MIT) — https://github.com/orestbida/cookieconsent. Its ESM build and stylesheet
  are copied unchanged into `web/src/vendor/cookieconsent/` with its LICENSE; the build's third-party notices carry it.

## Artwork

- **The Lampo logo's lettering** is derived from **Norican** by The Norican Project Authors (SIL Open Font License
  1.1) — https://github.com/googlefonts/NoricanFont. The logo ships as outlines; the font itself is not distributed.
  The licence text is in `docs/brand/OFL-Norican.txt` and in the build's third-party notices.
- **Agent marks** (`web/src/ui/agentLogos.ts`): path data from **Simple Icons** 16.33.0 (CC0-1.0) —
  https://simpleicons.org — for Claude, Cursor, Google Gemini, Windsurf and Zed Industries; the GitHub Copilot mark
  there comes from GitHub's Primer Octicons (MIT). The marks are trademarks of their respective owners, shown only to
  say which integration an agent uses; no endorsement is implied. OpenAI's mark (for ChatGPT and Codex) is path data
  from Simple Icons 15.22.0 (CC0-1.0), the last release that carried it, drawn from https://openai.com/brand.
- **Platform marks** (`web/src/ui/platformMarks.tsx`): path data from **Simple Icons** 16.33.0 (CC0-1.0) —
  https://simpleicons.org. Each is a trademark of its owner, shown only to say where a post goes; no endorsement is
  implied.
  - YouTube is a trademark of Google LLC.
  - Instagram is a trademark of Meta Platforms, Inc.
  - Facebook is a trademark of Meta Platforms, Inc.
- **The first run's sample** (`lib/sample-film/`): Lampo's own demo footage, AI-generated with Higgsfield (Seedance
  2.0) for the project's website, with the title set in Instrument Sans (SIL Open Font License 1.1, the UI's font)
  burned in. Where it comes from and how it is made: `lib/sample-film/README.md`.
- **The brand film's frames** the entrance plays (`web/src/assets/brand-film/`) and **the setup's stills**
  (`web/src/onboarding/frames/`): frames of the same footage, Lampo's own, AI-generated with Higgsfield (Seedance 2.0)
  for the project's website. How they are made: the README in each folder.

## Full license texts

Every build writes `web/dist/third-party-licenses.txt` (served by the app at `/third-party-licenses.txt`, linked from
Settings): each package bundled into the UI and each runtime dependency of the server, with the license text it ships.
The MCP App card (`web/dist-mcp/review.html`) carries the notices of what it bundles as a comment at its end. The
generator is `scripts/licenses.ts`.
