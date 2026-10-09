import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../../middleware/auth.js';
import { requireRouteParam } from '../../lib/route-param.js';
import { listReports,reviewReport,fieldReviewSchema } from './employee-field.service.js';
import { adminReportPhotos } from './employee-photos.service.js';
import {
  listAvailability,listShifts,createShift,offerShift,changeShiftStatus,
  shiftSchema,shiftOfferSchema,shiftStatusSchema,
} from './employee-scheduling.service.js';
import {
  listRoutesForAdmin,createRoute,updateRoute,routeCreateSchema,routeUpdateSchema,
} from './employee-routes.service.js';

export const adminFieldRouter=Router({mergeParams:true});
adminFieldRouter.use(requireAuth);
const reportQuery=z.object({status:z.enum(['assigned','acknowledged','in_progress','issue','submitted','approved','rejected']).optional()});
const unit=(req:any)=>requireRouteParam(req,'businessUnitId');

adminFieldRouter.get('/reports',async(req,res)=>{
  const {status}=reportQuery.parse(req.query);
  res.json(await listReports(req.auth!.userId,unit(req),status));
});
adminFieldRouter.post('/reports/:reportId/review',async(req,res)=>{
  res.json(await reviewReport(req.auth!.userId,unit(req),
    requireRouteParam(req,'reportId'),fieldReviewSchema.parse(req.body)));
});
adminFieldRouter.get('/reports/:reportId/photos',async(req,res)=>{
  res.json(await adminReportPhotos(req.auth!.userId,unit(req),
    requireRouteParam(req,'reportId')));
});
adminFieldRouter.get('/availability',async(req,res)=>{
  res.json(await listAvailability(req.auth!.userId,unit(req),false));
});
adminFieldRouter.get('/shifts',async(req,res)=>{
  res.json(await listShifts(req.auth!.userId,unit(req),true));
});
adminFieldRouter.post('/shifts',async(req,res)=>{
  res.status(201).json({data:await createShift(req.auth!.userId,unit(req),shiftSchema.parse(req.body))});
});
adminFieldRouter.patch('/shifts/:shiftId',async(req,res)=>{
  const {status}=shiftStatusSchema.parse(req.body);
  res.json({data:await changeShiftStatus(req.auth!.userId,unit(req),requireRouteParam(req,'shiftId'),status)});
});
adminFieldRouter.post('/shifts/:shiftId/offers',async(req,res)=>{
  const {employeeIds}=shiftOfferSchema.parse(req.body);
  res.json({data:await offerShift(req.auth!.userId,unit(req),requireRouteParam(req,'shiftId'),employeeIds)});
});
adminFieldRouter.get('/routes',async(req,res)=>{
  res.json(await listRoutesForAdmin(req.auth!.userId,unit(req)));
});
adminFieldRouter.post('/routes',async(req,res)=>{
  res.status(201).json({data:await createRoute(req.auth!.userId,unit(req),routeCreateSchema.parse(req.body))});
});
adminFieldRouter.patch('/routes/:routeId',async(req,res)=>{
  res.json({data:await updateRoute(req.auth!.userId,unit(req),requireRouteParam(req,'routeId'),routeUpdateSchema.parse(req.body))});
});
