/**
 * Songbook intake: settings.
 *
 * Secrets are NOT here. Put these two in Project Settings -> Script properties:
 *   ANTHROPIC_API_KEY   an API key from console.anthropic.com
 *   GITHUB_TOKEN        a fine-grained personal access token limited to the songbook repo
 *                       (Contents: read & write, Pull requests: read & write)
 */
const CONFIG = {
  // Gmail label that marks a message as a songbook submission. Forwarding a
  // message to <you>+songbook@gmail.com and a filter that applies this label is
  // the intended setup; applying the label by hand works too.
  LABEL: 'Songbook',
  DONE_LABEL: 'Songbook/Added',      // pull request opened
  FAILED_LABEL: 'Songbook/Failed',   // something went wrong; see the alert email

  GITHUB_REPO: 'evachamer-proanimal/songbook',
  BASE_BRANCH: 'main',
  SITE_URL: 'https://evachamer-proanimal.github.io/songbook/',

  // Claude settings. Effort "medium" keeps a single call well inside the
  // Apps Script fetch timeout; raise to "high" if pages come back sloppy.
  MODEL: 'claude-opus-5',
  EFFORT: 'medium',
  MAX_TOKENS: 16000,

  // Where alerts and "your PR is ready" notes go. Defaults to the account
  // running the script.
  ALERT_EMAIL: '',

  // Attachments larger than this are skipped (GitHub's contents API tops out
  // around 100 MB; audio rarely needs more than this).
  MAX_ATTACHMENT_MB: 40,

  // How often the trigger runs, in minutes (1, 5, 10, 15 or 30).
  POLL_MINUTES: 10,
};

const SECTIONS = {
  'originals': 'Animal Liberation Originals: songs written for the animal movement.',
  'rewrites': 'Rewrites: new animal-liberation lyrics set to an existing, recognizable tune (parodies, holiday rewrites).',
  'other-movements': 'Songs from Other Movements: protest, labor, civil-rights and other justice-movement songs sung as written.',
  'commercial-artists': 'Songs by Commercial Artists: songs by recording artists reproduced as written, presented for personal use only.',
};
