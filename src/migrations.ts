// Append migrations; never edit an already deployed migration.
export const migrations = [
  `CREATE TABLE schools (id TEXT PRIMARY KEY, name TEXT NOT NULL);
   CREATE TABLE users (
     id TEXT PRIMARY KEY, school_id TEXT NOT NULL REFERENCES schools(id),
     role TEXT NOT NULL CHECK(role IN ('teacher','student')),
     name TEXT NOT NULL, login TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL,
     avatar_item TEXT NOT NULL DEFAULT 'basic', eco_mode INTEGER NOT NULL DEFAULT 1
   );
   CREATE TABLE sessions (
     token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), expires_at BIGINT NOT NULL
   );
   CREATE TABLE classrooms (
     id TEXT PRIMARY KEY, school_id TEXT NOT NULL REFERENCES schools(id),
     teacher_id TEXT NOT NULL REFERENCES users(id), name TEXT NOT NULL,
     join_code TEXT NOT NULL UNIQUE, paused INTEGER NOT NULL DEFAULT 0
   );
   CREATE TABLE memberships (
     classroom_id TEXT NOT NULL REFERENCES classrooms(id), user_id TEXT NOT NULL REFERENCES users(id),
     alias TEXT NOT NULL, PRIMARY KEY(classroom_id,user_id), UNIQUE(classroom_id,alias)
   );
   CREATE TABLE groups (
     id TEXT PRIMARY KEY, classroom_id TEXT NOT NULL REFERENCES classrooms(id), name TEXT NOT NULL
   );
   CREATE TABLE group_members (
     group_id TEXT NOT NULL REFERENCES groups(id), classroom_id TEXT NOT NULL,
     user_id TEXT NOT NULL, role TEXT NOT NULL,
     PRIMARY KEY(group_id,user_id), UNIQUE(classroom_id,user_id),
     FOREIGN KEY(classroom_id,user_id) REFERENCES memberships(classroom_id,user_id)
   );
   CREATE TABLE missions (
     id TEXT PRIMARY KEY, classroom_id TEXT NOT NULL REFERENCES classrooms(id),
     status TEXT NOT NULL CHECK(status IN ('draft','published','closed')) DEFAULT 'draft',
     version INTEGER NOT NULL DEFAULT 1, content TEXT NOT NULL, created_at TEXT NOT NULL
   );
   CREATE TABLE submissions (
     id TEXT PRIMARY KEY, mission_id TEXT NOT NULL REFERENCES missions(id),
     group_id TEXT NOT NULL REFERENCES groups(id), version INTEGER NOT NULL,
     content TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(mission_id,group_id)
   );
   CREATE TABLE submission_revisions (
     submission_id TEXT NOT NULL REFERENCES submissions(id), version INTEGER NOT NULL,
     content TEXT NOT NULL, author_id TEXT NOT NULL REFERENCES users(id), created_at TEXT NOT NULL,
     PRIMARY KEY(submission_id,version)
   );
   CREATE TABLE evaluations (
     id TEXT PRIMARY KEY, submission_id TEXT NOT NULL REFERENCES submissions(id),
     submission_version INTEGER NOT NULL, teacher_id TEXT NOT NULL REFERENCES users(id),
     feedback TEXT NOT NULL, scores TEXT NOT NULL, created_at TEXT NOT NULL,
     UNIQUE(submission_id,submission_version),
     FOREIGN KEY(submission_id,submission_version) REFERENCES submission_revisions(submission_id,version)
   );
   CREATE TABLE rewards (
     user_id TEXT NOT NULL REFERENCES users(id), mission_id TEXT NOT NULL REFERENCES missions(id),
     xp INTEGER NOT NULL CHECK(xp >= 0), reason TEXT NOT NULL, created_at TEXT NOT NULL,
     PRIMARY KEY(user_id,mission_id)
   );
   CREATE TABLE help_requests (
     id TEXT PRIMARY KEY, group_id TEXT NOT NULL REFERENCES groups(id),
     message TEXT NOT NULL, answer TEXT, created_at TEXT NOT NULL, resolved_at TEXT
   );
   CREATE TABLE operations (
     user_id TEXT NOT NULL REFERENCES users(id), operation_id TEXT NOT NULL,
     fingerprint TEXT NOT NULL, response TEXT NOT NULL, created_at TEXT NOT NULL,
     PRIMARY KEY(user_id,operation_id)
   );
   CREATE INDEX idx_sessions_expiry ON sessions(expires_at);
   CREATE INDEX idx_classes_teacher ON classrooms(teacher_id);
   CREATE INDEX idx_missions_class ON missions(classroom_id);
   CREATE INDEX idx_groups_class ON groups(classroom_id);
   CREATE INDEX idx_help_group ON help_requests(group_id);
  `,
];
export const dataTables = [
  "schools",
  "users",
  "sessions",
  "classrooms",
  "memberships",
  "groups",
  "group_members",
  "missions",
  "submissions",
  "submission_revisions",
  "evaluations",
  "rewards",
  "help_requests",
  "operations",
] as const;
