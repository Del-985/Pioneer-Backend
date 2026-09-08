import { Router } from 'express';
import { requireRouteParam } from '../../lib/route-param.js';
import { requireAuth } from '../../middleware/auth.js';
import { consolidatedReportQuerySchema, reportRangeSchema, trialBalanceQuerySchema } from './admin-reporting.schemas.js';
import { getBusinessUnitSummary, getConsolidatedSummary, getTrialBalance } from './admin-reporting.service.js';

export const adminBusinessReportRouter=Router({mergeParams:true});
adminBusinessReportRouter.get('/summary',requireAuth,async(req,res)=>{const businessUnitId=requireRouteParam(req,'businessUnitId');res.json({data:await getBusinessUnitSummary(req.auth!.userId,businessUnitId,reportRangeSchema.parse(req.query))});});
adminBusinessReportRouter.get('/trial-balance',requireAuth,async(req,res)=>{const businessUnitId=requireRouteParam(req,'businessUnitId');res.json({data:await getTrialBalance(req.auth!.userId,businessUnitId,trialBalanceQuerySchema.parse(req.query))});});

export const adminConsolidatedReportRouter=Router();
adminConsolidatedReportRouter.get('/consolidated',requireAuth,async(req,res)=>{res.json({data:await getConsolidatedSummary(req.auth!.userId,consolidatedReportQuerySchema.parse(req.query))});});
