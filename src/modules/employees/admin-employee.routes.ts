import { Router } from 'express';
import { requireRouteParam } from '../../lib/route-param.js';
import { requireAuth } from '../../middleware/auth.js';
import { createEmployeeSchema, employeeListQuerySchema, updateEmployeeSchema } from './admin-employee.schemas.js';
import { createEmployee, listEmployees, updateEmployee } from './admin-employee.service.js';

export const adminEmployeeRouter=Router({mergeParams:true});
adminEmployeeRouter.get('/',requireAuth,async(req,res)=>{const businessUnitId=requireRouteParam(req,'businessUnitId');res.json(await listEmployees(req.auth!.userId,businessUnitId,employeeListQuerySchema.parse(req.query)));});
adminEmployeeRouter.post('/',requireAuth,async(req,res)=>{const businessUnitId=requireRouteParam(req,'businessUnitId');res.status(201).json({data:await createEmployee(req.auth!.userId,businessUnitId,createEmployeeSchema.parse(req.body))});});
adminEmployeeRouter.patch('/:employeeId',requireAuth,async(req,res)=>{const businessUnitId=requireRouteParam(req,'businessUnitId');const employeeId=requireRouteParam(req,'employeeId');res.json({data:await updateEmployee(req.auth!.userId,businessUnitId,employeeId,updateEmployeeSchema.parse(req.body))});});
