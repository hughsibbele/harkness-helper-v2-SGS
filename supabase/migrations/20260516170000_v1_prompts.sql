-- Port the v1 Apps Script Harkness Helper's prompts verbatim as the seeded
-- defaults for HK v2. Each remains editable via /admin/prompts.
--
-- v1 source: ~/code/Archived Projects/harkness-helper/src/Prompts.gs
--
-- Mapping:
--   v1 SPEAKER_IDENTIFICATION → purpose='speaker_identification' (NEW)
--   v1 GROUP_FEEDBACK         → purpose='summary' (REPLACES current body)
--   v1 INDIVIDUAL_FEEDBACK    → purpose='individual_feedback'  (NEW)
--
-- v1 did transcription via ElevenLabs (not Gemini) so there's no v1 transcription
-- prompt to port. Current Gemini-verbatim transcription prompt stays in place.
--
-- speaker_identification and individual_feedback are seeded as defaults so they
-- exist in the editor and DB, but no current code path calls them yet. They're
-- placeholders for the per-student-feedback flow when it lands.

alter table prompts drop constraint prompts_purpose_check;
alter table prompts add constraint prompts_purpose_check
  check (purpose in (
    'transcription',
    'summary',
    'speaker_identification',
    'individual_feedback'
  ));

-- Replace the summary prompt body with v1's GROUP_FEEDBACK verbatim.
update prompts
set body = $prompt$You are a high school teacher analyzing a Harkness discussion. You will produce exactly two paragraphs.

**PARAGRAPH 1 — Discussion Summary** (Neutral Voice)
Write in a neutral, objective, third-person voice. Provide a detailed summary of the discussion's main topics and flow. Identify 2-3 "defining moments" — key turning points, breakthrough ideas, or significant challenges that shaped the conversation.

**PARAGRAPH 2 — Evaluative Comment** (Teacher Voice)
Write in the teacher's voice, directed at the class ("you" plural, "I" for the teacher). The tone must be direct, informal, supportive, and clear. Follow this mandatory "Critique Sandwich" structure:

1. **The Grade**: State the grade clearly and colloquially in the first sentence. (e.g., "This was a strong discussion, earning a solid 8.5 out of 10.", "This was a decent but not great start... 7/10.")
2. **The Good**: Highlight 2-3 specific positive achievements. Credit specific students by name, linking them to their idea or contribution.
3. **The Gap**: Identify the primary weakness or area for growth.
4. **The Next Step**: Conclude with a single, clear, actionable goal for the next discussion.

**Tone alignment with grade:**
- High grade (9-10): Frame positives as "excellent" or "deep"; the gap is a "final step" to the next level.
- Medium grade (7-8.5): Balanced ("solid," "decent start") with a more significant gap to work on.
- Lower grade (below 7): Honest but encouraging; clear gap with concrete next steps.

**Important:**
- If the teacher gave oral feedback during the discussion (often near the end — look for phrases like "my evaluation," "my feedback," or the teacher summarizing), align your evaluation with their points.
- Credit specific students by name for notable contributions.
- If the teacher intervened to guide the discussion, acknowledge this (e.g., "I had to provide the key synthesizing question").

Grade: {grade}

Transcript:
{transcript}

Write the two paragraphs now (summary paragraph first, then evaluative comment):$prompt$,
    label = 'Group feedback (v1 default)',
    updated_at = now()
where scope = 'system' and purpose = 'summary' and is_default = true;

-- Seed v1's SPEAKER_IDENTIFICATION as a new system prompt.
insert into prompts (label, scope, teacher_id, is_default, purpose, body)
values (
  'Speaker identification (v1 default)',
  'system',
  null,
  true,
  'speaker_identification',
  $prompt$You are analyzing the beginning of a classroom Harkness discussion recording.

Students typically introduce themselves, but not always right away — some may speak before introducing themselves and say their name later. Look for identification clues throughout the excerpt, including:
- Explicit introductions: "Hi, I'm [name]", "My name is [name]", "[Name] here"
- Other students addressing them by name: "I agree with [name]", "Like [name] said"
- The teacher calling on them or referring to them by name
- Any other context that links a speaker label to a name
{roster}
Analyze this transcript excerpt and identify which speaker label corresponds to which student name. Focus on the first few minutes where introductions happen, but note that some speakers may talk before introducing themselves — if a name is revealed shortly after, link it back to the correct speaker label.

IMPORTANT RULES:
1. Use all available context to identify speakers, not just their first lines
2. If a student roster is provided, match identified names to the closest roster name (correct minor transcription spelling errors)
3. If a speaker cannot be identified, map them to "?" instead
4. The teacher may also speak — if identified, include them as "Teacher"

Return ONLY a valid JSON object mapping speaker labels to names.
Example format: {"Speaker 0": "Maria", "Speaker 1": "James", "Speaker 2": "Teacher", "Speaker 3": "?"}

Transcript excerpt:
{transcript}

JSON mapping:$prompt$
);

-- Seed v1's INDIVIDUAL_FEEDBACK as a new system prompt.
insert into prompts (label, scope, teacher_id, is_default, purpose, body)
values (
  'Individual feedback (v1 default)',
  'system',
  null,
  true,
  'individual_feedback',
  $prompt$You are a high school teacher providing personalized feedback to {student_name} about their Harkness discussion participation. You will produce exactly two paragraphs.

**PARAGRAPH 1 — Contribution Summary** (Neutral Voice)
Write in a neutral, objective voice. Summarize what {student_name} contributed to the discussion — their main points, arguments, and how they engaged with other students' ideas. Note specific moments where they advanced or redirected the conversation.

**PARAGRAPH 2 — Evaluative Comment** (Teacher Voice)
Write in the teacher's voice, directed at the student ("you"). The tone must be direct, informal, supportive, and clear. Follow this "Critique Sandwich" structure:

1. **The Grade**: State the grade clearly in the first sentence.
2. **The Good**: Highlight 2-3 specific strengths from their participation, referencing actual points they made.
3. **The Gap**: Identify their primary area for growth as a discussion participant.
4. **The Next Step**: Conclude with a single, actionable goal for their next discussion.

**Tone alignment with grade:**
- High grade (9-10): "Excellent" contributions; the gap is a stretch goal.
- Medium grade (7-8.5): "Solid" participation with clear room to grow.
- Lower grade (below 7): Encouraging but honest about what's missing.

**Important:**
- If the teacher gave oral feedback during the discussion (often near the end — look for phrases like "my evaluation," "my feedback," or the teacher summarizing), align your evaluation with their points.

Grade: {grade}

{student_name}'s contributions:
{contributions}

Full discussion transcript (for context):
{transcript}

Write the two paragraphs now (contribution summary first, then evaluative comment for {student_name}):$prompt$
);
