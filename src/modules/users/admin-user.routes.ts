import { Router } from 'express';
import { requireAuth } from '../../middleware/auth.js';
import {
  createRoleAssignmentSchema,
  createUserSchema,
  updateUserSchema,
} from './admin-user.schemas.js';
import {
  assignRoleToUser,
  createUser,
  listAccessibleUsers,
  listVisibleRoleAssignments,
  removeRoleAssignment,
  updateUser,
} from './admin-user.service.js';

export const adminUserRouter = Router();

adminUserRouter.get('/', requireAuth, async (req, res) => {
  res.json({ data: await listAccessibleUsers(req.auth!.userId) });
});

adminUserRouter.post('/', requireAuth, async (req, res) => {
  const input = createUserSchema.parse(req.body);
  const data = await createUser(req.auth!.userId, input);
  res.status(201).json({ data });
});

adminUserRouter.patch('/:userId', requireAuth, async (req, res) => {
  const input = updateUserSchema.parse(req.body);
  res.json({ data: await updateUser(req.auth!.userId, req.params.userId, input) });
});

adminUserRouter.get('/:userId/role-assignments', requireAuth, async (req, res) => {
  res.json({
    data: await listVisibleRoleAssignments(req.auth!.userId, req.params.userId),
  });
});

adminUserRouter.post('/:userId/role-assignments', requireAuth, async (req, res) => {
  const input = createRoleAssignmentSchema.parse(req.body);
  const data = await assignRoleToUser(req.auth!.userId, req.params.userId, input);
  res.status(201).json({ data });
});

adminUserRouter.delete('/:userId/role-assignments/:assignmentId', requireAuth, async (req, res) => {
  await removeRoleAssignment(
    req.auth!.userId,
    req.params.userId,
    req.params.assignmentId
  );
  res.status(204).end();
});
