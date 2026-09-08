import { Router } from 'express';
import { requireRouteParam } from '../../lib/route-param.js';
import { requireAuth } from '../../middleware/auth.js';
import { createIntegrationSchema, integrationListQuerySchema, updateIntegrationSchema } from './admin-integration.schemas.js';
import { createIntegration, listIntegrations, updateIntegration } from './admin-integration.service.js';

export const adminIntegrationRouter=Router();
adminIntegrationRouter.get('/',requireAuth,async(req,res)=>{res.json(await listIntegrations(req.auth!.userId,integrationListQuerySchema.parse(req.query)));});
adminIntegrationRouter.post('/',requireAuth,async(req,res)=>{res.status(201).json({data:await createIntegration(req.auth!.userId,createIntegrationSchema.parse(req.body))});});
adminIntegrationRouter.patch('/:integrationId',requireAuth,async(req,res)=>{const integrationId=requireRouteParam(req,'integrationId');res.json({data:await updateIntegration(req.auth!.userId,integrationId,updateIntegrationSchema.parse(req.body))});});
