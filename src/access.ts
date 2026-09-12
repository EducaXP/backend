import type { Store } from "./db.js";
import {
  requireFound,
  type User,
  type Classroom,
  type Group,
  type MissionRow,
  type SubmissionRow,
} from "./domain.js";
export async function classroomAccess(
  db: Store,
  user: User,
  id: string,
): Promise<Classroom> {
  return requireFound(
    await db.get<Classroom>(
      "SELECT c.* FROM classrooms c WHERE c.id=$1 AND c.school_id=$2 AND\n    (c.teacher_id=$3 OR EXISTS(SELECT 1 FROM memberships m WHERE m.classroom_id=c.id AND m.user_id=$4))",
      id,
      user.school_id,
      user.id,
      user.id,
    ),
  );
}
export async function groupAccess(
  db: Store,
  user: User,
  id: string,
): Promise<Group> {
  const group = requireFound(
    await db.get<Group>("SELECT * FROM groups WHERE id=$1", id),
  );
  const classroom = await classroomAccess(db, user, group.classroom_id);
  if (classroom.teacher_id !== user.id) {
    requireFound(
      await db.get(
        "SELECT 1 FROM group_members WHERE group_id=$1 AND user_id=$2",
        id,
        user.id,
      ),
    );
  }
  return group;
}
export async function missionAccess(
  db: Store,
  user: User,
  id: string,
): Promise<MissionRow> {
  const mission = requireFound(
    await db.get<MissionRow>("SELECT * FROM missions WHERE id=$1", id),
  );
  await classroomAccess(db, user, mission.classroom_id);
  if (user.role === "student" && mission.status === "draft")
    requireFound(undefined);
  return mission;
}
export async function submissionAccess(
  db: Store,
  user: User,
  id: string,
): Promise<SubmissionRow> {
  const submission = requireFound(
    await db.get<SubmissionRow>("SELECT * FROM submissions WHERE id=$1", id),
  );
  await groupAccess(db, user, submission.group_id);
  await missionAccess(db, user, submission.mission_id);
  return submission;
}
