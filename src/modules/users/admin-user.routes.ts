import { Router } from 'express';
import { requireRouteParam } from '../../lib/route-param.js';
import { requireAuth } from '../../middleware/auth.js';
import { adminUserSecurityRouter } from './admin-user-security.routes.js';
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

type AssignmentPayload = { roleId: string; legalEntityId?: string | undefined; businessUnitId?: string | undefined };
function normalizeAssignment(input: AssignmentPayload) {
  return { roleId: input.roleId, ...(input.legalEntityId ? { legalEntityId: input.legalEntityId } : {}), ...(input.businessUnitId ? { businessUnitId: input.businessUnitId } : {}) };
}

adminUserRouter.get('/', requireAuth, async (req,res)=>{res.json({data:await listAccessibleUsers(req.auth!.userId)});});
adminUserRouter.post('/', requireAuth, async (req,res)=>{const parsed=createUserSchema.parse(req.body);const input={email:parsed.email,displayName:parsed.displayName,password:parsed.password,...(parsed.initialAssignment?{initialAssignment:normalizeAssignment(parsed.initialAssignment)}:{})};res.status(201).json({data:await createUser(req.auth!.userId,input)});});
adminUserRouter.use('/:userId/security', adminUserSecurityRouter);
adminUserRouter.patch('/:userId', requireAuth, async (req,res)=>{const userId=requireRouteParam(req,'userId');const parsed=updateUserSchema.parse(req.body);const input={...(parsed.email!==undefined?{email:parsed.email}:{}),...(parsed.displayName!==undefined?{displayName:parsed.displayName}:{}),...(parsed.status!==undefined?{status:parsed.status}:{})};res.json({data:await updateUser(req.auth!.userId,userId,input)});});
adminUserRouter.get('/:userId/role-assignments', requireAuth, async (req,res)=>{const userId=requireRouteParam(req,'userId');res.json({data:await listVisibleRoleAssignments(req.auth!.userId,userId)});});
adminUserRouter.post('/:userId/role-assignments', requireAuth, async (req,res)=>{const userId=requireRouteParam(req,'userId');const parsed=createRoleAssignmentSchema.parse(req.body);res.status(201).json({data:await assignRoleToUser(req.auth!.userId,userId,normalizeAssignment(parsed))});});
adminUserRouter.delete('/:userId/role-assignments/:assignmentId', requireAuth, async (req,res)=>{const userId=requireRouteParam(req,'userId');const assignmentId=requireRouteParam(req,'assignmentId');await removeRoleAssignment(req.auth!.userId,userId,assignmentId);res.status(204).end();});
