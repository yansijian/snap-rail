/**
 * The forge store tables (namespace `forge`, database `data/forge.db`):
 * generated plugins with their immutable version history, creation
 * sessions, and the conversation log the agent loop replays. Rows survive
 * plugin reload — the registry, not any registering fiber, is the artifact;
 * `current_seq` is the activation pointer boot remounts from.
 *
 * @module @snap-rail/forge/tables
 */

import type { StoreSchema } from '@snap-rail/store'
import { integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core'

/** Generated plugins: the stable instance one row per created feature. */
export const plugins = sqliteTable('plugins', {
  id: text('id').primaryKey(),
  title: text('title').notNull(),
  description: text('description').notNull().default(''),
  /** Whether boot remounts this plugin (the activation pointer below). */
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  /** The active version's seq (`null` before the first run). */
  currentSeq: integer('current_seq'),
  createdAt: integer('created_at').notNull(),
})

/** Immutable code versions: append-only, never rewritten or deleted in place. */
export const versions = sqliteTable('versions', {
  pluginId: text('plugin_id').notNull(),
  /** The version's number; the wire id is `v<seq>`. */
  seq: integer('seq').notNull(),
  summary: text('summary').notNull().default(''),
  /** The host-half function body (`null` for renderer-only plugins). */
  hostSrc: text('host_src'),
  /** The renderer-half function body (`null` for host-only plugins). */
  clientSrc: text('client_src'),
  createdAt: integer('created_at').notNull(),
}, table => [
  primaryKey({ columns: [table.pluginId, table.seq] }),
])

/** Creation sessions with the agent loop. */
export const sessions = sqliteTable('sessions', {
  id: text('id').primaryKey(),
  title: text('title').notNull(),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
})

/** The conversation log, oldest-first (`meta` carries tool-call records). */
export const messages = sqliteTable('messages', {
  sessionId: text('session_id').notNull(),
  seq: integer('seq').notNull(),
  role: text('role').notNull(),
  content: text('content').notNull(),
  meta: text('meta'),
  createdAt: integer('created_at').notNull(),
}, table => [
  primaryKey({ columns: [table.sessionId, table.seq] }),
])

/** The namespace's drizzle schema. */
export const FORGE_SCHEMA: StoreSchema = { plugins, versions, sessions, messages }
