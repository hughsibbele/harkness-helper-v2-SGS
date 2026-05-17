-- Split the single Gemini pass into a two-pass flow:
--   pass 1 → verbatim transcript (discussions.transcript, prompt purpose='transcription')
--   pass 2 → narrative summary  (discussions.summary,    prompt purpose='summary')
--
-- The original prompt was summary-style (flowing prose, no names) — what users
-- actually saw under the 'transcript' label was effectively a summary. This
-- migration:
--   1. Adds discussions.summary + discussions.summary_prompt_id
--   2. Expands prompts.purpose CHECK to include 'summary'
--   3. Overwrites the seeded transcription prompt body to a verbatim style
--   4. Inserts a new system 'summary' prompt with the previous narrative body
--
-- Overwriting the existing transcription prompt body assumes the user hasn't
-- customized it via /admin/prompts. That's safe for the current install
-- (single-user, brand new). Future deployments that have customized prompts
-- would need to re-customize after this migration.

alter table discussions
  add column summary text,
  add column summary_prompt_id uuid references prompts(id) on delete restrict;

-- Expand purpose CHECK to allow 'summary'.
alter table prompts drop constraint prompts_purpose_check;
alter table prompts add constraint prompts_purpose_check
  check (purpose in ('transcription', 'summary'));

-- Rewrite the seeded transcription prompt to ask for verbatim output.
update prompts
set body = $prompt$# Harkness Discussion Transcription

## Role
You produce a verbatim transcript of an audio recording of a Harkness-style classroom discussion at Episcopal High School.

## Output style
- **Transcribe what was said as faithfully as you can.** Preserve actual words, filler ("um," "like"), restarts, and partial sentences when they're part of how the student spoke. Don't smooth them out.
- **Speaker handling.** Indicate speaker changes in line with a short marker like `[new speaker]` whenever the speaker changes. If you can't tell whether the voice changed, omit the marker — don't guess.
- **Names.** If any name is spoken aloud, replace it in your output with the literal token `Student_xxxxxx` (six lowercase hex characters — pick any; the app will rewrite to the actual anon_token on the way back). Apply to first names, last names, and full names. Do not anonymize the teacher's name; mark it as `Teacher` if used.
- **Unclear audio.** Mark inaudible or uncertain stretches with `[inaudible]` rather than guessing.
- **Non-speech.** Note long silences or laughter briefly in brackets (e.g., `[long pause]`, `[laughter]`) — keep these sparse.
- **No interpretation.** Don't summarize, condense, or paraphrase. The summary pass happens separately.

## What is NOT to be anonymized
The text of the discussion itself — works being discussed, characters in those works, historical figures, etc. — is not PII and should appear verbatim.
$prompt$,
    updated_at = now()
where scope = 'system' and purpose = 'transcription' and is_default = true;

-- New system summary prompt — uses the prior narrative-style content as its
-- starting body. This is the prompt the second Gemini call will use, with
-- the verbatim transcript pasted in as input.
insert into prompts (label, scope, teacher_id, is_default, purpose, body)
values (
  'Default',
  'system',
  null,
  true,
  'summary',
  $prompt$# Harkness Discussion Summary

## Role
Given a verbatim transcript of a Harkness-style classroom discussion at Episcopal High School, produce a flowing, content-rich summary. Your output is the source-of-record for the teacher's collective grade.

## Output style
- **Do not identify speakers by name.** The transcript anonymizes students as `Student_xxxxxx`; reuse those tokens or generic handles like "one student", "another student", "a third student" as needed. Even when names appear in the transcript, do not surface them.
- Write a continuous narrative, not turn-by-turn dialogue. Paragraphs that follow the arc of the conversation — what was raised, where it went, who pushed back, where it landed.
- Quote short, illustrative phrases verbatim when they capture the substance of an idea. Don't quote everything.
- Note moments of silence, hesitation, or apparent confusion ("there was a pause before someone tried again"). These are part of the discussion's texture.
- If the transcript notes `[inaudible]` stretches, acknowledge them briefly rather than guessing what was said.

## Length
Aim for 400–800 words for a typical 50–60 minute discussion. Longer if the discussion was particularly substantive; shorter if it stalled.

## What is NOT to be anonymized
The text of the discussion itself — works being discussed, characters in those works, historical figures, etc. — is not PII and should appear verbatim.
$prompt$
);
