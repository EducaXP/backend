import type { Store } from "./db.js";
import {
  requireFound,
  type User,
  type Classroom,
  type Group,
  type MissionRow,
  type SubmissionRow,
} from "./domain.js";

export function classroomAccess(db: Store, user: User, id: string): Classroom {
  return requireFound(
    db.get<Classroom>(
      `SELECT c.* FROM classrooms c WHERE c.id=? AND c.school_id=? AND
    (c.teacher_id=? OR EXISTS(SELECT 1 FROM memberships m WHERE m.classroom_id=c.id AND m.user_id=?))`,
      id,
      user.school_id,
      user.id,
      user.id,
    ),
  );
}
export function groupAccess(db: Store, user: User, id: string): Group {
  const group = requireFound(
    db.get<Group>("SELECT * FROM groups WHERE id=?", id),
  );
  const classroom = classroomAccess(db, user, group.classroom_id);
  if (classroom.teacher_id !== user.id) {
    requireFound(
      db.get(
        "SELECT 1 FROM group_members WHERE group_id=? AND user_id=?",
        id,
        user.id,
      ),
    );
  }
  return group;
}
export function missionAccess(db: Store, user: User, id: string): MissionRow {
  const mission = requireFound(
    db.get<MissionRow>("SELECT * FROM missions WHERE id=?", id),
  );
  classroomAccess(db, user, mission.classroom_id);
  if (user.role === "student" && mission.status === "draft")
    requireFound(undefined);
  return mission;
}
export function submissionAccess(
  db: Store,
  user: User,
  id: string,
): SubmissionRow {
  const submission = requireFound(
    db.get<SubmissionRow>("SELECT * FROM submissions WHERE id=?", id),
  );
  groupAccess(db, user, submission.group_id);
  missionAccess(db, user, submission.mission_id);
  return submission;
}
