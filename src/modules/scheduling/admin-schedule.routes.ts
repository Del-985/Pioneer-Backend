import { Router } from 'express';
import { requireRouteParam } from '../../lib/route-param.js';
import { requireAuth } from '../../middleware/auth.js';
import { createScheduleEntrySchema, scheduleListQuerySchema, updateScheduleEntrySchema } from './admin-schedule.schemas.js';
import { createScheduleEntry, listScheduleEntries, updateScheduleEntry } from './admin-schedule.service.js';

export const adminScheduleRouter = Router({ mergeParams:true });
adminScheduleRouter.get('/',requireAuth,async(req,res)=>{
  const businessUnitId=requireRouteParam(req,'businessUnitId');
  const result=await listScheduleEntries(req.auth!.userId,businessUnitId,scheduleListQuerySchema.parse(req.query));
  res.json(result);
});
adminScheduleRouter.post('/',requireAuth,async(req,res)=>{
  const businessUnitId=requireRouteParam(req,'businessUnitId');
  res.status(201).json({data:await createScheduleEntry(req.auth!.userId,businessUnitId,createScheduleEntrySchema.parse(req.body))});
});
adminScheduleRouter.patch('/:scheduleEntryId',requireAuth,async(req,res)=>{
  const businessUnitId=requireRouteParam(req,'businessUnitId');
  const scheduleEntryId=requireRouteParam(req,'scheduleEntryId');
  res.json({data:await updateScheduleEntry(req.auth!.userId,businessUnitId,scheduleEntryId,updateScheduleEntrySchema.parse(req.body))});
});
