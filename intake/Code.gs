/**
 * Songbook intake.
 *
 * Every few minutes: look for Gmail threads labeled CONFIG.LABEL that have not
 * been handled yet, ask Claude to turn each one into a songbook page, push the
 * page (plus any PDF / audio attachments) to a branch on GitHub, and open a
 * pull request for review. Merging the PR publishes the song.
 *
 * Entry points you run by hand:
 *   setup()            first run: creates the labels and triggers the auth prompts
 *   installTrigger()   schedules processSubmissions() every CONFIG.POLL_MINUTES
 *   removeTrigger()
 *   processSubmissions()  the job itself
 *   retryFailed()      clears the Failed label so those threads are tried again
 *   testClaude()       sends a tiny sample to Claude and logs the page it drafts
 *
 * Optional Google Form path (no email needed):
 *   createSubmissionForm()  builds the form once and stores its id
 *   installFormTrigger()    runs onFormSubmit() for every response
 */

// ---------------------------------------------------------------- setup

function setup() {
  [CONFIG.LABEL, CONFIG.DONE_LABEL, CONFIG.FAILED_LABEL].forEach(getOrCreateLabel_);
  const keyName = CONFIG.PROVIDER === 'openrouter' ? 'OPENROUTER_API_KEY' : 'ANTHROPIC_API_KEY';
  const missing = [keyName, 'GITHUB_TOKEN'].filter(k => !prop_(k));
  if (missing.length) {
    throw new Error('Add these Script properties first (Project Settings -> Script properties): ' + missing.join(', '));
  }
  // Touch every service once so all permissions are granted up front.
  UrlFetchApp.fetch('https://api.github.com/repos/' + CONFIG.GITHUB_REPO, { headers: githubHeaders_(), muteHttpExceptions: true });
  Logger.log('Setup complete. Now run installTrigger().');
}

function installTrigger() {
  removeTrigger();
  ScriptApp.newTrigger('processSubmissions').timeBased().everyMinutes(CONFIG.POLL_MINUTES).create();
  Logger.log('Trigger installed: every ' + CONFIG.POLL_MINUTES + ' minutes.');
}

function removeTrigger() {
  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === 'processSubmissions')
    .forEach(t => ScriptApp.deleteTrigger(t));
}

function retryFailed() {
  const failed = getOrCreateLabel_(CONFIG.FAILED_LABEL);
  failed.getThreads().forEach(t => t.removeLabel(failed));
  Logger.log('Failed label cleared; the next run will retry those threads.');
}

// ---------------------------------------------------------------- main job

function processSubmissions() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) return; // a previous run is still going

  try {
    const label = getOrCreateLabel_(CONFIG.LABEL);
    const done = getOrCreateLabel_(CONFIG.DONE_LABEL);
    const failed = getOrCreateLabel_(CONFIG.FAILED_LABEL);
    const skip = new Set([CONFIG.DONE_LABEL, CONFIG.FAILED_LABEL]);

    const threads = label.getThreads(0, 20).filter(t => !t.getLabels().some(l => skip.has(l.getName())));
    threads.forEach(thread => {
      try {
        const prUrl = handleThread_(thread);
        thread.addLabel(done);
        notify_('Songbook: pull request ready', 'A new submission is ready for review:\n\n' + prUrl +
          '\n\nMerge it to publish, or edit the page in the PR first.\n\nOriginal email: ' + gmailLink_(thread));
      } catch (err) {
        thread.addLabel(failed);
        notify_('Songbook: submission failed', 'Could not process "' + thread.getFirstMessageSubject() + '".\n\n' +
          (err && err.stack || err) + '\n\nOriginal email: ' + gmailLink_(thread) +
          '\n\nFix the cause, then run retryFailed() in the Apps Script editor.');
      }
    });
  } finally {
    lock.releaseLock();
  }
}

function handleThread_(thread) {
  const messages = thread.getMessages();
  const message = messages[messages.length - 1]; // the forwarded copy is the newest
  const submission = collectSubmission_(message);
  const draft = draftPage_(submission);
  return openPullRequest_(draft, submission, gmailLink_(thread));
}

// ---------------------------------------------------------------- gather the email

function collectSubmission_(message) {
  const body = message.getPlainBody() || '';
  const sub = {
    subject: message.getSubject(),
    from: message.getFrom(),
    date: message.getDate(),
    messageId: 'email ' + message.getId(),
    body: body,
    docs: [],       // {url, markdown}
    pdfs: [],       // {name, blob}
    images: [],     // {name, blob}
    uploads: [],    // {name, blob}  files that go into docs/files/ (pdf, audio)
    skipped: [],    // attachments we did not use, with a reason
  };

  // Google Docs links in the body -> Markdown via the Drive export endpoint.
  const seen = new Set();
  (body.match(/https:\/\/docs\.google\.com\/document\/d\/[A-Za-z0-9_-]+/g) || []).forEach(url => {
    const id = url.split('/d/')[1];
    if (seen.has(id)) return;
    seen.add(id);
    const md = exportGoogleDoc_(id);
    if (md) sub.docs.push({ url: url, markdown: md });
    else sub.skipped.push({ name: url, reason: 'Google Doc not readable by this account' });
  });

  message.getAttachments({ includeInlineImages: true, includeAttachments: true }).forEach(att => {
    const name = att.getName() || 'attachment';
    const mime = (att.getContentType() || '').toLowerCase();
    const mb = att.getSize() / (1024 * 1024);
    if (mb > CONFIG.MAX_ATTACHMENT_MB) {
      sub.skipped.push({ name: name, reason: 'larger than ' + CONFIG.MAX_ATTACHMENT_MB + ' MB' });
    } else if (mime === 'application/pdf' || /\.pdf$/i.test(name)) {
      sub.pdfs.push({ name: name, blob: att });
      sub.uploads.push({ name: name, blob: att });
    } else if (mime.startsWith('audio/') || /\.(mp3|m4a|wav|ogg)$/i.test(name)) {
      sub.uploads.push({ name: name, blob: att });
    } else if (mime.startsWith('image/')) {
      sub.images.push({ name: name, blob: att });
    } else if (/officedocument\.wordprocessingml|msword/.test(mime) || /\.docx?$/i.test(name)) {
      const md = wordToMarkdown_(att);
      if (md) sub.docs.push({ url: name, markdown: md });
      else sub.skipped.push({ name: name, reason: 'could not convert Word file' });
    } else if (mime.startsWith('text/')) {
      sub.docs.push({ url: name, markdown: att.getDataAsString() });
    } else {
      sub.skipped.push({ name: name, reason: 'unsupported type ' + mime });
    }
  });
  return sub;
}

/** Export a Google Doc as Markdown using the running account's access. Returns null if not readable. */
function exportGoogleDoc_(fileId) {
  const res = UrlFetchApp.fetch('https://www.googleapis.com/drive/v3/files/' + fileId + '/export?mimeType=text/markdown', {
    headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() }, muteHttpExceptions: true,
  });
  return res.getResponseCode() === 200 ? res.getContentText() : null;
}

/** Word -> temporary Google Doc -> Markdown -> delete the temp doc. */
function wordToMarkdown_(blob) {
  const token = ScriptApp.getOAuthToken();
  const boundary = 'songbook' + Date.now();
  const meta = JSON.stringify({ name: 'songbook-tmp-' + Date.now(), mimeType: 'application/vnd.google-apps.document' });
  const payload = Utilities.newBlob(
    '--' + boundary + '\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n' + meta +
    '\r\n--' + boundary + '\r\nContent-Type: ' + blob.getContentType() + '\r\n\r\n').getBytes()
    .concat(blob.getBytes())
    .concat(Utilities.newBlob('\r\n--' + boundary + '--').getBytes());
  const up = UrlFetchApp.fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart', {
    method: 'post', contentType: 'multipart/related; boundary=' + boundary, payload: payload,
    headers: { Authorization: 'Bearer ' + token }, muteHttpExceptions: true,
  });
  if (up.getResponseCode() !== 200) return null;
  const id = JSON.parse(up.getContentText()).id;
  try {
    return exportGoogleDoc_(id);
  } finally {
    UrlFetchApp.fetch('https://www.googleapis.com/drive/v3/files/' + id, {
      method: 'delete', headers: { Authorization: 'Bearer ' + token }, muteHttpExceptions: true,
    });
  }
}

// ---------------------------------------------------------------- Claude

const PAGE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['section', 'slug', 'title', 'page_markdown', 'summary', 'review_notes', 'is_song'],
  properties: {
    is_song: { type: 'boolean', description: 'false if the email does not actually contain a song to add' },
    section: { type: 'string', enum: Object.keys(SECTIONS) },
    slug: { type: 'string', description: 'lowercase-hyphenated file name without extension, from the title' },
    title: { type: 'string' },
    page_markdown: { type: 'string', description: 'the complete page in the songbook format' },
    summary: { type: 'string', description: 'one or two sentences for the pull request description' },
    review_notes: { type: 'string', description: 'anything the human reviewer should check: guessed chords, missing verses, copyright questions, unclear authorship. Empty string if nothing.' },
  },
};

function systemPrompt_() {
  return [
    'You convert emailed song submissions into pages for the Animal Liberation Songbook, a MkDocs site.',
    'The site has these sections:',
    Object.keys(SECTIONS).map(k => '- ' + k + ': ' + SECTIONS[k]).join('\n'),
    '',
    'PAGE FORMAT (follow exactly):',
    '1. YAML front matter with only `title`.',
    '2. `# Title` as the first line of the body.',
    '3. An italic credits line: songwriter, and for rewrites the original tune, e.g. *Jason Oliver · to the tune of Jingle Bells*. Omit if unknown.',
    '4. A bullet list of links from the submission (recordings, karaoke tracks, original artist links). Omit if none.',
    '5. The song. Any stanza that has chord lines goes inside `<pre class="chords">...</pre>`, one stanza per pre block,',
    '   with chords on their own line directly above the lyric line they belong to, positioned with spaces so each chord sits',
    '   over the syllable where it changes (monospace font). Do not escape characters inside pre blocks. Lyric-only stanzas are',
    '   plain Markdown paragraphs with two trailing spaces at the end of each line so line breaks are kept. Section markers',
    '   like (Chorus) or (Verse 2) stay as their own line at the top of the stanza.',
    '6. If the submission has both a chords version and a lyrics-only version, use content tabs:',
    '   `=== "Chords"` then the chords content indented four spaces, then `=== "Lyrics"` with the lyrics indented four spaces.',
    '   Do not fabricate a lyrics-only tab; only create tabs when both were supplied.',
    '',
    'Example of a finished page:',
    '---',
    'title: "Glass Walls"',
    '---',
    '',
    '# Glass Walls',
    '',
    '*Katherine Makenzie*',
    '',
    '- [Recording](https://www.youtube.com/watch?v=qowVZmpBIcw)',
    '',
    '<pre class="chords">(Verse 1)',
    '    B                   A#m',
    'Oh, we’re standing here again',
    '                     G#m',
    'Facing violence and despair</pre>',
    '',
    '(Chorus)  ',
    'If we could tear down those brick walls  ',
    'And replace them all with glass  ',
    '',
    'RULES:',
    '- Transcribe the song exactly as submitted. Never invent lyrics, verses, chords or authorship. If chords are only in an',
    '  attached PDF or image, transcribe them; if you cannot read them reliably, leave the page lyrics-only and say so in review_notes.',
    '- Strip email noise: greetings, signatures, quoted headers, "Sent from my iPhone", the forwarding banner.',
    '- Do not mention attachments in the page; the files section is added separately.',
    '- Pick the section by the song\'s nature. A parody of a known song is a rewrite. A published song by a recording artist,',
    '  reproduced as written, is commercial-artists.',
    '- If the email is not a song submission (a question, a thank-you, spam), set is_song=false and explain in summary.',
    '- Slug: ASCII, lowercase, hyphens, from the title, e.g. "every-goat-has-a-story".',
  ].join('\n');
}

function draftPage_(sub) {
  let text = 'Subject: ' + sub.subject + '\nFrom: ' + sub.from + '\n\n--- EMAIL BODY ---\n' + sub.body.slice(0, 60000);
  sub.docs.forEach(d => { text += '\n\n--- ATTACHED DOCUMENT (' + d.url + ') ---\n' + d.markdown.slice(0, 60000); });
  if (sub.uploads.length) text += '\n\n(Files that will be attached to the page: ' + sub.uploads.map(u => u.name).join(', ') + ')';
  if (sub.skipped.length) text += '\n\n(Attachments skipped: ' + sub.skipped.map(s => s.name + ' – ' + s.reason).join('; ') + ')';

  const raw = CONFIG.PROVIDER === 'openrouter' ? callOpenRouter_(text, sub) : callAnthropic_(text, sub);
  const draft = JSON.parse(raw);
  if (!draft.is_song) throw new Error('Not treated as a song submission: ' + draft.summary);
  draft.slug = (draft.slug || draft.title).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'untitled';
  return draft;
}

/** Direct Anthropic Messages API. Returns the JSON text of the drafted page. */
function callAnthropic_(text, sub) {
  const content = [];
  sub.pdfs.forEach(p => content.push({
    type: 'document', title: p.name,
    source: { type: 'base64', media_type: 'application/pdf', data: Utilities.base64Encode(p.blob.getBytes()) },
  }));
  sub.images.forEach(i => content.push({
    type: 'image',
    source: { type: 'base64', media_type: i.blob.getContentType(), data: Utilities.base64Encode(i.blob.getBytes()) },
  }));
  content.push({ type: 'text', text: text });

  const body = {
    model: CONFIG.MODEL,
    max_tokens: CONFIG.MAX_TOKENS,
    fallbacks: 'default',
    output_config: { effort: CONFIG.EFFORT, format: { type: 'json_schema', schema: PAGE_SCHEMA } },
    system: systemPrompt_(),
    messages: [{ role: 'user', content: content }],
  };
  const res = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', {
    method: 'post', contentType: 'application/json', payload: JSON.stringify(body), muteHttpExceptions: true,
    headers: {
      'x-api-key': prop_('ANTHROPIC_API_KEY'),
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'server-side-fallback-2026-07-01',
    },
  });
  if (res.getResponseCode() !== 200) throw new Error('Claude API ' + res.getResponseCode() + ': ' + res.getContentText().slice(0, 800));
  const msg = JSON.parse(res.getContentText());
  if (msg.stop_reason === 'refusal') throw new Error('Claude declined this submission: ' + JSON.stringify(msg.stop_details));
  if (msg.stop_reason === 'max_tokens') throw new Error('Claude ran out of output tokens; raise CONFIG.MAX_TOKENS');
  const textBlock = (msg.content || []).find(b => b.type === 'text');
  if (!textBlock) throw new Error('Claude returned no text block: ' + JSON.stringify(msg).slice(0, 800));
  return textBlock.text;
}

/** Same call through OpenRouter's OpenAI-style endpoint. Returns the JSON text of the drafted page. */
function callOpenRouter_(text, sub) {
  const content = [];
  sub.pdfs.forEach(p => content.push({
    type: 'file',
    file: { filename: p.name, file_data: 'data:application/pdf;base64,' + Utilities.base64Encode(p.blob.getBytes()) },
  }));
  sub.images.forEach(i => content.push({
    type: 'image_url',
    image_url: { url: 'data:' + i.blob.getContentType() + ';base64,' + Utilities.base64Encode(i.blob.getBytes()) },
  }));
  content.push({ type: 'text', text: text });

  const body = {
    model: CONFIG.OPENROUTER_MODEL,
    max_tokens: CONFIG.MAX_TOKENS,
    reasoning: { effort: CONFIG.EFFORT },
    response_format: { type: 'json_schema', json_schema: { name: 'songbook_page', strict: true, schema: PAGE_SCHEMA } },
    messages: [
      { role: 'system', content: systemPrompt_() },
      { role: 'user', content: content },
    ],
  };
  if (sub.pdfs.length) body.plugins = [{ id: 'file-parser', pdf: { engine: 'native' } }];
  const res = UrlFetchApp.fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'post', contentType: 'application/json', payload: JSON.stringify(body), muteHttpExceptions: true,
    headers: {
      Authorization: 'Bearer ' + prop_('OPENROUTER_API_KEY'),
      'HTTP-Referer': CONFIG.SITE_URL,
      'X-Title': 'Animal Liberation Songbook intake',
    },
  });
  if (res.getResponseCode() !== 200) throw new Error('OpenRouter ' + res.getResponseCode() + ': ' + res.getContentText().slice(0, 800));
  const msg = JSON.parse(res.getContentText());
  if (msg.error) throw new Error('OpenRouter error: ' + JSON.stringify(msg.error).slice(0, 800));
  const choice = (msg.choices || [])[0];
  if (!choice || !choice.message) throw new Error('OpenRouter returned no choices: ' + JSON.stringify(msg).slice(0, 800));
  if (choice.finish_reason === 'length') throw new Error('Model ran out of output tokens; raise CONFIG.MAX_TOKENS');
  let out = choice.message.content;
  if (Array.isArray(out)) out = out.filter(p => p.type === 'text').map(p => p.text).join('');
  return String(out).replace(/^```(?:json)?\s*|\s*```$/g, '');
}

// ---------------------------------------------------------------- GitHub

function githubHeaders_() {
  return {
    Authorization: 'Bearer ' + prop_('GITHUB_TOKEN'),
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
}

function gh_(method, path, payload) {
  const res = UrlFetchApp.fetch('https://api.github.com' + path, {
    method: method, headers: githubHeaders_(), muteHttpExceptions: true,
    contentType: 'application/json', payload: payload ? JSON.stringify(payload) : undefined,
  });
  const code = res.getResponseCode();
  const text = res.getContentText();
  if (code === 404 && method === 'get') return null;
  if (code >= 300) throw new Error('GitHub ' + method.toUpperCase() + ' ' + path + ' -> ' + code + ': ' + text.slice(0, 500));
  return text ? JSON.parse(text) : {};
}

function openPullRequest_(draft, sub, sourceLink) {
  const repo = '/repos/' + CONFIG.GITHUB_REPO;
  const base = gh_('get', repo + '/git/ref/heads/' + CONFIG.BASE_BRANCH).object.sha;

  // Unique file name on main.
  let slug = draft.slug, n = 2;
  while (gh_('get', repo + '/contents/docs/' + draft.section + '/' + slug + '.md?ref=' + CONFIG.BASE_BRANCH)) {
    slug = draft.slug + '-' + n++;
  }
  const branch = 'submission/' + slug + '-' + Utilities.formatDate(new Date(), 'UTC', 'yyyyMMdd-HHmm');
  gh_('post', repo + '/git/refs', { ref: 'refs/heads/' + branch, sha: base });

  // Attachments -> docs/files/<section>/
  const fileLinks = [];
  sub.uploads.forEach(u => {
    const safe = u.name.replace(/[^\w.\-() ]+/g, '_');
    const path = 'docs/files/' + draft.section + '/' + safe;
    gh_('put', repo + '/contents/' + encodeURI(path), {
      message: 'Add ' + safe + ' for ' + draft.title, branch: branch,
      content: Utilities.base64Encode(u.blob.getBytes()),
    });
    fileLinks.push({ label: safe.replace(/\.[^.]+$/, ''), rel: '../files/' + draft.section + '/' + encodeURIComponent(safe), ext: safe.split('.').pop().toLowerCase() });
  });

  // Page
  let page = draft.page_markdown.replace(/\r\n/g, '\n').trim() + '\n';
  if (draft.section === 'commercial-artists') {
    page = page.replace(/(\n# [^\n]+\n(?:\n\*[^\n]+\*\n)?)/, '$1\n!!! note ""\n    These songs are the property of their copyright holders and are presented for personal use only.\n');
  }
  if (fileLinks.length) {
    page += '\n## Files\n\n' + fileLinks.map(f => '- [' + f.label + '](' + f.rel + ')').join('\n') + '\n\n';
    fileLinks.forEach(f => {
      const h = '../' + f.rel;
      if (f.ext === 'pdf') page += '<object data="' + h + '" type="application/pdf" width="100%" height="700"><p><a href="' + h + '">' + f.label + '</a></p></object>\n\n';
      else if (['mp3', 'm4a', 'wav', 'ogg'].includes(f.ext)) page += '<audio controls preload="none" src="' + h + '"></audio>\n\n';
    });
  }
  page += '\n<!-- source: ' + sub.messageId + ' -->\n';
  gh_('put', repo + '/contents/docs/' + draft.section + '/' + slug + '.md', {
    message: 'Add song: ' + draft.title, branch: branch,
    content: Utilities.base64Encode(Utilities.newBlob(page).getBytes()),
  });

  const bodyLines = [
    draft.summary, '',
    '**Section:** ' + draft.section,
    '**From:** ' + sub.from.replace(/</g, '&lt;').replace(/>/g, '&gt;'),
    '**Subject:** ' + sub.subject,
    '**Source:** ' + sourceLink,
  ];
  if (fileLinks.length) bodyLines.push('**Files:** ' + fileLinks.map(f => f.label + '.' + f.ext).join(', '));
  if (sub.skipped.length) bodyLines.push('**Skipped attachments:** ' + sub.skipped.map(s => s.name + ' (' + s.reason + ')').join(', '));
  if (draft.review_notes) bodyLines.push('', '### Please check', '', draft.review_notes);
  bodyLines.push('', '_Drafted automatically from the emailed submission. Edit the page in this PR if needed, then merge to publish._');

  const pr = gh_('post', repo + '/pulls', {
    title: 'Add song: ' + draft.title, head: branch, base: CONFIG.BASE_BRANCH, body: bodyLines.join('\n'),
  });
  return pr.html_url;
}

// ---------------------------------------------------------------- helpers

function getOrCreateLabel_(name) {
  return GmailApp.getUserLabelByName(name) || GmailApp.createLabel(name);
}

function prop_(key) {
  return PropertiesService.getScriptProperties().getProperty(key);
}

function gmailLink_(thread) {
  return 'https://mail.google.com/mail/u/0/#all/' + thread.getId();
}

function notify_(subject, body) {
  const to = CONFIG.ALERT_EMAIL || Session.getActiveUser().getEmail();
  if (to) GmailApp.sendEmail(to, subject, body);
}

// ---------------------------------------------------------------- manual test

function testClaude() {
  const sample = {
    subject: 'Song submission: Every Goat Has a Story',
    from: 'Test <test@example.com>',
    body: 'Hi Eva, here is a chant song for the songbook.\n\nEvery Goat Has a Story\nby Jason Oliver\nrecording: https://youtu.be/ubQPWxFF_ok\n\n(repeat each line)\nC\nEvery goat has a story\n                          G\nAnd you\'ll know when you\'re near\n                    C\nThat each one deserves freedom\n        G          C   G  C\nThat\'s the reason I\'m here\n\nThanks!\nSent from my iPhone',
    docs: [], pdfs: [], images: [], uploads: [], skipped: [],
  };
  const draft = draftPage_(sample);
  Logger.log(JSON.stringify(draft, null, 2));
}

// ---------------------------------------------------------------- Google Form path

const FORM_FIELDS = {
  title: 'Song title',
  credits: 'Songwriter / credits (for a rewrite, also name the original tune)',
  text: 'Lyrics and chords',
  links: 'Links (recordings, karaoke tracks, sheet music)',
  section: 'Which section fits best?',
  name: 'Your name',
  email: 'Your email (only so we can ask a question about the song)',
  files: 'Files (sheet music PDF, recording, chord chart photo)',
};

/** Build the submission form once. Logs the URL to share. */
function createSubmissionForm() {
  const form = FormApp.create('Animal Liberation Songbook: submit a song');
  form.setDescription('Add a song to the songbook at ' + CONFIG.SITE_URL + '. Songs with a nonviolent, antispeciesist message are welcome. ' +
    'Everything you submit is published under CC BY-NC-SA 4.0 unless you tell us otherwise.');
  form.setCollectEmail(false);
  form.addTextItem().setTitle(FORM_FIELDS.title).setRequired(true);
  form.addTextItem().setTitle(FORM_FIELDS.credits);
  form.addParagraphTextItem().setTitle(FORM_FIELDS.text).setRequired(true)
    .setHelpText('Paste the whole song. Put chords on the line above the lyrics they go with.');
  form.addParagraphTextItem().setTitle(FORM_FIELDS.links);
  form.addMultipleChoiceItem().setTitle(FORM_FIELDS.section)
    .setChoiceValues(['An original song for the animal movement', 'A rewrite of an existing tune', 'A song from another movement', 'A song by a commercial artist', 'Not sure']);
  form.addTextItem().setTitle(FORM_FIELDS.name);
  form.addTextItem().setTitle(FORM_FIELDS.email);
  // File upload questions require the respondent to sign in to a Google account.
  form.addFileUploadItem ? form.addFileUploadItem().setTitle(FORM_FIELDS.files).setHelpText('Optional. Requires signing in to Google.') : null;
  PropertiesService.getScriptProperties().setProperty('FORM_ID', form.getId());
  Logger.log('Share this link: ' + form.getPublishedUrl());
  Logger.log('Edit the form here: ' + form.getEditUrl());
  Logger.log('Now run installFormTrigger().');
}

function installFormTrigger() {
  const id = prop_('FORM_ID');
  if (!id) throw new Error('Run createSubmissionForm() first, or set the FORM_ID script property to an existing form.');
  ScriptApp.getProjectTriggers().filter(t => t.getHandlerFunction() === 'onFormSubmit').forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('onFormSubmit').forForm(FormApp.openById(id)).onFormSubmit().create();
  Logger.log('Form trigger installed.');
}

function onFormSubmit(e) {
  const answers = {};
  e.response.getItemResponses().forEach(r => { answers[r.getItem().getTitle()] = r.getResponse(); });
  const get = k => answers[FORM_FIELDS[k]] || '';
  const sub = {
    subject: 'Form submission: ' + get('title'),
    from: (get('name') || 'Anonymous') + (get('email') ? ' <' + get('email') + '>' : ''),
    date: new Date(),
    messageId: 'form response ' + e.response.getId(),
    body: ['Song title: ' + get('title'), 'Credits: ' + get('credits'), 'Preferred section: ' + get('section'),
           'Links:\n' + get('links'), '', '--- SONG ---', get('text')].join('\n'),
    docs: [], pdfs: [], images: [], uploads: [], skipped: [],
  };
  const fileIds = [].concat(get('files') || []);
  fileIds.forEach(id => {
    try {
      const blob = DriveApp.getFileById(id).getBlob();
      const name = blob.getName(), mime = (blob.getContentType() || '').toLowerCase();
      if (mime === 'application/pdf') { sub.pdfs.push({ name, blob }); sub.uploads.push({ name, blob }); }
      else if (mime.startsWith('audio/')) sub.uploads.push({ name, blob });
      else if (mime.startsWith('image/')) sub.images.push({ name, blob });
      else if (/wordprocessingml|msword/.test(mime)) { const md = wordToMarkdown_(blob); md ? sub.docs.push({ url: name, markdown: md }) : sub.skipped.push({ name, reason: 'could not convert Word file' }); }
      else sub.skipped.push({ name, reason: 'unsupported type ' + mime });
    } catch (err) { sub.skipped.push({ name: id, reason: String(err) }); }
  });
  const link = 'https://docs.google.com/forms/d/' + prop_('FORM_ID') + '/edit#responses';
  try {
    const draft = draftPage_(sub);
    const prUrl = openPullRequest_(draft, sub, link);
    notify_('Songbook: pull request ready', 'A new form submission is ready for review:\n\n' + prUrl + '\n\nMerge it to publish.\n\nForm responses: ' + link);
  } catch (err) {
    notify_('Songbook: form submission failed', 'Could not process "' + sub.subject + '".\n\n' + (err && err.stack || err) + '\n\nForm responses: ' + link);
  }
}
