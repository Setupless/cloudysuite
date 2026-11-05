import type { Migrations } from "@cloudysuite/object-sql";

// Append only. Add a new entry instead of editing one: migrations.test.ts pins the
// digest of every entry.
export const MIGRATIONS: Migrations = [
  [
    // One row is an event that doesn't repeat, a series, or one changed date of a series,
    // which carries that date's RECURRENCE-ID. span_start and span_end only narrow the
    // range query, and a null span_end is a series with no last date.
    `CREATE TABLE events (
      uid TEXT NOT NULL,
      recurrence_id TEXT,
      title TEXT NOT NULL,
      location TEXT NOT NULL,
      notes TEXT NOT NULL,
      starts_at INTEGER,
      ends_at INTEGER,
      tzid TEXT,
      start_date TEXT,
      end_date TEXT,
      rrule TEXT,
      exdates TEXT NOT NULL DEFAULT '[]',
      organiser TEXT NOT NULL,
      sequence INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      span_start INTEGER NOT NULL,
      span_end INTEGER,
      CHECK (
        (starts_at IS NOT NULL AND ends_at > starts_at AND tzid IS NOT NULL
          AND start_date IS NULL AND end_date IS NULL) OR
        (starts_at IS NULL AND ends_at IS NULL AND tzid IS NULL
          AND start_date IS NOT NULL AND end_date > start_date)
      ),
      CHECK (recurrence_id IS NULL OR rrule IS NULL)
    )`,
    `CREATE UNIQUE INDEX events_identity ON events(uid, coalesce(recurrence_id, ''))`,
    `CREATE INDEX events_span ON events(span_start)`,
    // What stays of an event removed from this calendar, so the same invitation arriving
    // again can't bring it back.
    `CREATE TABLE removed_events (
      uid TEXT PRIMARY KEY,
      sequence INTEGER NOT NULL,
      removed_at INTEGER NOT NULL
    ) WITHOUT ROWID`,
  ],
  [
    // An event made here now keeps its organiser's name. Older ones get null, so every
    // row has the same shape.
    `UPDATE events SET organiser = json_set(organiser, '$.name', NULL)
     WHERE json_extract(organiser, '$.kind') = 'madeHere'
       AND json_type(organiser, '$.name') IS NULL`,
  ],
  [
    // Contentless because events already holds the text. Triggers keep it in the same
    // transaction as every change to events, whichever code path makes it. An event's
    // rowid lasts its whole life: only VACUUM renumbers, and nothing here runs it.
    `CREATE VIRTUAL TABLE event_search USING fts5(
      title, location, notes,
      content = '', contentless_delete = 1,
      tokenize = 'unicode61 remove_diacritics 2',
      prefix = '2 3'
    )`,
    `INSERT INTO event_search (rowid, title, location, notes)
     SELECT rowid, title, location, notes FROM events`,
    `CREATE TRIGGER events_search_insert AFTER INSERT ON events BEGIN
      INSERT INTO event_search (rowid, title, location, notes)
      VALUES (new.rowid, new.title, new.location, new.notes);
    END`,
    `CREATE TRIGGER events_search_change AFTER UPDATE OF title, location, notes ON events
    WHEN old.title <> new.title OR old.location <> new.location OR old.notes <> new.notes
    BEGIN
      DELETE FROM event_search WHERE rowid = old.rowid;
      INSERT INTO event_search (rowid, title, location, notes)
      VALUES (new.rowid, new.title, new.location, new.notes);
    END`,
    `CREATE TRIGGER events_search_delete AFTER DELETE ON events BEGIN
      DELETE FROM event_search WHERE rowid = old.rowid;
    END`,
  ],
];
