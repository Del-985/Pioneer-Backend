import { Router } from 'express';
import { requireRouteParam } from '../../lib/route-param.js';
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
  const userId = requireRouteParam(req, 'userId');
  const input = updateUserSchema.parse(req.body);
  res.json({ data: await updateUser(req.auth!.userId, userId, input) });
});

adminUserRouter.get('/:userId/role-assignments', requireAuth, async (req, res) => {
  const userId = requireRouteParam(req, 'userId');
  res.json({
    data: await listVisibleRoleAssignments(req.auth!.userId, userId),
  });
});

adminUserRouter.post('/:userId/role-assignments', requireAuth, async (req, res) => {
  const userId = requireRouteParam(req, 'userId');
  const input = createRoleAssignmentSchema.parse(req.body);
  const data = await assignRoleToUser(req.auth!.userId, userId, input);
  res.status(201).json({ data });
});

adminUserRouter.delete('/:userId/role-assignments/:assignmentId', requireAuth, async (req, res) => {
  const userId = requireRouteParam(req, 'userId');
  const assignmentId = requireRouteParam(req, 'assignmentId');
  await removeRoleAssignment(
    req.auth!.userId,
    userId,
    assignmentId
  );
  res.status(204).end();
});
