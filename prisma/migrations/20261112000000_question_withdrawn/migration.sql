-- Additive: a new lifecycle value. Existing rows are unchanged.
ALTER TYPE "QuestionStatus" ADD VALUE IF NOT EXISTS 'WITHDRAWN';
