import { Router } from 'express';
import { requireRouteParam } from '../../lib/route-param.js';
import { requireAuth } from '../../middleware/auth.js';
import { createMileageLogSchema, mileageListQuerySchema } from './admin-mileage.schemas.js';
import { createMileageLog, listMileageLogs } from './admin-mileage.service.js';

export const adminMileageRouter=Router({mergeParams:true});
adminMileageRouter.get('/',requireAuth,async(req,res)=>{const businessUnitId=requireRouteParam(req,'businessUnitId');res.json(await listMileageLogs(req.auth!.userId,businessUnitId,mileageListQuerySchema.parse(req.query)));});
adminMileageRouter.post('/',requireAuth,async(req,res)=>{const businessUnitId=requireRouteParam(req,'businessUnitId');res.status(201).json({data:await createMileageLog(req.auth!.userId,businessUnitId,createMileageLogSchema.parse(req.body))});});
