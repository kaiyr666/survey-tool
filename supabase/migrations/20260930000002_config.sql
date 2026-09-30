-- Live Poll — content configuration.
--
-- Question texts live here (in the database), not in page code: fix a typo in the
-- Supabase Table Editor (tables `questions` / `options` for the running session,
-- `app_config.template` for future sessions) and every screen picks it up — no rebuild.
--
-- Default operator PIN: 2468 — change it right after deploying:
--   select set_admin_pin('your-long-secret-pin');

insert into public.app_config (id, pin_hash, event_title, companies, template)
values (
  1,
  extensions.crypt('2468', extensions.gen_salt('bf')),
  'Panel session “Business challenges in the age of digitalization”',
  '["Leasing", "SinoAsia B&R", "Life", "Insurance", "Project", "Invest", "HUB"]'::jsonb,
  $json$[
    {
      "text": "What slows down digitalization and automation in your company the most?",
      "hint": "Choose up to two options",
      "type": "multi", "min": 1, "max": 2, "shuffle": true,
      "options": [
        {"text": "Lack of IT resources"},
        {"text": "Legacy systems and integrations"},
        {"text": "Data: quality and access"},
        {"text": "Manual, undocumented processes"},
        {"text": "People’s skills and habits"},
        {"text": "No priority or budget"},
        {"text": "Regulation and information security"},
        {"text": "Approvals between Group companies"}
      ]
    },
    {
      "text": "How often do you use AI tools at work?",
      "hint": "Choose one option",
      "type": "single", "min": 1, "max": 1, "shuffle": false,
      "options": [
        {"text": "Every day"},
        {"text": "Several times a week"},
        {"text": "Tried it, but it didn’t stick"},
        {"text": "Not using it yet"}
      ]
    },
    {
      "text": "What do you use AI for most often at work?",
      "hint": "Choose up to two options",
      "type": "multi", "min": 1, "max": 2, "shuffle": true,
      "options": [
        {"text": "Texts and emails"},
        {"text": "Searching and summarizing information"},
        {"text": "Data analysis and reports"},
        {"text": "Presentations and documents"},
        {"text": "Translation"},
        {"text": "Ideas and brainstorming"},
        {"text": "Code and task automation"},
        {"text": "Not using it yet", "exclusive": true, "pinned_last": true}
      ]
    }
  ]$json$::jsonb
);

-- Start with a test session so the app works right after deploy.
select public._create_session('test', 'Test session');
