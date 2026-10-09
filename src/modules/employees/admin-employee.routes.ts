import type { Request } from 'express';
import { Router } from 'express';
import { requireRouteParam } from '../../lib/route-param.js';
import { requireAuth } from '../../middleware/auth.js';
import { createEmployeeSchema, employeeListQuerySchema, updateEmployeeSchema } from './admin-employee.schemas.js';
import { createEmployee, listEmployees, updateEmployee } from './admin-employee.service.js';

import { inviteEmployeeAccount, resetEmployeePassword } from './admin-employee-account.service.js';

export const adminEmployeeRouter=Router({mergeParams:true});
function requestMetadata(req: Request) { return { ipAddress: req.ip ?? null, userAgent: req.get('user-agent') ?? null }; }

adminEmployeeRouter.get('/',requireAuth,async(req,res)=>{const businessUnitId=requireRouteParam(req,'businessUnitId');res.json(await listEmployees(req.auth!.userId,businessUnitId,employeeListQuerySchema.parse(req.query)));});
adminEmployeeRouter.post('/',requireAuth,async(req,res)=>{const businessUnitId=requireRouteParam(req,'businessUnitId');res.status(201).json({data:await createEmployee(req.auth!.userId,businessUnitId,createEmployeeSchema.parse(req.body))});});
adminEmployeeRouter.patch('/:employeeId',requireAuth,async(req,res)=>{const businessUnitId=requireRouteParam(req,'businessUnitId');const employeeId=requireRouteParam(req,'employeeId');res.json({data:await updateEmployee(req.auth!.userId,businessUnitId,employeeId,updateEmployeeSchema.parse(req.body))});});

adminEmployeeRouter.post('/:employeeId/invite',requireAuth,async(req,res)=>{
  const businessUnitId=requireRouteParam(req,'businessUnitId');
  const employeeId=requireRouteParam(req,'employeeId');
  res.status(202).json({data:await inviteEmployeeAccount(req.auth!.userId,businessUnitId,employeeId,requestMetadata(req))});
});
adminEmployeeRouter.post('/:employeeId/password-reset',requireAuth,async(req,res)=>{
  const businessUnitId=requireRouteParam(req,'businessUnitId');
  const employeeId=requireRouteParam(req,'employeeId');
  res.status(202).json({data:await resetEmployeePassword(req.auth!.userId,businessUnitId,employeeId,requestMetadata(req))});
});
