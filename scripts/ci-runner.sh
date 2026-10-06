#!/bin/sh
# What a CI job needs from the machine it runs on, for .github/workflows/ci.yml. On GitHub's runners (the public
# repository's) the workflow installs the packages; on the self-hosted runner a private copy of the repository may use
# (no sudo, by design) they are its operator's, so a job checks for them and fails naming what is missing instead of
# installing anything.
#   scripts/ci-runner.sh env             temp files and the npm cache under the runner's work dir (written to $GITHUB_ENV)
#   scripts/ci-runner.sh need <what>…    ffmpeg, ocr (tesseract with eng + deu), spelling (hunspell de_DE + en_US),
#                                        fonts (DejaVu), python3, unzip, git, chrome (the shared libraries the Chrome
#                                        builds in cache/chrome load: run it after `npm run chrome:install`)
#   scripts/ci-runner.sh cleanup         stop whatever the job left running (servers, Chrome, ffmpeg) on a self-hosted runner
set -eu

missing=''
lack() { missing="$missing
  - $1"; }

need() {
  for what in "$@"; do
    case "$what" in
      ffmpeg)
        command -v ffmpeg >/dev/null 2>&1 || lack 'ffmpeg (apt: ffmpeg)'
        command -v ffprobe >/dev/null 2>&1 || lack 'ffprobe (apt: ffmpeg)'
        ;;
      ocr)
        if command -v tesseract >/dev/null 2>&1; then
          langs=$(tesseract --list-langs 2>&1 || true)
          for l in eng deu; do printf '%s\n' "$langs" | grep -qx "$l" || lack "tesseract's $l language (apt: tesseract-ocr-$l)"; done
        else
          lack 'tesseract (apt: tesseract-ocr tesseract-ocr-eng tesseract-ocr-deu)'
        fi
        ;;
      spelling)
        command -v hunspell >/dev/null 2>&1 || lack 'hunspell (apt: hunspell)'
        [ -f /usr/share/hunspell/de_DE.dic ] || lack 'the German dictionary (apt: hunspell-de-de)'
        [ -f /usr/share/hunspell/en_US.dic ] || lack 'the English dictionary (apt: hunspell-en-us)'
        ;;
      fonts)
        [ -f /usr/share/fonts/truetype/dejavu/DejaVuSans.ttf ] || lack 'DejaVu fonts (apt: fonts-dejavu-core)'
        ;;
      python3 | unzip | git)
        command -v "$what" >/dev/null 2>&1 || lack "$what (apt: $what)"
        ;;
      chrome)
        found=$(find cache/chrome -type f \( -name chrome-headless-shell -o -name chrome \) -perm -u+x 2>/dev/null || true)
        [ -n "$found" ] || lack 'a Chrome build in cache/chrome (npm run chrome:install)'
        for bin in $found; do
          for lib in $(ldd "$bin" 2>/dev/null | awk '/not found/ { print $1 }'); do
            lack "$lib, which $(basename "$bin") loads (from the distribution's package that ships it)"
          done
        done
        ;;
      *)
        echo "ci-runner.sh: nothing called $what to check" >&2
        exit 2
        ;;
    esac
  done
  if [ -n "$missing" ]; then
    echo "::error title=The runner lacks what this job needs::$(printf '%s' "$missing" | tr '\n' ' ')" >&2
    printf 'This runner lacks:%s\n' "$missing" >&2
    echo 'On a self-hosted runner its operator installs these (jobs have no sudo there, on purpose).' >&2
    exit 1
  fi
  echo "the runner has $*"
}

# Temp files and the npm cache under the runner's work dir: the runner empties RUNNER_TEMP after each job, and nothing
# a job writes lands in the service's private /tmp or in a home other jobs share.
env_() {
  : "${RUNNER_TEMP:?RUNNER_TEMP is not set: run this in a GitHub Actions job}"
  : "${GITHUB_ENV:?GITHUB_ENV is not set: run this in a GitHub Actions job}"
  work=$(dirname "$RUNNER_TEMP")
  mkdir -p "$RUNNER_TEMP/tmp" "$work/_npm"
  {
    echo "TMPDIR=$RUNNER_TEMP/tmp"
    echo "npm_config_cache=$work/_npm"
  } >>"$GITHUB_ENV"
  echo "TMPDIR=$RUNNER_TEMP/tmp, npm cache $work/_npm"
}

# Stops every process of this account that the job started — it carries the job's RUNNER_TRACKING_ID, or works in the
# job's workspace or temp folder — except this script and the runner above it. The suites stop their own servers and
# Chrome, and the runner cleans up after a job too; this is the net under both on a machine that outlives the job.
cleanup() {
  [ -d /proc ] || {
    echo 'no /proc here: nothing to look for'
    return 0
  }
  keep=" $$ "
  p=$$
  while [ "${p:-1}" -gt 1 ]; do
    p=$(ps -o ppid= -p "$p" 2>/dev/null | tr -d ' ') || break
    keep="$keep$p "
  done
  uid=$(id -u)
  victims=''
  for d in /proc/[0-9]*; do
    pid=${d#/proc/}
    case "$keep" in *" $pid "*) continue ;; esac
    [ "$(stat -c %u "$d" 2>/dev/null || echo none)" = "$uid" ] || continue
    if [ -n "${RUNNER_TRACKING_ID:-}" ] && tr '\0' '\n' <"$d/environ" 2>/dev/null | grep -qx "RUNNER_TRACKING_ID=$RUNNER_TRACKING_ID"; then
      victims="$victims $pid"
      continue
    fi
    cwd=$(readlink "$d/cwd" 2>/dev/null || true)
    case "$cwd/" in
      "${GITHUB_WORKSPACE:-/nonexistent}"/* | "${RUNNER_TEMP:-/nonexistent}"/*) victims="$victims $pid" ;;
    esac
  done
  if [ -z "$victims" ]; then
    echo 'nothing left running'
    return 0
  fi
  echo 'stopping what the job left running:'
  # shellcheck disable=SC2086
  ps -o pid=,args= -p "$(echo $victims | tr ' ' ',')" 2>/dev/null || true
  # shellcheck disable=SC2086
  kill -TERM $victims 2>/dev/null || true
  i=0
  while [ $i -lt 10 ]; do
    alive=''
    for pid in $victims; do [ -d "/proc/$pid" ] && alive="$alive $pid"; done
    [ -n "$alive" ] || return 0
    sleep 0.5
    i=$((i + 1))
  done
  # shellcheck disable=SC2086
  kill -KILL $alive 2>/dev/null || true
}

cmd=${1:-}
[ $# -gt 0 ] && shift
case "$cmd" in
  env) env_ ;;
  need) need "$@" ;;
  cleanup) cleanup ;;
  *)
    echo 'usage: scripts/ci-runner.sh env | need <what>… | cleanup' >&2
    exit 2
    ;;
esac
