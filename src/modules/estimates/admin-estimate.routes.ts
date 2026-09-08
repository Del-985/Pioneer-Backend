import { Router } from 'express';
import { requireRouteParam } from '../../lib/route-param.js';
import { requireAuth } from '../../middleware/auth.js';
import { createEstimateSchema,estimateListQuerySchema,updateEstimateSchema } from './admin-estimate.schemas.js';
import { createEstimate,getEstimate,listEstimates,updateEstimate } from './admin-estimate.service.js';

export const adminEstimateRouter=Router({mergeParams:true});
adminEstimateRouter.get('/',requireAuth,async(req,res)=>{const businessUnitId=requireRouteParam(req,'businessUnitId');res.json(await listEstimates(req.auth!.userId,businessUnitId,estimateListQuerySchema.parse(req.query)));});
adminEstimateRouter.post('/',requireAuth,async(req,res)=>{const businessUnitId=requireRouteParam(req,'businessUnitId');res.status(201).json({data:await createEstimate(req.auth!.userId,businessUnitId,createEstimateSchema.parse(req.body))});});
adminEstimateRouter.get('/:estimateId',requireAuth,async(req,res)=>{const businessUnitId=requireRouteParam(req,'businessUnitId');const estimateId=requireRouteParam(req,'estimateId');res.json({data:await getEstimate(req.auth!.userId,businessUnitId,estimateId)});});
adminEstimateRouter.patch('/:estimateId',requireAuth,async(req,res)=>{const businessUnitId=requireRouteParam(req,'businessUnitId');const estimateId=requireRouteParam(req,'estimateId');res.json({data:await updateEstimate(req.auth!.userId,businessUnitId,estimateId,updateEstimateSchema.parse(req.body))});});
