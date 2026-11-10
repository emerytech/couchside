/** Only explicit answers are included; saved boxes and device data are never read. */
export const COUCHSIDE_SHARE_URL = 'https://couchside.tv/';
export const STORY_QUESTIONS = [
  { key: 'favorite', label: 'What’s your favorite part of Couchside?' },
  { key: 'mostUsed', label: 'What do you find yourself using Couchside to do the most?' },
  { key: 'future', label: 'What would you like to see added to Couchside in the future?' },
] as const;
export type CouchsideStory = { favorite: string; mostUsed: string; future: string };
export const STORY_ANSWER_LIMIT = 400;

export function setupShareText(answers: CouchsideStory): string {
  const sections = STORY_QUESTIONS.flatMap(({ key, label }) => {
    const value = answers[key];
    if (typeof value !== 'string' || value.length > STORY_ANSWER_LIMIT || /[\x00-\x08\x0b-\x1f\x7f]/.test(value)) throw Error('Check your answers.');
    return value.trim() ? [`${label}\n${value.trim()}`] : [];
  });
  if (!sections.length) throw Error('Answer at least one question.');
  return ['How I use Couchside', ...sections, COUCHSIDE_SHARE_URL].join('\n\n');
}

/** Opens a composer; the user reviews and sends their own message. */
export function showcaseDraftUrl(summary: string): string {
  const body = `${summary}\n\nPlease contact me before publishing my answers or name. Sending this email does not subscribe me to marketing.`;
  return `mailto:taylor@couchside.tv?subject=${encodeURIComponent('How I use Couchside')}&body=${encodeURIComponent(body)}`;
}
