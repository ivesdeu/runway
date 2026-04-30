-- Optional case study fields on projects (run after projects table exists).
ALTER TABLE public.projects ADD COLUMN IF NOT EXISTS case_study_published boolean DEFAULT false;
ALTER TABLE public.projects ADD COLUMN IF NOT EXISTS case_study_challenge text;
ALTER TABLE public.projects ADD COLUMN IF NOT EXISTS case_study_strategy jsonb DEFAULT '[]'::jsonb;
ALTER TABLE public.projects ADD COLUMN IF NOT EXISTS case_study_results jsonb DEFAULT '[]'::jsonb;
ALTER TABLE public.projects ADD COLUMN IF NOT EXISTS case_study_category text;
