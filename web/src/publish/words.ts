// Publishing in the UI's words: what a post's problems say (by their code: lib/publish/platforms.ts postProblems), where
// a post stands, who may see it. The server's English sentence (`message`) is what agents read; the UI says it in the
// person's language from the code and its numbers, and falls back to the server's words for a code it doesn't know.
import type { PostProblem, PostState, PostView, PostVisibility, PublishPlatform } from '../../../lib/types.ts';
import { locale, t } from '../i18n/index.ts';
import { secsWords } from '../lib/format.ts';

/** Brand names: the same in every language. */
export const PLATFORM_LABEL: Record<PublishPlatform, string> = { youtube: 'YouTube', instagram: 'Instagram', facebook: 'Facebook' };

const num = (v: string | number | undefined) => (typeof v === 'number' ? v.toLocaleString(locale()) : (v ?? ''));
const secs = (v: string | number | undefined) => (typeof v === 'number' ? secsWords(v) : String(v ?? ''));

/** One problem in the person's language. */
export function problemText(p: PostProblem, platform: PublishPlatform): string {
  const v = p.vars ?? {};
  const name = PLATFORM_LABEL[platform];
  switch (p.code) {
    case 'not_final':
      return t('This version isn’t the final one any more: posts go out from the final version only.');
    case 'title_long':
      return t('The title is {n} characters: {platform} takes {max}.', { n: num(v.n), max: num(v.max), platform: name });
    case 'title_angle':
      return t('YouTube takes no < or > in a title.');
    case 'title_missing':
      return t('YouTube needs a title.');
    case 'description_angle':
      return t('YouTube takes no < or > in a description.');
    case 'description_long':
      return platform === 'youtube'
        ? t('The description is {n} bytes: YouTube takes {max}.', { n: num(v.n), max: num(v.max) })
        : t('The caption is {n} characters: {platform} takes {max}.', { n: num(v.n), max: num(v.max), platform: name });
    case 'tags_long':
      return t('The tags are {n} characters together: {platform} takes {max}.', { n: num(v.n), max: num(v.max), platform: name });
    case 'tag_long':
      return t('The tag “{tag}” is longer than {max} characters.', { tag: String(v.tag ?? ''), max: num(v.max) });
    case 'hashtags_many':
      return t('{n} hashtags: {platform} takes {max}.', { n: num(v.n), max: num(v.max), platform: name });
    case 'visibility_unknown':
      return t('{platform} posts are public.', { platform: name });
    case 'video_short':
      return t('The video is too short: {platform} takes {min} at least.', { min: secs(v.min), platform: name });
    case 'video_long':
      return t('The video is too long: {platform} takes {max} at most.', { max: secs(v.max), platform: name });
    case 'youtube_verified':
      return t('Longer than {max}: YouTube allows it only on an account confirmed by phone.', { max: secs(v.max) });
    case 'facebook_not_reel':
      return t('Longer than {max}: it posts as a Facebook video, not a Reel.', { max: secs(v.max) });
    case 'aspect':
      return t('{size} isn’t {best}: {platform} shows it with bars or cropped.', { size: String(v.size ?? ''), best: String(v.best ?? ''), platform: name });
    case 'cover_outside':
      return t('The cover frame {frame} isn’t in the video.', { frame: num(v.frame) });
    case 'schedule_invalid':
      return t('That isn’t a time.');
    case 'schedule_past':
      return t('The time to post is in the past.');
    case 'schedule_far':
      return t('A post can be scheduled {max} days ahead at most.', { max: num(v.max) });
    case 'schedule_public':
      return t('YouTube makes a scheduled video public at its time: choose Public, or leave the time out.');
    case 'ai_missing':
      return t('Say whether it contains realistic AI-generated or altered people, places or events.');
    case 'ai_caption':
      return t('Lampo can’t set {platform}’s AI label yet: say it in the caption.', { platform: name });
    case 'kids_missing':
      return t('Say whether it is made for kids: YouTube asks it of every video.');
    case 'connection_missing':
      return t('Choose a {platform} connection, or download the kit and post it yourself.', { platform: name });
    case 'connection_platform':
      return t('That connection doesn’t post to {platform}.', { platform: name });
    case 'connection_not_ready':
      return t('That connection isn’t ready: look at it in Settings → Publishing.');
    case 'account_missing':
      return platform === 'facebook' ? t('Choose the Facebook Page.') : t('Choose the {platform} account.', { platform: name });
    case 'youtube_locked':
      return t(
        'Uploads stay private until your Google project passes YouTube’s audit: it won’t go public on its own, even at its time. Make it public in YouTube Studio.',
      );
    case 'schedule_awake':
      return t('Lampo sends it at that time: this machine must be awake and Lampo running then.');
    default:
      return p.message;
  }
}

/** Where a post stands, in a word or two. */
export function stateWord(s: PostState): string {
  switch (s) {
    case 'draft':
      return t('Draft');
    case 'queued':
      return t('Waiting to go out');
    case 'uploading':
      return t('Sending');
    case 'scheduled':
      return t('Scheduled');
    case 'posted':
      return t('Posted');
    case 'failed':
      return t('Failed');
    case 'cancelled':
      return t('Cancelled');
    case 'sent':
      return t('Sent, not confirmed');
  }
}

export const visibilityWord = (v: PostVisibility): string => (v === 'public' ? t('Public') : v === 'unlisted' ? t('Unlisted') : t('Private'));

/** A moment as people read it here: "Fri 9 Oct, 14:00". */
export const whenWords = (iso: string): string =>
  new Date(iso).toLocaleString(locale(), { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

/** The one line of a post as the player's stage line says it: "YouTube posted". */
export function postShort(platform: PublishPlatform, s: PostState): string {
  const name = PLATFORM_LABEL[platform];
  switch (s) {
    case 'posted':
      return t('{platform} posted', { platform: name });
    case 'scheduled':
      return t('{platform} scheduled', { platform: name });
    case 'failed':
      return t('{platform} failed', { platform: name });
    case 'cancelled':
      return t('{platform} cancelled', { platform: name });
    case 'sent':
      return t('{platform} not confirmed', { platform: name });
    case 'draft':
      return t('{platform} draft', { platform: name });
    default:
      return t('{platform} sending', { platform: name });
  }
}

/** Who drafted it, for the composer's foot: "Drafted by agent promo-edit". */
export function draftedBy(p: PostView): string {
  const agent = p.by.startsWith('agent:');
  return agent ? t('Drafted by the agent {name}', { name: p.by.slice(6) }) : t('Drafted by {name}', { name: p.by });
}

/** A post that went out before (the platform holds it, or was sent without an answer): what Retry does with it. */
export const wentOut = (p: Pick<PostView, 'remote_id' | 'state'>): boolean => !!p.remote_id || p.state === 'sent';

/**
 * The confirm before posting again something that went out before (A12 PUB-1): Lampo never sends it again by itself,
 * and the person says so only after looking on the platform.
 */
export function againWords(p: PostView): { title: string; body: string; action: string } {
  const name = PLATFORM_LABEL[p.platform];
  return {
    title: t('Post it on {platform} again?', { platform: name }),
    body:
      p.state === 'sent' && !p.remote_id
        ? t('It went out before and {platform} never said whether it arrived. Look on {platform} first: post it again only if it isn’t there.', {
            platform: name,
          })
        : t('It went out before: {platform} holds it. Post it again only if it isn’t on {platform}, or it will be there twice.', { platform: name }),
    action: t('Post again'),
  };
}
