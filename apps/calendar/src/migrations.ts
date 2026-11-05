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
  [
    // Everyone invited to an event, once for all its dates. On a copy, reply is whose
    // answer this calendar holds and what it is. The revision grows with each change to
    // the list or an answer on it, so an older list never replaces a newer one.
    `CREATE TABLE event_people (
      uid TEXT PRIMARY KEY,
      attendees TEXT NOT NULL,
      revision INTEGER NOT NULL,
      reply TEXT
    ) WITHOUT ROWID`,
    // On a copy, the organiser called this date, or the whole event, off. Adding a column
    // keeps each row's rowid, which event_search follows.
    `ALTER TABLE events ADD COLUMN cancelled INTEGER NOT NULL DEFAULT 0`,
    // Dates removed from a copy here, or this date and every later one. The organiser's
    // next change rewrites the copy, and these keep them out of it.
    `CREATE TABLE removed_dates (
      uid TEXT NOT NULL,
      recurrence_id TEXT NOT NULL,
      and_later INTEGER NOT NULL,
      removed_at INTEGER NOT NULL,
      PRIMARY KEY (uid, recurrence_id)
    ) WITHOUT ROWID`,
    // The organiser's side: this person's calendar needs the event as it is now. Written
    // in the transaction that changes the event, and sent by the alarm.
    `CREATE TABLE deliveries (
      user_id TEXT NOT NULL,
      uid TEXT NOT NULL,
      calendar_id TEXT NOT NULL,
      version INTEGER NOT NULL,
      tries INTEGER NOT NULL,
      try_at INTEGER NOT NULL,
      PRIMARY KEY (user_id, uid)
    ) WITHOUT ROWID`,
    `CREATE INDEX deliveries_due ON deliveries(try_at)`,
    // The invitee's side: the organiser's calendar needs this answer. The UID is the
    // event's there, and two calendars can each hold one with the same UID.
    `CREATE TABLE answer_notices (
      calendar_id TEXT NOT NULL,
      uid TEXT NOT NULL,
      attendee TEXT NOT NULL,
      answer TEXT NOT NULL,
      revision INTEGER NOT NULL,
      tries INTEGER NOT NULL,
      try_at INTEGER NOT NULL,
      PRIMARY KEY (calendar_id, uid)
    ) WITHOUT ROWID`,
  ],
];
