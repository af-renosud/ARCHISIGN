import { sql } from "drizzle-orm";
import { index, jsonb, pgTable, timestamp, varchar } from "drizzle-orm/pg-core";

// Session storage table backing connect-pg-simple. Required by the Google
// Workspace OAuth flow; do not drop or rename without coordinated rollout.
export const sessions = pgTable(
  "sessions",
  {
    sid: varchar("sid").primaryKey(),
    sess: jsonb("sess").notNull(),
    expire: timestamp("expire").notNull(),
  },
  (table) => [index("IDX_session_expire").on(table.expire)]
);

// User storage table — keyed on the Google `sub` claim. Profile fields are
// upserted on every successful sign-in by GoogleAuthService.
//
// NOTE: `email` is intentionally NOT unique. The stable identity is the
// Google subject ID (`id`). Stale rows left over from the old Replit Auth
// integration share emails with new Google sign-ins, and a unique
// constraint on email would (and did) block the upsert. With Google as
// the identity provider, the same email re-appearing under a new `id` is
// just a provider migration, not a duplicate identity.
export const users = pgTable("users", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  email: varchar("email"),
  firstName: varchar("first_name"),
  lastName: varchar("last_name"),
  profileImageUrl: varchar("profile_image_url"),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

export type UpsertUser = typeof users.$inferInsert;
export type User = typeof users.$inferSelect;
