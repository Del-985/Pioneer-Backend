import { Router } from 'express';
import { requireAuth } from '../../middleware/auth.js';
import { requireRouteParam } from '../../lib/route-param.js';
import {
  employeeJob,
  employeeJobs,
  employeeJobsQuerySchema,
  employeeProfile,
} from './employee-portal.service.js';

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
