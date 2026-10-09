import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../../middleware/auth.js';
import { requireRouteParam } from '../../lib/route-param.js';
import {
  employeeJob,
  employeeJobs,
  employeeJobsQuerySchema,
  employeeProfile,
} from './employee-portal.service.js';

import { fieldActionSchema, getMyReport, updateMyJob } from './employee-field.service.js';
import { employeeReportPhotos, newPhotoIntent, confirmPhoto, photoIntentSchema } from './employee-photos.service.js';
import {
 availabilitySchema, employeeSelf, listAvailability, saveAvailability,
 listShifts, respondToShift, shiftResponseSchema,
} from './employee-scheduling.service.js';
import { listRoutesForEmployee } from './employee-routes.service.js';

export const employeePortalRouter = Router();
employeePortalRouter.use(requireAuth);

// Self-service endpoints intentionally do not accept an employeeId supplied by
// the browser. Employee identity and business unit access derive from the
// authenticated user and their active employee records.
employeePortalRouter.get('/me', async (req, res) => {
  const actor = req.auth!;
  res.json({ data: await employeeProfile(actor.userId, actor) });
});

employeePortalRouter.get('/jobs', async (req, res) => {
  res.json(await employeeJobs(req.auth!.userId, employeeJobsQuerySchema.parse(req.query)));
});

employeePortalRouter.get('/jobs/:jobId', async (req, res) => {
  const jobId = requireRouteParam(req, 'jobId');
  res.json({ data: await employeeJob(req.auth!.userId, jobId) });
});

employeePortalRouter.get('/jobs/:jobId/report', async (req, res) => {
  res.json(await getMyReport(req.auth!.userId, requireRouteParam(req,'jobId')));
});
employeePortalRouter.post('/jobs/:jobId/action', async (req,res) => {
  res.json(await updateMyJob(req.auth!.userId,requireRouteParam(req,'jobId'),
    fieldActionSchema.parse(req.body)));
});
employeePortalRouter.get('/jobs/:jobId/photos',async(req,res)=>{
  res.json(await employeeReportPhotos(req.auth!.userId,requireRouteParam(req,'jobId')));
});
employeePortalRouter.post('/jobs/:jobId/photos/upload-intent',async(req,res)=>{
  res.status(201).json(await newPhotoIntent(req.auth!.userId,
    requireRouteParam(req,'jobId'),photoIntentSchema.parse(req.body)));
});
employeePortalRouter.post('/photos/:photoId/complete',async(req,res)=>{
  res.json(await confirmPhoto(req.auth!.userId,requireRouteParam(req,'photoId')));
});
const unitQuery=z.object({businessUnitId:z.string().uuid()});
employeePortalRouter.get('/availability',async(req,res)=>{
  const {businessUnitId}=unitQuery.parse(req.query);
  res.json(await listAvailability(req.auth!.userId,businessUnitId,true));
});
employeePortalRouter.put('/availability',async(req,res)=>{
  res.json(await saveAvailability(req.auth!.userId,availabilitySchema.parse(req.body)));
});
employeePortalRouter.get('/shifts',async(req,res)=>{
  const {businessUnitId}=unitQuery.parse(req.query);
  res.json(await listShifts(req.auth!.userId,businessUnitId,false));
});
employeePortalRouter.post('/shifts/:shiftId/respond',async(req,res)=>{
  const {response}=shiftResponseSchema.parse(req.body);
  res.json({data:await respondToShift(req.auth!.userId,
    requireRouteParam(req,'shiftId'),response)});
});
employeePortalRouter.get('/routes',async(req,res)=>{
  const {businessUnitId}=unitQuery.parse(req.query);
  res.json(await listRoutesForEmployee(req.auth!.userId,businessUnitId));
});
