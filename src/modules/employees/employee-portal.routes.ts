import {employeeProviderStatements} from './payroll-provider.service.js';
import {employeePostedAdjustments} from './payroll-adjustments.service.js';
import express, { Router } from 'express';
import { isObjectStorageConfigured } from '../bookkeeping/object-storage.service.js';
import { z } from 'zod';
import { requireEmployeePortalAuth, isTrustedEmployeePortalOrigin } from '../../middleware/auth.js';
import { HttpError } from '../../lib/http-error.js';
import { createSession, authenticateSessionToken, revokeSession } from '../auth/auth.service.js';
import { loginSchema, changePasswordSchema } from '../auth/auth.schemas.js';
import { loginRateLimiter } from '../auth/auth.routes.js';
import { changePassword } from '../auth/password-management.service.js';
import { requireRouteParam } from '../../lib/route-param.js';
import {
  employeeJob,
  employeeJobs,
  employeeJobsQuerySchema,
  employeeProfile,
} from './employee-portal.service.js';

import { fieldActionSchema, getMyReport, updateMyJob } from './employee-field.service.js';
import { employeeReportPhotos, newPhotoIntent, confirmPhoto, photoIntentSchema, storeEmployeePhotoContent, employeePhotoContent } from './employee-photos.service.js';
import {
 availabilitySchema, employeeSelf, listAvailability, saveAvailability,
 listShifts, respondToShift, shiftResponseSchema,
} from './employee-scheduling.service.js';
import { listRoutesForEmployee } from './employee-routes.service.js';
import { myGrossStatements } from './payroll.service.js';
import {
  timeQuerySchema,clockInSchema,beginBreakSchema,getEmployeeTimesheet,
  clockIn,startBreak,endBreak,clockOut,
} from './employee-time.service.js';

export const employeePortalRouter = Router();

function requestMetadata(req: express.Request) {
  return { ipAddress: req.ip ?? null, userAgent: req.get('user-agent') ?? null };
}

// The cookie-only shared /api/auth/login endpoint cannot establish a third-party
// session on iOS Safari. Issue an opaque, revocable, short-lived session token
// only to the employee portal. The raw token is never exposed on Admin APIs.
employeePortalRouter.post('/session/login',loginRateLimiter,async(req,res)=>{
  if(!isTrustedEmployeePortalOrigin(req.get('origin'))) {
    throw new HttpError(403,'EMPLOYEE_LOGIN_ORIGIN_DENIED',
      'Employee login must originate from the secure employee portal.');
  }
  const credentials=loginSchema.parse(req.body);
  const session=await createSession(credentials.email,credentials.password,
    requestMetadata(req),24);
  try {
    const profile=await employeeProfile(session.user.id,session.user);
    res.setHeader('Cache-Control','no-store');
    res.json({data:{
      token:session.token,expiresAt:session.expiresAt,profile,
    }});
  }catch(error){
    const auth=await authenticateSessionToken(session.token);
    await revokeSession(auth.sessionId,auth.userId,requestMetadata(req));
    throw error;
  }
});

employeePortalRouter.use(requireEmployeePortalAuth);

employeePortalRouter.post('/session/logout',async(req,res)=>{
  await revokeSession(req.auth!.sessionId,req.auth!.userId,requestMetadata(req));
  res.setHeader('Cache-Control','no-store');
  res.status(204).end();
});
employeePortalRouter.post('/session/password/change',async(req,res)=>{
  const input=changePasswordSchema.parse(req.body);
  await changePassword(req.auth!.userId,input.currentPassword,input.newPassword,
    req.auth!.sessionId,requestMetadata(req));
  res.status(204).end();
});

// Self-service endpoints intentionally do not accept an employeeId supplied by
// the browser. Employee identity and business unit access derive from the
// authenticated user and their active employee records.
employeePortalRouter.get('/capabilities', async (_req, res) => {
  res.json({data:{photoUploads:true,photoStorage:isObjectStorageConfigured() ? 'object_storage' : 'database'}});
});

employeePortalRouter.get('/me', async (req, res) => {
  const actor = req.auth!;
  res.setHeader('Cache-Control', 'private, no-store');
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
employeePortalRouter.post(
  '/photos/:photoId/content',
  express.raw({type:'application/octet-stream',limit:'10mb'}),
  async (req,res) => {
    if(!Buffer.isBuffer(req.body)) {
      res.status(400).json({error:{code:'PHOTO_BODY_REQUIRED',message:'Upload photo bytes using application/octet-stream.'}});
      return;
    }
    res.json(await storeEmployeePhotoContent(req.auth!.userId,
      requireRouteParam(req,'photoId'),req.body));
  }
);
employeePortalRouter.get('/photos/:photoId/content',async(req,res)=>{
  const image=await employeePhotoContent(req.auth!.userId,requireRouteParam(req,'photoId'));
  res.setHeader('Content-Type',image.contentType);
  res.setHeader('Cache-Control','private, no-store');
  res.setHeader('X-Content-Type-Options','nosniff');
  res.setHeader('Content-Disposition','inline');
  res.send(image.content);
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

employeePortalRouter.get('/time',async(req,res)=>{
  const input=timeQuerySchema.parse(req.query);
  res.json(await getEmployeeTimesheet(req.auth!.userId,input.businessUnitId,input.weekStart));
});
employeePortalRouter.post('/time/clock-in',async(req,res)=>{
  res.status(201).json(await clockIn(req.auth!.userId,clockInSchema.parse(req.body)));
});
employeePortalRouter.post('/time/break/start',async(req,res)=>{
  const {businessUnitId,paid}=timeQuerySchema.pick({businessUnitId:true})
    .extend({paid:beginBreakSchema.shape.paid}).parse(req.body);
  res.json(await startBreak(req.auth!.userId,businessUnitId,paid));
});
employeePortalRouter.post('/time/break/end',async(req,res)=>{
  const {businessUnitId}=timeQuerySchema.pick({businessUnitId:true}).parse(req.body);
  res.json(await endBreak(req.auth!.userId,businessUnitId));
});
employeePortalRouter.post('/time/clock-out',async(req,res)=>{
  const {businessUnitId}=timeQuerySchema.pick({businessUnitId:true}).parse(req.body);
  res.json(await clockOut(req.auth!.userId,businessUnitId));
});

employeePortalRouter.get('/pay/statements',async(req,res)=>{
  const {businessUnitId}=timeQuerySchema.pick({businessUnitId:true}).parse(req.query);
  res.json(await myGrossStatements(req.auth!.userId,businessUnitId));
});

employeePortalRouter.get('/pay/adjustments',async(req,res)=>{
  const {businessUnitId}=timeQuerySchema.pick({businessUnitId:true}).parse(req.query);
  res.json(await employeePostedAdjustments(req.auth!.userId,businessUnitId));
});

employeePortalRouter.get('/pay/provider-statements',async(req,res)=>{
  const {businessUnitId}=timeQuerySchema.pick({businessUnitId:true}).parse(req.query);
  res.setHeader('Cache-Control','private, no-store');
  res.json(await employeeProviderStatements(req.auth!.userId,businessUnitId));
});
