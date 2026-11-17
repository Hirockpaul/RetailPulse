-- 0001: database-wide foundations. Domain tables start in 0002 (Day 2).

-- Case-insensitive text for SKUs, location codes and emails.
CREATE EXTENSION IF NOT EXISTS citext;

-- Shared trigger function to maintain updated_at columns.
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
