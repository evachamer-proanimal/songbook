# Songbook intake (email or form → pull request)

A Google Apps Script that lives in the personal Google account (evachamer@gmail.com).
Submissions arrive two ways, and both end in the same place:

- **Email**: forward a submission to `evachamer+songbook@gmail.com`; a Gmail filter labels it `Songbook`.
- **Form**: a Google Form (created by the script) whose responses trigger the script directly.

For each submission the script:

1. reads the email, any Google Docs linked in it, and attached PDFs, Word files, images and audio;
2. asks Claude to draft a page in the songbook's format (and to pick the section);
3. pushes the page and the PDF/audio files to a branch in `evachamer-proanimal/songbook`;
4. opens a pull request and emails you the link.

Merging the pull request publishes the song. Nothing reaches the site without that click.

The public submission address is **eva@proanimal.org**. Forward from there to
`evachamer+songbook@gmail.com`; that address is the only thing that ever needs
to change if the public address changes.

## One-time setup (about 15 minutes)

All of this happens signed in as **evachamer@gmail.com**.

### 1. Gmail label and filter

- Gmail → Settings → Filters → Create filter: **To** `evachamer+songbook@gmail.com`
  → Apply label `Songbook` (create it), optionally *Skip the Inbox*.
- Labels `Songbook/Added` and `Songbook/Failed` are created by the script.

### 2. Tokens

- **Model key**: either an **OpenRouter** key (openrouter.ai → Keys; set `PROVIDER: 'openrouter'` in `Config.gs`, the default)
  or an **Anthropic** key (console.anthropic.com → API keys; set `PROVIDER: 'anthropic'`). Either way it's
  the same Claude model and a few cents per submission; OpenRouter adds a small fee and bills your OpenRouter credits.
- **GitHub token**: github.com → Settings → Developer settings → Fine-grained tokens → Generate.
  Resource owner `evachamer-proanimal`, repository access *Only select repositories* → `songbook`,
  permissions **Contents: Read and write** and **Pull requests: Read and write**, expiry 1 year
  (put the expiry date in your calendar; the script's failure email will tell you when it lapses).

### 3. Create the Apps Script project

Either paste the two `.gs` files and `appsscript.json` into a new project at script.google.com,
or from this folder with clasp (log in as the personal account first):

```bash
cd intake && clasp login && clasp create --type standalone --title "Songbook Intake" && clasp push
```

If clasp asks about overwriting the manifest, say yes: `appsscript.json` here carries the scopes.

### 4. Secrets

In the Apps Script editor: Project Settings (gear) → Script properties → add
`GITHUB_TOKEN` and either `OPENROUTER_API_KEY` or `ANTHROPIC_API_KEY`, matching `PROVIDER`.

### 5. Authorize and schedule

In the editor, run `setup()` once (accept the permission prompts), then `installTrigger()`.
Optionally run `testClaude()` and read the log to see a drafted page before sending real mail.

### 6. Optional: the submission form

Run `createSubmissionForm()` once; the log prints a share link and an edit link. Then run
`installFormTrigger()`. Put the share link on the songbook's home page (edit `docs/index.md`
in the repo) or anywhere else. Notes on the form:

- Text-only submissions need no Google sign-in. The *Files* question does force respondents to
  sign in to a Google account, which is a Google Forms rule, not ours. Delete that question in the
  form editor if you'd rather keep the form fully anonymous; email remains the path for attachments.
- Responses are processed the moment they arrive, no polling.

## Day to day

- Forward a submission to `evachamer+songbook@gmail.com`. That's it.
- You get an email with the pull request link. Open it, skim the page under *Files changed*,
  edit in the browser if something's off, and click **Merge**. The site rebuilds in about a minute.
- If something fails you get an email with the error; the thread gets `Songbook/Failed`.
  Fix the cause (usually an expired token) and run `retryFailed()`.

## Notes

- Word attachments are converted through a temporary Google Doc that is deleted right away.
- Google Docs links are read with the personal account's access, so a doc shared with that
  account (or public) works; a private doc is reported as skipped in the PR.
- Chord positioning from PDFs and photos is best-effort; the PR's *Please check* section calls out anything Claude was unsure of.
- Settings live in `Config.gs`. Model, effort, poll interval and size limits are all there.
